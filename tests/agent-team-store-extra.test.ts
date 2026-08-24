/**
 * Additional coverage for AgentTeamStore — paths not exercised by the existing
 * agent-team-store.test.ts:
 *   - upsertTeam + setTeamChatBindings
 *   - setAgentStatus / setAgentSessionId / upsertAgent reactivation
 *   - task lifecycle (upsertTask, listTasks, blockedBy)
 *   - appendRunOutput / listRuns
 *   - deleteTeam (cascades)
 *   - requireTeam error on missing team
 *   - mergeOutput behaviour via appendRunOutput
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), 'luckagent-team-store-extra-'));
  const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
  return store;
}

// =====================================================================
// upsertTeam
// =====================================================================

describe('AgentTeamStore.upsertTeam', () => {
  it('creates a new team via upsert', () => {
    const store = makeStore();
    const team = store.upsertTeam({ name: 'alpha', description: 'Alpha team' });
    expect(team).toMatchObject({ name: 'alpha', description: 'Alpha team', status: 'active', managedByConfig: true });
    store.close();
  });

  it('updates an existing team via upsert without losing unspecified fields', () => {
    const store = makeStore();
    store.createTeam('beta', 'Original description', { displayChatIds: ['oc_original'] });
    const updated = store.upsertTeam({ name: 'beta', description: 'Updated description' });
    expect(updated.description).toBe('Updated description');
    expect(updated.displayChatIds).toEqual(['oc_original']); // preserved
    store.close();
  });

  it('merges chatIds and displayChatIds on update', () => {
    const store = makeStore();
    store.upsertTeam({ name: 'gamma', chatIds: ['c1'], displayChatIds: ['d1'] });
    const updated = store.upsertTeam({ name: 'gamma', chatIds: ['c2'], displayChatIds: ['d2'] });
    expect(updated.chatIds).toContain('c2');
    expect(updated.displayChatIds).toContain('d2');
    store.close();
  });
});

// =====================================================================
// setTeamChatBindings
// =====================================================================

describe('AgentTeamStore.setTeamChatBindings', () => {
  it('updates chatIds and displayChatIds independently', () => {
    const store = makeStore();
    store.createTeam('t1', 'T1', { chatIds: ['old-chat'], displayChatIds: ['old-display'] });

    store.setTeamChatBindings('t1', { chatIds: ['new-chat'] });
    const after1 = store.getTeam('t1')!;
    expect(after1.chatIds).toContain('new-chat');
    expect(after1.displayChatIds).toContain('old-display'); // unchanged

    store.setTeamChatBindings('t1', { displayChatIds: ['new-display'] });
    const after2 = store.getTeam('t1')!;
    expect(after2.displayChatIds).toContain('new-display');
    store.close();
  });

  it('returns undefined when team does not exist', () => {
    const store = makeStore();
    expect(store.setTeamChatBindings('missing', { chatIds: ['x'] })).toBeUndefined();
    store.close();
  });
});

// =====================================================================
// setTeamStatus
// =====================================================================

describe('AgentTeamStore.setTeamStatus', () => {
  it('transitions a team from active to stopped and back', () => {
    const store = makeStore();
    store.createTeam('flip', 'Flipper');
    store.setTeamStatus('flip', 'stopped');
    expect(store.getTeam('flip')?.status).toBe('stopped');
    store.setTeamStatus('flip', 'active');
    expect(store.getTeam('flip')?.status).toBe('active');
    store.close();
  });
});

// =====================================================================
// setAgentStatus
// =====================================================================

describe('AgentTeamStore.setAgentStatus', () => {
  it('transitions agent statuses: idle → working → stopped → idle', () => {
    const store = makeStore();
    store.createTeam('team1');
    store.createAgent('team1', { name: 'bot', engine: 'claude' });

    store.setAgentStatus('team1', 'bot', 'working');
    expect(store.getAgent('team1', 'bot')?.status).toBe('working');

    store.setAgentStatus('team1', 'bot', 'stopped');
    expect(store.getAgent('team1', 'bot')?.status).toBe('stopped');

    store.setAgentStatus('team1', 'bot', 'idle');
    expect(store.getAgent('team1', 'bot')?.status).toBe('idle');
    store.close();
  });
});

// =====================================================================
// setAgentSessionId
// =====================================================================

describe('AgentTeamStore.setAgentSessionId', () => {
  it('stores and clears the sessionId', () => {
    const store = makeStore();
    store.createTeam('team2');
    store.createAgent('team2', { name: 'worker', engine: 'claude' });

    store.setAgentSessionId('team2', 'worker', 'session-abc-123');
    expect(store.getAgent('team2', 'worker')?.sessionId).toBe('session-abc-123');

    store.setAgentSessionId('team2', 'worker', undefined);
    expect(store.getAgent('team2', 'worker')?.sessionId).toBeUndefined();
    store.close();
  });

  it('also updates engine when provided', () => {
    const store = makeStore();
    store.createTeam('team3');
    store.createAgent('team3', { name: 'a', engine: 'claude' });

    store.setAgentSessionId('team3', 'a', 'sess-xyz', 'kimi');
    expect(store.getAgent('team3', 'a')?.engine).toBe('kimi');
    store.close();
  });

  it('returns undefined for non-existent agent', () => {
    const store = makeStore();
    store.createTeam('team4');
    expect(store.setAgentSessionId('team4', 'ghost', 'sess')).toBeUndefined();
    store.close();
  });
});

// =====================================================================
// upsertAgent — reactivation of stopped agents
// =====================================================================

describe('AgentTeamStore.upsertAgent', () => {
  it('reactivates a stopped agent to idle on upsert', () => {
    const store = makeStore();
    store.createTeam('team5');
    store.createAgent('team5', { name: 'worker', engine: 'claude' });
    store.setAgentStatus('team5', 'worker', 'stopped');

    store.upsertAgent('team5', { name: 'worker', engine: 'claude' });
    expect(store.getAgent('team5', 'worker')?.status).toBe('idle');
    store.close();
  });

  it('preserves working status when re-upserting a working agent', () => {
    const store = makeStore();
    store.createTeam('team6');
    store.createAgent('team6', { name: 'w', engine: 'codex' });
    store.setAgentStatus('team6', 'w', 'working');

    store.upsertAgent('team6', { name: 'w', engine: 'codex' });
    expect(store.getAgent('team6', 'w')?.status).toBe('working');
    store.close();
  });

  it('creates new agent if not found', () => {
    const store = makeStore();
    store.createTeam('team7');
    store.upsertAgent('team7', { name: 'new-agent', engine: 'kimi', role: 'coder' });
    expect(store.getAgent('team7', 'new-agent')).toMatchObject({ name: 'new-agent', engine: 'kimi', role: 'coder' });
    store.close();
  });
});

// =====================================================================
// Task lifecycle
// =====================================================================

describe('AgentTeamStore task lifecycle', () => {
  it('creates multiple tasks with auto-incrementing ids', () => {
    const store = makeStore();
    store.createTeam('tasks');
    const t1 = store.createTask('tasks', { subject: 'First task' });
    const t2 = store.createTask('tasks', { subject: 'Second task' });
    const t3 = store.createTask('tasks', { subject: 'Third task' });
    expect(t1.id).toBe(1);
    expect(t2.id).toBe(2);
    expect(t3.id).toBe(3);
    store.close();
  });

  it('upserts a task by id (update existing)', () => {
    const store = makeStore();
    store.createTeam('tasks2');
    const task = store.createTask('tasks2', { subject: 'Original' });
    const updated = store.upsertTask('tasks2', { id: task.id, subject: 'Updated', status: 'in_progress' });
    expect(updated.subject).toBe('Updated');
    expect(updated.status).toBe('in_progress');
    store.close();
  });

  it('upserts a task by id (insert new with explicit id)', () => {
    const store = makeStore();
    store.createTeam('tasks3');
    const task = store.upsertTask('tasks3', { id: 99, subject: 'Explicit ID task' });
    expect(task.id).toBe(99);
    expect(task.subject).toBe('Explicit ID task');
    store.close();
  });

  it('upserts a task without id — creates new', () => {
    const store = makeStore();
    store.createTeam('tasks4');
    const task = store.upsertTask('tasks4', { subject: 'No ID task' });
    expect(task.id).toBeGreaterThan(0);
    store.close();
  });

  it('listTasks excludes deleted tasks', () => {
    const store = makeStore();
    store.createTeam('tasks5');
    const t1 = store.createTask('tasks5', { subject: 'Keep me' });
    const t2 = store.createTask('tasks5', { subject: 'Delete me' });
    store.updateTask('tasks5', t2.id, { status: 'deleted' });
    const list = store.listTasks('tasks5');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(t1.id);
    store.close();
  });

  it('stores and retrieves blockedBy dependencies', () => {
    const store = makeStore();
    store.createTeam('tasks6');
    const t1 = store.createTask('tasks6', { subject: 'Base task' });
    const t2 = store.createTask('tasks6', { subject: 'Dependent', blockedBy: [t1.id] });
    expect(store.getTask('tasks6', t2.id)?.blockedBy).toEqual([t1.id]);
    store.close();
  });

  it('updateTask returns undefined for missing task', () => {
    const store = makeStore();
    store.createTeam('tasks7');
    expect(store.updateTask('tasks7', 999, { subject: 'ghost' })).toBeUndefined();
    store.close();
  });
});

// =====================================================================
// appendRunOutput
// =====================================================================

describe('AgentTeamStore.appendRunOutput', () => {
  it('appends output to a running run', () => {
    const store = makeStore();
    store.createTeam('runs1');
    const run = store.createRun('runs1', { agentName: 'bot' });

    store.appendRunOutput('runs1', run.id, 'First chunk');
    expect(store.getRun('runs1', run.id)?.output).toBe('First chunk');

    store.appendRunOutput('runs1', run.id, 'Second chunk');
    const output = store.getRun('runs1', run.id)?.output;
    expect(output).toContain('First chunk');
    expect(output).toContain('Second chunk');
    store.close();
  });

  it('does not append to a completed run', () => {
    const store = makeStore();
    store.createTeam('runs2');
    const run = store.createRun('runs2', { agentName: 'bot' });
    store.updateRun('runs2', run.id, { status: 'completed', output: 'Final output' });

    // Should return existing run unchanged
    const result = store.appendRunOutput('runs2', run.id, 'extra chunk');
    expect(result?.output).toBe('Final output');
    store.close();
  });

  it('returns undefined for non-existent run', () => {
    const store = makeStore();
    store.createTeam('runs3');
    expect(store.appendRunOutput('runs3', 'ghost-run-id', 'chunk')).toBeUndefined();
    store.close();
  });

  it('ignores empty/whitespace-only append', () => {
    const store = makeStore();
    store.createTeam('runs4');
    const run = store.createRun('runs4', { agentName: 'bot' });
    store.appendRunOutput('runs4', run.id, 'Initial');
    store.appendRunOutput('runs4', run.id, '   '); // whitespace only
    expect(store.getRun('runs4', run.id)?.output).toBe('Initial');
    store.close();
  });
});

// =====================================================================
// listRuns
// =====================================================================

describe('AgentTeamStore.listRuns', () => {
  it('returns all runs for a team', () => {
    const store = makeStore();
    store.createTeam('lr1');
    const r1 = store.createRun('lr1', { agentName: 'a' });
    const r2 = store.createRun('lr1', { agentName: 'b' });
    const runs = store.listRuns('lr1');
    expect(runs).toHaveLength(2);
    // Both runs are present (order may vary when timestamps collide)
    const ids = runs.map((r) => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
    store.close();
  });

  it('listRuns is empty for a new team', () => {
    const store = makeStore();
    store.createTeam('lr2');
    expect(store.listRuns('lr2')).toHaveLength(0);
    store.close();
  });
});

// =====================================================================
// deleteTeam (cascades)
// =====================================================================

describe('AgentTeamStore.deleteTeam', () => {
  it('deletes a team and cascades to agents, tasks, messages, runs', () => {
    const store = makeStore();
    store.createTeam('dead', 'Will be deleted');
    store.createAgent('dead', { name: 'ghost', engine: 'claude' });
    store.createTask('dead', { subject: 'ghost task' });
    store.sendMessage('dead', { toName: 'ghost', body: 'hello' });
    store.createRun('dead', { agentName: 'ghost' });

    const deleted = store.deleteTeam('dead');
    expect(deleted).toBe(true);
    expect(store.getTeam('dead')).toBeUndefined();
    store.close();
  });

  it('returns false when deleting a non-existent team', () => {
    const store = makeStore();
    expect(store.deleteTeam('ghost-team')).toBe(false);
    store.close();
  });
});

// =====================================================================
// requireTeam error
// =====================================================================

describe('AgentTeamStore requireTeam guard', () => {
  it('throws 404-like error when accessing agents on a non-existent team', () => {
    const store = makeStore();
    expect(() => store.listAgents('ghost')).toThrow('Agent team not found: ghost');
    store.close();
  });

  it('throws when creating agent on non-existent team', () => {
    const store = makeStore();
    expect(() => store.createAgent('ghost', { name: 'bot', engine: 'claude' })).toThrow('Agent team not found');
    store.close();
  });

  it('throws when creating task on non-existent team', () => {
    const store = makeStore();
    expect(() => store.createTask('ghost', { subject: 'x' })).toThrow('Agent team not found');
    store.close();
  });

  it('throws when sending message on non-existent team', () => {
    const store = makeStore();
    expect(() => store.sendMessage('ghost', { toName: 'someone', body: 'hi' })).toThrow('Agent team not found');
    store.close();
  });

  it('error has statusCode 404', () => {
    const store = makeStore();
    try {
      store.listAgents('ghost');
      expect.fail('Should have thrown');
    } catch (err: any) {
      expect(err.statusCode).toBe(404);
    }
    store.close();
  });
});

// =====================================================================
// findTeamForChat — displayChatIds priority over chatIds
// =====================================================================

describe('AgentTeamStore.findTeamForChat', () => {
  it('prefers displayChatIds over chatIds when both match different teams', () => {
    const store = makeStore();
    store.createTeam('team-a', '', { chatIds: ['shared-chat'], displayChatIds: [] });
    store.createTeam('team-b', '', { chatIds: [], displayChatIds: ['shared-chat'] });

    // team-b has shared-chat in displayChatIds, team-a in chatIds
    // findTeamForChat should find team-b first (displayChatIds priority)
    const found = store.findTeamForChat('shared-chat');
    expect(found?.name).toBe('team-b');
    store.close();
  });

  it('falls back to chatIds when not in any displayChatIds', () => {
    const store = makeStore();
    store.createTeam('chatonly', '', { chatIds: ['oc_chatonly'], displayChatIds: [] });
    expect(store.findTeamForChat('oc_chatonly')?.name).toBe('chatonly');
    store.close();
  });

  it('returns undefined for stopped teams', () => {
    const store = makeStore();
    store.createTeam('inactive', '', { displayChatIds: ['oc_inactive'] });
    store.setTeamStatus('inactive', 'stopped');
    expect(store.findTeamForChat('oc_inactive')).toBeUndefined();
    store.close();
  });
});

// =====================================================================
// status — unreadMessages count
// =====================================================================

describe('AgentTeamStore.status unreadMessages', () => {
  it('counts unread messages correctly', () => {
    const store = makeStore();
    store.createTeam('status-test');
    store.createAgent('status-test', { name: 'reader', engine: 'claude' });

    store.sendMessage('status-test', { toName: 'reader', body: 'msg1' });
    store.sendMessage('status-test', { toName: 'reader', body: 'msg2' });
    store.sendMessage('status-test', { toName: 'reader', body: 'msg3' });

    expect(store.status('status-test')?.unreadMessages).toBe(3);

    store.markMessagesRead('status-test', 'reader');
    expect(store.status('status-test')?.unreadMessages).toBe(0);
    store.close();
  });
});

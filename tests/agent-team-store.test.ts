import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AgentTeamStore } from '../src/agent-teams/team-store.js';

const logger = {
  child: () => logger,
  info: () => {},
} as any;

describe('AgentTeamStore', () => {
  it('stores team agents, tasks, messages, and runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    const team = store.createTeam('demo', 'Demo team');
    expect(team).toMatchObject({ name: 'demo', description: 'Demo team', status: 'active' });

    const agent = store.createAgent('demo', {
      name: 'reviewer',
      role: 'review',
      engine: 'deepseek',
      prompt: 'Review changes',
    });
    expect(agent).toMatchObject({ teamName: 'demo', name: 'reviewer', status: 'idle', engine: 'deepseek' });
    expect(store.deleteAgent('demo', 'missing')).toBe(false);

    const task = store.createTask('demo', {
      subject: 'Review CLI',
      description: 'Check command shape',
      owner: 'reviewer',
    });
    expect(task).toMatchObject({ id: 1, subject: 'Review CLI', status: 'pending', owner: 'reviewer' });

    const updated = store.updateTask('demo', 1, { status: 'completed', result: 'Looks good' });
    expect(updated).toMatchObject({ status: 'completed', result: 'Looks good' });

    const message = store.sendMessage('demo', {
      fromName: 'lead',
      toName: 'reviewer',
      summary: 'review task',
      body: 'Please review task 1',
    });
    expect(message).toMatchObject({ fromName: 'lead', toName: 'reviewer', body: 'Please review task 1' });
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(1);
    expect(store.markMessagesRead('demo', 'reviewer')).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true)).toHaveLength(0);

    const run = store.createRun('demo', { agentName: 'reviewer', taskId: 1 });
    expect(run).toMatchObject({ teamName: 'demo', agentName: 'reviewer', taskId: 1, status: 'running' });
    expect(store.getRunningRun('demo', 'reviewer')).toMatchObject({ id: run.id, status: 'running' });
    expect(store.updateRun('demo', run.id, { status: 'completed', output: 'done' })).toMatchObject({ output: 'done' });
    expect(store.getRunningRun('demo', 'reviewer')).toBeUndefined();

    const status = store.status('demo');
    expect(status?.agents).toHaveLength(1);
    expect(status?.tasks).toHaveLength(1);
    expect(status?.runs).toHaveLength(1);
    expect(store.deleteAgent('demo', 'reviewer')).toBe(true);
    expect(store.listAgents('demo')).toHaveLength(0);

    store.close();
  });

  it('marks only selected message ids read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));
    store.createTeam('demo', 'Demo team');

    const first = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #1' });
    const second = store.sendMessage('demo', { fromName: 'lead', toName: 'reviewer', body: 'Task #2' });
    store.sendMessage('demo', { fromName: 'lead', toName: 'other', body: 'Other task' });

    expect(store.markMessagesReadById('demo', 'reviewer', [first.id])).toBe(1);
    expect(store.listMessages('demo', 'reviewer', true).map((message) => message.id)).toEqual([second.id]);
    expect(store.listMessages('demo', 'other', true)).toHaveLength(1);

    store.close();
  });

  it('allows lead as a normal member name for nested teams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('demo', 'Demo team');
    expect(store.createAgent('demo', { name: 'lead', engine: 'deepseek' })).toMatchObject({ name: 'lead', status: 'idle' });
    store.reconcileTeams([{
      name: 'demo',
      agents: [
        { name: 'lead', role: 'lead', engine: 'deepseek' },
        { name: 'worker', role: 'worker', engine: 'deepseek' },
      ],
    }]);

    expect(store.getAgent('demo', 'lead')).toMatchObject({ name: 'lead', role: 'lead' });
    expect(store.listAgents('demo').map((agent) => agent.name)).toEqual(['lead', 'worker']);
    expect(store.status('demo')?.agents.map((agent) => agent.name)).toEqual(['lead', 'worker']);

    store.close();
  });

  it('does not stop manual teams when bots.json resident teams are removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual-team', 'Created by CLI', {
      displayChatIds: ['oc_manual'],
    });
    store.reconcileTeams([{
      name: 'resident-team',
      description: 'From bots.json',
      displayChatIds: ['oc_resident'],
      agents: [{ name: 'lead', engine: 'deepseek' }],
    }]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'active', managedByConfig: true });
    expect(store.listAgents('resident-team').map((agent) => agent.name)).toEqual(['lead']);

    store.reconcileTeams([]);

    expect(store.getTeam('manual-team')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident-team')).toMatchObject({ status: 'stopped', managedByConfig: true });
    expect(store.findTeamForChat('oc_manual')).toMatchObject({ name: 'manual-team' });
    expect(store.findTeamForChat('oc_resident')).toBeUndefined();
    store.close();
  });

  it('reconciles configured teams and resolves chat display bindings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.reconcileTeams([{
      name: 'luckagent-dev',
      description: 'Runtime team',
      chatIds: ['team:luckagent-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'deepseek' },
        { name: 'runtime-engineer', role: 'runtime', engine: 'deepseek', prompt: 'Own runtime' },
      ],
      tasks: [
        { id: 5, subject: 'Implement supervisor', owner: 'runtime-engineer' },
      ],
    }]);

    expect(store.getTeam('luckagent-dev')).toMatchObject({
      name: 'luckagent-dev',
      chatIds: ['team:luckagent-dev:runtime-engineer'],
      displayChatIds: ['oc_chat_123'],
      managedByConfig: true,
    });
    expect(store.getAgent('luckagent-dev', 'runtime-engineer')).toMatchObject({ role: 'runtime', engine: 'deepseek' });
    expect(store.getAgent('luckagent-dev', 'lead')).toMatchObject({ role: 'lead', engine: 'deepseek' });
    expect(store.getTask('luckagent-dev', 5)).toMatchObject({ subject: 'Implement supervisor', owner: 'runtime-engineer' });
    expect(store.findTeamForChat('oc_chat_123')).toMatchObject({ name: 'luckagent-dev' });
    expect(store.findTeamForChat('team:luckagent-dev:runtime-engineer')).toMatchObject({ name: 'luckagent-dev' });
    expect(store.findTeamForChat('oc_other')).toBeUndefined();

    store.reconcileTeams([{
      name: 'luckagent-dev',
      description: 'Runtime team',
      displayChatIds: ['oc_chat_456'],
      agents: [
        { name: 'lead', role: 'lead', engine: 'deepseek' },
      ],
    }]);

    expect(store.getAgent('luckagent-dev', 'runtime-engineer')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_123')).toBeUndefined();
    expect(store.findTeamForChat('oc_chat_456')).toMatchObject({ name: 'luckagent-dev' });

    store.reconcileTeams([]);
    expect(store.getTeam('luckagent-dev')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('oc_chat_456')).toBeUndefined();
    store.close();
  });

  it('preserves manual teams when resident config is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'luckagent-agent-teams-'));
    const store = new AgentTeamStore(logger, join(dir, 'teams.db'));

    store.createTeam('manual', 'Manual team', { displayChatIds: ['manual-chat'] });
    store.reconcileTeams([{
      name: 'resident',
      displayChatIds: ['resident-chat'],
      agents: [{ name: 'worker', engine: 'deepseek' }],
    }]);

    expect(store.getTeam('manual')).toMatchObject({ status: 'active', managedByConfig: false });
    expect(store.getTeam('resident')).toMatchObject({ status: 'active', managedByConfig: true });

    store.reconcileTeams([]);
    expect(store.getTeam('manual')).toMatchObject({ status: 'active' });
    expect(store.findTeamForChat('manual-chat')).toMatchObject({ name: 'manual' });
    expect(store.getTeam('resident')).toMatchObject({ status: 'stopped' });
    expect(store.findTeamForChat('resident-chat')).toBeUndefined();

    store.close();
  });
});

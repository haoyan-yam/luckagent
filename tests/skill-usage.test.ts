import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateUsage,
  botForCwd,
  collectLine,
  coverageByBot,
  emptyCache,
  scanTranscripts,
  skillsInToolUse,
  type SkillUse,
} from '../src/api/skill-usage.js';

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'skill-usage-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const assistant = (blocks: unknown[], opts: { cwd?: string; ts?: string; session?: string } = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts ?? '2026-10-01T08:00:00.000Z',
    cwd: opts.cwd ?? '/p/ufs',
    sessionId: opts.session ?? 's1',
    message: { content: blocks },
  }) + '\n';
const skillCall = (id: string, skill: string, opts: { cwd?: string; ts?: string; session?: string } = {}) =>
  assistant([{ type: 'tool_use', id, name: 'Skill', input: { skill, args: 'x' } }], opts);
const bash = (id: string, command: string, opts: { ts?: string } = {}) =>
  assistant([{ type: 'tool_use', id, name: 'Bash', input: { command } }], opts);
const userPrompt = (promptId: string, text = 'hi', ts = '2026-09-30T00:00:00.000Z') =>
  JSON.stringify({ type: 'user', promptId, timestamp: ts, cwd: '/p/ufs', sessionId: 's1', message: { content: text } }) + '\n';
const toolResult = (promptId: string, output: string) =>
  JSON.stringify({ type: 'user', promptId, timestamp: '2026-10-01T08:00:01.000Z', cwd: '/p/ufs', message: { content: [{ type: 'tool_result', content: output }] } }) + '\n';

describe('skillsInToolUse', () => {
  it('recognizes the Skill tool and direct use of a skill dir', () => {
    expect(skillsInToolUse({ type: 'tool_use', name: 'Skill', input: { skill: 'ufs-poster' } })).toEqual([{ skill: 'ufs-poster', viaTool: true }]);
    expect(
      skillsInToolUse({ type: 'tool_use', name: 'Bash', input: { command: 'cat .claude/skills/seph-xlsx/SKILL.md && python3 /p/x/.claude/skills/seph-audit/scripts/a.py' } }),
    ).toEqual([
      { skill: 'seph-xlsx', viaTool: false },
      { skill: 'seph-audit', viaTool: false },
    ]);
    expect(skillsInToolUse({ type: 'tool_use', name: 'Read', input: { file_path: '/p/vs/.claude/skills/vs-report/references/a.md' } })).toEqual([
      { skill: 'vs-report', viaTool: false },
    ]);
  });

  it('ignores listings and globs that name no specific skill', () => {
    expect(skillsInToolUse({ type: 'tool_use', name: 'Bash', input: { command: 'ls .claude/skills/ && head .claude/skills/*/SKILL.md' } })).toEqual([]);
    expect(skillsInToolUse({ type: 'text', text: '.claude/skills/x/' })).toEqual([]);
  });
});

describe('collectLine', () => {
  it('counts one use per turn+skill, keeping the earliest time and whether the Skill tool was involved', () => {
    const uses: Record<string, SkillUse> = {};
    collectLine(bash('b1', 'python3 .claude/skills/ufs-poster/scripts/r.py', { ts: '2026-10-01T08:00:05Z' }), 'p1', uses);
    collectLine(skillCall('t1', 'ufs-poster', { ts: '2026-10-01T08:00:00Z' }), 'p1', uses);
    collectLine(bash('b2', 'python3 .claude/skills/ufs-poster/scripts/r.py'), 'p2', uses);
    expect(Object.keys(uses).sort()).toEqual(['p1|ufs-poster', 'p2|ufs-poster']);
    expect(uses['p1|ufs-poster']).toMatchObject({ viaTool: true, ts: Date.parse('2026-10-01T08:00:00Z') });
    expect(uses['p2|ufs-poster'].viaTool).toBe(false);
  });

  it('ignores non-assistant lines and broken JSON', () => {
    const uses: Record<string, SkillUse> = {};
    collectLine(toolResult('p1', 'cat .claude/skills/ufs-poster/SKILL.md'), 'p1', uses);
    collectLine('{"name":"Skill" broken', 'p1', uses);
    expect(uses).toEqual({});
  });
});

describe('botForCwd', () => {
  const bots = [
    { name: 'clarinsbot', workdir: '/p/clarins' },
    { name: 'clarinsredbot', workdir: '/p/clarinsred' },
    { name: 'nested', workdir: '/p/clarins/work' },
  ];
  it('matches the workdir itself and its subdirectories, longest wins', () => {
    expect(botForCwd('/p/clarins', bots)).toBe('clarinsbot');
    expect(botForCwd('/p/clarins/work-absplit', bots)).toBe('clarinsbot');
    expect(botForCwd('/p/clarins/work/x', bots)).toBe('nested');
  });
  it('does not confuse sibling dirs sharing a name prefix', () => {
    expect(botForCwd('/p/clarinsred', bots)).toBe('clarinsredbot');
    expect(botForCwd('/elsewhere', bots)).toBeNull();
  });
});

describe('scanTranscripts', () => {
  it('scans incrementally, tracks turns across appends, waits for partial lines, keeps history of deleted files', async () => {
    const root = tmp();
    mkdirSync(join(root, '-p-ufs', 'sess', 'subagents'), { recursive: true });
    const a = join(root, '-p-ufs', 'a.jsonl');
    const sub = join(root, '-p-ufs', 'sess', 'subagents', 'agent-1.jsonl');
    // Turn p1: Skill tool + the script run 3 times → one use.
    writeFileSync(
      a,
      userPrompt('p1') +
        skillCall('t1', 'ufs-poster') +
        bash('b1', 'python3 .claude/skills/ufs-poster/scripts/r.py') +
        toolResult('p1', 'ok') +
        bash('b2', 'python3 .claude/skills/ufs-poster/scripts/r.py') +
        bash('b3', 'python3 .claude/skills/ufs-poster/scripts/r.py'),
    );
    writeFileSync(sub, userPrompt('p9') + skillCall('t2', 'ufs-daily'));

    const cache = await scanTranscripts(root, emptyCache());
    expect(Object.keys(cache.uses).sort()).toEqual(['p1|ufs-poster', 'p9|ufs-daily']);
    expect(cache.files[a]).toMatchObject({ firstTs: Date.parse('2026-09-30T00:00:00.000Z'), cwd: '/p/ufs', promptId: 'p1' });

    // Appended assistant line with no new user line still belongs to turn p1.
    appendFileSync(a, bash('b4', 'cat .claude/skills/ufs-share/SKILL.md'));
    await scanTranscripts(root, cache);
    expect(cache.uses['p1|ufs-share']).toBeDefined();

    // New turn, written half-way: only counted once the line is complete.
    const partial = bash('b5', 'python3 .claude/skills/ufs-copy/scripts/c.py');
    appendFileSync(a, userPrompt('p2') + partial.slice(0, 40));
    await scanTranscripts(root, cache);
    expect(cache.uses['p2|ufs-copy']).toBeUndefined();
    appendFileSync(a, partial.slice(40));
    await scanTranscripts(root, cache);
    expect(cache.uses['p2|ufs-copy']?.viaTool).toBe(false);

    // A forked session copying history does not double count.
    writeFileSync(join(root, '-p-ufs', 'fork.jsonl'), userPrompt('p1') + skillCall('t1', 'ufs-poster'));
    await scanTranscripts(root, cache);
    expect(Object.keys(cache.uses)).toHaveLength(4);

    // Transcript cleanup deletes the file; its uses and coverage survive.
    unlinkSync(a);
    await scanTranscripts(root, cache);
    expect(cache.uses['p1|ufs-share']).toBeDefined();
    expect(coverageByBot(Object.values(cache.files), [{ name: 'UFSbot', workdir: '/p/ufs' }])).toEqual({
      UFSbot: '2026-09-30T00:00:00.000Z',
    });
  });
});

describe('aggregateUsage', () => {
  it('counts per bot/skill with 7/30-day windows, sessions, direct-only uses and last use', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    const day = 86400000;
    const uses: SkillUse[] = [
      { skill: 'ufs-poster', cwd: '/p/ufs', sessionId: 's1', ts: now - 1 * day, viaTool: true },
      { skill: 'ufs-poster', cwd: '/p/ufs/sub', sessionId: 's1', ts: now - 10 * day, viaTool: false },
      { skill: 'ufs-poster', cwd: '/p/ufs', sessionId: 's2', ts: now - 40 * day, viaTool: false },
      { skill: 'other', cwd: '/nowhere', sessionId: 's3', ts: now, viaTool: true },
    ];
    const out = aggregateUsage(uses, [{ name: 'UFSbot', workdir: '/p/ufs' }], now);
    expect(out).toEqual({
      UFSbot: {
        'ufs-poster': { total: 3, last7d: 1, last30d: 2, sessions: 2, direct: 2, lastUsedAt: new Date(now - day).toISOString() },
      },
    });
  });
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateRecalls,
  collectRecallLine,
  memoryReadsInCommand,
  memoryReadsInToolUse,
  type MemoryRecall,
} from '../src/api/memory-recall.js';
import { scanTranscriptsWith } from '../src/api/skill-usage.js';

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'memory-recall-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

const MEM = '/Users/x/.claude/projects/-p-ufs/memory';
const assistant = (blocks: unknown[], ts = '2026-10-01T08:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, cwd: '/p/ufs', sessionId: 's1', message: { content: blocks } }) + '\n';
const read = (id: string, file_path: string, ts?: string) => assistant([{ type: 'tool_use', id, name: 'Read', input: { file_path } }], ts);
const bash = (id: string, command: string, ts?: string) => assistant([{ type: 'tool_use', id, name: 'Bash', input: { command } }], ts);
const userPrompt = (promptId: string) =>
  JSON.stringify({ type: 'user', promptId, timestamp: '2026-09-30T00:00:00.000Z', cwd: '/p/ufs', sessionId: 's1', message: { content: 'hi' } }) + '\n';

describe('memoryReadsInCommand', () => {
  it('finds reads by full path, by bare name after cd, and via a dir variable', () => {
    expect(memoryReadsInCommand(`cat ${MEM}/a.md; grep -n x ~/.claude/projects/-p-vs/memory/b.md`)).toEqual([
      { project: '-p-ufs', file: 'a.md' },
      { project: '-p-vs', file: 'b.md' },
    ]);
    expect(memoryReadsInCommand(`cd ~/.claude/projects/-p-ufs/memory && sed -n '1,80p' a.md; grep -n "x" b.md c.md | head`)).toEqual([
      { project: '-p-ufs', file: 'a.md' },
      { project: '-p-ufs', file: 'b.md' },
      { project: '-p-ufs', file: 'c.md' },
    ]);
    expect(memoryReadsInCommand(`M=${MEM}; cat $M/a.md "$M/b.md"`)).toEqual([
      { project: '-p-ufs', file: 'a.md' },
      { project: '-p-ufs', file: 'b.md' },
    ]);
  });

  it('skips writes, heredoc bodies, MEMORY.md, globs and other directories', () => {
    const write = `cd ${MEM}; cat >> a.md <<'EOF'\nsee b.md\nEOF\nsed -i '' 's/x/y/' c.md && rm d.md; cat MEMORY.md`;
    expect(memoryReadsInCommand(write)).toEqual([]);
    expect(memoryReadsInCommand(`cd ${MEM} && grep -l x *.md && cat /p/ufs/README.md work/notes.md`)).toEqual([]);
    expect(memoryReadsInCommand('cat README.md')).toEqual([]);
  });

  it('only attributes bare names when a single memory dir is in play', () => {
    expect(memoryReadsInCommand(`ls ${MEM} ~/.claude/projects/-p-vs/memory; cat a.md`)).toEqual([]);
  });
});

describe('memoryReadsInToolUse', () => {
  it('counts Read/Grep of a memory file, not MEMORY.md, Edit or Write', () => {
    expect(memoryReadsInToolUse({ type: 'tool_use', name: 'Read', input: { file_path: `${MEM}/a.md` } })).toEqual([{ project: '-p-ufs', file: 'a.md' }]);
    expect(memoryReadsInToolUse({ type: 'tool_use', name: 'Grep', input: { pattern: 'x', path: `${MEM}/a.md` } })).toEqual([{ project: '-p-ufs', file: 'a.md' }]);
    expect(memoryReadsInToolUse({ type: 'tool_use', name: 'Read', input: { file_path: `${MEM}/MEMORY.md` } })).toEqual([]);
    expect(memoryReadsInToolUse({ type: 'tool_use', name: 'Edit', input: { file_path: `${MEM}/a.md` } })).toEqual([]);
    expect(memoryReadsInToolUse({ type: 'tool_use', name: 'Write', input: { file_path: `${MEM}/a.md` } })).toEqual([]);
  });
});

describe('collectRecallLine + aggregateRecalls', () => {
  it('counts one recall per turn per file and attributes it to the memory dir owner', () => {
    const uses: Record<string, MemoryRecall> = {};
    collectRecallLine(read('r1', `${MEM}/a.md`, '2026-10-01T08:00:05Z'), 'p1', uses);
    collectRecallLine(bash('b1', `cat ${MEM}/a.md`, '2026-10-01T08:00:00Z'), 'p1', uses);
    collectRecallLine(read('r2', `${MEM}/a.md`, '2026-09-01T08:00:00Z'), 'p0', uses);
    // Another bot reading UFS's memory still counts for UFS's file.
    collectRecallLine(read('r3', `${MEM}/b.md`), 'p2', uses);
    collectRecallLine('{"type":"assistant", broken /memory', 'p3', uses);
    expect(Object.keys(uses).sort()).toEqual(['p0|-p-ufs/a.md', 'p1|-p-ufs/a.md', 'p2|-p-ufs/b.md']);
    expect(uses['p1|-p-ufs/a.md'].ts).toBe(Date.parse('2026-10-01T08:00:00Z'));

    const stats = aggregateRecalls(Object.values(uses), [{ bot: 'UFSbot', memDir: MEM }], Date.parse('2026-10-05T00:00:00Z'));
    expect(stats.UFSbot['a.md']).toEqual({ total: 2, last7d: 1, last30d: 1, sessions: 1, lastRecalledAt: '2026-10-01T08:00:00.000Z' });
    expect(stats.UFSbot['b.md'].total).toBe(1);
    expect(aggregateRecalls(Object.values(uses), [{ bot: 'VSbot', memDir: '/Users/x/.claude/projects/-p-vs/memory' }])).toEqual({});
  });

  it('works through the shared incremental transcript scan', async () => {
    const root = tmp();
    mkdirSync(join(root, '-p-ufs'), { recursive: true });
    writeFileSync(join(root, '-p-ufs', 's.jsonl'), userPrompt('p1') + read('r1', `${MEM}/a.md`) + bash('b1', `cd ${MEM} && cat a.md b.md`));
    const cache = await scanTranscriptsWith(root, { version: 1, files: {}, uses: {} as Record<string, MemoryRecall> }, {
      markers: [Buffer.from('/memory')],
      collect: collectRecallLine,
    });
    expect(Object.keys(cache.uses).sort()).toEqual(['p1|-p-ufs/a.md', 'p1|-p-ufs/b.md']);
  });
});

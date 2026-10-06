import { describe, expect, it } from 'vitest';
import { buildFeed, memoryActivity, recentMemories, skillActivity, summarizePrompt, taskBreakdown, topSkills } from '../src/api/dashboard.js';

// Local-time timestamps keep the tests timezone-independent.
const at = (day: number, h: number) => new Date(2026, 9, day, h).getTime(); // Oct <day>

describe('taskBreakdown', () => {
  it('splits finished tasks into member requests and scheduled runs', () => {
    const b = taskBreakdown([
      { type: 'task_completed', botName: 'A', userId: 'scheduler', timestamp: 1 },
      { type: 'task_failed', botName: 'A', userId: 'scheduler', timestamp: 2 },
      { type: 'task_completed', botName: 'A', userId: 'ou_1', timestamp: 3 },
      { type: 'task_completed', botName: 'B', userId: 'ou_1', timestamp: 4 },
      { type: 'task_failed', botName: 'B', userId: 'ou_2', timestamp: 5 },
      { type: 'task_started', botName: 'B', userId: 'ou_3', timestamp: 6 }, // not finished
    ]);
    expect(b).toEqual({
      total: 5,
      members: 3,
      scheduled: 2,
      failed: 2,
      failedScheduled: 1,
      people: 2,
      perBot: { A: { members: 1, scheduled: 2, failed: 1 }, B: { members: 2, scheduled: 0, failed: 1 } },
    });
  });
});

describe('skillActivity', () => {
  it('counts uses per local day over the last 7 days and compares with the 7 before', () => {
    const now = at(14, 12);
    const a = skillActivity(
      [
        { bot: 'A', skill: 's', ts: at(14, 9) }, // today
        { bot: 'A', skill: 's', ts: at(8, 9) }, // first day of the window
        { bot: 'B', skill: 't', ts: at(8, 0) },
        { bot: 'B', skill: 't', ts: at(7, 23) }, // previous week
        { bot: 'B', skill: 't', ts: at(1, 0) }, // previous week, first day
        { bot: 'B', skill: 't', ts: at(1, 0) - 1 }, // older → ignored
      ],
      now,
    );
    expect(a.days[0]).toBe('2026-10-08');
    expect(a.days[6]).toBe('2026-10-14');
    expect(a.daily).toEqual([2, 0, 0, 0, 0, 0, 1]);
    expect(a.uses7d).toBe(3);
    expect(a.usesPrev7d).toBe(2);
    expect(a.perBot).toEqual({ A: 2, B: 1 });
  });
});

describe('memoryActivity', () => {
  it('separates new memories from updated ones in the last 7 days', () => {
    const now = at(14, 12);
    const iso = (t: number) => new Date(t).toISOString();
    const m = memoryActivity(
      [
        {
          bot: 'A',
          ratio: 0.5,
          files: [
            { exists: true, createdAt: iso(at(12, 9)), mtime: iso(at(13, 9)) }, // new
            { exists: true, createdAt: iso(at(1, 9)), mtime: iso(at(10, 9)) }, // updated
            { exists: true, createdAt: null, mtime: iso(at(11, 9)) }, // birth unknown → updated
            { exists: true, createdAt: iso(at(1, 9)), mtime: iso(at(2, 9)) }, // untouched
            { exists: false, createdAt: null, mtime: null }, // index entry without file
          ],
        },
        { bot: 'B', ratio: 0, files: [] },
      ],
      now,
    );
    expect(m).toEqual({
      total: 4,
      created7d: 1,
      updated7d: 2,
      perBot: { A: { count: 4, ratio: 0.5 }, B: { count: 0, ratio: 0 } },
    });
  });
});

describe('summarizePrompt', () => {
  it('uses a scheduled prompt\'s 【title】, else the first words', () => {
    expect(summarizePrompt('【每日群聊总结·自动发现(本 bot 自跑·静默)】你是 ELbot…')).toBe('每日群聊总结·自动发现(本 bot 自跑·静默)');
    expect(summarizePrompt('在吗')).toBe('在吗');
    expect(summarizePrompt('帮我  把这张\n图换个背景'.repeat(5), 10)).toBe('帮我 把这张 图换个…');
    expect(summarizePrompt(undefined)).toBe('');
  });
});

describe('buildFeed', () => {
  const now = at(14, 12);
  const ev = (type: string, botName: string, chatId: string, ts: number, extra: Record<string, unknown> = {}) => ({
    type,
    botName,
    chatId,
    timestamp: ts,
    userId: 'ou_1',
    prompt: '在吗',
    ...extra,
  });

  it('pairs starts with finishes per bot+chat, shows unfinished recent starts as running first', () => {
    const feed = buildFeed(
      [
        ev('task_started', 'A', 'c1', at(14, 9)),
        ev('task_completed', 'A', 'c1', at(14, 9) + 5000, { durationMs: 5000 }),
        ev('task_started', 'B', 'c2', at(14, 11)), // still running
        ev('task_started', 'C', 'c3', at(14, 8)), // started 4h ago, never finished → stale, hidden
        ev('task_failed', 'D', 'c4', at(14, 10), { userId: 'scheduler', prompt: '【日报】…', errorMessage: 'boom' }),
      ],
      now,
    );
    expect(feed.map((f) => [f.bot, f.status, f.source, f.summary])).toEqual([
      ['B', 'running', 'member', '在吗'],
      ['D', 'failed', 'scheduler', '日报'],
      ['A', 'done', 'member', '在吗'],
    ]);
    expect(feed[1].error).toBe('boom');
    expect(feed[2].durationMs).toBe(5000);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 30 }, (_, i) => ev('task_completed', 'A', `c${i}`, at(14, 9) + i));
    expect(buildFeed(many, now, 5)).toHaveLength(5);
  });
});

describe('topSkills', () => {
  it('ranks skills by uses, listing bots and whether it is a project skill', () => {
    const top = topSkills(
      [
        { bot: 'A', skill: 'ufs-poster' },
        { bot: 'A', skill: 'ufs-poster' },
        { bot: 'B', skill: 'lark-doc' },
        { bot: 'A', skill: 'lark-doc' },
        { bot: 'B', skill: 'dataviz' },
      ],
      { A: new Set(['ufs-poster']) },
      2,
    );
    expect(top).toEqual([
      { skill: 'lark-doc', count: 2, bots: ['A', 'B'], project: false },
      { skill: 'ufs-poster', count: 2, bots: ['A'], project: true },
    ]);
  });
});

describe('recentMemories', () => {
  it('lists the latest-touched memories across bots and flags new ones', () => {
    const now = at(14, 12);
    const iso = (t: number) => new Date(t).toISOString();
    const f = (file: string, mtime: number, created: number | null) => ({
      file,
      title: file,
      exists: true,
      mtime: iso(mtime),
      createdAt: created === null ? null : iso(created),
    });
    const out = recentMemories(
      [
        { bot: 'A', files: [f('a1.md', at(13, 9), at(13, 9)), f('a2.md', at(2, 9), at(1, 9))] },
        { bot: 'B', files: [f('b1.md', at(14, 10), at(1, 9)), { ...f('gone.md', at(14, 11), null), exists: false }] },
      ],
      now,
      2,
    );
    expect(out.map((m) => [m.bot, m.file, m.isNew])).toEqual([
      ['B', 'b1.md', false],
      ['A', 'a1.md', true],
    ]);
  });
});

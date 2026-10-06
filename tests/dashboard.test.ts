import { describe, expect, it } from 'vitest';
import { memoryActivity, skillActivity, taskBreakdown } from '../src/api/dashboard.js';

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

// Pin the zone so the UTC-vs-local rollover case is deterministic (the prod
// machine runs in Asia/Shanghai, UTC+8). Node honours runtime TZ changes.
process.env.TZ = 'Asia/Shanghai';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetManager } from '../src/api/budget-manager.js';

const logger = (() => {
  const l = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  l.child.mockReturnValue(l);
  return l;
})();

// Local wall-clock time on 2026-10-<day>.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);

let dir: string;
let dataPath: string;
let managers: BudgetManager[] = [];

function make(): BudgetManager {
  const m = new BudgetManager(logger, { dataPath });
  managers.push(m);
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  dataPath = path.join(dir, 'budgets.json');
});

afterEach(() => {
  for (const m of managers) m.destroy();
  managers = [];
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('BudgetManager daily rollover', () => {
  it('accumulates spend across calls within the same day', () => {
    const bm = make();
    vi.setSystemTime(at(6, 10));
    bm.recordCost('A', 1);
    vi.setSystemTime(at(6, 11));
    bm.recordCost('A', 2);
    bm.getAllBudgets();
    bm.getReport();
    vi.setSystemTime(at(6, 12));
    bm.recordCost('A', 3);

    const b = bm.getBudget('A')!;
    expect(b.todaySpent).toBe(6);
    expect(b.todayTasks).toBe(3);
    expect(b.history).toEqual([]);
  });

  it('enforces the daily limit once it is reached', () => {
    const bm = make();
    vi.setSystemTime(at(6, 10));
    bm.setLimit('A', 5);
    bm.recordCost('A', 3);
    expect(bm.canAcceptTask('A').allowed).toBe(true);
    bm.recordCost('A', 3);
    const check = bm.canAcceptTask('A');
    expect(check.allowed).toBe(false);
    expect(check.reason).toMatch(/exhausted/);
  });

  it('rolls over at local midnight, not at 00:00 UTC (08:00 in UTC+8)', () => {
    const bm = make();
    vi.setSystemTime(at(5, 23)); // Oct 5 local (15:00Z)
    bm.recordCost('A', 1);
    vi.setSystemTime(at(6, 7)); // Oct 6 local, still Oct 5 in UTC
    bm.recordCost('A', 2);
    vi.setSystemTime(at(6, 9)); // Oct 6 local and UTC
    bm.recordCost('A', 4);

    const b = bm.getBudget('A')!;
    expect(b.history).toEqual([{ date: '2026-10-05', costUsd: 1, taskCount: 1 }]);
    expect(b.todaySpent).toBe(6);
    expect(b.todayTasks).toBe(2);
    expect(b.day).toBe('2026-10-06');
  });

  it('stamps the history record with the day the spend happened, even after idle days', () => {
    const bm = make();
    vi.setSystemTime(at(1, 15));
    bm.recordCost('A', 2);
    vi.setSystemTime(at(6, 10));
    bm.recordCost('A', 1);

    const b = bm.getBudget('A')!;
    expect(b.history).toEqual([{ date: '2026-10-01', costUsd: 2, taskCount: 1 }]);
    expect(b.todaySpent).toBe(1);
  });

  it('weekly report sums the last 7 local days including today', () => {
    const bm = make();
    for (const d of [1, 5]) {
      vi.setSystemTime(at(d, 12));
      bm.recordCost('A', 10);
    }
    vi.setSystemTime(at(6, 12));
    bm.recordCost('A', 1);
    vi.setSystemTime(at(8, 0, 30)); // Oct 8 00:30 local: window is Oct 2..Oct 8
    bm.recordCost('A', 100);

    expect(bm.getReport('weekly').A).toEqual({ spent: 111, tasks: 3, limit: 0 });
    expect(bm.getReport('daily').A).toEqual({ spent: 100, tasks: 1, limit: 0 });
  });
});

describe('BudgetManager.recordTaskEvent', () => {
  it('records completed and failed tasks, ignores task_started', () => {
    const bm = make();
    vi.setSystemTime(at(6, 10));
    bm.recordTaskEvent({ type: 'task_started', botName: 'A' });
    bm.recordTaskEvent({ type: 'task_completed', botName: 'A', costUsd: 1.5 });
    bm.recordTaskEvent({ type: 'task_failed', botName: 'A', costUsd: 0.5 });
    bm.recordTaskEvent({ type: 'task_failed', botName: 'B' }); // failed before any spend

    expect(bm.getBudget('A')).toMatchObject({ todaySpent: 2, todayTasks: 2 });
    expect(bm.getBudget('B')).toMatchObject({ todaySpent: 0, todayTasks: 1 });
  });
});

describe('BudgetManager persistence', () => {
  it('persists the current day and reloads it', () => {
    vi.setSystemTime(at(6, 10));
    const bm = make();
    bm.recordCost('A', 2);
    bm.destroy(); // flushes the pending save

    const saved = JSON.parse(fs.readFileSync(dataPath, 'utf-8')).budgets[0];
    expect(saved).toMatchObject({ botName: 'A', day: '2026-10-06', todaySpent: 2, todayTasks: 1 });

    const reloaded = make();
    expect(reloaded.getBudget('A')).toMatchObject({ day: '2026-10-06', todaySpent: 2, todayTasks: 1 });
  });

  it('loads legacy files without `day`, attributing pending spend to the file mtime day', () => {
    fs.writeFileSync(dataPath, JSON.stringify({
      budgets: [{
        botName: 'VSbot', dailyLimitUsd: 0, todaySpent: 5.09, todayTasks: 1, paused: false,
        history: [{ date: '2026-08-04', costUsd: 1, taskCount: 1 }],
      }],
    }));
    const mtime = new Date(2026, 7, 19, 1, 52); // Aug 19 01:52 local
    fs.utimesSync(dataPath, mtime, mtime);

    vi.setSystemTime(at(6, 10));
    const bm = make();
    const b = bm.getBudget('VSbot')!;
    expect(b.history).toEqual([
      { date: '2026-08-04', costUsd: 1, taskCount: 1 },
      { date: '2026-08-19', costUsd: 5.09, taskCount: 1 },
    ]);
    expect(b).toMatchObject({ day: '2026-10-06', todaySpent: 0, todayTasks: 0 });
  });
});

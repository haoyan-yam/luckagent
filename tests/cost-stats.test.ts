import { describe, expect, it } from 'vitest';
import { buildCostTrend, localDay, type CostEvent } from '../src/api/cost-stats.js';

// All times built in local time, so the test is timezone-independent.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime(); // Oct <day>
const ev = (botName: string, ts: number, costUsd: number, type = 'task_completed'): CostEvent => ({ botName, type, costUsd, timestamp: ts });

describe('buildCostTrend', () => {
  const now = at(6, 13, 0); // Oct 6, 13:00

  it('buckets task events per bot into local days, oldest first', () => {
    const t = buildCostTrend(
      [
        ev('A', at(4, 9), 1.111),
        ev('A', at(6, 8), 2),
        ev('A', at(6, 9), 0, 'task_failed'),
        ev('B', at(5, 23, 59), 3),
        ev('A', at(6, 10), 99, 'task_started'), // not a task outcome
        ev('A', at(1, 10), 50), // outside the 3-day window
      ],
      3,
      now,
    );
    expect(t.days).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
    expect(t.byBot).toEqual({
      A: { tasks: [1, 0, 2], failed: [0, 0, 1], cost: [1.11, 0, 2] },
      B: { tasks: [0, 1, 0], failed: [0, 0, 0], cost: [0, 3, 0] },
    });
  });

  it('compares today with yesterday up to the same time of day', () => {
    const t = buildCostTrend(
      [
        ev('A', at(5, 9), 4), // yesterday, before 13:00 → counted
        ev('A', at(5, 12, 59), 1, 'task_failed'),
        ev('A', at(5, 20), 100), // yesterday evening → not "so far"
        ev('A', at(6, 11), 2.5),
      ],
      7,
      now,
    );
    expect(t.today).toEqual({ tasks: 1, failed: 0, costUsd: 2.5 });
    expect(t.yesterdaySoFar).toEqual({ tasks: 2, failed: 1, costUsd: 5 });
  });

  it('reports where stored data begins', () => {
    const earliest = new Date(2026, 8, 29, 10).getTime(); // Sep 29
    expect(buildCostTrend([], 7, now, earliest).dataSince).toBe('2026-09-29');
    expect(localDay(earliest)).toBe('2026-09-29');
    expect(buildCostTrend([], 7, now).dataSince).toBeNull();
  });
});

/**
 * Daily task / cost aggregation for the admin dashboard, built from the
 * activity store's task events. Days are LOCAL calendar days (same as the
 * dashboard's "today", which starts at local midnight).
 */

export interface CostEvent {
  botName: string;
  type: string;
  costUsd?: number;
  timestamp: number;
}

export interface BotDaily {
  tasks: number[];
  failed: number[];
  cost: number[];
}

export interface CostTrend {
  /** Local dates YYYY-MM-DD, oldest first; the last one is today. */
  days: string[];
  byBot: Record<string, BotDaily>;
  /** Today so far vs. yesterday up to the same time of day — a fair comparison before midnight. */
  today: { tasks: number; failed: number; costUsd: number };
  yesterdaySoFar: { tasks: number; failed: number; costUsd: number };
  /** Earliest event in the store — days before it have no data (not zero spend). */
  dataSince: string | null;
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function startOfLocalDay(ts: number, offsetDays = 0): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d.getTime();
}

const isTask = (e: CostEvent) => e.type === 'task_completed' || e.type === 'task_failed';
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Bucket task events into the last `days` local days. Exported for tests. */
export function buildCostTrend(
  events: Iterable<CostEvent>,
  days: number,
  now = Date.now(),
  earliest: number | null = null,
): CostTrend {
  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(localDay(startOfLocalDay(now, -i)));
  const index = new Map(dayList.map((d, i) => [d, i]));

  const todayStart = startOfLocalDay(now);
  const yesterdayStart = startOfLocalDay(now, -1);
  const sameTimeYesterday = yesterdayStart + (now - todayStart);
  const today = { tasks: 0, failed: 0, costUsd: 0 };
  const yesterdaySoFar = { tasks: 0, failed: 0, costUsd: 0 };

  const byBot: Record<string, BotDaily> = {};
  for (const e of events) {
    if (!isTask(e)) continue;
    const cost = e.costUsd || 0;
    const failed = e.type === 'task_failed' ? 1 : 0;
    if (e.timestamp >= todayStart && e.timestamp <= now) {
      today.tasks++;
      today.failed += failed;
      today.costUsd += cost;
    } else if (e.timestamp >= yesterdayStart && e.timestamp <= sameTimeYesterday) {
      yesterdaySoFar.tasks++;
      yesterdaySoFar.failed += failed;
      yesterdaySoFar.costUsd += cost;
    }
    const i = index.get(localDay(e.timestamp));
    if (i === undefined) continue;
    const b = (byBot[e.botName] ||= { tasks: Array(days).fill(0), failed: Array(days).fill(0), cost: Array(days).fill(0) });
    b.tasks[i]++;
    b.failed[i] += failed;
    b.cost[i] += cost;
  }
  for (const b of Object.values(byBot)) b.cost = b.cost.map(round2);
  today.costUsd = round2(today.costUsd);
  yesterdaySoFar.costUsd = round2(yesterdaySoFar.costUsd);
  return { days: dayList, byBot, today, yesterdaySoFar, dataSince: earliest !== null ? localDay(earliest) : null };
}

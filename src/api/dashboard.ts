/**
 * System-overview aggregates for the admin dashboard: how the bots are
 * running and what they accumulate — tasks by source, skill use, memory
 * growth. Pure builders; the route in admin-routes.ts gathers the inputs.
 *
 * Cost is deliberately absent: bots run on a Claude subscription, so
 * per-task cost is only an API-equivalent reference (shown elsewhere, muted).
 */

export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Activity rows the scheduler fires carry this userId; everything else came from a person. */
export const SCHEDULER_USER = 'scheduler';

export interface TaskEventLike {
  type: string;
  botName: string;
  userId?: string;
  timestamp: number;
}

export interface TaskBreakdown {
  total: number;
  /** Requests from group members (not the scheduler). */
  members: number;
  scheduled: number;
  failed: number;
  failedScheduled: number;
  /** Distinct people who asked something. */
  people: number;
  perBot: Record<string, { members: number; scheduled: number; failed: number }>;
}

/** Split finished tasks by who triggered them. Exported for tests. */
export function taskBreakdown(events: Iterable<TaskEventLike>): TaskBreakdown {
  const out: TaskBreakdown = { total: 0, members: 0, scheduled: 0, failed: 0, failedScheduled: 0, people: 0, perBot: {} };
  const people = new Set<string>();
  for (const e of events) {
    if (e.type !== 'task_completed' && e.type !== 'task_failed') continue;
    const scheduled = e.userId === SCHEDULER_USER;
    const failed = e.type === 'task_failed';
    const b = (out.perBot[e.botName] ||= { members: 0, scheduled: 0, failed: 0 });
    out.total++;
    if (scheduled) {
      out.scheduled++;
      b.scheduled++;
    } else {
      out.members++;
      b.members++;
      if (e.userId) people.add(e.userId);
    }
    if (failed) {
      out.failed++;
      b.failed++;
      if (scheduled) out.failedScheduled++;
    }
  }
  out.people = people.size;
  return out;
}

export interface SkillActivity {
  /** Local dates of the last 7 days, oldest first (last = today). */
  days: string[];
  daily: number[];
  uses7d: number;
  usesPrev7d: number;
  perBot: Record<string, number>;
}

/** Skill uses (turns) in the last 7 days vs. the 7 before. Exported for tests. */
export function skillActivity(uses: Iterable<{ bot: string; skill: string; ts: number }>, now = Date.now()): SkillActivity {
  const days: string[] = [];
  for (let i = 6; i >= 0; i--) days.push(localDay(now - i * DAY_MS));
  const index = new Map(days.map((d, i) => [d, i]));
  const daily = Array(7).fill(0) as number[];
  const perBot: Record<string, number> = {};
  let usesPrev7d = 0;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6); // start of the 7-day window (local)
  const prevStart = start.getTime() - 7 * DAY_MS;
  for (const u of uses) {
    if (u.ts >= start.getTime() && u.ts <= now) {
      const i = index.get(localDay(u.ts));
      if (i !== undefined) daily[i]++;
      perBot[u.bot] = (perBot[u.bot] ?? 0) + 1;
    } else if (u.ts >= prevStart && u.ts < start.getTime()) {
      usesPrev7d++;
    }
  }
  return { days, daily, uses7d: daily.reduce((a, b) => a + b, 0), usesPrev7d, perBot };
}

export interface MemoryFileLike {
  exists: boolean;
  mtime: string | null;
  createdAt: string | null;
}

export interface MemoryActivity {
  total: number;
  created7d: number;
  /** Changed in the last 7 days but created earlier (or creation time unknown). */
  updated7d: number;
  perBot: Record<string, { count: number; ratio: number }>;
}

/** Memory growth across bots; `ratio` = MEMORY.md load-limit usage. Exported for tests. */
export function memoryActivity(
  bots: Array<{ bot: string; files: MemoryFileLike[]; ratio: number }>,
  now = Date.now(),
): MemoryActivity {
  const out: MemoryActivity = { total: 0, created7d: 0, updated7d: 0, perBot: {} };
  const since = now - 7 * DAY_MS;
  for (const b of bots) {
    const files = b.files.filter((f) => f.exists);
    out.perBot[b.bot] = { count: files.length, ratio: b.ratio };
    out.total += files.length;
    for (const f of files) {
      const created = f.createdAt ? Date.parse(f.createdAt) : NaN;
      const modified = f.mtime ? Date.parse(f.mtime) : NaN;
      if (created >= since) out.created7d++;
      else if (modified >= since) out.updated7d++;
    }
  }
  return out;
}

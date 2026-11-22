/**
 * App-wide timezone. The host machine may sit in a different zone (e.g. a US
 * server) than the people using the bots (GMT+8), so every process pins
 * `process.env.TZ` to one configured IANA zone at startup. Child processes
 * (bot engine sessions, python scripts, `date`) inherit it.
 *
 * Source: LUCKAGENT_TIMEZONE > SCHEDULE_TIMEZONE (legacy) > Asia/Shanghai.
 * Use IANA names — NOT "GMT+8" (POSIX TZ strings invert the sign) and
 * NOT "Etc/GMT-8" unless you really mean it.
 */
export const FALLBACK_TIMEZONE = 'Asia/Shanghai';

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedTimezone {
  timezone: string;
  /** Where the value came from. */
  source: 'LUCKAGENT_TIMEZONE' | 'SCHEDULE_TIMEZONE' | 'default';
  /** Set when a configured value was rejected and we fell back. */
  invalid?: string;
}

export function resolveAppTimezone(env: NodeJS.ProcessEnv = process.env): ResolvedTimezone {
  for (const key of ['LUCKAGENT_TIMEZONE', 'SCHEDULE_TIMEZONE'] as const) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    if (isValidTimezone(raw)) return { timezone: raw, source: key };
    return { timezone: FALLBACK_TIMEZONE, source: 'default', invalid: `${key}=${raw}` };
  }
  return { timezone: FALLBACK_TIMEZONE, source: 'default' };
}

let applied: ResolvedTimezone | null = null;

/** Pin process.env.TZ to the app timezone. Idempotent; call right after env files load. */
export function applyAppTimezone(env: NodeJS.ProcessEnv = process.env): ResolvedTimezone {
  const r = resolveAppTimezone(env);
  if (r.invalid) {
    console.warn(`[luckagent] invalid timezone ${r.invalid}, falling back to ${r.timezone}`);
  }
  process.env.TZ = r.timezone;
  applied = r;
  return r;
}

/** The effective app timezone (resolves lazily if applyAppTimezone hasn't run). */
export function appTimezone(): string {
  return (applied ?? resolveAppTimezone()).timezone;
}

/** "+08:00"-style UTC offset of `tz` at `at`. */
export function utcOffsetLabel(tz: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value;
  // "GMT+08:00" / "GMT" (for UTC)
  const m = part?.match(/GMT([+-]\d{2}:\d{2})?/);
  return m?.[1] ?? '+00:00';
}

/** Host machine zone, captured before TZ was overridden (for diagnostics). */
export const HOST_TIMEZONE: string = (() => {
  const pre = process.env.TZ;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || pre || 'UTC';
  } catch {
    return pre || 'UTC';
  }
})();

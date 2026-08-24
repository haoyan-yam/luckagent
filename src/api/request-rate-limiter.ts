/**
 * In-memory per-IP request rate limiter for the bridge HTTP API.
 *
 * Two independent guards per client IP, both using a sliding 60s window:
 *
 *   1. Global request ceiling — blunts brute abuse (default 300 req/min).
 *   2. Failed-auth backoff — after N failed auth attempts (default 10) within
 *      the window, the IP is locked out (429) for a cooldown window. Successful
 *      auth never counts toward this and never triggers the lockout.
 *
 * No external dependencies — a plain sliding-window-of-timestamps per IP. The
 * bookkeeping Map is bounded by both a periodic sweep (drops idle entries) and
 * a hard LRU-style cap (evicts the oldest-seen entry when the cap is exceeded)
 * so a flood of unique source IPs cannot grow it unboundedly.
 *
 * Time is injectable (`now`) so the logic is deterministic under test.
 */

export interface RateLimiterConfig {
  /** Sliding window length in ms for both counters. Default 60_000. */
  windowMs?: number;
  /** Max total requests per IP per window before 429. Default 300. */
  maxRequests?: number;
  /** Failed-auth attempts per IP per window before lockout. Default 10. */
  maxAuthFails?: number;
  /** Lockout duration in ms once the auth-fail threshold is crossed. Default 60_000. */
  authLockoutMs?: number;
  /** Hard cap on tracked IPs before LRU eviction kicks in. Default 50_000. */
  maxEntries?: number;
  /** Globally disable the limiter (escape hatch). Default false. */
  disabled?: boolean;
  /** Injectable clock for tests. Default () => Date.now(). */
  now?: () => number;
}

interface IpEntry {
  /** Timestamps (ms) of recent requests within the window. */
  requests: number[];
  /** Timestamps (ms) of recent FAILED auth attempts within the window. */
  authFails: number[];
  /** If set and in the future, the IP is locked out until this time (ms). */
  lockedUntil: number;
  /** Last time this entry was touched — used for sweep + LRU eviction. */
  lastSeen: number;
}

export interface RateLimitDecision {
  /** True if the request should be rejected. */
  limited: boolean;
  /** HTTP status to return when limited (always 429). */
  status: 429;
  /** Seconds the caller should back off (Retry-After). */
  retryAfterSec: number;
  /** Machine-readable reason. */
  reason: 'global' | 'auth-lockout';
}

const DEFAULTS = {
  windowMs: 60_000,
  maxRequests: 300,
  maxAuthFails: 10,
  authLockoutMs: 60_000,
  maxEntries: 50_000,
};

export class RequestRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxAuthFails: number;
  private readonly authLockoutMs: number;
  private readonly maxEntries: number;
  private readonly disabled: boolean;
  private readonly now: () => number;
  private readonly entries = new Map<string, IpEntry>();
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(config: RateLimiterConfig = {}) {
    this.windowMs = config.windowMs ?? DEFAULTS.windowMs;
    this.maxRequests = config.maxRequests ?? DEFAULTS.maxRequests;
    this.maxAuthFails = config.maxAuthFails ?? DEFAULTS.maxAuthFails;
    this.authLockoutMs = config.authLockoutMs ?? DEFAULTS.authLockoutMs;
    this.maxEntries = config.maxEntries ?? DEFAULTS.maxEntries;
    this.disabled = config.disabled ?? false;
    this.now = config.now ?? (() => Date.now());
  }

  /**
   * Start a periodic sweep that drops idle entries. Call once after construction
   * when running inside a real server. The timer is unref'd so it never keeps
   * the process alive. No-op when disabled.
   */
  startSweep(intervalMs = 60_000): void {
    if (this.disabled || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }

  /** Number of tracked IPs (for tests / metrics). */
  size(): number {
    return this.entries.size;
  }

  private getOrCreate(ip: string, t: number): IpEntry {
    let entry = this.entries.get(ip);
    if (!entry) {
      entry = { requests: [], authFails: [], lockedUntil: 0, lastSeen: t };
      this.entries.set(ip, entry);
      this.enforceCap(ip);
    }
    return entry;
  }

  /** Evict the least-recently-seen entry when over the cap. */
  private enforceCap(except: string): void {
    if (this.entries.size <= this.maxEntries) return;
    let oldestKey: string | undefined;
    let oldest = Infinity;
    for (const [key, e] of this.entries) {
      if (key === except) continue;
      if (e.lastSeen < oldest) {
        oldest = e.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey) this.entries.delete(oldestKey);
  }

  private prune(arr: number[], cutoff: number): number[] {
    // Timestamps are appended in order, so drop from the front.
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    return i > 0 ? arr.slice(i) : arr;
  }

  /**
   * Record a request and decide whether it should be rejected. Call this on
   * EVERY non-exempt request, before auth is evaluated. Returns null to allow.
   */
  check(ip: string): RateLimitDecision | null {
    if (this.disabled) return null;
    const t = this.now();
    const cutoff = t - this.windowMs;
    const entry = this.getOrCreate(ip, t);
    entry.lastSeen = t;

    // Existing lockout still active?
    if (entry.lockedUntil > t) {
      return {
        limited: true,
        status: 429,
        retryAfterSec: Math.ceil((entry.lockedUntil - t) / 1000),
        reason: 'auth-lockout',
      };
    }

    entry.requests = this.prune(entry.requests, cutoff);
    entry.requests.push(t);

    if (entry.requests.length > this.maxRequests) {
      return {
        limited: true,
        status: 429,
        retryAfterSec: Math.ceil(this.windowMs / 1000),
        reason: 'global',
      };
    }
    return null;
  }

  /**
   * Record a FAILED auth attempt. If the threshold is crossed within the window,
   * the IP is locked out for the cooldown window. Returns the resulting decision
   * (so callers can immediately surface the lockout) or null if still under it.
   */
  recordAuthFailure(ip: string): RateLimitDecision | null {
    if (this.disabled) return null;
    const t = this.now();
    const cutoff = t - this.windowMs;
    const entry = this.getOrCreate(ip, t);
    entry.lastSeen = t;

    entry.authFails = this.prune(entry.authFails, cutoff);
    entry.authFails.push(t);

    if (entry.authFails.length >= this.maxAuthFails) {
      entry.lockedUntil = t + this.authLockoutMs;
      entry.authFails = []; // reset so a fresh window starts after cooldown
      return {
        limited: true,
        status: 429,
        retryAfterSec: Math.ceil(this.authLockoutMs / 1000),
        reason: 'auth-lockout',
      };
    }
    return null;
  }

  /**
   * Record a SUCCESSFUL auth — clears the failed-auth counter for the IP so a
   * legitimate client that mistyped a few times is never throttled once it
   * authenticates. Never triggers a lockout.
   */
  recordAuthSuccess(ip: string): void {
    if (this.disabled) return;
    const entry = this.entries.get(ip);
    if (entry) {
      entry.authFails = [];
      entry.lastSeen = this.now();
    }
  }

  /** Drop entries that have had no activity for two windows. */
  sweep(): void {
    const cutoff = this.now() - this.windowMs * 2;
    for (const [ip, entry] of this.entries) {
      if (entry.lastSeen < cutoff && entry.lockedUntil < this.now()) {
        this.entries.delete(ip);
      }
    }
  }
}

/** Build a limiter from environment variables with sane defaults. */
export function rateLimiterFromEnv(env: NodeJS.ProcessEnv = process.env): RequestRateLimiter {
  const num = (raw: string | undefined, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return new RequestRateLimiter({
    disabled: env.LUCKAGENT_RATE_LIMIT_DISABLED === '1',
    maxRequests: num(env.LUCKAGENT_RATE_LIMIT_MAX, DEFAULTS.maxRequests),
    maxAuthFails: num(env.LUCKAGENT_RATE_LIMIT_AUTH_FAILS, DEFAULTS.maxAuthFails),
  });
}

/**
 * Resolve the client IP for rate-limiting. We default to the socket's
 * remoteAddress because this bridge is typically NOT behind a trusted reverse
 * proxy — trusting X-Forwarded-For unconditionally would let any client spoof
 * its identity and evade the limiter. Only honour the FIRST X-Forwarded-For hop
 * when LUCKAGENT_TRUST_PROXY=1 is explicitly set by an operator who knows a
 * trusted proxy sits in front.
 */
export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxy = process.env.LUCKAGENT_TRUST_PROXY === '1',
): string {
  if (trustProxy && forwardedFor) {
    const raw = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const first = raw.split(',')[0]?.trim();
    if (first) return first;
  }
  return remoteAddress || 'unknown';
}

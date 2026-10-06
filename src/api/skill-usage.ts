/**
 * Skill usage stats — mined from Claude Code session transcripts.
 *
 * Bots use a skill in two ways, both visible as assistant `tool_use` blocks
 * in their `.jsonl` transcripts under ~/.claude/projects/<sanitized cwd>/:
 *   - the `Skill` tool (`{name: "Skill", input: {skill}}`);
 *   - directly — `cat .claude/skills/<name>/SKILL.md`, running
 *     `.claude/skills/<name>/scripts/*.py`, Read-ing its references. In
 *     practice this is the MAJORITY of project-skill use, so counting only
 *     Skill tool calls badly undercounts.
 *
 * One "use" = one user turn (prompt) that touched the skill, however many
 * tool calls it took — a single request running a skill's script 20 times
 * counts once. Turns are identified by the `promptId` stamped on user lines
 * (assistant lines inherit the most recent one in the same file).
 *
 * Scanning is incremental (byte offsets per append-only file). Uses are
 * cached in ~/.luckagent/skill-usage-cache.json keyed by turn+skill, which
 * de-dupes history copied into forked sessions and keeps stats after Claude
 * Code's transcript cleanup (cleanupPeriodDays) deletes old files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SkillUse {
  skill: string;
  cwd: string;
  sessionId: string;
  /** epoch ms of the first touch in the turn */
  ts: number;
  /** Turn invoked the skill through the Skill tool (vs. only direct reads/runs). */
  viaTool: boolean;
}

interface FileState {
  size: number;
  mtimeMs: number;
  /** Byte offset just past the last complete line already scanned. */
  offset: number;
  /** promptId of the last user line before `offset` — the turn in progress. */
  promptId: string | null;
  /** First record timestamp / cwd — bound per-bot coverage. Kept after the file is deleted. */
  firstTs: number | null;
  cwd: string | null;
}

export interface UsageCache {
  version: 2;
  files: Record<string, FileState>;
  uses: Record<string, SkillUse>;
}

export interface SkillUsageStat {
  /** Turns that used the skill. */
  total: number;
  last7d: number;
  last30d: number;
  sessions: number;
  /** Of `total`, turns that used it only directly (never via the Skill tool). */
  direct: number;
  lastUsedAt: string | null;
}

export interface SkillUsageSnapshot {
  scanning: boolean;
  lastScanAt: string | null;
  /** bot → earliest transcript record seen for it ("never used" means since then). */
  coverage: Record<string, string>;
  /** bot → skill → stat */
  usage: Record<string, Record<string, SkillUsageStat>>;
}

const MARKERS = [Buffer.from('"name":"Skill"'), Buffer.from('.claude/skills/')];
const PROMPT_ID = Buffer.from('"promptId":"');
const SKILL_PATH_RE = /\.claude\/skills\/([A-Za-z0-9][\w.-]*)/g;
const DAY_MS = 24 * 60 * 60 * 1000;

export function emptyCache(): UsageCache {
  return { version: 2, files: {}, uses: {} };
}

/** Skills a single tool_use block touches. Exported for tests. */
export function skillsInToolUse(block: any): Array<{ skill: string; viaTool: boolean }> {
  if (block?.type !== 'tool_use') return [];
  const out = new Map<string, boolean>();
  if (block.name === 'Skill' && typeof block.input?.skill === 'string' && block.input.skill) {
    out.set(block.input.skill, true);
  }
  const text = JSON.stringify(block.input ?? '');
  for (const m of text.matchAll(SKILL_PATH_RE)) {
    if (!out.has(m[1])) out.set(m[1], false);
  }
  return [...out].map(([skill, viaTool]) => ({ skill, viaTool }));
}

/** Record skill uses found on one assistant line into `uses`. Exported for tests. */
export function collectLine(line: string, promptId: string | null, uses: Record<string, SkillUse>): void {
  if (!MARKERS.some((m) => line.includes(m.toString()))) return;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  const content = rec?.message?.content;
  if (rec?.type !== 'assistant' || !Array.isArray(content)) return;
  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts) || typeof rec.cwd !== 'string') return;
  const sessionId = String(rec.sessionId || '');
  for (const block of content) {
    for (const { skill, viaTool } of skillsInToolUse(block)) {
      // No promptId (very old transcripts) → each tool call stands alone.
      const turn = promptId ?? `call:${block.id}`;
      const key = `${turn}|${skill}`;
      const prev = uses[key];
      if (prev) {
        prev.ts = Math.min(prev.ts, ts);
        prev.viaTool ||= viaTool;
      } else {
        uses[key] = { skill, cwd: rec.cwd, sessionId, ts, viaTool };
      }
    }
  }
}

function lastPromptIdIn(buf: Buffer): string | null {
  const i = buf.lastIndexOf(PROMPT_ID);
  if (i === -1) return null;
  const start = i + PROMPT_ID.length;
  const end = buf.indexOf(0x22, start); // closing quote
  return end === -1 ? null : buf.subarray(start, end).toString('utf8');
}

function readFileHead(file: string): { firstTs: number | null; cwd: string | null } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf8');
    const ts = Date.parse(head.match(/"timestamp":"([^"]+)"/)?.[1] ?? '');
    const cwd = head.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1];
    return { firstTs: Number.isFinite(ts) ? ts : null, cwd: cwd ? JSON.parse(`"${cwd}"`) : null };
  } catch {
    return { firstTs: null, cwd: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Scan complete lines from `start`, tracking the current turn's promptId.
 * Returns the offset past the last newline and the promptId in effect there.
 */
async function scanFileFrom(
  file: string,
  start: number,
  promptId: string | null,
  uses: Record<string, SkillUse>,
): Promise<{ offset: number; promptId: string | null }> {
  let offset = start;
  let pid = promptId;
  let pending: Buffer[] = [];
  const stream = fs.createReadStream(file, { start, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const nl = chunk.lastIndexOf(0x0a);
    if (nl === -1) {
      pending.push(chunk);
      continue;
    }
    const complete = pending.length ? Buffer.concat([...pending, chunk.subarray(0, nl + 1)]) : chunk.subarray(0, nl + 1);
    pending = nl + 1 < chunk.length ? [chunk.subarray(nl + 1)] : [];
    offset += complete.length;
    // Cheap byte-level prefilter: most chunks touch no skill — just carry the turn forward.
    if (!MARKERS.some((m) => complete.indexOf(m) !== -1)) {
      pid = lastPromptIdIn(complete) ?? pid;
      continue;
    }
    for (const line of complete.toString('utf8').split('\n')) {
      if (line.includes('"type":"user"')) {
        const m = line.match(/"promptId":"([^"]+)"/);
        if (m) pid = m[1];
      } else {
        collectLine(line, pid, uses);
      }
    }
  }
  return { offset, promptId: pid };
}

function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      // <project>/<session>.jsonl and <project>/<session>/subagents/*.jsonl
      if (e.isDirectory() && depth < 3 && e.name !== 'memory') walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Incrementally fold new transcript content into `cache` (mutated). Exported for tests. */
export async function scanTranscripts(root: string, cache: UsageCache): Promise<UsageCache> {
  for (const file of listJsonl(root)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const prev = cache.files[file];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) continue;
    // Transcripts are append-only; a shrunk file was rewritten → rescan whole.
    const resume = prev && st.size >= prev.offset;
    const head = resume ? { firstTs: prev.firstTs, cwd: prev.cwd } : readFileHead(file);
    try {
      const r = await scanFileFrom(file, resume ? prev.offset : 0, resume ? prev.promptId : null, cache.uses);
      cache.files[file] = { size: st.size, mtimeMs: st.mtimeMs, offset: r.offset, promptId: r.promptId, ...head };
    } catch {
      /* unreadable right now — retry next scan */
    }
  }
  // Entries of deleted files stay: tiny, and they keep each bot's coverage start.
  return cache;
}

/** Bot owning a cwd: longest workdir that equals or contains it. Exported for tests. */
export function botForCwd(cwd: string, bots: Array<{ name: string; workdir: string }>): string | null {
  let best: { name: string; len: number } | null = null;
  for (const b of bots) {
    const wd = b.workdir.replace(/\/+$/, '');
    if (cwd === wd || cwd.startsWith(`${wd}/`)) {
      if (!best || wd.length > best.len) best = { name: b.name, len: wd.length };
    }
  }
  return best?.name ?? null;
}

/** Aggregate cached uses into per-bot, per-skill stats. Exported for tests. */
export function aggregateUsage(
  uses: Iterable<SkillUse>,
  bots: Array<{ name: string; workdir: string }>,
  now = Date.now(),
): Record<string, Record<string, SkillUsageStat>> {
  const acc = new Map<string, { stat: SkillUsageStat; sessions: Set<string>; last: number }>();
  for (const u of uses) {
    const bot = botForCwd(u.cwd, bots);
    if (!bot) continue;
    const key = `${bot}\u0000${u.skill}`;
    let a = acc.get(key);
    if (!a) {
      a = { stat: { total: 0, last7d: 0, last30d: 0, sessions: 0, direct: 0, lastUsedAt: null }, sessions: new Set(), last: 0 };
      acc.set(key, a);
    }
    a.stat.total++;
    if (now - u.ts <= 7 * DAY_MS) a.stat.last7d++;
    if (now - u.ts <= 30 * DAY_MS) a.stat.last30d++;
    if (!u.viaTool) a.stat.direct++;
    if (u.sessionId) a.sessions.add(u.sessionId);
    if (u.ts > a.last) a.last = u.ts;
  }
  const out: Record<string, Record<string, SkillUsageStat>> = {};
  for (const [key, a] of acc) {
    const [bot, skill] = key.split('\u0000');
    (out[bot] ||= {})[skill] = { ...a.stat, sessions: a.sessions.size, lastUsedAt: a.last ? new Date(a.last).toISOString() : null };
  }
  return out;
}

/** Earliest transcript record per bot. Exported for tests. */
export function coverageByBot(
  files: Iterable<FileState>,
  bots: Array<{ name: string; workdir: string }>,
): Record<string, string> {
  const min = new Map<string, number>();
  for (const f of files) {
    if (f.firstTs === null || !f.cwd) continue;
    const bot = botForCwd(f.cwd, bots);
    if (bot && (!min.has(bot) || f.firstTs < min.get(bot)!)) min.set(bot, f.firstTs);
  }
  return Object.fromEntries([...min].map(([b, ts]) => [b, new Date(ts).toISOString()]));
}

/**
 * Process-wide tracker: serves the last result instantly and refreshes in the
 * background (first full scan of a few GB of transcripts takes a few seconds).
 */
export class SkillUsageTracker {
  private cache: UsageCache | null = null;
  private refreshing: Promise<void> | null = null;
  private lastScanAt: number | null = null;

  constructor(
    private readonly cachePath: string,
    private readonly projectsRoot: string,
    private readonly minIntervalMs = 60_000,
  ) {}

  private load(): UsageCache {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      // Older cache versions counted differently — rebuild from scratch.
      this.cache = parsed?.version === 2 && parsed.files && parsed.uses ? parsed : emptyCache();
    } catch {
      this.cache = emptyCache();
    }
    return this.cache!;
  }

  private persist(cache: UsageCache): void {
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      const tmp = `${this.cachePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache));
      fs.renameSync(tmp, this.cachePath);
    } catch {
      /* stats still served from memory */
    }
  }

  refresh(): Promise<void> {
    if (!this.refreshing) {
      const cache = this.load();
      this.refreshing = scanTranscripts(this.projectsRoot, cache)
        .then((c) => {
          this.persist(c);
          this.lastScanAt = Date.now();
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    return this.refreshing;
  }

  snapshot(bots: Array<{ name: string; workdir: string }>): SkillUsageSnapshot {
    const cache = this.load();
    if (!this.refreshing && (this.lastScanAt === null || Date.now() - this.lastScanAt > this.minIntervalMs)) {
      void this.refresh().catch(() => {});
    }
    return {
      scanning: this.refreshing !== null,
      lastScanAt: this.lastScanAt ? new Date(this.lastScanAt).toISOString() : null,
      coverage: coverageByBot(Object.values(cache.files), bots),
      usage: aggregateUsage(Object.values(cache.uses), bots),
    };
  }
}

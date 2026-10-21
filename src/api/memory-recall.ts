/**
 * Memory recall stats — how often bots actually read each auto-memory file,
 * mined from Claude Code session transcripts with the same incremental scan
 * as skill usage (see skill-usage.ts).
 *
 * MEMORY.md itself is loaded into every session, so it is never counted.
 * A memory file is only "recalled" when the bot reads it on purpose, which
 * shows up as an assistant `tool_use` block:
 *   - `Read` (or `Grep` with `path`) on `…/.claude/projects/<p>/memory/<f>.md`;
 *   - `Bash` that names the file — `cat`, `sed -n`, `grep … f.md`, `tail`,
 *     either by full path or by bare name after `cd …/memory` / `M=…/memory`.
 *     Writes don't count: redirect targets (`cat >> f.md`), `sed -i`, `rm`,
 *     `mv`, `cp`, `touch`, `tee`, and heredoc bodies are skipped.
 * Edit/Write are updates, not recalls. Transcripts also carry `file`
 * attachments of memory files, but those are Claude Code re-attaching
 * recently read files after context compaction — not new recalls.
 *
 * One recall = one user turn that read the file, however many times.
 */

import * as path from 'node:path';
import {
  coverageByBot,
  TranscriptScanStore,
  type LineCollector,
} from './skill-usage.js';

export interface MemoryRecall {
  /** Folder under ~/.claude/projects/ owning the memory dir (the reader may be another bot). */
  project: string;
  file: string;
  sessionId: string;
  /** epoch ms of the first read in the turn */
  ts: number;
}

export interface MemoryRecallStat {
  /** Turns that read the file. */
  total: number;
  last7d: number;
  last30d: number;
  sessions: number;
  lastRecalledAt: string | null;
}

export interface MemoryRecallSnapshot {
  scanning: boolean;
  lastScanAt: string | null;
  /** bot → earliest transcript record seen for it ("never recalled" means since then). */
  coverage: Record<string, string>;
  /** bot → memory file → stat */
  recall: Record<string, Record<string, MemoryRecallStat>>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MEM_FILE_PATH_RE = /\.claude\/projects\/([^/\s'"]+)\/memory\/([^/\s'"]+\.md)$/;
const MEM_DIR_RE = /\.claude\/projects\/([^/\s'"]+)\/memory(?![\w.-])/g;
const MEM_PREFIX_RE = /\.claude\/projects\/([^/\s'"]+)\/memory\/$/;
/** Optional redirect, then a path-ish prefix, then a `.md` leaf name. */
const MD_TOKEN_RE = /(>{1,2}\s*)?['"]?([^\s'"<>|;&()]*?)([^\s'"<>|;&()/=$*?]+\.md)(?![\w.-])/g;
const HEREDOC_RE = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g;
const WRITE_SEGMENT_RE = /^\s*(?:sudo\s+)?(?:rm|mv|cp|touch|tee|truncate|ln)\b|\bsed\s+(?:-\w+\s+)*-i/;

/** Memory files (project, file) a Bash command reads. Exported for tests. */
export function memoryReadsInCommand(command: string): Array<{ project: string; file: string }> {
  // Heredoc bodies are content being written (or a script), not files being read.
  const cmd = command.replace(HEREDOC_RE, '');
  const dirs = new Set([...cmd.matchAll(MEM_DIR_RE)].map((m) => m[1]));
  if (dirs.size === 0) return [];
  // Bare names (after `cd …/memory`, `$M/…`) are only attributable with one memory dir in play.
  const bareDir = dirs.size === 1 ? [...dirs][0] : null;
  const out = new Map<string, { project: string; file: string }>();
  for (const segment of cmd.split(/&&|\|\||[;\n|]/)) {
    if (WRITE_SEGMENT_RE.test(segment)) continue;
    for (const m of segment.matchAll(MD_TOKEN_RE)) {
      const [, redirect, prefix, file] = m;
      if (redirect || file === 'MEMORY.md') continue;
      const explicit = prefix.match(MEM_PREFIX_RE);
      const project = explicit
        ? explicit[1]
        : prefix === '' || prefix === './' || /^\$\{?\w+\}?\/$/.test(prefix)
          ? bareDir
          : null; // some other directory's .md
      if (project) out.set(`${project}/${file}`, { project, file });
    }
  }
  return [...out.values()];
}

/** Memory files a single tool_use block reads. Exported for tests. */
export function memoryReadsInToolUse(block: any): Array<{ project: string; file: string }> {
  if (block?.type !== 'tool_use') return [];
  const input = block.input ?? {};
  if (block.name === 'Read' || block.name === 'Grep') {
    const p = block.name === 'Read' ? input.file_path : input.path;
    const m = typeof p === 'string' ? p.match(MEM_FILE_PATH_RE) : null;
    return m && m[2] !== 'MEMORY.md' ? [{ project: m[1], file: m[2] }] : [];
  }
  if (block.name === 'Bash' && typeof input.command === 'string') return memoryReadsInCommand(input.command);
  return [];
}

/** Record memory recalls found on one assistant line into `uses`. Exported for tests. */
export function collectRecallLine(line: string, promptId: string | null, uses: Record<string, MemoryRecall>): void {
  if (!line.includes('/memory')) return;
  let rec: any;
  try {
    rec = JSON.parse(line);
  } catch {
    return;
  }
  const content = rec?.message?.content;
  if (rec?.type !== 'assistant' || !Array.isArray(content)) return;
  const ts = Date.parse(rec.timestamp);
  if (!Number.isFinite(ts)) return;
  const sessionId = String(rec.sessionId || '');
  for (const block of content) {
    for (const { project, file } of memoryReadsInToolUse(block)) {
      const turn = promptId ?? `call:${block.id}`;
      const key = `${turn}|${project}/${file}`;
      const prev = uses[key];
      if (prev) prev.ts = Math.min(prev.ts, ts);
      else uses[key] = { project, file, sessionId, ts };
    }
  }
}

const RECALL_COLLECTOR: LineCollector<MemoryRecall> = {
  markers: [Buffer.from('/memory')],
  collect: collectRecallLine,
};

/** Aggregate recalls into per-bot, per-file stats, by which bot owns the memory dir. Exported for tests. */
export function aggregateRecalls(
  uses: Iterable<MemoryRecall>,
  dirs: Array<{ bot: string; memDir: string }>,
  now = Date.now(),
): Record<string, Record<string, MemoryRecallStat>> {
  const botByProject = new Map(dirs.map((d) => [path.basename(path.dirname(d.memDir)), d.bot]));
  const acc = new Map<string, { stat: MemoryRecallStat; sessions: Set<string>; last: number }>();
  for (const u of uses) {
    const bot = botByProject.get(u.project);
    if (!bot) continue;
    const key = `${bot}\u0000${u.file}`;
    let a = acc.get(key);
    if (!a) {
      a = { stat: { total: 0, last7d: 0, last30d: 0, sessions: 0, lastRecalledAt: null }, sessions: new Set(), last: 0 };
      acc.set(key, a);
    }
    a.stat.total++;
    if (now - u.ts <= 7 * DAY_MS) a.stat.last7d++;
    if (now - u.ts <= 30 * DAY_MS) a.stat.last30d++;
    if (u.sessionId) a.sessions.add(u.sessionId);
    if (u.ts > a.last) a.last = u.ts;
  }
  const out: Record<string, Record<string, MemoryRecallStat>> = {};
  for (const [key, a] of acc) {
    const [bot, file] = key.split('\u0000');
    (out[bot] ||= {})[file] = { ...a.stat, sessions: a.sessions.size, lastRecalledAt: a.last ? new Date(a.last).toISOString() : null };
  }
  return out;
}

export class MemoryRecallTracker {
  private readonly store: TranscriptScanStore<MemoryRecall>;

  constructor(cachePath: string, projectsRoot: string, minIntervalMs = 60_000) {
    this.store = new TranscriptScanStore(cachePath, projectsRoot, 1, RECALL_COLLECTOR, minIntervalMs);
  }

  refresh(): Promise<void> {
    return this.store.refresh();
  }

  /** `bots` (physical workdirs) bound coverage; `dirs` map memory dirs to their owning bot. */
  snapshot(bots: Array<{ name: string; workdir: string }>, dirs: Array<{ bot: string; memDir: string }>): MemoryRecallSnapshot {
    const { cache, scanning, lastScanAt } = this.store.current();
    return {
      scanning,
      lastScanAt,
      coverage: coverageByBot(Object.values(cache.files), bots),
      recall: aggregateRecalls(Object.values(cache.uses), dirs),
    };
  }
}

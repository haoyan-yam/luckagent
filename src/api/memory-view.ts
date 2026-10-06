/**
 * Read-only views over a bot's Claude Code auto-memory directory
 * (~/.claude/projects/<sanitized workdir>/memory/): the MEMORY.md index,
 * per-file frontmatter, and index health against the CLI's load limits.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface MemoryIndexEntry { title: string; file: string; hook: string; }

/** Parse MEMORY.md lines of the form `- [Title](file.md) — hook`. */
export function parseMemoryIndex(indexRaw: string): MemoryIndexEntry[] {
  const out: MemoryIndexEntry[] = [];
  for (const line of indexRaw.split('\n')) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]{1,2}\s*(.*))?$/);
    if (m) out.push({ title: m[1].trim(), file: m[2].trim(), hook: (m[3] || '').trim() });
  }
  return out;
}

/**
 * Claude Code loads MEMORY.md into every session but truncates it past
 * 200 lines or 25,000 characters (JS string length of the trimmed text) —
 * the rest is silently invisible to the bot. Verified against the CLI
 * source (2.1.290: `dD=200, ete=25000`).
 */
export const MEMORY_INDEX_LIMITS = { lines: 200, chars: 25_000 } as const;

/** An index line longer than this is a paragraph, not a pointer. */
export const LONG_INDEX_LINE_CHARS = 150;

export interface MemoryFrontmatter {
  name: string;
  description: string;
  /** user | feedback | project | reference — top-level `type:` or under `metadata:`. */
  type: string;
}

export interface MemoryFileView {
  file: string;
  title: string;
  hook: string;
  /** Index-line characters attributed to this memory (shared lines split evenly; 0 if unindexed). */
  lineChars: number;
  indexed: boolean;
  exists: boolean;
  sizeBytes: number | null;
  mtime: string | null;
  frontmatter: MemoryFrontmatter | null;
}

export interface BotMemoryView {
  exists: boolean;
  memoryDir: string | null;
  index: { exists: boolean; lines: number; chars: number };
  files: MemoryFileView[];
}

const LINK_RE = /\[([^\]]+)\]\(<?([^)\s>]+\.md)>?\)/g;
const SEPARATORS_RE = /^[\s—–\-:：|｜·]+/;

/**
 * Memory links on one index line. Bots don't stick to `- [T](f.md) — hook`:
 * lines carry ⭐/⛔ markers, table rows, or several links at once
 * (`8月日报：[0831](a.md) ｜ [0828](b.md)`). A single-link line's hook is the
 * text after the link; on a multi-link line every link shares the whole
 * line, markdown stripped. Exported for tests.
 */
export function parseIndexLine(line: string): Array<{ title: string; file: string; hook: string }> {
  const links = [...line.matchAll(LINK_RE)];
  if (links.length === 0) return [];
  const file = (raw: string) => raw.replace(/^\.\//, '');
  if (links.length === 1) {
    const m = links[0];
    const hook = line.slice(m.index! + m[0].length).replace(SEPARATORS_RE, '').replace(/\s*\|\s*$/, '').trim();
    return [{ title: m[1].trim(), file: file(m[2]), hook }];
  }
  const flat = line
    .replace(LINK_RE, '$1')
    .replace(/^\s*[-*|]\s*/, '')
    .replace(/\*\*|`/g, '')
    .replace(/\s*\|\s*/g, ' | ')
    .trim();
  return links.map((m) => ({ title: m[1].trim(), file: file(m[2]), hook: flat }));
}

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Parse the YAML-ish frontmatter memories are written with. Exported for tests. */
export function parseMemoryFrontmatter(text: string): MemoryFrontmatter | null {
  const m = text.match(FRONTMATTER_RE);
  if (!m) return null;
  const fm: MemoryFrontmatter = { name: '', description: '', type: '' };
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^(\s*)(name|description|type):\s*(.*)$/);
    if (!kv) continue;
    const [, indent, key, value] = kv;
    // name/description only at top level; type may sit under `metadata:`.
    if (key === 'type') fm.type ||= unquote(value);
    else if (!indent) fm[key as 'name' | 'description'] = unquote(value);
  }
  return fm;
}

/** Strip frontmatter, returning the markdown body. Exported for tests. */
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, '').replace(/^\s+/, '');
}

function readHead(file: string, bytes = 4096): string {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Full read-only view of one memory directory. Exported for tests. */
export function readBotMemory(memDir: string | null): BotMemoryView {
  if (!memDir || !fs.existsSync(memDir)) {
    return { exists: false, memoryDir: null, index: { exists: false, lines: 0, chars: 0 }, files: [] };
  }
  let indexRaw: string | null = null;
  try {
    indexRaw = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8');
  } catch { /* no index */ }
  const trimmed = (indexRaw ?? '').trim();
  const index = {
    exists: indexRaw !== null,
    lines: trimmed ? trimmed.split('\n').length : 0,
    chars: trimmed.length,
  };

  const onDisk = new Map<string, fs.Stats>();
  try {
    for (const f of fs.readdirSync(memDir)) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      try { onDisk.set(f, fs.statSync(path.join(memDir, f))); } catch { /* raced away */ }
    }
  } catch { /* unreadable dir */ }

  const view = (file: string, st: fs.Stats | undefined) => ({
    exists: !!st,
    sizeBytes: st?.size ?? null,
    mtime: st?.mtime.toISOString() ?? null,
    frontmatter: st ? parseMemoryFrontmatter(readHead(path.join(memDir, file))) : null,
  });

  const files: MemoryFileView[] = [];
  const indexed = new Set<string>();
  for (const line of (indexRaw ?? '').split('\n')) {
    const entries = parseIndexLine(line);
    // A line grouping several memories costs each of them its share.
    const lineChars = entries.length ? Math.round(line.trim().length / entries.length) : 0;
    for (const entry of entries) {
      if (indexed.has(entry.file)) continue;
      indexed.add(entry.file);
      files.push({ ...entry, lineChars, indexed: true, ...view(entry.file, onDisk.get(entry.file)) });
    }
  }
  for (const [file, st] of onDisk) {
    if (indexed.has(file)) continue;
    files.push({ file, title: file.replace(/\.md$/, ''), hook: '', lineChars: 0, indexed: false, ...view(file, st) });
  }
  return { exists: true, memoryDir: memDir, index, files };
}

export interface MemorySearchHit {
  bot: string;
  file: string;
  /** Number of occurrences in the file. */
  matches: number;
  /** Text around the first occurrence, whitespace collapsed. */
  snippet: string;
}

const contentCache = new Map<string, { mtimeMs: number; text: string; lower: string }>();

function readCached(file: string): { text: string; lower: string } | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    contentCache.delete(file);
    return null;
  }
  const hit = contentCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit;
  try {
    const text = fs.readFileSync(file, 'utf-8');
    const entry = { mtimeMs: st.mtimeMs, text, lower: text.toLowerCase() };
    contentCache.set(file, entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * Case-insensitive full-text search over memory files (MEMORY.md excluded —
 * its lines are the hooks, already searchable client-side). A few MB in
 * total, so a linear scan with an mtime-keyed content cache is plenty.
 * Exported for tests.
 */
export function searchMemories(
  dirs: Array<{ bot: string; memDir: string }>,
  query: string,
  limit = 300,
): { hits: MemorySearchHit[]; truncated: boolean } {
  const q = query.trim().toLowerCase();
  const hits: MemorySearchHit[] = [];
  if (!q) return { hits, truncated: false };
  for (const { bot, memDir } of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort();
    } catch {
      continue;
    }
    for (const file of names) {
      const c = readCached(path.join(memDir, file));
      if (!c) continue;
      const first = c.lower.indexOf(q);
      if (first === -1) continue;
      if (hits.length >= limit) return { hits, truncated: true };
      let matches = 0;
      for (let i = first; i !== -1; i = c.lower.indexOf(q, i + q.length)) matches++;
      const start = Math.max(0, first - 40);
      const end = Math.min(c.text.length, first + q.length + 80);
      const snippet = `${start > 0 ? '…' : ''}${c.text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < c.text.length ? '…' : ''}`;
      hits.push({ bot, file, matches, snippet });
    }
  }
  return { hits, truncated: false };
}

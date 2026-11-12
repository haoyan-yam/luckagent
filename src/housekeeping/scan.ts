import * as fs from 'node:fs';
import * as path from 'node:path';
import { crc32 } from 'node:zlib';
import { expandUserPath } from '../config.js';
import type { HousekeepingRule } from './config.js';
import { compileGlobs, matchesAny } from './glob.js';
import { isZipJunk, readZipEntries } from './zip-index.js';

export interface Candidate {
  abs: string;
  /** Relative to the rule root, POSIX separators. */
  rel: string;
  size: number;
  mtimeMs: number;
  /**
   * When the file last changed on this machine: max(mtime, ctime). Unzip and
   * `cp -p` keep an old mtime, so material that arrived today can look months
   * old; ctime moves on arrival, rename, chmod or being opened — "age" uses this.
   */
  touchedMs: number;
}

const DAY = 86_400_000;

/** Walk a directory tree without following symlinks. Yields regular files. */
async function* walk(root: string, rel = ''): AsyncGenerator<{ abs: string; rel: string }> {
  let dir: fs.Dir;
  try {
    dir = await fs.promises.opendir(path.join(root, rel));
  } catch {
    return;
  }
  for await (const ent of dir) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) yield* walk(root, r);
    else if (ent.isFile()) yield { abs: path.join(root, r), rel: r.normalize('NFC') };
  }
}

/** Indexes and manifests that exist to find archived files again — never archive those. */
export function isBookkeeping(rel: string): boolean {
  const base = rel.split('/').pop() ?? rel;
  return base === '.feishu-index.tsv' || base === '归档清单.tsv' || /^_(?:pkl)?已归档.*\.tsv$/.test(base);
}

export function ruleRoot(rule: HousekeepingRule): string {
  return path.resolve(expandUserPath(rule.root));
}

/** Files that pass the rule's glob / age / size filter (before kind-specific checks). */
export async function listMatches(rule: HousekeepingRule, now = Date.now(), shouldStop?: () => boolean): Promise<Candidate[]> {
  const root = ruleRoot(rule);
  const inc = compileGlobs(rule.include);
  const exc = compileGlobs(rule.exclude);
  const cutoff = now - rule.minAgeDays * DAY;
  const minBytes = rule.minSizeMB * 1024 * 1024;
  const out: Candidate[] = [];
  for await (const f of walk(root)) {
    if (shouldStop?.()) break;
    if (isBookkeeping(f.rel) || !matchesAny(f.rel, inc) || matchesAny(f.rel, exc)) continue;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(f.abs);
    } catch {
      continue;
    }
    const touchedMs = Math.max(st.mtimeMs, st.ctimeMs);
    if (!st.isFile() || touchedMs >= cutoff || st.size < minBytes) continue;
    out.push({ abs: f.abs, rel: f.rel, size: st.size, mtimeMs: st.mtimeMs, touchedMs });
  }
  return out;
}

// ---------------------------------------------------------------------------
// codex-exec-sessions
// ---------------------------------------------------------------------------

/** True when a Codex rollout file was produced by `codex exec` (originator in the first event). */
export async function isCodexExecSession(abs: string): Promise<boolean> {
  let fh: fs.promises.FileHandle | undefined;
  try {
    fh = await fs.promises.open(abs, 'r');
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString('utf-8');
    return /"originator"\s*:\s*"codex_exec"/.test(head);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}

// ---------------------------------------------------------------------------
// extracted-zip
// ---------------------------------------------------------------------------

async function fileCrc32(abs: string): Promise<number> {
  let c = 0;
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 4 << 20 })) {
    c = crc32(chunk as Buffer, c);
  }
  return c >>> 0;
}

/**
 * Index of (basename, size) → paths for every non-zip file under one project,
 * built lazily and shared across all zips of that project.
 */
export class ProjectFileIndex {
  private cache = new Map<string, Map<string, string[]>>();
  private crcCache = new Map<string, number>();

  async forProject(projectDir: string): Promise<Map<string, string[]>> {
    let idx = this.cache.get(projectDir);
    if (idx) return idx;
    idx = new Map();
    for await (const f of walk(projectDir)) {
      if (f.rel.toLowerCase().endsWith('.zip')) continue;
      let size: number;
      try {
        size = (await fs.promises.lstat(f.abs)).size;
      } catch {
        continue;
      }
      const key = `${path.basename(f.rel)}\0${size}`;
      const list = idx.get(key);
      if (list) list.push(f.abs);
      else idx.set(key, [f.abs]);
    }
    this.cache.set(projectDir, idx);
    return idx;
  }

  async crc(abs: string): Promise<number> {
    let c = this.crcCache.get(abs);
    if (c === undefined) {
      c = await fileCrc32(abs);
      this.crcCache.set(abs, c);
    }
    return c;
  }
}

export interface ZipCheck {
  extracted: boolean;
  total: number;
  matched: number;
  missing: string[];
}

/**
 * A zip counts as extracted when every real entry (junk ignored) has a file of
 * the same basename, size and CRC-32 somewhere in the same project — the first
 * path segment under the rule root (or the root itself if the zip sits there).
 */
export async function checkExtractedZip(rule: HousekeepingRule, c: Candidate, index: ProjectFileIndex): Promise<ZipCheck> {
  const entries = readZipEntries(c.abs);
  if (!entries) return { extracted: false, total: 0, matched: 0, missing: ['（无法读取 zip 目录）'] };
  const root = ruleRoot(rule);
  const seg = c.rel.split('/');
  const projectDir = seg.length > 1 ? path.join(root, seg[0]) : root;
  const idx = await index.forProject(projectDir);
  let total = 0;
  let matched = 0;
  const missing: string[] = [];
  for (const e of entries) {
    if (isZipJunk(e.name, e.size)) continue;
    total++;
    const cands = idx.get(`${path.basename(e.name)}\0${e.size}`) ?? [];
    let ok = false;
    for (const p of cands) {
      if ((await index.crc(p)) === e.crc32) {
        ok = true;
        break;
      }
    }
    if (ok) matched++;
    else if (missing.length < 3) missing.push(e.name);
  }
  return { extracted: total > 0 && matched === total, total, matched, missing };
}

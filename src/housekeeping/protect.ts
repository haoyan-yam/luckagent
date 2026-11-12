import * as fs from 'node:fs';
import * as path from 'node:path';
import { expandUserPath } from '../config.js';
import { readBotsConfig } from '../api/bots-config-writer.js';
import { memoryDirCandidates, parseMemoryFrontmatter } from '../api/memory-view.js';

/**
 * Files a bot's memory (or CLAUDE.md) points at are working knowledge — a brand
 * book, a PPT master, a credentials deck — not stale clutter, however old they
 * are. Housekeeping never touches them.
 *
 * - Any memory / CLAUDE.md that names a concrete file protects that file.
 * - Long-lived memories (spec / ref / sop / deliverable / ppt / template, or
 *   frontmatter type `reference`) and CLAUDE.md also protect directories they
 *   name. Project logs don't: they mention every task folder they ever used,
 *   and protecting those would make work/ impossible to clean.
 */

const LONG_LIVED_PREFIXES = ['spec-', 'ref-', 'sop-', 'deliverable-', 'ppt-', 'template-'];
/** Inside `code spans` a path may contain spaces; bare tokens stop at whitespace and CJK punctuation. */
const CODE_SPAN = /`([^`\n]+)`/g;
const BARE = /(?:~\/|\/)?(?:[\w.\-\u4e00-\u9fff]+\/)*(?:inputs|outputs|work)\/[^\s`"'()（）「」『』，。、；：:*|<>[\]]+/g;
const SUBDIR = /(?:^|\/)(?:inputs|outputs|work)\//;
const CACHE_FILE = /\.(?:pkl|npy)$/i;

export interface Protection {
  /** abs file path → why */
  files: Map<string, string>;
  /** abs dir path (no trailing slash) → why */
  dirs: Map<string, string>;
  /** How many bots' memory was read — 0 means protection could not be established. */
  bots: number;
}

export function emptyProtection(): Protection {
  return { files: new Map(), dirs: new Map(), bots: 0 };
}

/** Candidate path strings mentioned in a markdown document. */
export function extractPathRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CODE_SPAN)) {
    const s = m[1].trim();
    if (SUBDIR.test(s)) out.add(s);
  }
  // Bare tokens: blank out code spans first so their pieces aren't re-read
  const bare = text.replace(CODE_SPAN, ' ');
  for (const m of bare.matchAll(BARE)) out.add(m[0]);
  return [...out].map((s) => s.replace(/[.,;:)）】」]+$/, ''));
}

/** Resolve a mentioned path against the bot's workdir; projects-relative forms like `samsclub/inputs/x` too. */
function resolveRef(ref: string, workDir: string): string[] {
  if (ref.startsWith('~/') || ref.startsWith('/')) return [path.resolve(expandUserPath(ref))];
  const cands = [path.resolve(workDir, ref), path.resolve(path.dirname(workDir), ref)];
  return [...new Set(cands)];
}

function isLongLived(file: string, text: string): boolean {
  const base = path.basename(file);
  if (base === 'CLAUDE.md') return true;
  if (LONG_LIVED_PREFIXES.some((p) => base.startsWith(p))) return true;
  return parseMemoryFrontmatter(text)?.type === 'reference';
}

/** Add every file/dir referenced by one document. */
export function protectFromDocument(prot: Protection, docPath: string, text: string, workDir: string, label: string, forceLongLived = false): void {
  const longLived = forceLongLived || isLongLived(docPath, text);
  for (const ref of extractPathRefs(text.normalize('NFC'))) {
    for (const abs of resolveRef(ref, workDir)) {
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const why = `${label} 引用`;
      // Analysis logs cite their pkl/npy caches all the time; pinning those would
      // switch the cache rule off. Only long-lived docs can pin a cache file.
      if (st.isFile() && CACHE_FILE.test(abs) && !longLived) continue;
      if (st.isFile()) {
        if (!prot.files.has(abs)) prot.files.set(abs, why);
      } else if (st.isDirectory() && longLived) {
        const d = abs.replace(/\/+$/, '');
        if (d !== workDir && !/\/(inputs|outputs|work)$/.test(d) && !prot.dirs.has(d)) prot.dirs.set(d, why);
      }
    }
  }
}

const SCRIPT_EXT = /\.(?:py|sh|js|mjs|cjs|ts)$/i;
const SCRIPT_ACTIVE_DAYS = 60;
const SCRIPT_MAX_BYTES = 1 << 20;
/** Quoted string literals that name a file with an extension; f-strings / templates are skipped. */
const STRING_LIT = /(["'])((?:(?!\1)[^\n{}$])+?\.[A-Za-z0-9]{2,5})\1/g;

function* walkFiles(dir: string, skip: (name: string) => boolean): Generator<string> {
  let ents: fs.Dirent[];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    if (skip(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, skip);
    else if (e.isFile()) yield p;
  }
}

/**
 * Scripts the bot is still using (changed within 60 days) protect the files they
 * open by literal path — template decks, base images, masks. Caches are left to
 * the cache rule's keep-latest-per-series instead.
 */
export function protectFromScripts(prot: Protection, workDir: string, botName: string, now = Date.now()): void {
  const cutoff = now - SCRIPT_ACTIVE_DAYS * 86_400_000;
  const skip = (n: string) => n === 'node_modules' || n === '.git' || n === '__pycache__' || n === '.venv' || n === 'venv';
  for (const script of walkFiles(path.join(workDir, 'work'), skip)) {
    if (!SCRIPT_EXT.test(script)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(script);
    } catch {
      continue;
    }
    if (Math.max(st.mtimeMs, st.ctimeMs) < cutoff || st.size > SCRIPT_MAX_BYTES) continue;
    const text = fs.readFileSync(script, 'utf-8');
    const why = `${botName} 脚本 ${path.relative(workDir, script)} 使用`;
    for (const m of text.matchAll(STRING_LIT)) {
      const lit = m[2].trim();
      if (CACHE_FILE.test(lit)) continue;
      const cands = lit.startsWith('~/') || lit.startsWith('/') ? [path.resolve(expandUserPath(lit))] : [path.resolve(path.dirname(script), lit), path.resolve(workDir, lit)];
      for (const abs of cands) {
        if (prot.files.has(abs)) continue;
        try {
          if (fs.statSync(abs).isFile()) prot.files.set(abs, why);
        } catch {
          /* not a file */
        }
      }
    }
  }
}

/** Project skills are reference material by nature: everything they mention is kept, dirs included. */
function skillDocs(workDir: string): string[] {
  return [...walkFiles(path.join(workDir, '.claude', 'skills'), (n) => n === 'node_modules' || n === '.git')].filter((f) => f.endsWith('.md'));
}

/** Scan every bot's memory dir, CLAUDE.md, project skills and active scripts. */
export function buildProtection(botsConfigPath?: string, now = Date.now()): Protection {
  const prot = emptyProtection();
  let bots: Array<{ name: string; workDir: string }> = [];
  try {
    const cfgPath = botsConfigPath ?? (process.env.BOTS_CONFIG ? path.resolve(process.env.BOTS_CONFIG) : undefined);
    if (cfgPath) {
      bots = (readBotsConfig(cfgPath).feishuBots || [])
        .filter((b) => b.defaultWorkingDirectory)
        .map((b) => ({ name: b.name, workDir: path.resolve(expandUserPath(b.defaultWorkingDirectory!)) }));
    }
  } catch {
    /* unreadable bots.json → no bot-level protection, but the scan still runs */
  }
  prot.bots = bots.length;
  for (const b of bots) {
    const docs: string[] = [path.join(b.workDir, 'CLAUDE.md')];
    const memDir = memoryDirCandidates(b.workDir).find((d) => fs.existsSync(d));
    if (memDir) {
      for (const f of fs.readdirSync(memDir)) if (f.endsWith('.md')) docs.push(path.join(memDir, f));
    }
    for (const doc of docs) {
      let text: string;
      try {
        text = fs.readFileSync(doc, 'utf-8');
      } catch {
        continue;
      }
      const label = path.basename(doc) === 'CLAUDE.md' ? `${b.name} 的 CLAUDE.md` : `${b.name} 记忆 ${path.basename(doc, '.md')}`;
      protectFromDocument(prot, doc, text, b.workDir, label);
    }
    for (const doc of skillDocs(b.workDir)) {
      let text: string;
      try {
        text = fs.readFileSync(doc, 'utf-8');
      } catch {
        continue;
      }
      const skill = path.relative(path.join(b.workDir, '.claude', 'skills'), doc).split(path.sep)[0];
      protectFromDocument(prot, doc, text, b.workDir, `${b.name} 技能 ${skill}`, true);
    }
    protectFromScripts(prot, b.workDir, b.name, now);
  }
  return prot;
}

/** Why `abs` must be kept, or null. */
export function protectedReason(prot: Protection, abs: string): string | null {
  const f = prot.files.get(abs);
  if (f) return f;
  for (const [d, why] of prot.dirs) if (abs.startsWith(d + path.sep)) return why;
  return null;
}

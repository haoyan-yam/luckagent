import * as fs from 'node:fs';
import * as path from 'node:path';
import { COMPAT_PROVIDERS, DEEPSEEK_KNOWN_MODELS } from '../engines/claude/auth-env.js';

/**
 * Global defaults the admin console may edit in .env. Deliberately a closed
 * whitelist with per-key value validation — the console must never become a
 * generic ".env editor" (API_SECRET, API keys, ports stay terminal-only).
 * An empty string always means "unset": the built-in default applies.
 */
export const ENGINE_VALUES = ['claude', 'deepseek', 'minimax'] as const;
export const IMAGE_GEN_VALUES = ['codex', 'seedream'] as const;

// Model ids like claude-opus-5, claude-fable-5-1[1m], us.anthropic.claude-…:0
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/;

// Volcengine credentials / names. Charsets are deliberately narrow: nothing
// that could break out of a .env line (no whitespace, quotes, '#', newlines).
const ARK_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,255}$/;
const TOS_AK_RE = /^[A-Za-z0-9]{8,128}$/;
const TOS_SK_RE = /^[A-Za-z0-9+/=]{8,256}$/;
const TOS_BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const TOS_REGION_RE = /^[a-z]{2,}(-[a-z0-9]+)+$/;

export const EDITABLE_DEFAULTS: Record<string, (v: string) => boolean> = {
  LUCKAGENT_ENGINE: (v) => (ENGINE_VALUES as readonly string[]).includes(v),
  CLAUDE_MODEL: (v) => MODEL_ID_RE.test(v),
  DEEPSEEK_MODEL: (v) => DEEPSEEK_KNOWN_MODELS.includes(v),
  MINIMAX_MODEL: (v) => COMPAT_PROVIDERS.minimax.models.some((m) => m.id === v),
  IMAGE_GEN_PROVIDER: (v) => (IMAGE_GEN_VALUES as readonly string[]).includes(v),
  // 视频生成（seedance-video）：方舟 key 与 Seedream 生图共用；TOS 只用于本地参考视频/音频
  ARK_API_KEY: (v) => ARK_KEY_RE.test(v),
  TOS_ACCESS_KEY: (v) => TOS_AK_RE.test(v),
  TOS_SECRET_KEY: (v) => TOS_SK_RE.test(v),
  TOS_BUCKET: (v) => TOS_BUCKET_RE.test(v),
  TOS_REGION: (v) => TOS_REGION_RE.test(v),
};

/** Write-only keys: the console may set or clear them but never reads them back. */
export const SECRET_DEFAULTS: ReadonlySet<string> = new Set(['ARK_API_KEY', 'TOS_ACCESS_KEY', 'TOS_SECRET_KEY']);

/** What the console may see of a value: secrets reduced to a `••••tail` hint. */
export function displayDefault(key: string, value: string): string {
  if (!value || !SECRET_DEFAULTS.has(key)) return value;
  return `••••${value.slice(-4)}`;
}

export type DefaultsUpdate = Record<string, string>;

/** Validate a PUT body. Unknown keys and bad values are errors, never silently dropped. */
export function validateDefaultsUpdate(body: unknown): { updates: DefaultsUpdate } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be an object' };
  const updates: DefaultsUpdate = {};
  for (const [key, raw] of Object.entries(body as Record<string, unknown>)) {
    const check = EDITABLE_DEFAULTS[key];
    if (!check) return { error: `Not editable from the console: ${key}` };
    if (typeof raw !== 'string') return { error: `${key} must be a string` };
    const value = raw.trim();
    if (value !== '' && !check(value)) {
      // never echo a rejected secret back
      return { error: `Invalid value for ${key}${SECRET_DEFAULTS.has(key) ? '' : `: ${value}`}` };
    }
    updates[key] = value;
  }
  if (Object.keys(updates).length === 0) return { error: 'Nothing to update' };
  return { updates };
}

/**
 * Apply updates to .env text, touching only the affected lines:
 * - value set: replace the first active `KEY=` line (later duplicates are
 *   dropped — dotenv lets the last one win), else the first `# KEY=` template
 *   line, else append;
 * - value '': comment out every active `KEY=` line as `# KEY=`.
 */
export function applyEnvUpdates(content: string, updates: DefaultsUpdate): string {
  const hadTrailingNewline = content.endsWith('\n');
  let lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  for (const [key, value] of Object.entries(updates)) {
    const active = new RegExp(`^\\s*${key}\\s*=`);
    const commented = new RegExp(`^#\\s*${key}\\s*=`);
    const activeIdx = lines.map((l, i) => (active.test(l) ? i : -1)).filter((i) => i >= 0);
    if (value === '') {
      lines = lines.map((l, i) => (activeIdx.includes(i) ? `# ${key}=` : l));
      continue;
    }
    const line = `${key}=${value}`;
    if (activeIdx.length > 0) {
      const [first, ...rest] = activeIdx;
      lines[first] = line;
      lines = lines.filter((_, i) => !rest.includes(i));
      continue;
    }
    const tmplIdx = lines.findIndex((l) => commented.test(l));
    if (tmplIdx >= 0) lines[tmplIdx] = line;
    else lines.push(line);
  }
  return lines.join('\n') + (hadTrailingNewline || lines.length > 0 ? '\n' : '');
}

/** Write .env atomically (temp file + rename), keeping the original file mode (0600). */
export function writeEnvUpdates(envPath: string, updates: DefaultsUpdate): void {
  let content = '';
  let mode = 0o600;
  try {
    content = fs.readFileSync(envPath, 'utf-8');
    mode = fs.statSync(envPath).mode & 0o777;
  } catch {
    /* missing .env: create it */
  }
  const next = applyEnvUpdates(content, updates);
  const tmp = path.join(path.dirname(envPath), `.env.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, next, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, envPath);
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type * as http from 'node:http';
import { readBotsConfig } from '../bots-config-writer.js';
import { expandUserPath } from '../../config.js';
import { resolveEngineName } from '../../engines/index.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

/**
 * Admin-console backend endpoints (all under /admin/api/*, Bearer-gated by the
 * global auth check in http-server.ts — deliberately NOT in the cross-verify
 * allowlist, so only the local API secret can reach them).
 */

const LOG_LINE_CAP = 1000;
const LOG_TAIL_BYTES = 512 * 1024;
const FEISHU_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';

let lastRestartRequestAt = 0;

function startTimeMs(): number {
  const t = (globalThis as any).__luckagent_start_time;
  return typeof t === 'number' ? t : Date.now();
}

function pkgVersion(): string {
  try {
    const pkgPath = path.resolve(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function coreUrl(): string {
  return (process.env.LUCKAGENT_CORE_URL || 'http://localhost:9200').trim().replace(/\/+$/, '');
}

/** Tail up to `lines` lines from a log file, reading at most the last 512 KB. */
export function tailLogFile(absPath: string, lines: number): { lines: string[]; truncated: boolean } {
  let fd: number;
  try {
    fd = fs.openSync(absPath, 'r');
  } catch {
    return { lines: [], truncated: false };
  }
  try {
    const stat = fs.fstatSync(fd);
    const readLen = Math.min(stat.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
    let text = buf.toString('utf-8');
    const truncatedByBytes = stat.size > LOG_TAIL_BYTES;
    if (truncatedByBytes) {
      // Drop the (likely partial) first line.
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    const all = text.split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    const capped = Math.min(Math.max(1, lines), LOG_LINE_CAP);
    return { lines: all.slice(-capped), truncated: truncatedByBytes || all.length > capped };
  } finally {
    fs.closeSync(fd);
  }
}

function todayStartMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function probeCore(): Promise<{ up: boolean; uptime?: number; version?: string }> {
  try {
    const resp = await fetch(`${coreUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return { up: false };
    const body = (await resp.json()) as { uptime?: number; version?: string };
    return { up: true, uptime: body.uptime, version: body.version };
  } catch {
    return { up: false };
  }
}

function pm2Jlist(): Promise<{ available: boolean; apps?: Array<Record<string, unknown>> }> {
  return new Promise((resolve) => {
    execFile('pm2', ['jlist'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ available: false });
      try {
        const raw = JSON.parse(stdout) as Array<Record<string, any>>;
        const apps = raw.map((a) => {
          const e = a.pm2_env || {};
          const monit = a.monit || {};
          return {
            name: a.name,
            pid: a.pid || null,
            status: e.status,
            restarts: e.restart_time,
            uptimeMs: e.pm_uptime ? Date.now() - e.pm_uptime : null,
            memoryMb: monit.memory ? Math.round((monit.memory / 1024 / 1024) * 10) / 10 : null,
            cpu: monit.cpu ?? null,
          };
        });
        resolve({ available: true, apps });
      } catch {
        resolve({ available: false });
      }
    });
  });
}

/** Effective-config view: whitelisted, secrets reduced to set/tail hints. */
function effectiveConfig(ctx: RouteContext): Record<string, unknown> {
  const claudeCliInstalled = (): boolean => {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try { fs.accessSync(path.join(dir, 'claude'), fs.constants.X_OK); return true; } catch { /* next */ }
    }
    return false;
  };
  // Subscription-login state as cached by the Claude CLI in ~/.claude.json
  // (refreshed whenever claude runs — profileFetchedAt tells how fresh).
  const claudeAuthStatus = () => {
    const cliInstalled = claudeCliInstalled();
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8'));
      const oa = raw?.oauthAccount;
      if (!oa || typeof oa !== 'object') return { cliInstalled, loggedIn: false };
      return {
        cliInstalled,
        loggedIn: true,
        email: typeof oa.emailAddress === 'string' ? oa.emailAddress : undefined,
        billingType: typeof oa.billingType === 'string' ? oa.billingType : undefined,
        seatTier: typeof oa.seatTier === 'string' ? oa.seatTier : undefined,
        rateLimitTier: typeof oa.userRateLimitTier === 'string' ? oa.userRateLimitTier : undefined,
        hasAvailableSubscription: typeof raw.hasAvailableSubscription === 'boolean' ? raw.hasAvailableSubscription : undefined,
        trialEndsAt: typeof oa.claudeCodeTrialEndsAt === 'string' ? oa.claudeCodeTrialEndsAt : undefined,
        profileFetchedAt: typeof oa.profileFetchedAt === 'string' ? oa.profileFetchedAt : undefined,
      };
    } catch {
      return { cliInstalled, loggedIn: false };
    }
  };
  const readCoreTokenFile = (): string | undefined => {
    try {
      const v = fs.readFileSync(path.join(os.homedir(), '.luckagent-core', 'token'), 'utf-8').trim();
      return v || undefined;
    } catch {
      return undefined;
    }
  };
  const secretHint = (v: string | undefined) =>
    v ? { set: true, tail: v.slice(-4) } : { set: false };
  const stateDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
  return {
    ports: {
      apiPort: parseInt(process.env.API_PORT || '9100', 10),
      apiHost: process.env.LUCKAGENT_API_HOST?.trim() || '127.0.0.1',
      coreUrl: coreUrl(),
    },
    paths: {
      home: process.cwd(),
      botsConfig: ctx.botsConfigPath || null,
      stateDir,
      logsDir: path.resolve(process.cwd(), 'logs'),
      outputsBaseDir: process.env.OUTPUTS_BASE_DIR || path.join(os.tmpdir(), `luckagent-outputs-${os.userInfo().username}`),
    },
    engineDefaults: {
      claudeModel: process.env.CLAUDE_MODEL || null,
      claudeBackend: process.env.CLAUDE_BACKEND === 'sdk' ? 'sdk' : 'pty',
      scheduleTimezone: process.env.SCHEDULE_TIMEZONE || null,
    },
    credentials: {
      apiSecret: secretHint(process.env.API_SECRET),
      anthropicApiKey: secretHint(process.env.ANTHROPIC_API_KEY),
      openaiApiKey: secretHint(process.env.OPENAI_API_KEY),
      // image-gen resolves OPENAI_IMAGE_API_KEY first, then OPENAI_API_KEY —
      // show the dedicated var so the installer-written key is visible.
      openaiImageApiKey: secretHint(process.env.OPENAI_IMAGE_API_KEY),
      // Token resolution is file-first (~/.luckagent-core/token, written by
      // the installer) with the env var as fallback — mirror that so a
      // normally-installed machine doesn't read as 未配置.
      coreToken: secretHint(process.env.LUCKAGENT_CORE_TOKEN || readCoreTokenFile()),
      deepseekApiKey: secretHint(process.env.DEEPSEEK_API_KEY),
      minimaxApiKey: secretHint(process.env.MINIMAX_API_KEY),
      arkApiKey: secretHint(process.env.ARK_API_KEY),
      volcengineTts: secretHint(process.env.VOLCENGINE_TTS_ACCESS_KEY),
      elevenlabs: secretHint(process.env.ELEVENLABS_API_KEY),
    },
    claudeAuth: claudeAuthStatus(),
  };
}


// ---------------------------------------------------------------------------
// Skills & auto-memory read-only viewers (admin console 「技能」「记忆」 pages)
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  description: string;
  kind: 'dir' | 'symlink' | 'git';
  updatedAt: string | null;
}

/** First `description:` from SKILL.md frontmatter; falls back to the first
 *  non-frontmatter, non-heading paragraph line. Exported for tests. */
export function readSkillDescription(skillDir: string): string {
  try {
    const md = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8');
    const fm = md.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      const d = fm[1].match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m);
      if (d) return d[1].split('\n')[0].trim().slice(0, 300);
    }
    const body = fm ? md.slice(fm[0].length) : md;
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('>')) return t.slice(0, 300);
    }
  } catch { /* no SKILL.md */ }
  return '';
}

/** Scan a skills root (~/.claude/skills or <workdir>/.claude/skills). */
export function scanSkillsDir(dir: string): SkillInfo[] {
  const out: SkillInfo[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const p = path.join(dir, name);
    let lst: fs.Stats;
    try { lst = fs.lstatSync(p); } catch { continue; }
    const isLink = lst.isSymbolicLink();
    let st: fs.Stats;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    const kind: SkillInfo['kind'] = isLink ? 'symlink' : fs.existsSync(path.join(p, '.git')) ? 'git' : 'dir';
    let updatedAt: string | null;
    try { updatedAt = fs.statSync(path.join(p, 'SKILL.md')).mtime.toISOString(); }
    catch { updatedAt = st.mtime.toISOString(); }
    out.push({ name, description: readSkillDescription(p), kind, updatedAt });
  }
  return out;
}

/** Claude Code keys per-project data dirs by the workdir path with separators
 *  munged to '-'. Two candidates cover the known variants. Exported for tests. */
export function memoryDirCandidates(workDir: string): string[] {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const c1 = workDir.replaceAll('/', '-');
  const c2 = workDir.replace(/[/.]/g, '-');
  const cands = [...new Set([c1, c2])];
  return cands.map((c) => path.join(root, c, 'memory'));
}

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

function safeLeafName(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  if (v.includes('/') || v.includes('\\') || v.includes('..')) return null;
  return v;
}

function resolveBotWorkdir(botsConfigPath: string | undefined, botName: string): string | null {
  if (!botsConfigPath) return null;
  try {
    const cfg = readBotsConfig(botsConfigPath);
    const entry = (cfg.feishuBots || []).find((b) => b.name === botName);
    if (!entry?.defaultWorkingDirectory) return null;
    return expandUserPath(entry.defaultWorkingDirectory);
  } catch {
    return null;
  }
}


/** launchd boot-persistence for pm2 — the missing piece behind a real
 *  "macOS auto-update rebooted at 2am, bots offline all morning" outage. */
export function pm2StartupConfigured(roots?: string[]): boolean {
  const dirs = roots ?? [path.join(os.homedir(), 'Library', 'LaunchAgents'), '/Library/LaunchDaemons'];
  for (const d of dirs) {
    try {
      if (fs.readdirSync(d).some((f) => f.includes('pm2') && f.endsWith('.plist'))) return true;
    } catch { /* dir absent */ }
  }
  return false;
}

export async function handleAdminRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, scheduler, logger, botsConfigPath, activityStore } = ctx;


  // GET /admin/api/skills — global + per-bot project-level skills (read-only)
  if (method === 'GET' && url === '/admin/api/skills') {
    const globalDir = path.join(os.homedir(), '.claude', 'skills');
    const bots: Array<{ name: string; workdir: string; skills: SkillInfo[] }> = [];
    try {
      const cfg = botsConfigPath ? readBotsConfig(botsConfigPath) : { feishuBots: [] };
      for (const b of cfg.feishuBots || []) {
        if (!b.defaultWorkingDirectory) continue;
        const wd = expandUserPath(b.defaultWorkingDirectory);
        bots.push({ name: b.name, workdir: wd, skills: scanSkillsDir(path.join(wd, '.claude', 'skills')) });
      }
    } catch { /* bots.json unreadable — still return globals */ }
    jsonResponse(res, 200, { globalDir, global: scanSkillsDir(globalDir), bots });
    return true;
  }

  // GET /admin/api/skills/detail?scope=global|bot&bot=<name>&skill=<name>
  if (method === 'GET' && url.startsWith('/admin/api/skills/detail?')) {
    const q = new URL(url, 'http://x').searchParams;
    const skill = safeLeafName(q.get('skill'));
    if (!skill) { jsonResponse(res, 400, { error: 'bad skill name' }); return true; }
    let root: string | null;
    if (q.get('scope') === 'bot') {
      const wd = resolveBotWorkdir(botsConfigPath, q.get('bot') || '');
      root = wd ? path.join(wd, '.claude', 'skills') : null;
    } else {
      root = path.join(os.homedir(), '.claude', 'skills');
    }
    if (!root) { jsonResponse(res, 404, { error: 'bot not found' }); return true; }
    const dir = path.join(root, skill);
    let real: string;
    try { real = fs.realpathSync(dir); } catch { jsonResponse(res, 404, { error: 'skill not found' }); return true; }
    let skillMd = '';
    try { skillMd = fs.readFileSync(path.join(real, 'SKILL.md'), 'utf-8').slice(0, 200_000); } catch { /* none */ }
    const files: string[] = [];
    const walk = (d: string, rel: string) => {
      if (files.length >= 200) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.name === '.git') continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(d, e.name), r);
        else files.push(r);
        if (files.length >= 200) return;
      }
    };
    walk(real, '');
    jsonResponse(res, 200, { name: skill, skillMd, files, truncated: files.length >= 200 });
    return true;
  }

  // GET /admin/api/memory?bot=<name> — the bot's auto-memory, indexed view
  if (method === 'GET' && url.startsWith('/admin/api/memory?')) {
    const q = new URL(url, 'http://x').searchParams;
    const botName = q.get('bot') || '';
    const wd = resolveBotWorkdir(botsConfigPath, botName);
    if (!wd) { jsonResponse(res, 404, { error: 'bot not found' }); return true; }
    const memDir = memoryDirCandidates(wd).find((d) => fs.existsSync(d));
    if (!memDir) {
      jsonResponse(res, 200, { exists: false, workdir: wd, entries: [], orphans: [] });
      return true;
    }
    let indexRaw = '';
    try { indexRaw = fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf-8'); } catch { /* no index */ }
    const indexed = parseMemoryIndex(indexRaw);
    const onDisk = new Map<string, fs.Stats>();
    try {
      for (const f of fs.readdirSync(memDir)) {
        if (f.endsWith('.md') && f !== 'MEMORY.md') onDisk.set(f, fs.statSync(path.join(memDir, f)));
      }
    } catch { /* ignore */ }
    const entries = indexed.map((e) => {
      const st = onDisk.get(e.file);
      return { ...e, exists: !!st, sizeBytes: st?.size ?? null, mtime: st?.mtime.toISOString() ?? null };
    });
    const referenced = new Set(indexed.map((e) => e.file));
    const orphans = [...onDisk.entries()]
      .filter(([f]) => !referenced.has(f))
      .map(([f, st]) => ({ file: f, sizeBytes: st.size, mtime: st.mtime.toISOString() }));
    jsonResponse(res, 200, { exists: true, memoryDir: memDir, workdir: wd, hasIndex: !!indexRaw, entries, orphans });
    return true;
  }

  // GET /admin/api/memory/file?bot=<name>&file=<name.md>
  if (method === 'GET' && url.startsWith('/admin/api/memory/file?')) {
    const q = new URL(url, 'http://x').searchParams;
    const file = safeLeafName(q.get('file'));
    if (!file || !file.endsWith('.md')) { jsonResponse(res, 400, { error: 'bad file name' }); return true; }
    const wd = resolveBotWorkdir(botsConfigPath, q.get('bot') || '');
    if (!wd) { jsonResponse(res, 404, { error: 'bot not found' }); return true; }
    const memDir = memoryDirCandidates(wd).find((d) => fs.existsSync(d));
    if (!memDir) { jsonResponse(res, 404, { error: 'no memory dir' }); return true; }
    try {
      const p = path.join(memDir, file);
      const st = fs.statSync(p);
      jsonResponse(res, 200, { file, content: fs.readFileSync(p, 'utf-8').slice(0, 300_000), sizeBytes: st.size, mtime: st.mtime.toISOString() });
    } catch {
      jsonResponse(res, 404, { error: 'file not found' });
    }
    return true;
  }

  // GET /admin/api/overview — aggregate dashboard payload
  if (method === 'GET' && (url === '/admin/api/overview' || url.startsWith('/admin/api/overview?'))) {
    const started = startTimeMs();
    const mem = process.memoryUsage();
    const toMb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;

    // Configured entries vs running registry — the diff is the failed set.
    let configured: Array<{ name: string; engine: string; workDir: string | null }> = [];
    let configDirty = false;
    let configError: string | null = null;
    if (botsConfigPath) {
      try {
        const cfg = readBotsConfig(botsConfigPath);
        configured = (cfg.feishuBots || []).map((b) => ({
          name: b.name,
          engine: (b as { engine?: string }).engine || 'claude',
          workDir: b.defaultWorkingDirectory || null,
        }));
        const mtime = fs.statSync(botsConfigPath).mtimeMs;
        configDirty = mtime > started;
      } catch (err: any) {
        configError = `bots.json 读取失败: ${err?.message || err}`;
        logger.warn({ err: err?.message }, 'admin overview: bots.json unreadable');
      }
    }

    const runningNames = new Set(registry.list().map((b) => b.name));
    const since = todayStartMs();
    const todayEvents = activityStore?.list({ since, limit: 2000 }) ?? [];

    const bots = configured.map((c) => {
      const bot = registry.get(c.name);
      const executors = { total: 0, active: 0 };
      if (bot) {
        const reg = bot.bridge.getPersistentRegistry?.();
        if (reg) {
          for (const e of reg.list()) {
            executors.total++;
            if (e.hasActiveTurn) executors.active++;
          }
        }
      }
      const events = todayEvents.filter((e) => e.botName === c.name);
      const completed = events.filter((e) => e.type === 'task_completed');
      const failed = events.filter((e) => e.type === 'task_failed');
      const lastEvent = events[0];
      const totals = bot ? bot.bridge.costTracker.getStats().byBot[c.name] : undefined;
      return {
        name: c.name,
        engine: bot ? resolveEngineName(bot.config) : c.engine,
        workDir: c.workDir,
        running: runningNames.has(c.name),
        executors,
        today: {
          tasks: completed.length + failed.length,
          failed: failed.length,
          costUsd: Math.round(events.reduce((s, e) => s + (e.costUsd || 0), 0) * 10000) / 10000,
        },
        sinceStart: totals
          ? { totalTasks: totals.totalTasks, totalCostUsd: totals.totalCostUsd }
          : { totalTasks: 0, totalCostUsd: 0 },
        lastActivityAt: lastEvent ? lastEvent.timestamp : null,
      };
    });

    const recurring = scheduler.listRecurringTasks()
      .filter((r) => r.status === 'active')
      .sort((a, b) => a.nextExecuteAt - b.nextExecuteAt)
      .slice(0, 5)
      .map((r) => ({ id: r.id, botName: r.botName, label: r.label || null, nextExecuteAt: new Date(r.nextExecuteAt).toISOString() }));

    const recentFailures = todayEvents
      .filter((e) => e.type === 'task_failed')
      .slice(0, 10)
      .map((e) => ({ botName: e.botName, chatId: e.chatId, errorMessage: e.errorMessage || null, timestamp: e.timestamp }));

    const core = await probeCore();

    jsonResponse(res, 200, {
      pm2StartupConfigured: pm2StartupConfigured(),
      bridge: {
        version: pkgVersion(),
        uptime: Math.floor((Date.now() - started) / 1000),
        memory: { rssMb: toMb(mem.rss), heapUsedMb: toMb(mem.heapUsed) },
      },
      core,
      bots,
      configDirty,
      configError,
      schedule: {
        oneTime: scheduler.taskCount(),
        recurring: scheduler.recurringTaskCount(),
        upcoming: recurring,
      },
      today: {
        tasks: todayEvents.filter((e) => e.type !== 'task_started').length,
        failed: todayEvents.filter((e) => e.type === 'task_failed').length,
        costUsd: Math.round(todayEvents.reduce((s, e) => s + (e.costUsd || 0), 0) * 10000) / 10000,
      },
      recentFailures,
    });
    return true;
  }

  // GET /admin/api/logs?file=out|error&lines=200
  if (method === 'GET' && url.startsWith('/admin/api/logs')) {
    const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const file = parsed.searchParams.get('file') === 'error' ? 'error' : 'out';
    const lines = parseInt(parsed.searchParams.get('lines') || '200', 10) || 200;
    // Two-value enum mapped to fixed paths — no user-supplied path segments.
    const abs = path.resolve(process.cwd(), 'logs', file === 'error' ? 'error.log' : 'out.log');
    const result = tailLogFile(abs, lines);
    jsonResponse(res, 200, { file, ...result });
    return true;
  }

  // POST /admin/api/feishu/test-connection — {appId, appSecret} or {botName}
  if (method === 'POST' && url === '/admin/api/feishu/test-connection') {
    const body = await parseJsonBody(req);
    let appId = typeof body.appId === 'string' ? body.appId.trim() : '';
    let appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : '';
    const botName = typeof body.botName === 'string' ? body.botName.trim() : '';

    if (botName && (!appId || !appSecret)) {
      if (!botsConfigPath) {
        jsonResponse(res, 400, { error: 'BOTS_CONFIG not set' });
        return true;
      }
      const cfg = readBotsConfig(botsConfigPath);
      const entry = (cfg.feishuBots || []).find((b) => b.name === botName);
      if (!entry) {
        jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
        return true;
      }
      appId = entry.feishuAppId;
      appSecret = entry.feishuAppSecret;
    }
    if (!appId || !appSecret) {
      jsonResponse(res, 400, { error: 'Provide appId + appSecret, or botName' });
      return true;
    }
    try {
      const resp = await fetch(FEISHU_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(5000),
      });
      const data = (await resp.json()) as { code?: number; msg?: string };
      const ok = resp.ok && data.code === 0;
      jsonResponse(res, 200, { ok, feishuCode: data.code ?? null, msg: ok ? 'credentials valid' : (data.msg || `HTTP ${resp.status}`) });
    } catch (err: any) {
      jsonResponse(res, 200, { ok: false, feishuCode: null, msg: `request failed: ${err?.message || err}` });
    }
    return true;
  }

  // GET /admin/api/pm2 — read-only process listing
  if (method === 'GET' && url === '/admin/api/pm2') {
    jsonResponse(res, 200, await pm2Jlist());
    return true;
  }

  // POST /admin/api/restart — breadcrumb + exit(0); PM2 autorestart brings us back
  if (method === 'POST' && url === '/admin/api/restart') {
    const now = Date.now();
    if (now - lastRestartRequestAt < 30_000) {
      jsonResponse(res, 429, { error: 'restart already in progress' });
      return true;
    }
    lastRestartRequestAt = now;
    try {
      const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last-restart.json'), JSON.stringify({ restartedAt: Math.floor(now / 1000) }) + '\n');
    } catch (err: any) {
      logger.warn({ err: err?.message }, 'restart breadcrumb write failed');
    }
    logger.warn('admin console requested a bridge restart — exiting for PM2 to respawn');
    jsonResponse(res, 202, { restarting: true, etaSec: 5 });
    setTimeout(() => process.exit(0), 500);
    return true;
  }

  // GET /admin/api/config — read-only effective config (secrets masked)
  if (method === 'GET' && url === '/admin/api/config') {
    jsonResponse(res, 200, effectiveConfig(ctx));
    return true;
  }

  // GET /admin/api/feishu/chats?bot=<name> — groups the bot is a member of
  if (method === 'GET' && url.startsWith('/admin/api/feishu/chats')) {
    const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const botName = parsed.searchParams.get('bot') || '';
    const bot = registry.get(botName);
    if (!bot?.feishuClient) {
      jsonResponse(res, 404, { error: bot ? 'bot has no Feishu client (not running?)' : `Bot not running: ${botName}` });
      return true;
    }
    try {
      const chats = await collectBotChats(bot.feishuClient);
      jsonResponse(res, 200, { chats });
    } catch (err: any) {
      jsonResponse(res, 502, { error: `Feishu chat list failed: ${err?.message || err}` });
    }
    return true;
  }

  // GET /admin/api/feishu/chat-members?bot=<name>&chatId=<oc_> — group members (bots excluded by Feishu)
  if (method === 'GET' && url.startsWith('/admin/api/feishu/chat-members')) {
    const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const botName = parsed.searchParams.get('bot') || '';
    const chatId = parsed.searchParams.get('chatId') || '';
    const bot = registry.get(botName);
    if (!bot?.feishuClient) {
      jsonResponse(res, 404, { error: bot ? 'bot has no Feishu client (not running?)' : `Bot not running: ${botName}` });
      return true;
    }
    if (!chatId) {
      jsonResponse(res, 400, { error: 'Missing chatId' });
      return true;
    }
    try {
      const members = await collectChatMembers(bot.feishuClient, chatId);
      jsonResponse(res, 200, { members });
    } catch (err: any) {
      jsonResponse(res, 502, { error: `Feishu member list failed: ${err?.message || err}` });
    }
    return true;
  }

  // GET /admin/api/group-summary?bot=<name> — per-bot summary prefs (excluded chats)
  if (method === 'GET' && url.startsWith('/admin/api/group-summary')) {
    const parsed = new URL(url, `http://${req.headers.host || 'localhost'}`);
    const botName = parsed.searchParams.get('bot') || '';
    if (!botName) {
      jsonResponse(res, 400, { error: 'Missing bot' });
      return true;
    }
    const prefs = readSummaryPrefs();
    jsonResponse(res, 200, { bot: botName, excluded: prefs[botName]?.excluded ?? [] });
    return true;
  }

  // PUT /admin/api/group-summary — replace a bot's excluded list
  if (method === 'PUT' && url === '/admin/api/group-summary') {
    const body = await parseJsonBody(req);
    const botName = typeof body.bot === 'string' ? body.bot.trim() : '';
    const excluded = Array.isArray(body.excluded)
      ? (body.excluded as unknown[]).filter((v): v is string => typeof v === 'string' && v.startsWith('oc_'))
      : null;
    if (!botName || excluded === null) {
      jsonResponse(res, 400, { error: 'Body must be {bot, excluded: ["oc_..."]}' });
      return true;
    }
    const prefs = readSummaryPrefs();
    prefs[botName] = { excluded };
    writeSummaryPrefs(prefs);
    jsonResponse(res, 200, { bot: botName, excluded });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Feishu lookups (used by the admin console's group-summary + member pickers)
// ---------------------------------------------------------------------------

interface FeishuChatLister {
  im: {
    chat: {
      list: (payload?: { params?: Record<string, unknown> }) => Promise<{
        code?: number;
        msg?: string;
        data?: { items?: Array<{ chat_id?: string; name?: string; avatar?: string }>; page_token?: string; has_more?: boolean };
      }>;
    };
    chatMembers: {
      get: (payload?: { params?: Record<string, unknown>; path: { chat_id: string } }) => Promise<{
        code?: number;
        msg?: string;
        data?: { items?: Array<{ member_id?: string; name?: string }>; page_token?: string; has_more?: boolean };
      }>;
    };
  };
}

const FEISHU_PAGE_CAP = 20; // 20 pages × 100 = up to 2000 rows; plenty for an ops tool

/** All groups the bot is in (paginated; P2P chats are not returned by Feishu). */
export async function collectBotChats(client: FeishuChatLister): Promise<Array<{ chatId: string; name: string; avatar?: string }>> {
  const out: Array<{ chatId: string; name: string; avatar?: string }> = [];
  let pageToken: string | undefined;
  for (let i = 0; i < FEISHU_PAGE_CAP; i++) {
    const resp = await client.im.chat.list({
      params: { page_size: 100, sort_type: 'ByActiveTimeDesc', ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (resp.code !== 0) throw new Error(resp.msg || `feishu code ${resp.code}`);
    for (const it of resp.data?.items ?? []) {
      if (it.chat_id) out.push({ chatId: it.chat_id, name: it.name || it.chat_id, ...(it.avatar ? { avatar: it.avatar } : {}) });
    }
    if (!resp.data?.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return out;
}

/** Human members of one group, as open_ids (Feishu omits bot members). */
export async function collectChatMembers(client: FeishuChatLister, chatId: string): Promise<Array<{ openId: string; name: string }>> {
  const out: Array<{ openId: string; name: string }> = [];
  let pageToken: string | undefined;
  for (let i = 0; i < FEISHU_PAGE_CAP; i++) {
    const resp = await client.im.chatMembers.get({
      path: { chat_id: chatId },
      params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (resp.code !== 0) throw new Error(resp.msg || `feishu code ${resp.code}`);
    for (const it of resp.data?.items ?? []) {
      if (it.member_id) out.push({ openId: it.member_id, name: it.name || it.member_id });
    }
    if (!resp.data?.has_more || !resp.data.page_token) break;
    pageToken = resp.data.page_token;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Group-summary prefs (which chats are explicitly excluded from daily digests)
// ---------------------------------------------------------------------------

type SummaryPrefs = Record<string, { excluded: string[] }>;

function summaryPrefsPath(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
  return path.join(dir, 'group-summary.json');
}

export function readSummaryPrefs(): SummaryPrefs {
  try {
    const raw = fs.readFileSync(summaryPrefsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as SummaryPrefs) : {};
  } catch {
    return {};
  }
}

export function writeSummaryPrefs(prefs: SummaryPrefs): void {
  const file = summaryPrefsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

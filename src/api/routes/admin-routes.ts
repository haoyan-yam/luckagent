import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type * as http from 'node:http';
import { readBotsConfig } from '../bots-config-writer.js';
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
      codexModel: process.env.CODEX_MODEL || null,
      scheduleTimezone: process.env.SCHEDULE_TIMEZONE || null,
    },
    credentials: {
      apiSecret: secretHint(process.env.API_SECRET),
      anthropicApiKey: secretHint(process.env.ANTHROPIC_API_KEY),
      openaiApiKey: secretHint(process.env.OPENAI_API_KEY),
      coreToken: secretHint(process.env.LUCKAGENT_CORE_TOKEN),
      volcengineTts: secretHint(process.env.VOLCENGINE_TTS_ACCESS_KEY),
      elevenlabs: secretHint(process.env.ELEVENLABS_API_KEY),
    },
  };
}

export async function handleAdminRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, scheduler, logger, botsConfigPath, activityStore } = ctx;

  // GET /admin/api/overview — aggregate dashboard payload
  if (method === 'GET' && (url === '/admin/api/overview' || url.startsWith('/admin/api/overview?'))) {
    const started = startTimeMs();
    const mem = process.memoryUsage();
    const toMb = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;

    // Configured entries vs running registry — the diff is the failed set.
    let configured: Array<{ name: string; engine: string; workDir: string | null }> = [];
    let configDirty = false;
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
      bridge: {
        version: pkgVersion(),
        uptime: Math.floor((Date.now() - started) / 1000),
        memory: { rssMb: toMb(mem.rss), heapUsedMb: toMb(mem.heapUsed) },
      },
      core,
      bots,
      configDirty,
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

  return false;
}

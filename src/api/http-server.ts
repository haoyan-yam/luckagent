import * as http from 'node:http';
import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import { loadAppConfig } from '../config.js';
import type { AgentTeamConfig } from '../agent-teams/team-store.js';
import type { BotRegistry } from './bot-registry.js';
import type { TaskScheduler } from '../scheduler/task-scheduler.js';
import type { DocSync } from '../sync/doc-sync.js';
import type { PeerManager } from './peer-manager.js';

import { AsyncTaskStore } from './async-task-store.js';
import { timingSafeStrEqual } from '../utils/timing-safe.js';
import { rateLimiterFromEnv, resolveClientIp } from './request-rate-limiter.js';
import { IntentRouter } from './intent-router.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { BudgetManager } from './budget-manager.js';
import { TeamManager } from './team-manager.js';
import { ActivityStore } from './activity-store.js';
import { AgentTeamStore } from '../agent-teams/team-store.js';
import { AgentTeamSupervisor } from '../agent-teams/team-supervisor.js';
import { metrics as _metrics } from '../utils/metrics.js';
import type { SessionRegistry } from '../session/session-registry.js';
import {
  jsonResponse,
  handleVoiceRoutes,
  handleTeamRoutes,
  handleTaskRoutes,
  handleBotRoutes,
  handleSyncRoutes,
  handleSessionRoutes,
  handleExecutorRoutes,
  handleAgentTeamRoutes,
  handleAdminRoutes,
} from './routes/index.js';
import { serveAdminStatic } from './admin-static.js';
import type { RouteContext } from './routes/index.js';

interface ApiServerOptions {
  port: number;
  secret?: string;
  registry: BotRegistry;
  scheduler: TaskScheduler;
  logger: Logger;
  botsConfigPath?: string;
  docSync?: DocSync;
  feishuServiceClient?: lark.Client;
  peerManager?: PeerManager;
  circuitBreaker?: CircuitBreaker;
  budgetManager?: BudgetManager;
  teamManager?: TeamManager;
  agentTeamStore?: AgentTeamStore;
  agentTeams?: AgentTeamConfig[];
  sessionRegistry?: SessionRegistry;
}

const startTime = Date.now();
// Expose start time for metrics route
(globalThis as any).__luckagent_start_time = startTime;

const WHOAMI_VERIFY_TIMEOUT_MS = 5_000;

/**
 * Routes that accept the dual-auth gate: local secret OR a Bearer that
 * luckagent-core `/api/whoami` validates. Covers the cross-bridge RPC entry
 * points (`/api/talk`, `/api/tasks`) plus the read-only peer-discovery
 * endpoints that peer-manager polls — without these, peer state can never
 * become healthy across hosts that don't share a local secret.
 */
export function isCrossVerifyRoute(method: string, url: string): boolean {
  if (method === 'POST' && (url === '/api/talk' || url.startsWith('/api/talk?'))) return true;
  if (method === 'POST' && (url === '/api/tasks' || url.startsWith('/api/tasks?'))) return true;
  if (method === 'GET' && url.startsWith('/api/talk/')) return true;
  if (method === 'GET' && (url === '/api/bots' || url.startsWith('/api/bots?'))) return true;
  if (method === 'GET' && (url === '/api/skills' || url.startsWith('/api/skills?'))) return true;
  if (method === 'GET' && (url === '/api/peers' || url.startsWith('/api/peers?'))) return true;
  return false;
}

function luckagentCoreBaseUrl(): string | undefined {
  const candidates = [process.env.LUCKAGENT_CORE_AGENT_BUS_URL, process.env.LUCKAGENT_CORE_URL];
  for (const raw of candidates) {
    const trimmed = raw?.trim();
    if (trimmed) return trimmed.replace(/\/+$/, '');
  }
  return undefined;
}

/**
 * Verify a Bearer header against luckagent-core `GET /api/whoami`. Returns true
 * only on HTTP 200. Fails closed on any error (network, non-200, timeout).
 */
async function verifyBearerViaLuckagentCore(
  authHeader: string,
  logger: Logger,
): Promise<boolean> {
  const base = luckagentCoreBaseUrl();
  if (!base) {
    logger.warn(
      'cross-bridge talk attempted but LUCKAGENT_CORE_AGENT_BUS_URL/LUCKAGENT_CORE_URL is unset — cannot verify',
    );
    return false;
  }
  try {
    const resp = await fetch(`${base}/api/whoami`, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(WHOAMI_VERIFY_TIMEOUT_MS),
    });
    return resp.ok;
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'whoami verification failed');
    return false;
  }
}

export function startApiServer(options: ApiServerOptions): http.Server {
  const { port, secret, registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient, peerManager } = options;
  // Always bind loopback by default; exposing to the network requires an
  // explicit opt-in via LUCKAGENT_API_HOST (e.g. 0.0.0.0) AND a secret set.
  const host = process.env.LUCKAGENT_API_HOST?.trim() || '127.0.0.1';

  // Initialize shared services
  const asyncTaskStore = new AsyncTaskStore();
  const intentRouter = new IntentRouter(logger);
  const circuitBreaker = options.circuitBreaker ?? new CircuitBreaker(logger);
  const budgetManager = options.budgetManager ?? new BudgetManager(logger);
  const teamManager = options.teamManager ?? new TeamManager(logger);
  const agentTeamStore = options.agentTeamStore ?? new AgentTeamStore(logger);
  const activityStore = new ActivityStore(logger);
  const agentTeamSupervisor = new AgentTeamSupervisor({ registry, store: agentTeamStore, logger });
  if (options.agentTeams?.length) {
    agentTeamStore.reconcileTeams(options.agentTeams);
    logger.info({ count: options.agentTeams.length }, 'Agent teams reconciled from config');
  }
  const agentTeamsConfigWatcher = watchAgentTeamsConfig({
    botsConfigPath,
    store: agentTeamStore,
    logger,
  });

  // Per-IP in-memory rate limiter (global ceiling + failed-auth backoff).
  // Configurable via LUCKAGENT_RATE_LIMIT_MAX / LUCKAGENT_RATE_LIMIT_AUTH_FAILS,
  // disabled via LUCKAGENT_RATE_LIMIT_DISABLED=1.
  const rateLimiter = rateLimiterFromEnv();
  rateLimiter.startSweep();

  // Build route context (shared across all route handlers)
  const ctx: RouteContext = {
    registry, scheduler, logger, botsConfigPath, docSync, feishuServiceClient,
    peerManager,
    asyncTaskStore, intentRouter, circuitBreaker, budgetManager,
    teamManager,
    sessionRegistry: options.sessionRegistry,
    activityStore,
    agentTeamStore,
    agentTeamSupervisor,
  };

  if (peerManager) {
    peerManager.setRelayHandler(async (message) => {
      const parsedContent = parseRelayContent(message.content);
      const botName = typeof parsedContent?.botName === 'string' && parsedContent.botName
        ? parsedContent.botName
        : message.targetBot;
      const prompt = typeof parsedContent?.prompt === 'string' && parsedContent.prompt
        ? parsedContent.prompt
        : (typeof parsedContent?.content === 'string' && parsedContent.content ? parsedContent.content : message.content);
      const chatId = typeof parsedContent?.chatId === 'string' && parsedContent.chatId
        ? parsedContent.chatId
        : (message.chatId || `agent-inbox-${botName}`);
      const sendCards = typeof parsedContent?.sendCards === 'boolean' ? parsedContent.sendCards : true;
      const bot = registry.get(botName);
      if (!bot) {
        logger.warn({ messageId: message.id, botName, targetBot: message.targetBot }, 'relay inbox target bot not found locally');
        return;
      }
      logger.info({ messageId: message.id, botName, chatId, fromBot: message.fromBot, fromOwner: message.fromOwner }, 'executing relay inbox talk message');
      await bot.bridge.executeApiTask({
        prompt,
        chatId,
        userId: message.fromBot || message.fromOwner || 'agent-bus',
        sendCards,
      });
    });
  }

  for (const bot of registry.listRegistered()) {
    bot.bridge.setAgentTeamStore(agentTeamStore);
  }
  agentTeamSupervisor.start();

  // Route handlers in priority order
  const routeHandlers = [
    handleAdminRoutes,
    handleVoiceRoutes,
    handleTeamRoutes,
    handleTaskRoutes,
    handleBotRoutes,
    handleSyncRoutes,
    handleSessionRoutes,
    handleExecutorRoutes,
    handleAgentTeamRoutes,
  ];

  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    // Resolve the client IP. We default to socket.remoteAddress because this
    // bridge is typically NOT behind a trusted reverse proxy; X-Forwarded-For is
    // only honoured when LUCKAGENT_TRUST_PROXY=1 (see resolveClientIp).
    const clientIp = resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for']);

    // Rate limiting (global per-IP ceiling + failed-auth backoff). GET
    // /api/health is exempt so liveness/readiness probes are never throttled.
    const isHealthProbe = method === 'GET' && url === '/api/health';
    if (!isHealthProbe) {
      const decision = rateLimiter.check(clientIp);
      if (decision) {
        res.setHeader('Retry-After', String(decision.retryAfterSec));
        jsonResponse(res, decision.status, { error: 'Too Many Requests', reason: decision.reason });
        return;
      }
    }

    // Auth check.
    //
    // /api/talk and /api/tasks routes accept dual auth: the local secret
    // (luckagent CLI shortcut, local cross-bot dispatch) OR any Bearer that
    // luckagent-core `GET /api/whoami` validates (cross-bridge peer calls,
    // `luckagent talk` from any user with a luckagent-core token). Every other
    // API stays single-secret.
    // GET /api/health is exempt: it returns only minimal liveness info (see
    // handler below) so probes/load-balancers can hit it without a secret.
    // /admin/* static assets (NOT /admin/api/*) are exempt: they are just the
    // public JS/HTML of the admin console; every data call still needs Bearer.
    const isPublicHealth = method === 'GET' && url === '/api/health';
    const isAdminStatic = url === '/' || url === '/admin' || (url.startsWith('/admin/') && !url.startsWith('/admin/api/'));
    if (secret && !isPublicHealth && !isAdminStatic) {
      const auth = req.headers.authorization;
      const bearer = typeof auth === 'string' && /^Bearer\s+/i.test(auth)
        ? auth.replace(/^Bearer\s+/i, '')
        : undefined;
      const urlToken = url.includes('token=')
        ? new URL(url, `http://${req.headers.host || 'localhost'}`).searchParams.get('token')
        : null;
      // Timing-safe comparison so the secret can't be recovered byte-by-byte.
      const localOk = timingSafeStrEqual(bearer, secret)
        || timingSafeStrEqual(urlToken, secret);

      const rejectUnauthorized = () => {
        // Count this as a failed auth attempt; trips the per-IP lockout once the
        // threshold is crossed. The next request from this IP will see 429.
        rateLimiter.recordAuthFailure(clientIp);
        jsonResponse(res, 401, { error: 'Unauthorized' });
      };

      if (!localOk) {
        const canCrossVerify = isCrossVerifyRoute(method, url) && typeof auth === 'string' && /^Bearer\s+/i.test(auth);
        if (!canCrossVerify) {
          rejectUnauthorized();
          return;
        }
        const verified = await verifyBearerViaLuckagentCore(auth!, logger);
        if (!verified) {
          rejectUnauthorized();
          return;
        }
      }
      // Successful auth — clear any accumulated failed-auth counter so a
      // legitimate client is never throttled by the backoff guard.
      rateLimiter.recordAuthSuccess(clientIp);
    }

    try {
      // GET /api/health — minimal, unauthenticated-safe liveness probe.
      // Deliberately returns ONLY status + uptime so an unauthenticated caller
      // (deploy/k8s probe, or anyone if no api.secret is set) can't enumerate
      // peer count, peer health, or peer URLs for reconnaissance. Detailed
      // topology lives behind the authenticated /api/status route.
      if (method === 'GET' && url === '/api/health') {
        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
        });
        return;
      }

      // GET /api/status — same diagnostics that /api/health used to leak, but
      // gated by the auth check above (local secret or cross-verified Bearer).
      if (method === 'GET' && url === '/api/status') {
        const peerStatuses = peerManager?.getPeerStatuses() ?? [];

        // Process memory (MB). rss = total resident set, heapUsed = V8 heap in use.
        const mem = process.memoryUsage();
        const toMb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

        // Executor-pool stats: reachable here via the same per-bot persistent
        // registry the /api/executors route uses — no new plumbing required.
        // We expose only aggregate counts (total + active turns), not per-chat
        // detail, to keep /api/status lightweight.
        let executorTotal = 0;
        let executorActive = 0;
        for (const bot of registry.listRegistered()) {
          const reg = bot.bridge.getPersistentRegistry?.();
          if (!reg) continue;
          for (const e of reg.list()) {
            executorTotal++;
            if (e.hasActiveTurn) executorActive++;
          }
        }

        jsonResponse(res, 200, {
          status: 'ok',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          bots: registry.list().length,
          peerBots: peerManager?.getPeerBots().length ?? 0,
          peers: peerStatuses.length,
          peersHealthy: peerStatuses.filter((p) => p.healthy).length,
          scheduledTasks: scheduler.taskCount(),
          recurringTasks: scheduler.recurringTaskCount(),
          memory: { rssMb: toMb(mem.rss), heapUsedMb: toMb(mem.heapUsed) },
          executors: { total: executorTotal, active: executorActive },
          rateLimit: { trackedIps: rateLimiter.size() },
        });
        return;
      }

      // Dispatch to route handlers
      for (const handler of routeHandlers) {
        if (await handler(ctx, req, res, method, url)) return;
      }

      // Admin console static assets (/, /admin, /admin/*)
      if (serveAdminStatic(req, res, method, url)) return;

      // 404 fallback
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: any) {
      const statusCode = err.statusCode || 500;
      if (statusCode >= 500) {
        logger.error({ err, method, url }, 'API request error');
      }
      jsonResponse(res, statusCode, { error: err.message || 'Internal server error' });
    }
  });

  // Wire activity events: each bridge records to ActivityStore
  for (const bot of registry.listRegistered()) {
    bot.bridge.onActivityEvent = (event) => {
      activityStore.record(event);
    };
  }

  server.listen(port, host, () => {
    logger.info({ host, port }, 'API server started');
  });
  server.on('close', () => {
    agentTeamsConfigWatcher?.close();
    agentTeamSupervisor.destroy();
    rateLimiter.stopSweep();
  });

  return server;
}

function parseRelayContent(content: string): Record<string, any> | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, any> : undefined;
  } catch {
    return undefined;
  }
}

function watchAgentTeamsConfig(options: {
  botsConfigPath?: string;
  store: AgentTeamStore;
  logger: Logger;
}): fs.FSWatcher | undefined {
  if (!options.botsConfigPath || process.env.LUCKAGENT_AGENT_TEAMS_HOT_RELOAD === '0') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const config = loadAppConfig();
        options.store.reconcileTeams(config.agentTeams);
        options.logger.info({ count: config.agentTeams.length }, 'Agent teams hot-reloaded from bots.json');
      } catch (err: any) {
        options.logger.warn({ err: err?.message || err }, 'Agent teams hot reload failed');
      }
    }, 250);
  };
  try {
    const watcher = fs.watch(options.botsConfigPath, reload);
    watcher.unref?.();
    return watcher;
  } catch (err: any) {
    options.logger.warn({ err: err?.message || err, botsConfigPath: options.botsConfigPath }, 'Agent teams hot reload watcher failed');
    return undefined;
  }
}

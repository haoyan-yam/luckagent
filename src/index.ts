import * as https from 'node:https';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { loadAppConfig, type BotConfig } from './config.js';
import { createLogger, type Logger } from './utils/logger.js';
import { createEventDispatcher } from './feishu/event-handler.js';
import { MessageSender } from './feishu/message-sender.js';
import { FeishuSenderAdapter } from './feishu/feishu-sender-adapter.js';
import { MessageBridge } from './bridge/message-bridge.js';
import { OutboundLedger } from './bridge/outbound-ledger.js';
import { loadRestartBreadcrumb } from './bridge/restart-notice.js';
import type { IMessageSender } from './bridge/message-sender.interface.js';
import type { BotConfigBase } from './config.js';
import { BotRegistry } from './api/bot-registry.js';
import { PeerManager } from './api/peer-manager.js';
import { TaskScheduler } from './scheduler/task-scheduler.js';
import { startApiServer } from './api/http-server.js';
import { DocSync } from './sync/doc-sync.js';
import { MemoryClient } from './memory/memory-client.js';

import { SessionRegistry } from './session/session-registry.js';

interface FeishuBotHandle {
  name: string;
  bridge: MessageBridge;
  wsClient: lark.WSClient;
  config: BotConfigBase;
  sender: IMessageSender;
  feishuClient: lark.Client;
}

/**
 * LUCKAGENT_LOCAL_ADDRESS=<source-ip> pins the source address of every Feishu
 * socket (REST + the wss long-connection), so the OS routes them out the
 * interface owning that IP instead of the default route. Workaround for VPN
 * clients with smart split-tunneling (e.g. some corporate VPNs) that capture *.feishu.cn
 * into a tunnel that is actually down while still claiming connected: live
 * sockets held by an old process keep working, but the next restart can't
 * reconnect and every bot goes silent — looking like the upgrade broke it.
 *
 * REST coverage works by setting the agent on the lark SDK's shared
 * `defaultHttpInstance`, which every `lark.Client` here uses (bot clients,
 * the Feishu service client, DocSync). Mutating it — rather than passing a
 * custom `httpInstance` — keeps the SDK's own interceptors intact; a custom
 * axios instance must re-implement the response-unwrap interceptor or the
 * SDK's internal tenant-token fetch destructures `code` from the wrapped
 * body and silently breaks ("code: undefined"). The returned agent must
 * additionally be passed to each `lark.WSClient`, whose `agent` option goes
 * straight to the underlying wss socket.
 *
 * Native-fetch traffic is deliberately NOT touched (no undici global
 * dispatcher): nothing in this codebase calls Feishu via fetch, and a global
 * dispatcher would also re-route peer/luckagent-core traffic out of scope.
 *
 * Unset (the default) → returns undefined and nothing is constructed.
 */
function setupFeishuLocalAddress(logger: Logger): https.Agent | undefined {
  const localAddress = process.env.LUCKAGENT_LOCAL_ADDRESS?.trim();
  if (!localAddress) return undefined;
  const agent = new https.Agent({ keepAlive: true, localAddress });
  lark.defaultHttpInstance.defaults.httpsAgent = agent;
  logger.info({ localAddress }, 'Feishu sockets bound to local address (LUCKAGENT_LOCAL_ADDRESS)');
  return agent;
}

async function startFeishuBot(botConfig: BotConfig, logger: Logger, localAgent?: https.Agent, outboundLedger?: OutboundLedger): Promise<FeishuBotHandle> {
  const botLogger = logger.child({ bot: botConfig.name });

  botLogger.info('Starting Feishu bot...');

  // Create Feishu API client
  const client = new lark.Client({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    disableTokenCache: false,
  });

  // Fetch bot info to get bot's open_id for accurate @mention detection
  let botOpenId: string | undefined;
  try {
    const botInfo: any = await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' });
    botOpenId = botInfo?.bot?.open_id;
    if (botOpenId) {
      botLogger.info({ botOpenId }, 'Bot info fetched');
    } else {
      botLogger.warn('Could not get bot open_id. Ensure the Feishu app has Bot capability enabled and the app version is published.');
    }
  } catch (err: any) {
    botLogger.warn({ err: err?.message || err }, 'Failed to fetch bot info. Check: 1) Bot capability is enabled in Feishu app 2) App is published 3) App credentials are correct');
  }

  // Create sender and bridge (FeishuSenderAdapter wraps the Feishu-specific MessageSender)
  const rawSender = new MessageSender(client, botLogger);
  // [design-note P] 出站台账：adapter 写入（记每条出站消息）、bridge 读取（引用回复解析）
  const sender = new FeishuSenderAdapter(rawSender, { ledger: outboundLedger, botName: botConfig.name });
  const bridge = new MessageBridge(botConfig, botLogger, sender, { outboundLedger });

  // Create event dispatcher wired to the bridge
  const dispatcher = createEventDispatcher(
    botConfig,
    botLogger,
    (msg) => {
      bridge.handleMessage(msg).catch((err) => {
        botLogger.error({ err, msg }, 'Unhandled error in message bridge');
      });
    },
    botOpenId,
    rawSender,
    (event) => {
      bridge.handleCardAction(event).catch((err) => {
        botLogger.error({ err, event }, 'Unhandled error in card action handler');
      });
    },
  );

  // Create WebSocket client
  const wsClient = new lark.WSClient({
    appId: botConfig.feishu.appId,
    appSecret: botConfig.feishu.appSecret,
    loggerLevel: lark.LoggerLevel.info,
    agent: localAgent,
  });

  // Start WebSocket connection with event dispatcher
  await wsClient.start({ eventDispatcher: dispatcher });

  botLogger.info('Feishu bot is running');
  botLogger.info({
    defaultWorkingDirectory: botConfig.claude.defaultWorkingDirectory,
    maxTurns: botConfig.claude.maxTurns ?? 'unlimited',
    maxBudgetUsd: botConfig.claude.maxBudgetUsd ?? 'unlimited',
  }, 'Configuration');

  return { name: botConfig.name, bridge, wsClient, config: botConfig, sender, feishuClient: client };
}

/**
 * Filter the loaded bot set by env so a SECOND luckagent instance can run just
 * one bot (e.g. to dogfood the PTY backend) without disturbing production:
 *   - LUCKAGENT_ONLY_BOTS=<a,b>    keep only these bot names (whitelist)
 *   - LUCKAGENT_EXCLUDE_BOTS=<a,b> drop these bot names (blacklist)
 * Both are comma-separated and applied across every platform array. The
 * production instance EXCLUDES the test bot; the test instance runs ONLY it
 * (on a different API_PORT). This avoids two processes fighting over one
 * bot's Feishu long-connection.
 */
function applyBotFilter(appConfig: ReturnType<typeof loadAppConfig>, logger: Logger): void {
  const parse = (v?: string) =>
    new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const only = parse(process.env.LUCKAGENT_ONLY_BOTS);
  const exclude = parse(process.env.LUCKAGENT_EXCLUDE_BOTS);
  if (only.size === 0 && exclude.size === 0) return;

  const keep = (name: string): boolean => {
    if (only.size > 0 && !only.has(name)) return false;
    if (exclude.has(name)) return false;
    return true;
  };
  const before = { feishu: appConfig.feishuBots.length };
  appConfig.feishuBots = appConfig.feishuBots.filter((b) => keep(b.name));
  logger.info(
    {
      only: [...only],
      exclude: [...exclude],
      before,
      after: { feishu: appConfig.feishuBots.length },
    },
    'Bot filter applied (LUCKAGENT_ONLY_BOTS / LUCKAGENT_EXCLUDE_BOTS)',
  );
}

async function main() {
  const appConfig = loadAppConfig();
  const logger = createLogger(appConfig.log.level);
  applyBotFilter(appConfig, logger);

  // Read (and clear) the restart breadcrumb left by `luckagent restart/update`,
  // so the first turn in each chat after a restart can be reminded not to
  // restart again. Must run before any message can be handled.
  loadRestartBreadcrumb();

  const feishuCount = appConfig.feishuBots.length;
  logger.info({ feishuBots: feishuCount }, 'Starting Luckagent bridge...');

  // Create bot registry
  const registry = new BotRegistry();

  // [design-note P] 出站消息台账——单例、全部 Feishu bot 共用（om_* 全局唯一；
  // bot_name 列区分归属，跨 bot 引用也能命中）。在 bot 启动前构造，无竞态窗口。
  const outboundLedger = new OutboundLedger(logger);

  // Must run before ANY lark.Client makes a request (token fetches included)
  // so no Feishu socket ever goes out the default route.
  const feishuLocalAgent = setupFeishuLocalAddress(logger);

  // Start bots independently so a single platform/API timeout does not
  // take down the whole Luckagent process.
  const feishuHandles = feishuCount > 0
    ? await startBotsSafely(
      appConfig.feishuBots,
      (bot) => startFeishuBot(bot, logger, feishuLocalAgent, outboundLedger),
      logger,
      'feishu',
    )
    : [];

  // Register all bots in the registry
  for (const handle of feishuHandles) {
    registry.register({
      name: handle.name,
      platform: 'feishu',
      config: handle.config,
      bridge: handle.bridge,
      sender: handle.sender,
      feishuClient: handle.feishuClient,
    });
  }

  const allNames = feishuHandles.map((h) => h.name);
  logger.info({ bots: allNames }, 'All bots started');

  // Create task scheduler
  const scheduler = new TaskScheduler(registry, logger);

  // Initialize peer manager for cross-instance bot discovery.
  // Registry mode (env LUCKAGENT_CORE_AGENT_BUS_URL or LUCKAGENT_CORE_URL — the
  // central server URL) lets the bridge boot peerManager even with zero
  // static peers — it discovers them via the central /api/agents endpoint
  // on the first poll tick. The local bot list is the full set of bots
  // configured in bots.json; visibility (per bot) is passed through to the
  // bulk-register call so `visible:false` rows are hidden in the registry.
  const localBotsForRegistry = appConfig.feishuBots.map((b) => ({ name: b.name, visible: b.visible, memoryPublic: b.memoryPublic }));
  let peerManager: PeerManager | undefined;
  if (
    appConfig.peers.length > 0 ||
    process.env.LUCKAGENT_CORE_AGENT_BUS_URL?.trim() ||
    process.env.LUCKAGENT_CORE_URL?.trim()
  ) {
    peerManager = new PeerManager(appConfig.peers, localBotsForRegistry, logger);
    await peerManager.refreshAll();
    const statuses = peerManager.getPeerStatuses();
    const healthyCount = statuses.filter((s) => s.healthy).length;
    logger.info({ peerCount: statuses.length, healthyPeers: healthyCount }, 'Peer manager initialized');
  }

  // Create a dedicated Feishu service client for wiki sync & doc reader
  let feishuServiceClient: lark.Client | undefined;
  if (appConfig.feishuService) {
    feishuServiceClient = new lark.Client({
      appId: appConfig.feishuService.appId,
      appSecret: appConfig.feishuService.appSecret,
      disableTokenCache: false,
    });
    logger.info('Feishu service client initialized (for wiki sync & doc reader)');
  }

  // Initialize wiki sync service (uses dedicated service app credentials)
  let docSync: DocSync | undefined;
  if (appConfig.feishuService && process.env.WIKI_SYNC_ENABLED !== 'false') {
    const syncMemoryClient = new MemoryClient(logger);
    const syncStateDir = process.env.WIKI_SYNC_STATE_DIR
      ? path.resolve(process.env.WIKI_SYNC_STATE_DIR)
      : path.join(process.cwd(), 'data');
    docSync = new DocSync(
      {
        feishuAppId: appConfig.feishuService.appId,
        feishuAppSecret: appConfig.feishuService.appSecret,
        databaseDir: syncStateDir,
        wikiSpaceName: process.env.WIKI_SPACE_NAME || 'MetaMemory',
        wikiSpaceId: process.env.WIKI_SPACE_ID || undefined,
        throttleMs: process.env.WIKI_SYNC_THROTTLE_MS ? parseInt(process.env.WIKI_SYNC_THROTTLE_MS, 10) : undefined,
      },
      syncMemoryClient,
      logger,
    );
    // Inject into all Feishu bot bridges
    for (const handle of feishuHandles) {
      handle.bridge.setDocSync(docSync);
    }
    logger.info('Wiki sync service initialized (manual trigger via /sync — luckagent-core writes do not auto-push)');
  }

  // Initialize cross-platform session registry
  const sessionRegistry = new SessionRegistry(logger);
  // Inject into all bot bridges
  for (const info of registry.list()) {
    const bot = registry.get(info.name);
    if (bot) bot.bridge.setSessionRegistry(sessionRegistry);
  }

  // Resolve bots config path for API-driven bot CRUD
  const botsConfigPath = process.env.BOTS_CONFIG
    ? path.resolve(process.env.BOTS_CONFIG)
    : undefined;

  // Start API server
  const apiServer = startApiServer({
    port: appConfig.api.port,
    secret: appConfig.api.secret,
    registry,
    scheduler,
    logger,
    botsConfigPath,
    docSync,
    feishuServiceClient,
    peerManager,
    sessionRegistry,
    agentTeams: appConfig.agentTeams,
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    scheduler.destroy();
    if (peerManager) {
      peerManager.destroy();
    }
    apiServer.close();
    if (docSync) {
      docSync.destroy();
    }
    sessionRegistry.close();
    outboundLedger.close(); // [design-note P]
    const teardowns: Promise<void>[] = [];
    for (const handle of feishuHandles) {
      teardowns.push(handle.bridge.destroyAsync());
    }
    // Cap teardown wait so a hung executor can't block exit indefinitely
    await Promise.race([
      Promise.allSettled(teardowns),
      new Promise((resolve) => setTimeout(resolve, 15_000)),
    ]);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function startBotsSafely<TConfig extends BotConfigBase, THandle>(
  bots: TConfig[],
  starter: (bot: TConfig) => Promise<THandle>,
  logger: Logger,
  platform: 'feishu',
): Promise<THandle[]> {
  const results = await Promise.allSettled(bots.map((bot) => starter(bot)));
  const handles: THandle[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const bot = bots[i];
    if (!result || !bot) continue;

    if (result.status === 'fulfilled') {
      handles.push(result.value);
      continue;
    }

    logger.error(
      { err: result.reason, botName: bot.name, platform },
      'Failed to start bot; continuing with remaining bots',
    );
  }

  return handles;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

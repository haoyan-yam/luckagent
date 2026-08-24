import * as fs from 'node:fs';
import type * as http from 'node:http';
import { addBot, removeBot, updateBot, getBotEntry, addPeer, removePeer } from '../bots-config-writer.js';
import { installSkillsToWorkDir } from '../skills-installer.js';
import { resolveEngineName } from '../../engines/index.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

export async function handleBotRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, logger, botsConfigPath, peerManager } = ctx;

  // GET /api/bots/:name/profile — detailed bot profile with stats
  if (method === 'GET' && /^\/api\/bots\/[^/]+\/profile$/.test(url)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    const bot = registry.get(botName);
    if (!bot) {
      jsonResponse(res, 404, { error: `Bot not found: ${botName}` });
      return true;
    }
    const stats = bot.bridge.costTracker.getStats();
    const botStats = stats.byBot[botName];
    jsonResponse(res, 200, {
      name: bot.name, description: bot.config.description, specialties: bot.config.specialties,
      icon: bot.config.icon, platform: bot.platform,
      engine: resolveEngineName(bot.config),
      model: defaultModelForConfig(bot.config),
      workingDirectory: bot.config.claude.defaultWorkingDirectory,
      maxConcurrentTasks: bot.config.maxConcurrentTasks, budgetLimitDaily: bot.config.budgetLimitDaily,
      stats: botStats || { totalTasks: 0, completedTasks: 0, failedTasks: 0, totalCostUsd: 0 },
    });
    return true;
  }

  // GET /api/bots
  if (method === 'GET' && url === '/api/bots') {
    const localBots = registry.list();
    const peerBots = peerManager?.getPeerBots() ?? [];
    jsonResponse(res, 200, { bots: [...localBots, ...peerBots] });
    return true;
  }

  // GET /api/peers
  if (method === 'GET' && url === '/api/peers') {
    jsonResponse(res, 200, { peers: peerManager?.getPeerStatuses() ?? [] });
    return true;
  }

  // POST /api/peers — add a static peer at runtime (no restart)
  if (method === 'POST' && url === '/api/peers') {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const body = await parseJsonBody(req);
    const name = (body.name as string)?.trim();
    const peerUrl = (body.url as string)?.trim();
    const secret = (body.secret as string) || undefined;
    if (!name || !peerUrl) {
      jsonResponse(res, 400, { error: 'Missing required fields: name, url' });
      return true;
    }
    if (!/^https?:\/\//i.test(peerUrl)) {
      jsonResponse(res, 400, { error: 'url must start with http:// or https://' });
      return true;
    }

    peerManager.addPeer({ name, url: peerUrl, ...(secret ? { secret } : {}) });

    // Persist to bots.json so the peer survives a restart (best-effort).
    let persisted = false;
    if (botsConfigPath) {
      try {
        addPeer(botsConfigPath, { name, url: peerUrl, ...(secret ? { secret } : {}) });
        persisted = true;
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer added in-memory but persisting to bots.json failed');
      }
    }
    logger.info({ name, url: peerUrl, persisted }, 'peer added at runtime');
    jsonResponse(res, 201, {
      name,
      url: peerUrl,
      persisted,
      message: persisted
        ? 'Peer added and persisted. Active immediately, no restart needed.'
        : 'Peer added (in-memory only — set BOTS_CONFIG to persist across restarts).',
    });
    return true;
  }

  // DELETE /api/peers/:name — remove a peer at runtime
  if (method === 'DELETE' && url.startsWith('/api/peers/')) {
    if (!peerManager) {
      jsonResponse(res, 400, { error: 'Peering is disabled (no PeerManager configured)' });
      return true;
    }
    const name = decodeURIComponent(url.slice('/api/peers/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing peer name' });
      return true;
    }
    const removed = peerManager.removePeer(name);
    let persistedRemoval = false;
    if (botsConfigPath) {
      try {
        persistedRemoval = removePeer(botsConfigPath, name);
      } catch (err: any) {
        logger.warn({ name, err: err?.message }, 'peer removed in-memory but updating bots.json failed');
      }
    }
    if (!removed && !persistedRemoval) {
      jsonResponse(res, 404, { error: `Peer not found: ${name}` });
      return true;
    }
    logger.info({ name, persistedRemoval }, 'peer removed at runtime');
    jsonResponse(res, 200, { name, removed: true });
    return true;
  }

  // POST /api/bots — create a new bot
  if (method === 'POST' && url === '/api/bots') {
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    const platform = (body.platform as string) || 'feishu';
    const name = body.name as string;

    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    if (platform !== 'feishu') {
      jsonResponse(res, 400, { error: 'platform must be "feishu"' });
      return true;
    }

    const appId = body.feishuAppId as string;
    const appSecret = body.feishuAppSecret as string;
    const workDirInput = body.defaultWorkingDirectory as string;
    if (!appId || !appSecret || !workDirInput) {
      jsonResponse(res, 400, { error: 'Feishu bot requires: feishuAppId, feishuAppSecret, defaultWorkingDirectory' });
      return true;
    }
    const entry: Record<string, unknown> = {
      name, ...(body.description ? { description: body.description } : {}),
      ...(body.engine ? { engine: body.engine } : {}),
      ...(body.codex ? { codex: body.codex } : {}),
      ...(body.kimi ? { kimi: body.kimi } : {}),
      feishuAppId: appId, feishuAppSecret: appSecret, defaultWorkingDirectory: workDirInput,
      ...(body.maxTurns ? { maxTurns: body.maxTurns } : {}),
      ...(body.maxBudgetUsd ? { maxBudgetUsd: body.maxBudgetUsd } : {}),
      ...(body.model ? { model: body.model } : {}),
      ...(body.groupOnly !== undefined ? { groupOnly: body.groupOnly } : {}),
      ...(body.groupOnlyAllowUsers ? { groupOnlyAllowUsers: body.groupOnlyAllowUsers } : {}),
      ...(body.downloadsDir ? { downloadsDir: body.downloadsDir } : {}),
    };

    try {
      const workDir = body.defaultWorkingDirectory as string;
      fs.mkdirSync(workDir, { recursive: true });

      addBot(botsConfigPath, 'feishu', entry as any);
      logger.info({ name, platform }, 'Bot added to config');

      if (body.installSkills) {
        installSkillsToWorkDir(workDir, logger, { platform: 'feishu' });
      }

      jsonResponse(res, 201, {
        name, platform, workingDirectory: workDir,
        requiresRestart: true,
        message: 'Bot added. Restart the bridge to activate it.',
      });
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        jsonResponse(res, 409, { error: err.message });
      } else {
        throw err;
      }
    }
    return true;
  }

  // PUT /api/bots/:name — update an existing bot
  if (method === 'PUT' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }
    const body = await parseJsonBody(req);
    // Strip any masked secret values so an echoed-back mask can never be
    // written into bots.json (updateBot treats ''/null as "delete this key",
    // so an unchanged secret must simply be absent from the payload).
    stripMaskedSecrets(body);
    const updated = updateBot(botsConfigPath, name, body);
    if (!updated) {
      jsonResponse(res, 404, { error: `Bot not found: ${name}` });
      return true;
    }
    logger.info({ name, updates: Object.keys(body) }, 'Bot config updated');
    jsonResponse(res, 200, { name, updated: true, requiresRestart: true, message: 'Saved. Restart the bridge to apply.' });
    return true;
  }

  // GET /api/bots/:name
  if (method === 'GET' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }

    const running = registry.get(name);
    const runningInfo = running
      ? { running: true, workingDirectory: running.config.claude.defaultWorkingDirectory }
      : { running: false };

    if (botsConfigPath) {
      const found = getBotEntry(botsConfigPath, name);
      if (found) {
        jsonResponse(res, 200, { name, platform: found.platform, ...runningInfo, config: redactBotEntry(found.entry as unknown as Record<string, unknown>) });
        return true;
      }
    }

    if (running) {
      jsonResponse(res, 200, { name, platform: running.platform, ...runningInfo });
      return true;
    }

    jsonResponse(res, 404, { error: `Bot not found: ${name}` });
    return true;
  }

  // DELETE /api/bots/:name
  if (method === 'DELETE' && url.startsWith('/api/bots/')) {
    const name = decodeURIComponent(url.slice('/api/bots/'.length));
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing bot name' });
      return true;
    }
    if (!botsConfigPath) {
      jsonResponse(res, 400, { error: 'Bot CRUD requires BOTS_CONFIG to be set' });
      return true;
    }

    const removed = removeBot(botsConfigPath, name);
    if (!removed) {
      jsonResponse(res, 404, { error: `Bot not found: ${name}` });
      return true;
    }
    registry.deregister(name);
    logger.info({ name }, 'Bot removed from config');
    jsonResponse(res, 200, { name, removed: true, requiresRestart: true, message: 'Bot removed. Restart the bridge to apply.' });
    return true;
  }

  return false;
}

/** Secret-bearing keys in a bots.json entry (top-level and nested engine blocks). */
const SECRET_KEYS = ['feishuAppSecret', 'apiKey'];
const MASK_PREFIX = '••••';

/** Mask a secret to a "set + tail" hint; never return the full value. */
function maskSecret(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return `${MASK_PREFIX}${value.slice(-4)}`;
}

/** Deep-copy a bots.json entry with every secret field replaced by a mask. */
export function redactBotEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (SECRET_KEYS.includes(k)) {
      const masked = maskSecret(v);
      if (masked !== undefined) out[k] = masked;
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactBotEntry(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Remove masked secret values from an inbound update payload (recursively).
 * A field whose value still carries the mask prefix means "unchanged" — it
 * must not reach updateBot, whose ''/null semantics would delete or corrupt
 * the stored secret.
 */
export function stripMaskedSecrets(body: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.startsWith(MASK_PREFIX)) {
      delete body[k];
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      stripMaskedSecrets(v as Record<string, unknown>);
    }
  }
}

function defaultModelForConfig(config: import('../../config.js').BotConfigBase): string | undefined {
  switch (resolveEngineName(config)) {
    case 'claude':
      return config.claude.model;
    case 'kimi':
      return config.kimi?.model;
    case 'codex':
      return config.codex?.model || config.codex?.displayModel;
  }
}

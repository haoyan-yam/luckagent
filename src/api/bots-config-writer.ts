import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BotsJsonNewFormat, FeishuBotJsonEntry, PeerJsonEntry } from '../config.js';

export function readBotsConfig(configPath: string): BotsJsonNewFormat {
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);

  // Handle old array format (backward compat)
  if (Array.isArray(parsed)) {
    return { feishuBots: parsed as FeishuBotJsonEntry[] };
  }

  return parsed as BotsJsonNewFormat;
}

export function writeBotsConfig(configPath: string, config: BotsJsonNewFormat): void {
  const json = JSON.stringify(config, null, 2) + '\n';
  const tmpPath = path.join(path.dirname(configPath), '.bots.json.tmp');
  fs.writeFileSync(tmpPath, json, { mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
}

/** Collect all bot names. */
function allBotNames(config: BotsJsonNewFormat): string[] {
  return (config.feishuBots || []).map((b) => b.name);
}

export function addBot(
  configPath: string,
  platform: 'feishu',
  entry: FeishuBotJsonEntry,
): void {
  const config = readBotsConfig(configPath);

  if (allBotNames(config).includes(entry.name)) {
    throw new Error(`Bot with name "${entry.name}" already exists`);
  }

  if (!config.feishuBots) config.feishuBots = [];
  config.feishuBots.push(entry);

  writeBotsConfig(configPath, config);
}

export function removeBot(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);

  if (config.feishuBots) {
    const idx = config.feishuBots.findIndex((b) => b.name === name);
    if (idx !== -1) {
      config.feishuBots.splice(idx, 1);
      writeBotsConfig(configPath, config);
      return true;
    }
  }

  return false;
}

export function updateBot(configPath: string, name: string, updates: Record<string, unknown>): boolean {
  const config = readBotsConfig(configPath);

  const bots = config.feishuBots;
  if (!bots) return false;
  const idx = bots.findIndex((b: any) => b.name === name);
  if (idx === -1) return false;

  // Merge updates into existing entry (name and platform credentials are immutable)
  const entry = bots[idx] as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'name' || key === 'platform') continue; // immutable
    if (value === undefined || value === null || value === '') {
      delete entry[key];
    } else {
      entry[key] = value;
    }
  }
  writeBotsConfig(configPath, config);
  return true;
}

/**
 * Add (or update by name) a static peer in the bots.json `peers[]` array so it
 * survives a bridge restart. Idempotent — re-adding an existing name updates
 * its url/secret rather than duplicating.
 */
export function addPeer(configPath: string, entry: PeerJsonEntry): void {
  const config = readBotsConfig(configPath);
  if (!config.peers) config.peers = [];
  const idx = config.peers.findIndex((p) => p.name === entry.name);
  const normalized: PeerJsonEntry = {
    name: entry.name,
    url: entry.url.replace(/\/+$/, ''),
    ...(entry.secret ? { secret: entry.secret } : {}),
  };
  if (idx !== -1) {
    config.peers[idx] = normalized;
  } else {
    config.peers.push(normalized);
  }
  writeBotsConfig(configPath, config);
}

/** Remove a peer from bots.json `peers[]` by name. Returns true if removed. */
export function removePeer(configPath: string, name: string): boolean {
  const config = readBotsConfig(configPath);
  if (!config.peers) return false;
  const idx = config.peers.findIndex((p) => p.name === name);
  if (idx === -1) return false;
  config.peers.splice(idx, 1);
  writeBotsConfig(configPath, config);
  return true;
}

export function getBotEntry(
  configPath: string,
  name: string,
): { platform: 'feishu'; entry: FeishuBotJsonEntry } | null {
  const config = readBotsConfig(configPath);

  const feishu = config.feishuBots?.find((b) => b.name === name);
  if (feishu) return { platform: 'feishu', entry: feishu };

  return null;
}

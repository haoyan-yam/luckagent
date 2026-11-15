import type { BotConfig, BotsJsonNewFormat, FeishuBotJsonEntry } from './config.js';

export const CONNECTION_PROVIDERS = ['lmuai', 'anthropic', 'deepseek', 'minimax', 'custom'] as const;
export type ConnectionProvider = typeof CONNECTION_PROVIDERS[number];

/** Stored only in the local, owner-readable bots.json. API responses omit keys. */
export interface ModelConnection {
  id: string;
  provider?: ConnectionProvider;
  importedFrom?: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  disableNonessentialTraffic?: boolean;
}

export function validateConnectionSelection(value: unknown, cfg: BotsJsonNewFormat, global = false): void {
  if (value === undefined || value === null || value === '' || value === 'local' || value === 'legacy' || (!global && value === 'inherit')) return;
  if (typeof value !== 'string' || !cfg.modelConnections?.some(c => c.id === value)) {
    throw new Error('请选择有效的模型连接');
  }
}

/** Absent fields on legacy compat bots must not opt them into a new global connection. */
export function botConnectionChoice(entry: Pick<FeishuBotJsonEntry, 'engine' | 'modelConnection'>): string {
  if (entry.modelConnection) return entry.modelConnection;
  const engine = entry.engine || process.env.LUCKAGENT_ENGINE || 'claude';
  return engine === 'deepseek' || engine === 'minimax' ? 'legacy' : 'inherit';
}

export function selectedModelConnection(entry: Pick<FeishuBotJsonEntry, 'engine' | 'modelConnection'>, cfg: BotsJsonNewFormat): string {
  const choice = botConnectionChoice(entry);
  return choice === 'inherit' ? cfg.defaultModelConnection || 'legacy' : choice;
}

export function modelConnectionEngine(connection: ModelConnection | 'local'): 'claude' | 'deepseek' | 'minimax' {
  return connection !== 'local' && (connection.provider === 'deepseek' || connection.provider === 'minimax') ? connection.provider : 'claude';
}

export function applyModelConnection(bot: BotConfig, entry: FeishuBotJsonEntry, cfg: BotsJsonNewFormat): BotConfig {
  const selected = selectedModelConnection(entry, cfg);
  if (selected === 'legacy') return bot;
  if (selected === 'local') {
    bot.engine = 'claude';
    bot.claude.connection = 'local';
    bot.claude.backend = entry.backend || 'pty';
    bot.claude.apiKey = undefined;
    bot.claude.model = entry.model || undefined;
  } else {
    const connection = cfg.modelConnections?.find(c => c.id === selected);
    if (!connection) throw new Error(`Bot "${bot.name}": 模型连接不存在`);
    bot.engine = modelConnectionEngine(connection);
    bot.claude.connection = { ...connection };
    bot.claude.apiKey = undefined;
    bot.claude.model = entry.model || connection.model;
    if (bot.engine === 'deepseek' || bot.engine === 'minimax') {
      bot.claude.backend = 'sdk';
      // Keep legacy consumers (status, /model, persistent pool) in sync with
      // the resolved connection; never merge in a different legacy key.
      bot[bot.engine] = { apiKey: connection.apiKey, baseUrl: connection.baseUrl, model: bot.claude.model };
    }
  }
  return bot;
}

export function connectionUsers(cfg: BotsJsonNewFormat, id: string): string[] {
  return (cfg.feishuBots || []).filter(b => selectedModelConnection(b, cfg) === id).map(b => b.name);
}

export function parseModelConnection(body: Record<string, unknown>, id: string, previous?: ModelConnection): ModelConnection {
  const provider = body.provider ?? previous?.provider ?? 'custom';
  if (!(CONNECTION_PROVIDERS as readonly unknown[]).includes(provider)) throw new Error('请选择有效的服务商');
  if (body.disableNonessentialTraffic !== undefined && typeof body.disableNonessentialTraffic !== 'boolean') {
    throw new Error('禁用非必要流量须为布尔值');
  }
  const disableNonessentialTraffic = body.disableNonessentialTraffic as boolean | undefined
    ?? previous?.disableNonessentialTraffic ?? false;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!name || name.length > 80) throw new Error('连接名称须为 1–80 个字符');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/.test(model)) throw new Error('请填写有效的模型 ID');
  let url: URL;
  try { url = new URL(String(body.baseUrl || '')); } catch { throw new Error('接口地址格式不正确'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址须为 HTTP(S) 地址，不能包含凭证、查询参数或锚点');
  }
  let apiKey = previous?.apiKey;
  if (body.clearApiKey === true) apiKey = undefined;
  else if (body.apiKey !== undefined && body.apiKey !== '') {
    if (typeof body.apiKey !== 'string' || !/^[\x21-\x7E]{1,4096}$/.test(body.apiKey) || body.apiKey.startsWith('••••')) {
      throw new Error('API Key 格式不正确');
    }
    apiKey = body.apiKey;
  }
  return { id, name, model, provider: provider as ConnectionProvider, ...(previous?.importedFrom ? { importedFrom: previous.importedFrom } : {}), baseUrl: url.toString().replace(/\/+$/, ''), disableNonessentialTraffic, ...(apiKey ? { apiKey } : {}) };
}

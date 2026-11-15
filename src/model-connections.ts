import type { BotConfig, BotsJsonNewFormat, FeishuBotJsonEntry } from './config.js';

/** Stored only in the local, owner-readable bots.json. API responses omit keys. */
export interface ModelConnection {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  disableNonessentialTraffic?: boolean;
}

export function validateConnectionSelection(value: unknown, cfg: BotsJsonNewFormat, global = false): void {
  if (value === undefined || value === null || value === '' || value === 'local' || (global && value === 'legacy')) return;
  if (typeof value !== 'string' || !cfg.modelConnections?.some(c => c.id === value)) {
    throw new Error('请选择有效的模型连接');
  }
}

export function applyModelConnection(bot: BotConfig, entry: FeishuBotJsonEntry, cfg: BotsJsonNewFormat): BotConfig {
  const selected = entry.modelConnection || cfg.defaultModelConnection || 'legacy';
  if (selected === 'legacy') return bot;
  if (selected === 'local') {
    bot.claude.connection = 'local';
    bot.claude.backend = entry.backend || 'pty';
    bot.claude.apiKey = undefined;
    bot.claude.model = entry.model || undefined;
  } else {
    const connection = cfg.modelConnections?.find(c => c.id === selected);
    if (!connection) throw new Error(`Bot "${bot.name}": 模型连接不存在`);
    bot.claude.connection = { ...connection };
    bot.claude.apiKey = undefined;
    bot.claude.model = entry.model || connection.model;
  }
  return bot;
}

export function connectionUsers(cfg: BotsJsonNewFormat, id: string): string[] {
  return (cfg.feishuBots || []).filter(b =>
    (b.engine || process.env.LUCKAGENT_ENGINE || 'claude') === 'claude' &&
    (b.modelConnection || cfg.defaultModelConnection || 'legacy') === id,
  ).map(b => b.name);
}

export function parseModelConnection(body: Record<string, unknown>, id: string, previous?: ModelConnection): ModelConnection {
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
  return { id, name, model, baseUrl: url.toString().replace(/\/+$/, ''), disableNonessentialTraffic, ...(apiKey ? { apiKey } : {}) };
}

import type { BotsJsonNewFormat } from '../config.js';
import type { ModelConnection } from '../model-connections.js';
import { COMPAT_PROVIDERS } from '../engines/claude/auth-env.js';

/** Server-only view of legacy credentials. Callers must remove apiKey before returning it. */
export function legacyModelConnections(cfg: BotsJsonNewFormat, env: NodeJS.ProcessEnv = process.env): Array<Omit<ModelConnection, 'id'> & { source: string }> {
  const result: Array<Omit<ModelConnection, 'id'> & { source: string }> = [];
  for (const engine of ['deepseek', 'minimax'] as const) {
    const p = COMPAT_PROVIDERS[engine];
    const prefix = engine.toUpperCase();
    const globalKey = env[p.keyEnv];
    const baseUrl = env[`${prefix}_BASE_URL`] || p.defaultBaseUrl;
    const model = env[`${prefix}_MODEL`] || p.defaultModel;
    if (globalKey || env[`${prefix}_MODEL`] || env[`${prefix}_BASE_URL`] || env.LUCKAGENT_ENGINE === engine) {
      result.push({ source: `env:${engine}`, provider: engine, name: `${p.displayName}（旧全局配置）`, baseUrl, model, apiKey: globalKey });
    }
    for (const b of cfg.feishuBots || []) {
      const block = b[engine];
      if (!block || !Object.keys(block).length) continue;
      result.push({ source: `bot:${b.name}:${engine}`, provider: engine, name: `${p.displayName}（${b.name} 旧配置）`,
        baseUrl: block.baseUrl || baseUrl, model: block.model || model, apiKey: block.apiKey || globalKey });
    }
  }
  return result;
}

export const MODEL_CONNECTION_PRESETS = [
  { provider: 'lmuai', name: '灵眸', baseUrl: 'https://api.lmuai.ai', model: '' },
  ...Object.values(COMPAT_PROVIDERS).map(p => ({ provider: p.engine, name: p.displayName, baseUrl: p.defaultBaseUrl, model: p.defaultModel })),
  { provider: 'anthropic', name: 'Anthropic API', baseUrl: 'https://api.anthropic.com', model: '' },
  { provider: 'custom', name: '自定义兼容接口', baseUrl: '', model: '' },
];

import type { BotConfigBase } from '../../config.js';

/**
 * Anthropic-compatible endpoint providers. Each runs through the SAME Claude
 * Code runtime — engine choice only decides which endpoint/key/models get
 * injected. All entries were verified live through the four-gate battery:
 * basic messages / thinking+tool_use loop / vision / a full agent turn with
 * tools writing to disk through our engine path.
 */
export interface CompatProvider {
  /** engine value in bots.json */
  engine: 'deepseek' | 'minimax';
  displayName: string;
  defaultBaseUrl: string;
  defaultModel: string;
  /** UI picker entries (id + short zh note). */
  models: Array<{ id: string; note: string }>;
  /** Global env var carrying the API key. */
  keyEnv: string;
  applyUrl: string;
  /** Whether the DEFAULT model natively understands images. */
  visionNative: boolean;
}

export const COMPAT_PROVIDERS: Record<'deepseek' | 'minimax', CompatProvider> = {
  deepseek: {
    engine: 'deepseek',
    displayName: 'DeepSeek',
    defaultBaseUrl: 'https://api.deepseek.com/anthropic',
    defaultModel: 'deepseek-v4-flash',
    models: [
      { id: 'deepseek-v4-flash', note: '快 · 便宜 · 默认' },
      { id: 'deepseek-v4-pro', note: '更强推理' },
    ],
    keyEnv: 'DEEPSEEK_API_KEY',
    applyUrl: 'https://platform.deepseek.com',
    visionNative: true,
  },
  minimax: {
    engine: 'minimax',
    displayName: 'MiniMax',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3',
    models: [
      { id: 'MiniMax-M3', note: '旗舰 · 原生看图 · 默认' },
      { id: 'MiniMax-M2.5', note: '上一代 · 更省' },
    ],
    keyEnv: 'MINIMAX_API_KEY',
    applyUrl: 'https://platform.minimaxi.com',
    visionNative: true,
  },
};

export function compatProviderFor(engine: string | undefined): CompatProvider | undefined {
  return engine === 'deepseek' || engine === 'minimax' ? COMPAT_PROVIDERS[engine] : undefined;
}

export const DEEPSEEK_DEFAULT_BASE_URL = COMPAT_PROVIDERS.deepseek.defaultBaseUrl;
export const DEEPSEEK_DEFAULT_MODEL = COMPAT_PROVIDERS.deepseek.defaultModel;
// vision-exp is a valid endpoint id but intentionally absent from UI pickers.
export const DEEPSEEK_KNOWN_MODELS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];

/**
 * Auth-related env vars to inject into the spawned Claude Code process for
 * this bot config. Injected AFTER the machine-level auth vars are filtered,
 * so per-bot credentials deterministically win over any host login /
 * apiKeyHelper / global ANTHROPIC_* env.
 *
 * - engine 'deepseek' → BASE_URL + BOTH key vars set to the DeepSeek key
 *   (setting only AUTH_TOKEN is not enough on hosts with a Claude login —
 *   the CLI may resolve auth from its own config first; observed live).
 * - engine 'claude' with an explicit bots.json apiKey → ANTHROPIC_API_KEY.
 * - otherwise → undefined (Claude Code resolves auth itself: OAuth login,
 *   env passthrough, apiKeyHelper …).
 */
export function resolveClaudeAuthEnv(config: BotConfigBase): Record<string, string> | undefined {
  const provider = compatProviderFor(config.engine);
  if (provider) {
    const block = provider.engine === 'minimax' ? config.minimax : config.deepseek;
    const key = block?.apiKey || process.env[provider.keyEnv];
    if (!key) {
      throw new Error(
        `Bot "${config.name}": engine is '${provider.engine}' but no API key configured — set bots.json ${provider.engine}.apiKey or env ${provider.keyEnv} (get one at ${provider.applyUrl})`,
      );
    }
    return {
      ANTHROPIC_BASE_URL: block?.baseUrl || provider.defaultBaseUrl,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: key,
    };
  }
  if (config.claude.apiKey) {
    return { ANTHROPIC_API_KEY: config.claude.apiKey };
  }
  return undefined;
}

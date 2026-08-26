import type { BotConfigBase } from '../../config.js';

/**
 * DeepSeek runs through the Claude engine pointed at DeepSeek's official
 * Anthropic-compatible endpoint (no extra CLI — key only). Verified live:
 * messages / thinking+tool_use / vision blocks all speak the Anthropic
 * protocol, and a full Claude Code agent turn completes end-to-end.
 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic';
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
// vision-exp is a valid endpoint id but intentionally absent from UI pickers:
// flash/pro are natively multimodal (verified through the Read-tool chain),
// so the experimental vision variant has no daily-use role.
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
  if (config.engine === 'deepseek') {
    const key = config.deepseek?.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!key) {
      throw new Error(
        `Bot "${config.name}": engine is 'deepseek' but no API key configured — set bots.json deepseek.apiKey or env DEEPSEEK_API_KEY (get one at https://platform.deepseek.com)`,
      );
    }
    return {
      ANTHROPIC_BASE_URL: config.deepseek?.baseUrl || DEEPSEEK_DEFAULT_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: key,
      ANTHROPIC_API_KEY: key,
    };
  }
  if (config.claude.apiKey) {
    return { ANTHROPIC_API_KEY: config.claude.apiKey };
  }
  return undefined;
}

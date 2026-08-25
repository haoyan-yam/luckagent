import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Engine, EngineName } from './types.js';
import { ClaudeEngine } from './claude/index.js';
import { DEEPSEEK_DEFAULT_MODEL } from './claude/auth-env.js';
import { KimiEngine } from './kimi/index.js';
import { CodexEngine } from './codex/index.js';

/**
 * Create an Engine for the given bot config.
 *
 * Engine selection:
 *   1. `config.engine` field (explicit)
 *   2. `LUCKAGENT_ENGINE` env var (global default)
 *   3. `'codex'` (fallback)
 */
export function createEngine(
  config: BotConfigBase,
  logger: Logger,
  override?: EngineName,
): Engine {
  const name = override ?? resolveEngineName(config);
  switch (name) {
    case 'claude':
      return new ClaudeEngine(config, logger);
    case 'kimi':
      return new KimiEngine(config, logger);
    case 'codex':
      return new CodexEngine(config, logger);
    case 'deepseek': {
      // DeepSeek = Claude engine + DeepSeek's Anthropic-compatible endpoint.
      // Derive a config whose claude.model defaults to the DeepSeek model;
      // credentials/baseUrl are injected per-spawn via resolveClaudeAuthEnv.
      const derived: BotConfigBase = {
        ...config,
        claude: {
          ...config.claude,
          model: config.deepseek?.model || DEEPSEEK_DEFAULT_MODEL,
          apiKey: undefined,
        },
      };
      return new ClaudeEngine(derived, logger);
    }
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown engine: ${_exhaustive}`);
    }
  }
}

/** Resolve the default engine for a bot config (no session override). */
export function resolveEngineName(config: BotConfigBase): EngineName {
  const explicit = config.engine;
  if (explicit) return explicit;
  const envDefault = process.env.LUCKAGENT_ENGINE as EngineName | undefined;
  if (envDefault === 'claude' || envDefault === 'kimi' || envDefault === 'codex' || envDefault === 'deepseek') return envDefault;
  return 'claude';
}

export type { Engine, EngineName, Executor } from './types.js';
export { ClaudeEngine } from './claude/index.js';
export { KimiEngine } from './kimi/index.js';
export { CodexEngine } from './codex/index.js';

// Re-export shared types and classes currently used by the bridge and web/api layers.
// Moving these behind the engine boundary lets consumers import from a single place.
export {
  ClaudeExecutor,
  DEFAULT_CODEX_GOAL_MAX_ITERATIONS,
  StreamProcessor,
  SessionManager,
  extractImagePaths,
} from './claude/index.js';
export type {
  UserSession,
  SDKMessage,
  ExecutionHandle,
  ExecutorOptions,
  ApiContext,
  DetectedTool,
  TeamEvent,
} from './claude/index.js';

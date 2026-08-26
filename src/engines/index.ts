import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type { Engine, EngineName } from './types.js';
import { ClaudeEngine } from './claude/index.js';
import { DEEPSEEK_DEFAULT_MODEL } from './claude/auth-env.js';

/**
 * Create an Engine for the given bot config.
 *
 * Engine selection:
 *   1. `config.engine` field (explicit)
 *   2. `LUCKAGENT_ENGINE` env var (global default)
 *   3. `'claude'` (fallback)
 */
export function createEngine(
  config: BotConfigBase,
  logger: Logger,
  override?: EngineName,
): Engine {
  const name = override ?? resolveEngineName(config);
  switch (name) {
    case 'claude':
      // Pin the engine field to the RESOLVED name: a session override
      // (/model claude on a deepseek bot) must not inherit the bot-level
      // engine field, or auth-env resolution would inject the wrong backend.
      return new ClaudeEngine({ ...config, engine: 'claude' }, logger);
    case 'deepseek':
      return new ClaudeEngine(deriveDeepseekConfig(config), logger);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown engine: ${_exhaustive}`);
    }
  }
}

/**
 * DeepSeek = Claude engine + DeepSeek's Anthropic-compatible endpoint.
 * Derivation rules (exported for tests):
 *  - engine pinned to 'deepseek' (session overrides must not inherit the
 *    bot-level engine field — auth-env resolution keys off it);
 *  - claude.model defaults to the DeepSeek model;
 *  - backend forced to 'sdk': the PTY backend spawns the `claude` CLI binary,
 *    which a zero-install DeepSeek machine doesn't have (and PTY's
 *    subscription-billing rationale doesn't apply to DeepSeek);
 *  - credentials/baseUrl are injected per-spawn via resolveClaudeAuthEnv.
 */
export function deriveDeepseekConfig(config: BotConfigBase): BotConfigBase {
  return {
    ...config,
    engine: 'deepseek',
    claude: {
      ...config.claude,
      model: config.deepseek?.model || DEEPSEEK_DEFAULT_MODEL,
      apiKey: undefined,
      backend: 'sdk',
    },
  };
}

/** Resolve the default engine for a bot config (no session override). */
export function resolveEngineName(config: BotConfigBase): EngineName {
  const explicit = config.engine;
  if (explicit) return explicit;
  const envDefault = process.env.LUCKAGENT_ENGINE as EngineName | undefined;
  if (envDefault === 'claude' || envDefault === 'deepseek') return envDefault;
  return 'claude';
}

export type { Engine, EngineName, Executor } from './types.js';
export { ClaudeEngine } from './claude/index.js';

// Re-export shared types and classes currently used by the bridge and web/api layers.
// Moving these behind the engine boundary lets consumers import from a single place.
export {
  ClaudeExecutor,
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

import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import type {
  ClaudeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
  TeamEvent,
} from './claude/executor.js';
import type { StreamProcessor } from './claude/stream-processor.js';

export type EngineName = 'claude' | 'deepseek';

/**
 * An Engine is a programmable agent backend (Claude Code, or Claude Code
 * pointed at DeepSeek's Anthropic-compatible endpoint).
 * It produces an Executor that the bridge drives for a single chat session.
 *
 * In Phase 1 we only ship the Claude implementation; the interface lets us
 * drop in another implementation without touching the bridge.
 */
export interface Engine {
  readonly name: EngineName;
  /** Returns the executor used to run queries for this engine. */
  createExecutor(): Executor;
  /** Returns the StreamProcessor class used to process engine messages into CardState. */
  createStreamProcessor(userPrompt: string): StreamProcessorLike;
}

/**
 * Executor abstraction. Both engines must support the multi-turn
 * `startExecution` path (streaming + sendAnswer + resolveQuestion + finish)
 * and the one-shot `execute` path used by voice mode.
 *
 * Phase 1 aliases these to the Claude types. Phase 2 will generalise
 * SDKMessage into a union (EngineMessage) with engine-specific events.
 */
export interface Executor {
  startExecution(options: ExecutorOptions): ExecutionHandle;
  execute(options: ExecutorOptions): AsyncGenerator<SDKMessage>;
}

export type StreamProcessorLike = StreamProcessor;

export type {
  ClaudeExecutor,
  ExecutionHandle,
  ExecutorOptions,
  SDKMessage,
  ApiContext,
  TeamEvent,
};

/** Context passed to engine factory. */
export interface EngineContext {
  config: BotConfigBase;
  logger: Logger;
}

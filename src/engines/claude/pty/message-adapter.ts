/**
 * PTY backend — message adapter.
 *
 * Translates raw JSONL records from an interactive Claude session into the
 * in-repo {@link SDKMessage} shape consumed by stream-processor.ts.
 *
 * Key mappings:
 *   - `type:'assistant'` records → SDKMessage with content blocks preserved
 *   - `type:'user'` records (tool_result) → SDKMessage type:'user' (stream-processor
 *     doesn't branch on 'user', but we forward for completeness / future use)
 *   - `type:'system'` records → SDKMessage type:'system' with subtype
 *   - Noise records (file-history-snapshot, queue-operation, progress, last-prompt) → null
 *   - synthesizeResult() builds a terminal `type:'result'` SDKMessage
 */

import type { SDKMessage } from '../executor.js';
import type { AdaptJsonlRecord, SynthesizeResult, RawJsonlRecord } from './contract.js';

/**
 * Record types that should be silently dropped — they carry no information
 * the stream-processor needs.
 */
const DROP_TYPES = new Set([
  'file-history-snapshot',
  'queue-operation',
  'last-prompt',
  'progress',
  'summary',
]);

/**
 * Map a single raw JSONL record to zero, one, or multiple SDKMessages.
 */
export const adaptJsonlRecord: AdaptJsonlRecord = (
  record: RawJsonlRecord,
): SDKMessage | SDKMessage[] | null => {
  const recType = record.type as string | undefined;
  if (!recType || DROP_TYPES.has(recType)) return null;

  const sessionId = (record.sessionId ?? record.session_id) as string | undefined;

  if (recType === 'assistant') {
    return adaptAssistant(record, sessionId);
  }

  if (recType === 'user') {
    return adaptUser(record, sessionId);
  }

  if (recType === 'system') {
    return adaptSystem(record, sessionId);
  }

  // Unknown type — drop.
  return null;
};

// ── Assistant records ────────────────────────────────────────────────────────

function adaptAssistant(
  record: RawJsonlRecord,
  sessionId: string | undefined,
): SDKMessage | null {
  const msg = record.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const rawContent = msg.content;
  if (!Array.isArray(rawContent)) return null;

  // Map content blocks — keep only the fields SDKMessage.message.content expects.
  const content = rawContent
    .map(mapContentBlock)
    .filter((b): b is NonNullable<typeof b> => b !== null);

  if (content.length === 0) return null;

  return {
    type: 'assistant',
    uuid: record.uuid as string | undefined,
    session_id: sessionId,
    parent_tool_use_id: (record.parentToolUseID as string | undefined) ?? null,
    message: { content },
  };
}

// ── User records (tool_result / task notification) ───────────────────────────

function adaptUser(
  record: RawJsonlRecord,
  sessionId: string | undefined,
): SDKMessage | null {
  const msg = record.message as Record<string, unknown> | undefined;
  if (!msg) return null;

  const rawContent = msg.content;
  // User message content can be a plain string (initial prompt) or blocks array.
  if (typeof rawContent === 'string') {
    // Initial user prompt — stream-processor doesn't consume 'user' type, but
    // we forward it so session_id is captured early.
    return {
      type: 'user',
      session_id: sessionId,
      parent_tool_use_id: (record.parentToolUseID as string | undefined) ?? null,
      message: {
        content: [{ type: 'text', text: rawContent }],
      },
    };
  }

  if (!Array.isArray(rawContent)) return null;

  const content = rawContent
    .map(mapContentBlock)
    .filter((b): b is NonNullable<typeof b> => b !== null);

  if (content.length === 0) return null;

  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: (record.parentToolUseID as string | undefined) ?? null,
    message: { content },
  };
}

// ── System records ───────────────────────────────────────────────────────────

function adaptSystem(
  record: RawJsonlRecord,
  sessionId: string | undefined,
): SDKMessage | null {
  const subtype = record.subtype as string | undefined;
  // System records without a meaningful subtype are noise (e.g. stop_hook_summary).
  if (!subtype) return null;

  return {
    type: 'system',
    subtype,
    session_id: sessionId,
  };
}

// ── Content block mapper ─────────────────────────────────────────────────────

/**
 * Map a raw content block to the shape expected by SDKMessage.message.content.
 * Keeps: type, text, name, id, input (for tool_use), tool_use_id + content (for tool_result).
 * Drops: thinking blocks (not part of the SDKMessage contract), unknown shapes.
 */
function mapContentBlock(
  block: unknown,
): { type: string; text?: string; name?: string; id?: string; input?: unknown } | null {
  if (!block || typeof block !== 'object') return null;
  const b = block as Record<string, unknown>;
  const blockType = b.type as string | undefined;
  if (!blockType) return null;

  switch (blockType) {
    case 'text':
      return { type: 'text', text: (b.text as string) ?? '' };

    case 'tool_use':
      return {
        type: 'tool_use',
        id: b.id as string | undefined,
        name: b.name as string | undefined,
        input: b.input,
      };

    case 'tool_result':
      // tool_result blocks live inside user messages. The stream-processor
      // handles them in processAssistantMessage (completeCurrentTool).
      return {
        type: 'tool_result',
        text: typeof b.content === 'string' ? b.content : undefined,
      };

    case 'thinking':
      // Thinking blocks are not part of the SDKMessage contract — drop.
      return null;

    default:
      // Pass through unknown block types with minimal fields.
      return { type: blockType, text: b.text as string | undefined };
  }
}

// ── Result synthesis ─────────────────────────────────────────────────────────

/**
 * Build a synthetic terminal `result` SDKMessage. Interactive Claude's JSONL
 * has no explicit result line — this is synthesized when the Stop hook fires.
 */
export const synthesizeResult: SynthesizeResult = (args) => {
  const msg: SDKMessage = {
    type: 'result',
    subtype: args.isError ? 'error' : 'success',
    session_id: args.sessionId,
    result: args.resultText ?? '',
    is_error: args.isError ?? false,
    num_turns: args.numTurns,
  };

  if (args.usage) {
    if (args.usage.costUSD !== undefined) {
      msg.total_cost_usd = args.usage.costUSD;
    }
    // modelUsage expects a per-model breakdown. The consumer
    // (processResultMessage) picks the model with the highest cost and surfaces
    // that key as the displayed model name — so use the REAL model captured off
    // the assistant jsonl records, falling back to a placeholder only if unknown.
    if (args.usage.inputTokens !== undefined || args.usage.outputTokens !== undefined) {
      msg.modelUsage = {
        [args.model || 'unknown']: {
          inputTokens: args.usage.inputTokens ?? 0,
          outputTokens: args.usage.outputTokens ?? 0,
          contextWindow: 200000,
          costUSD: args.usage.costUSD ?? 0,
        },
      };
    }
  }

  return msg;
};

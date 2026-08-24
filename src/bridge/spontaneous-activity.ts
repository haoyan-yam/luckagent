import {
  SPONTANEOUS_BODY_MAX_CHARS,
  SPONTANEOUS_SNIPPET_MAX_CHARS,
} from './bridge-constants.js';

/**
 * Extract a user-readable assistant text snippet for between-turn activity cards.
 * Tool/result events are intentionally ignored to avoid repeating implementation noise.
 */
export function extractSpontaneousSnippet(msg: unknown): string | null {
  const m = msg as { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string }> } };
  if (m?.type !== 'assistant' || !m.message?.content) return null;
  for (const blk of m.message.content) {
    if (blk.type === 'text' && blk.text) {
      const trimmed = String(blk.text).trim();
      if (!trimmed) continue;
      if (trimmed.length <= SPONTANEOUS_SNIPPET_MAX_CHARS) return trimmed;
      return trimmed.slice(0, SPONTANEOUS_SNIPPET_MAX_CHARS) + '…';
    }
  }
  return null;
}

export function formatSpontaneousCardBody(snippets: string[]): string {
  if (snippets.length === 0) return '';
  if (snippets.length === 1) return snippets[0];

  const sep = '\n\n---\n\n';
  const kept: string[] = [];
  let total = 0;
  let droppedCount = 0;
  for (let i = snippets.length - 1; i >= 0; i--) {
    const next = snippets[i];
    const cost = next.length + (kept.length > 0 ? sep.length : 0);
    if (total + cost > SPONTANEOUS_BODY_MAX_CHARS) {
      droppedCount = i + 1;
      break;
    }
    kept.unshift(next);
    total += cost;
  }
  const body = kept.join(sep);
  if (droppedCount > 0) {
    const noun = droppedCount === 1 ? 'event' : 'events';
    return `_(${droppedCount} earlier ${noun} omitted; ${kept.length} shown)_\n\n` + body;
  }
  return body;
}

import type { EngineName } from '../engines/index.js';

const CODEX_BRIDGE_COMMANDS = new Set(['goal', 'background', 'bg']);

export function normalizePromptForEngine(text: string, engine: EngineName): string {
  if (engine !== 'codex') return text;
  const match = text.match(/^\/([A-Za-z0-9][A-Za-z0-9_-]*)([\s\S]*)$/);
  if (!match) return text;
  if (CODEX_BRIDGE_COMMANDS.has(match[1].toLowerCase())) return text;
  const suffix = match[2] ?? '';
  if (suffix && !/^\s/.test(suffix)) return text;
  return `$${match[1]}${suffix}`;
}

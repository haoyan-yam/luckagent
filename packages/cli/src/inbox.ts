/**
 * `luckagent inbox` subcommands.
 *
 *   luckagent inbox register [--bot-name <name>]
 *   luckagent inbox project-id
 *   luckagent inbox peek    [--chat <id>] [--all-chats] [--limit 20]
 *   luckagent inbox poll    [--chat <id>] [--wait 30] [--once|--loop]
 *   luckagent inbox clear   [--chat <id>] [--all-chats]
 *
 * Wire shapes match `packages/server/src/agents/inbox-routes.ts`. Without an
 * explicit `--chat`, `peek`, `poll`, and `clear` use the cwd-derived chatId
 * (`deriveProjectChatId`) so each project directory is its own conversation
 * thread for CC/Codex users. `--all-chats` opts into the cross-chat view.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseArgs, print, loadConfig } from '@luckagent/cli-core';
import { deriveProjectChatId } from './project-id.js';

interface BusConfig {
  url: string;
  token: string;
}

function readTokenFile(): string {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.luckagent-core', 'token'), 'utf8');
    return raw.split(/\r?\n/)[0]?.trim() || '';
  } catch {
    return '';
  }
}

function loadBusConfig(): BusConfig {
  const env = process.env;
  const overrideUrl = (env.LUCKAGENT_CORE_AGENT_BUS_URL || '').trim();
  if (overrideUrl) {
    const token = (env.LUCKAGENT_CORE_TOKEN || '').trim() || readTokenFile();
    if (!token) {
      throw new Error(
        'no token configured — set LUCKAGENT_CORE_TOKEN env var, or write the token to ~/.luckagent-core/token',
      );
    }
    return { url: overrideUrl.replace(/\/+$/, ''), token };
  }
  const cfg = loadConfig();
  return { url: cfg.url, token: cfg.token };
}

interface WhoamiResponse {
  botName: string;
  ownerName: string;
  role: string;
  authSource: string;
  credentialId: string;
}

async function busRequest<T = unknown>(
  cfg: BusConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + apiPath, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave raw */ }
  }
  return { status: res.status, body: parsed as T };
}

async function busRequestOk<T = unknown>(
  cfg: BusConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  apiPath: string,
  body?: unknown,
): Promise<T> {
  const { status, body: respBody } = await busRequest<T>(cfg, method, apiPath, body);
  if (status < 200 || status >= 300) {
    const errMsg = typeof respBody === 'object' && respBody && 'error' in (respBody as Record<string, unknown>)
      ? String((respBody as unknown as { error: unknown }).error)
      : String(respBody);
    throw new Error(`luckagent-core ${method} ${apiPath} → ${status}: ${errMsg}`);
  }
  return respBody;
}

function defaultInboxBotName(whoami: WhoamiResponse): string {
  const owner = whoami.ownerName || whoami.botName || 'anon';
  const host = os.hostname().split('.')[0] || 'host';
  return `cli:${owner}@${host}`;
}

function usage(): string {
  return `luckagent inbox — central agent-bus inbox for CLI users.

CC/Codex have no resident bridge to accept /api/talk, so messages addressed
to a CLI bot are spooled centrally and drained via long-poll. Each project
directory (cwd) defaults to its own chatId for thread isolation.

Subcommands:
  register [--bot-name <name>]      Register an inbox-only agent. Without
                                    --bot-name, defaults to
                                    \`cli:<ownerName>@<hostname>\`. Registers
                                    with \`url: 'inbox:'\` so senders route
                                    through the central inbox.
  project-id                        Print the cwd-derived chatId.
  peek    [--chat <id>] [--all-chats] [--limit 20]
                                    Show queued messages (does NOT pop).
                                    Without --chat or --all-chats, filters by
                                    the cwd chatId.
  poll    [--chat <id>] [--wait 30] [--once|--loop]
                                    Atomically pop the oldest queued message,
                                    long-polling up to --wait seconds. --once
                                    is the default; --loop keeps draining.
                                    Each message is printed as one JSON line
                                    on stdout (pipeline-friendly).
  clear   [--chat <id>] [--all-chats]
                                    Delete queued messages. Defaults to the
                                    cwd chatId; --all-chats wipes every chat.

Flags:
  --bot-name <name>   target bot for register / peek / poll / clear
                      (peek/poll/clear default to your own bot via /api/whoami)
  --chat <id>         explicit chatId (skip cwd default)
  --all-chats         act across every chatId for this bot
  --limit <n>         peek: max rows (default 20, hard cap 200)
  --wait <s>          poll: long-poll wait in seconds (default 30, hard cap 60)
  --once|--loop       poll: single shot vs continuous drain

Env:
  LUCKAGENT_CORE_URL              luckagent-core base URL (default http://localhost:9200)
  LUCKAGENT_CORE_AGENT_BUS_URL    override the inbox base URL (falls back to LUCKAGENT_CORE_URL)
  LUCKAGENT_CORE_TOKEN            bearer token (or ~/.luckagent-core/token)
`;
}

async function cmdRegister(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  let botName = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  if (!botName) {
    const whoami = await busRequestOk<WhoamiResponse>(cfg, 'GET', '/api/whoami');
    botName = defaultInboxBotName(whoami);
  }
  const resp = await busRequestOk(cfg, 'POST', '/api/agents', {
    botName,
    url: 'inbox:',
    visible: true,
  });
  print(resp);
}

function cmdProjectId(): void {
  process.stdout.write(deriveProjectChatId() + '\n');
}

async function resolveTargetBotName(cfg: BusConfig, flags: Record<string, string | true>): Promise<string> {
  const explicit = typeof flags['bot-name'] === 'string' ? flags['bot-name'].trim() : '';
  if (explicit) return explicit;
  const whoami = await busRequestOk<WhoamiResponse>(cfg, 'GET', '/api/whoami');
  if (whoami.botName) return whoami.botName;
  throw new Error(
    'no bot-name resolved — pass --bot-name <name> (your token does not map to a registered bot)',
  );
}

function resolveChatFlag(flags: Record<string, string | true>): { chatId?: string; explicit: boolean } {
  if (flags['all-chats']) return { chatId: undefined, explicit: true };
  const explicit = typeof flags.chat === 'string' ? flags.chat.trim() : '';
  if (explicit) return { chatId: explicit, explicit: true };
  return { chatId: deriveProjectChatId(), explicit: false };
}

async function cmdPeek(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  const botName = await resolveTargetBotName(cfg, flags);
  const { chatId, explicit } = resolveChatFlag(flags);
  if (!explicit) {
    process.stderr.write(`→ using project-derived chatId: ${chatId}\n`);
  }
  const limitRaw = typeof flags.limit === 'string' ? Number(flags.limit) : NaN;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.floor(limitRaw)) : 20;
  const qs = new URLSearchParams({ limit: String(limit) });
  if (chatId !== undefined) qs.set('chatId', chatId);
  const resp = await busRequestOk(
    cfg, 'GET', `/api/inbox/${encodeURIComponent(botName)}?${qs.toString()}`,
  );
  print(resp);
}

async function cmdClear(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  const botName = await resolveTargetBotName(cfg, flags);
  const { chatId, explicit } = resolveChatFlag(flags);
  if (!explicit) {
    process.stderr.write(`→ using project-derived chatId: ${chatId}\n`);
  }
  const qs = new URLSearchParams();
  if (chatId !== undefined) qs.set('chatId', chatId);
  const apiPath = `/api/inbox/${encodeURIComponent(botName)}${qs.toString() ? '?' + qs.toString() : ''}`;
  const resp = await busRequestOk(cfg, 'DELETE', apiPath);
  print(resp);
}

interface PollMessage {
  id: string;
  targetBot: string;
  chatId: string;
  fromBot: string | null;
  fromOwner: string;
  content: string;
  enqueuedAt: string;
}

interface PollResponse {
  message: PollMessage | null;
  waitedMs?: number;
}

async function cmdPoll(args: string[]): Promise<void> {
  const { flags } = parseArgs(args);
  const cfg = loadBusConfig();
  const botName = await resolveTargetBotName(cfg, flags);
  const { chatId, explicit } = resolveChatFlag(flags);
  if (!explicit) {
    process.stderr.write(`→ using project-derived chatId: ${chatId}\n`);
  }
  const waitRaw = typeof flags.wait === 'string' ? Number(flags.wait) : NaN;
  const waitSec = Number.isFinite(waitRaw) ? Math.max(0, Math.min(60, Math.floor(waitRaw))) : 30;
  const loop = flags.loop === true;
  // --once is implicit when --loop is not set; surface as a no-op for clarity.

  const qs = new URLSearchParams({ wait: String(waitSec) });
  if (chatId !== undefined) qs.set('chatId', chatId);
  const apiPath = `/api/inbox/${encodeURIComponent(botName)}/poll?${qs.toString()}`;

  // SIGINT handling: in --loop mode, let Ctrl-C exit cleanly without a Node
  // stacktrace. The default handler is fine for --once.
  if (loop) {
    const onSig = (): void => { process.exit(0); };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  }

  do {
    const resp = await busRequestOk<PollResponse>(cfg, 'POST', apiPath);
    if (resp.message) {
      // One JSON line per message → pipe-friendly.
      process.stdout.write(JSON.stringify(resp.message) + '\n');
    } else if (!loop) {
      // Single-shot timeout: emit a marker line so callers can distinguish
      // empty-poll from "errored before responding".
      process.stdout.write(JSON.stringify({ message: null, waitedMs: resp.waitedMs ?? 0 }) + '\n');
    }
  } while (loop);
}

export async function run(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(usage());
    return;
  }
  switch (sub) {
    case 'register':
      return cmdRegister(rest);
    case 'project-id':
      return cmdProjectId();
    case 'peek':
      return cmdPeek(rest);
    case 'poll':
      return cmdPoll(rest);
    case 'clear':
      return cmdClear(rest);
    default:
      process.stderr.write(`luckagent inbox: unknown subcommand '${sub}'\n\n`);
      process.stdout.write(usage());
      process.exit(2);
  }
}

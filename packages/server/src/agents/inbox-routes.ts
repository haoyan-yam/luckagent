import type * as http from 'node:http';
import type { Credential } from '../auth/credentials.js';
import type { AgentStore } from './agent-store.js';
import type { InboxStore, InboxMessage } from './inbox-store.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

/**
 * Ownership check shared by poll/peek/clear: the credential must own the
 * target bot, or be admin. Mirrors the inline ownership pattern in
 * `agent-routes.ts` rather than introducing a helper used in only one file.
 */
function ownsBot(agents: AgentStore, botName: string, cred: Credential): boolean {
  if (cred.role === 'admin') return true;
  const rec = agents.getByName(botName);
  if (!rec) return false;
  if (rec.ownerCredentialId === cred.id) return true;
  // Same-human-different-machine: the user-level owner-bypass that already
  // governs `listAgents` and the memory ACL. A second cred under the same
  // ownerName can drain the inbox of a bot it doesn't directly own.
  if (cred.ownerName && rec.ownerName && rec.ownerName === cred.ownerName) return true;
  return false;
}

function publicShape(msg: InboxMessage) {
  return {
    id: msg.id,
    targetBot: msg.targetBot,
    chatId: msg.chatId,
    fromBot: msg.fromBot,
    fromOwner: msg.fromOwner,
    content: msg.content,
    enqueuedAt: msg.enqueuedAt,
  };
}

/**
 * POST /api/inbox/:botName — enqueue a message addressed to `botName`.
 *
 * Any valid Bearer can enqueue (the credential must exist and be non-revoked,
 * which `authenticate` already enforces upstream). We do NOT require the
 * caller to own `botName` — that's the whole point of an inbox: a stranger
 * sends mail to you. The target bot's owner drains it via `/poll`.
 *
 * Server stamps `fromBot/fromOwner/fromCredentialId` from `cred`; any
 * matching fields in the request body are ignored (anti-spoof).
 */
export function enqueueInbox(
  inbox: InboxStore,
  agents: AgentStore,
  botName: string,
  body: Record<string, unknown>,
  cred: Credential,
): RouteResult {
  if (!botName) return err(400, 'bot_name_required');
  // Allow enqueueing to a bot that hasn't registered yet — registration is
  // an opt-in flag on the wire, not a precondition for receiving. We DO
  // check for registration when the bot is known so we can return a friendly
  // 404 instead of silently spooling; but in tests the registry can be
  // empty by design, so the 404 only fires when at least one bot exists.
  const known = agents.getByName(botName);
  if (!known) return err(404, 'agent_not_found');

  const content = typeof body.content === 'string' ? body.content : '';
  if (!content) return err(400, 'content_required');
  const chatId = typeof body.chatId === 'string' ? body.chatId : '';
  // Cred.botName is empty for the bootstrap admin (no bot). Surface that as
  // `fromBot=null` rather than empty-string so the consumer can render
  // "system" cleanly.
  const fromBot = cred.botName ? cred.botName : null;

  const msg = inbox.enqueue({
    targetBot: botName,
    chatId,
    fromBot,
    fromOwner: cred.ownerName || '',
    fromCredentialId: cred.id,
    content,
  });
  return {
    status: 201,
    body: { message: publicShape(msg) },
  };
}

/**
 * GET /api/inbox/:botName — peek (does not delete).
 * Owner of `botName` (or admin) only. Returns up to `limit` (default 20,
 * max 200) oldest messages, optionally filtered by `chatId`.
 */
export function peekInbox(
  inbox: InboxStore,
  agents: AgentStore,
  botName: string,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  if (!ownsBot(agents, botName, cred)) return err(403, 'inbox_ownership_required');
  const chatIdRaw = query.get('chatId');
  const chatId = chatIdRaw === null ? undefined : chatIdRaw;
  const limitRaw = query.get('limit');
  const limit = limitRaw ? Number(limitRaw) : 20;
  const messages = inbox.peek(botName, chatId, Number.isFinite(limit) ? limit : 20);
  return {
    status: 200,
    body: {
      messages: messages.map(publicShape),
      count: inbox.count(botName, chatId),
    },
  };
}

/**
 * DELETE /api/inbox/:botName — clear the queue (or just a chatId slice).
 * Owner of `botName` (or admin) only.
 */
export function clearInbox(
  inbox: InboxStore,
  agents: AgentStore,
  botName: string,
  query: URLSearchParams,
  cred: Credential,
): RouteResult {
  if (!ownsBot(agents, botName, cred)) return err(403, 'inbox_ownership_required');
  const chatIdRaw = query.get('chatId');
  const chatId = chatIdRaw === null ? undefined : chatIdRaw;
  const removed = inbox.clear(botName, chatId);
  return { status: 200, body: { removed } };
}

const POLL_TICK_MS = 500;
const POLL_MAX_WAIT_MS = 60_000;
const POLL_DEFAULT_WAIT_MS = 30_000;

/**
 * POST /api/inbox/:botName/poll — long-poll pop.
 *
 * Holds the connection up to `wait` seconds (default 30, hard cap 60).
 * Ticks every 500ms; on the first hit, atomically pops the oldest message
 * matching the optional `chatId` filter and returns it. On timeout returns
 * `{ message: null, waitedMs }`.
 *
 * 60s cap is well within the standard 120s LB/Caddy idle window; bumping
 * higher risks intermediary RST.
 *
 * Unlike the other handlers in this file this one writes to `res` directly
 * — long-poll doesn't fit the synchronous `RouteResult` shape (we don't know
 * the body until the wait resolves). The caller's `res.on('finish')` audit
 * hook still fires when we end the response.
 */
export interface PollDeps {
  inbox: InboxStore;
  agents: AgentStore;
}

export interface PollOptions {
  botName: string;
  chatId: string | undefined;
  waitMs: number;
  cred: Credential;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /**
   * Test seam: callers can supply a synthetic clock + setTimeout/clearTimeout
   * so unit tests don't have to wait real wall-clock seconds for the timeout
   * branch. Defaults to the real ones at module level.
   */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
  nowMs?: () => number;
}

export function pollInbox(deps: PollDeps, opts: PollOptions): void {
  const { inbox, agents } = deps;
  const { botName, chatId, waitMs, cred, req, res } = opts;
  const setI = opts.setIntervalImpl ?? setInterval;
  const clearI = opts.clearIntervalImpl ?? clearInterval;
  const setT = opts.setTimeoutImpl ?? setTimeout;
  const clearT = opts.clearTimeoutImpl ?? clearTimeout;
  const now = opts.nowMs ?? Date.now;

  const respond = (status: number, body: unknown): void => {
    if (res.writableEnded) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(json);
  };

  if (!ownsBot(agents, botName, cred)) {
    respond(403, { error: 'inbox_ownership_required' });
    return;
  }

  // Synchronous first-try — common case where there's already a message.
  const first = inbox.popOne(botName, chatId);
  if (first) {
    respond(200, { message: publicShape(first) });
    return;
  }

  if (waitMs <= 0) {
    respond(200, { message: null, waitedMs: 0 });
    return;
  }

  const cappedWait = Math.min(waitMs, POLL_MAX_WAIT_MS);
  const startedAt = now();
  let tickHandle: ReturnType<typeof setInterval> | null = null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let settled = false;

  const cleanup = (): void => {
    if (tickHandle) { clearI(tickHandle); tickHandle = null; }
    if (timeoutHandle) { clearT(timeoutHandle); timeoutHandle = null; }
  };

  const settle = (status: number, body: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    respond(status, body);
  };

  const onClose = (): void => {
    // Client disconnected mid-poll. Don't drain a message from the queue
    // (popOne would lose it forever); just stop spinning.
    if (settled) return;
    settled = true;
    cleanup();
    // Don't write — socket is closed.
  };
  req.once('close', onClose);

  tickHandle = setI(() => {
    if (settled) return;
    const msg = inbox.popOne(botName, chatId);
    if (msg) {
      settle(200, { message: publicShape(msg) });
    }
  }, POLL_TICK_MS);

  timeoutHandle = setT(() => {
    if (settled) return;
    settle(200, { message: null, waitedMs: now() - startedAt });
  }, cappedWait);
}

/** Parse the `wait` parameter (seconds → ms). Used by `server.ts`. */
export function parsePollWaitMs(raw: unknown): number {
  // Body or query value, treat as seconds. Clamp 0..60.
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(n) || n < 0) return POLL_DEFAULT_WAIT_MS;
  const seconds = Math.min(60, Math.floor(n));
  return seconds * 1000;
}

export const __testing = {
  POLL_TICK_MS,
  POLL_MAX_WAIT_MS,
  POLL_DEFAULT_WAIT_MS,
};

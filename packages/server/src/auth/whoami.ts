import type { Credential } from './credentials.js';
import type { AgentStore } from '../agents/agent-store.js';

export interface RouteResult {
  status: number;
  body: unknown;
}

/**
 * GET /api/whoami — token verification + identity introspection.
 *
 * The bridge calls this with the caller's core token to verify a
 * cross-bridge `/api/talk` request: if 200, the token is valid; the response
 * also surfaces the caller's botName/role/authSource for caller-stamping.
 * The CLI surfaces the same data through `agents whoami`.
 *
 * It does nothing beyond echoing already-authenticated metadata — no DB
 * writes, no token issuance.
 *
 * Also returns `memoryPublic` (when the caller is a member bot with an
 * agent-registry row): the metamemory CLI consumes it to decide whether
 * default writes auto-prefix into `/shared/<botName>/` or `/users/<botName>/`.
 * Returns `false` when no agent row exists (bots that haven't bulk-registered
 * yet, or admins) — that's the safe private default.
 */
export function getWhoami(cred: Credential, agentStore?: AgentStore): RouteResult {
  let memoryPublic = false;
  if (agentStore && cred.role !== 'admin') {
    const rec = agentStore.getByName(cred.botName);
    if (rec) memoryPublic = rec.memoryPublic;
  }
  return {
    status: 200,
    body: {
      botName: cred.botName,
      ownerName: cred.ownerName,
      role: cred.role,
      authSource: cred.authSource ?? 'bearer',
      credentialId: cred.id,
      memoryPublic,
    },
  };
}

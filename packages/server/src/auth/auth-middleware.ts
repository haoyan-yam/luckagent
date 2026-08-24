import type * as http from 'node:http';
import type { Credential } from './credentials.js';
import type { CredentialsStore } from './credentials-store.js';

export interface AuthFailure {
  status: number;
  error: string;
}

export interface AuthSuccess {
  credential: Credential;
}

export type AuthResult = AuthSuccess | AuthFailure;

export function isAuthFailure(r: AuthResult): r is AuthFailure {
  return (r as AuthFailure).status !== undefined;
}

export function extractBearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h) return null;
  if (h.startsWith('Bearer ')) return h.slice('Bearer '.length).trim();
  if (h.startsWith('bearer ')) return h.slice('bearer '.length).trim();
  return null;
}

/**
 * Resolve a request to a credential. Returns either {credential} or
 * {status, error} suitable for sending as a JSON response.
 *
 * Side effects: on success, queues a lastUsedAt update (non-blocking).
 */
export function authenticate(req: http.IncomingMessage, store: CredentialsStore): AuthResult {
  const token = extractBearer(req);
  if (!token) return { status: 401, error: 'missing_token' };
  const cred = store.lookupByToken(token);
  if (!cred) return { status: 401, error: 'invalid_token' };
  if (cred.revokedAt !== null) return { status: 401, error: 'credential_revoked' };
  store.touchLastUsed(cred.id);
  return { credential: cred };
}

export function requireAdmin(cred: Credential): AuthFailure | null {
  if (cred.role !== 'admin') return { status: 403, error: 'admin_required' };
  return null;
}

/**
 * Match an inbound (already lowercased) email against the whitelist.
 *
 * Two entry shapes are supported, and may be mixed in the same list:
 *   - Exact email, e.g. `alice@example.com` — equality match.
 *   - Domain wildcard, e.g. `@example.com` — matches any email whose
 *     domain part (everything after the LAST `@`) equals the suffix.
 *     The leading `@` is required so a bare hostname like `example.com`
 *     never accidentally degrades into a wildcard.
 *
 * The caller is responsible for passing both lists already trimmed and
 * lowercased (see `index.ts` env parse). This function does no further
 * normalization on the entries themselves.
 */
export function emailMatchesAllowlist(email: string, allowedEmails: string[]): boolean {
  if (!email) return false;
  if (allowedEmails.includes(email)) return true;
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0) return false;
  const domainKey = email.slice(atIdx); // includes leading '@'
  for (const entry of allowedEmails) {
    if (entry.length > 1 && entry.startsWith('@') && entry === domainKey) return true;
  }
  return false;
}


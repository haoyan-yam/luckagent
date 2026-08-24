import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from 'pino';
import { CredentialsStore } from './auth/credentials-store.js';
import { authenticate, isAuthFailure } from './auth/auth-middleware.js';
import { MemoryStore, ALLOWED_CONTENT_TYPES } from './memory/memory-store.js';
import { SkillStore } from './skills/skill-store.js';
import { AgentStore } from './agents/agent-store.js';
import { InboxStore } from './agents/inbox-store.js';
import { AuditLog, createDefaultAuditLog, type AuditOp } from './observability/audit-log.js';
import * as memoryRoutes from './memory/memory-routes.js';
import * as skillRoutes from './skills/skill-routes.js';
import * as agentRoutes from './agents/agent-routes.js';
import * as inboxRoutes from './agents/inbox-routes.js';
import * as adminRoutes from './admin/admin-routes.js';
import * as whoamiRoutes from './auth/whoami.js';
import { name as pkgName, version as pkgVersion } from './pkg-meta.js';

export interface ServerOptions {
  port: number;
  /**
   * Bind address. Defaults to '127.0.0.1' so the server is only reachable
   * locally (or via a reverse proxy you put in front of it). Set explicitly to
   * '0.0.0.0' to expose it on the network / for dev/test on remote hosts.
   */
  host?: string;
  dataDir: string;
  instanceName?: string;
  logger: Logger;
}

export interface ServerHandle {
  server: http.Server;
  db: Database.Database;
  credentialsStore: CredentialsStore;
  memoryStore: MemoryStore;
  skillStore: SkillStore;
  agentStore: AgentStore;
  inboxStore: InboxStore;
  auditLog: AuditLog;
  startedAt: number;
  close(): Promise<void>;
}

const MAX_BODY_SIZE = 10 * 1024 * 1024;

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(json);
}

class PayloadTooLargeError extends Error {
  statusCode = 413;
  constructor() {
    super('payload_too_large');
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      total += chunk.length;
      if (total > MAX_BODY_SIZE) { tooLarge = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new PayloadTooLargeError());
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

/**
 * Resolve a memory `idOrPath` slice from a URL pathname. UUIDs never contain
 * `/`, so an interior `/` reliably marks a path lookup. oauth2-proxy v7
 * decodes `%2F` → `/` upstream and Caddy collapses `//` → `/`, so the leading
 * `/` of a path-style lookup is stripped by the time we slice it off the URL.
 * Re-add it so `findFolderByPath` / path-based document lookups still hit.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Decode a URL slice into either a memory UUID or a logical `/`-prefixed path.
 *
 * We loop `decodeURIComponent` until the value stops changing (cap 5
 * iterations) instead of a single decode pass.
 *
 * Why decode-until-stable: the cookie-auth request path traverses
 * Caddy + oauth2-proxy v7, which re-encodes already-percent-encoded bytes
 * (`%XX` → `%25XX`) on every hop because oauth2-proxy reads `URL.Path`
 * instead of `URL.RawPath` before forwarding. CJK segments like
 * `%E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3` arrive at this server as
 * `%25E6%258A%2580%25E6%259C%25AF%25E6%2596%2587%25E6%25A1%25A3`, so a
 * single `decodeURIComponent` peels just one of two layers and the resulting
 * string never matches the stored path. The Bearer-bypass route in Caddy
 * (`@bearer`) is unaffected because it routes verbatim through
 * `httputil.ReverseProxy` and skips oauth2-proxy entirely. MR !17 fixed the
 * pchar-literal case (`@`, sub-delims) by sending literal bytes the proxy
 * can't mangle, but CJK has no literal-alternative encoding, so we must
 * normalize on the server.
 *
 * This is lossless: memory paths never contain a literal `%` (slug
 * normalization strips it; emails don't include it; CJK is non-ASCII), and
 * the proxy chain is monotonic (only ever adds `%25`, never removes), so
 * iterating to a fixed point converges to the canonical logical path. Mirrors
 * the client-side `fullyDecodeSegment` shipped in MR !16
 * (`packages/web-ui/src/routes/memory-path.tsx`), applied symmetrically here.
 *
 * Malformed `%`-sequences (e.g. `%ZZ`) make `decodeURIComponent` throw; we
 * trap and return the last valid value so a hand-crafted URL can't 500.
 */
export function decodeMemoryIdOrPath(slice: string): string {
  let current = slice;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed percent-encoding — stick with the last decodable value.
      break;
    }
    if (next === current) break;
    current = next;
  }
  if (current.startsWith('/')) return current;
  // The browser cookie path (oauth2-proxy/Caddy) collapses the `//` boundary
  // between the route prefix and a slash-prefixed path, stripping the path's
  // leading slash. A genuine UUID id has no slash either, so we can't branch
  // on "contains a slash" — a top-level folder like `shared` would be missed.
  // Disambiguate by shape: anything not UUID-shaped is a path missing its `/`.
  if (UUID_RE.test(current)) return current;
  return '/' + current;
}

function deriveOp(method: string, pathname: string): AuditOp | string {
  if (pathname.startsWith('/admin/')) return 'admin';
  if (pathname === '/api/memory/search' || pathname === '/api/skills/search') return 'search';
  if (pathname.endsWith('/publish')) return 'publish';
  if (pathname.endsWith('/install')) return 'install';
  if (pathname === '/api/agents/heartbeat' && method === 'POST') return 'heartbeat';
  if (pathname === '/api/agents/bulk' && method === 'POST') return 'register';
  if (pathname === '/api/agents' && method === 'POST') return 'register';
  if (pathname === '/api/whoami' && method === 'GET') return 'whoami';
  if (pathname.endsWith('/visibility') && method === 'PATCH') return 'visibility';
  if (pathname.startsWith('/api/inbox/')) {
    if (pathname.endsWith('/poll') && method === 'POST') return 'inbox_pop';
    if (method === 'POST') return 'inbox_enqueue';
    if (method === 'GET') return 'inbox_peek';
    if (method === 'DELETE') return 'inbox_clear';
  }
  if (method === 'POST') return 'create';
  if (method === 'PATCH' || method === 'PUT') return 'update';
  if (method === 'DELETE') return 'delete';
  if (method === 'GET') {
    const isCollection = pathname === '/api/memory/folders'
      || pathname === '/api/memory/documents'
      || pathname === '/api/skills'
      || pathname === '/api/agents';
    return isCollection ? 'list' : 'get';
  }
  return method.toLowerCase();
}

export function startServer(options: ServerOptions): ServerHandle {
  const { port, dataDir, logger } = options;
  const host = options.host || '127.0.0.1';
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'central.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const credentialsStore = new CredentialsStore(db, logger.child({ module: 'credentials' }));
  const memoryStore = new MemoryStore(db, logger.child({ module: 'memory' }));
  const skillStore = new SkillStore(db, logger.child({ module: 'skills' }));
  const agentStore = new AgentStore(db, logger.child({ module: 'agents' }));
  const inboxStore = new InboxStore(db, logger.child({ module: 'inbox' }));
  const auditLog = createDefaultAuditLog(dataDir, logger);

  // Admin bootstrap
  const tokenFile = path.join(dataDir, 'admin-bootstrap-token.txt');
  const bootstrapToken = credentialsStore.bootstrapAdmin(tokenFile);
  if (bootstrapToken) {
    logger.warn({ tokenFile }, 'ADMIN TOKEN BOOTSTRAPPED — SAVE IT NOW; this is the only time it is displayed');
    logger.warn({ token: bootstrapToken }, 'luckagent-core admin token (one-time)');
  }

  const startedAt = Date.now();
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsed.pathname;
    const query = parsed.searchParams;

    const auditStart = Date.now();
    let credentialId = 'anonymous';
    let role = 'anonymous';
    let authSource: 'web' | 'bearer' | undefined;
    const audited = pathname.startsWith('/api/') || pathname.startsWith('/admin/');
    if (audited) {
      res.on('finish', () => {
        try {
          auditLog.append({
            ts: new Date().toISOString(),
            op: deriveOp(method, pathname),
            path: pathname,
            credentialId,
            role,
            sourceIp: req.socket.remoteAddress || 'unknown',
            status: res.statusCode,
            latencyMs: Date.now() - auditStart,
            ...(authSource ? { authSource } : {}),
          });
        } catch { /* audit must never break the request */ }
      });
    }

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    try {
      // Health (open)
      if (method === 'GET' && pathname === '/health') {
        jsonResponse(res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          version: pkgVersion,
        });
        return;
      }

      // Manifest (open)
      if (method === 'GET' && pathname === '/api/manifest') {
        jsonResponse(res, 200, {
          schemaVersion: 1,
          instance: { name: options.instanceName || pkgName },
          capabilities: {
            memory: true,
            skills: true,
            content_types: [...ALLOWED_CONTENT_TYPES],
          },
        });
        return;
      }

      // Authenticate everything else under /api/* or /admin/*
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/admin/')) {
        jsonResponse(res, 404, { error: 'not_found' });
        return;
      }

      // Bearer-only auth.
      const auth = authenticate(req, credentialsStore);
      if (isAuthFailure(auth)) {
        jsonResponse(res, auth.status, { error: auth.error });
        return;
      }
      const cred = auth.credential;
      credentialId = cred.id;
      role = cred.role;
      authSource = 'bearer';

      // ---- Admin routes ----
      if (pathname === '/admin/credentials/issue' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.issueCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials/revoke' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, adminRoutes.revokeCredential(credentialsStore, body, cred));
      }
      if (pathname === '/admin/credentials' && method === 'GET') {
        return jsonResult(res, adminRoutes.listCredentials(credentialsStore, cred));
      }
      if (pathname === '/admin/audit' && method === 'GET') {
        return jsonResult(res, adminRoutes.readAudit(auditLog, query, cred));
      }

      // ---- Memory routes ----
      if (pathname === '/api/memory/folders' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listFolders(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/folders/tree' && method === 'GET') {
        return jsonResult(res, memoryRoutes.getFolderTree(memoryStore, cred));
      }
      if (pathname === '/api/memory/folders' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createFolder(memoryStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'GET') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.getFolder(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/folders/') && method === 'DELETE') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/folders/'.length));
        return jsonResult(res, memoryRoutes.deleteFolder(memoryStore, idOrPath, cred));
      }

      if (pathname === '/api/memory/search' && method === 'GET') {
        return jsonResult(res, memoryRoutes.search(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'GET') {
        return jsonResult(res, memoryRoutes.listDocuments(memoryStore, query, cred));
      }
      if (pathname === '/api/memory/documents' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.createDocument(memoryStore, agentStore, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'GET') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.getDocument(memoryStore, idOrPath, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && (method === 'PATCH' || method === 'PUT')) {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        const body = await parseJsonBody(req);
        return jsonResult(res, memoryRoutes.updateDocument(memoryStore, idOrPath, body, cred));
      }
      if (pathname.startsWith('/api/memory/documents/') && method === 'DELETE') {
        const idOrPath = decodeMemoryIdOrPath(pathname.slice('/api/memory/documents/'.length));
        return jsonResult(res, memoryRoutes.deleteDocument(memoryStore, idOrPath, cred));
      }

      // ---- Skill routes ----
      if (pathname === '/api/skills' && method === 'GET') {
        return jsonResult(res, skillRoutes.listSkills(skillStore, cred));
      }
      if (pathname === '/api/skills/search' && method === 'GET') {
        return jsonResult(res, skillRoutes.searchSkills(skillStore, query, cred));
      }
      // POST /api/skills/:name/publish — publish skill content for :name
      const publishMatch = pathname.match(/^\/api\/skills\/([^/]+)\/publish$/);
      if (publishMatch && method === 'POST') {
        const name = decodeURIComponent(publishMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, skillRoutes.publishSkill(skillStore, name, body, cred));
      }
      // GET /api/skills/:name/references — unpacked file list (lazy-loaded by skill-hub install)
      const referencesMatch = pathname.match(/^\/api\/skills\/([^/]+)\/references$/);
      if (referencesMatch && method === 'GET') {
        const name = decodeURIComponent(referencesMatch[1]);
        return jsonResult(res, skillRoutes.getSkillReferences(skillStore, name, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'GET') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.getSkill(skillStore, name, cred));
      }
      if (pathname.startsWith('/api/skills/') && method === 'DELETE') {
        const name = decodeURIComponent(pathname.slice('/api/skills/'.length));
        return jsonResult(res, skillRoutes.deleteSkill(skillStore, name, cred));
      }

      // ---- Whoami (token introspection / bridge token-verify hop) ----
      if (pathname === '/api/whoami' && method === 'GET') {
        return jsonResult(res, whoamiRoutes.getWhoami(cred, agentStore));
      }

      // ---- Agent-bus routes ----
      if (pathname === '/api/agents' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.registerAgent(agentStore, body, cred));
      }
      if (pathname === '/api/agents/bulk' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.registerAgentsBulk(agentStore, body, cred));
      }
      if (pathname === '/api/agents/heartbeat' && method === 'POST') {
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.heartbeat(agentStore, body, cred));
      }
      if (pathname === '/api/agents' && method === 'GET') {
        return jsonResult(res, agentRoutes.listAgents(agentStore, query, cred));
      }
      const visMatch = pathname.match(/^\/api\/agents\/([^/]+)\/visibility$/);
      if (visMatch && method === 'PATCH') {
        const botName = decodeURIComponent(visMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentVisibility(agentStore, botName, body, cred));
      }
      const memVisMatch = pathname.match(/^\/api\/agents\/([^/]+)\/memory-visibility$/);
      if (memVisMatch && method === 'PATCH') {
        const botName = decodeURIComponent(memVisMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentMemoryPublic(agentStore, botName, body, cred));
      }
      const vtoMatch = pathname.match(/^\/api\/agents\/([^/]+)\/visible-to-owners$/);
      if (vtoMatch && method === 'PATCH') {
        const botName = decodeURIComponent(vtoMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, agentRoutes.setAgentVisibleToOwners(agentStore, botName, body, cred));
      }
      if (pathname.startsWith('/api/agents/') && method === 'DELETE') {
        const botName = decodeURIComponent(pathname.slice('/api/agents/'.length));
        return jsonResult(res, agentRoutes.removeAgent(agentStore, botName, cred));
      }

      // ---- Inbox routes (central agent-bus inbox for CLI users) ----
      // Match order: longer paths first so `/poll` doesn't hit the bare
      // `/api/inbox/:botName` enqueue match.
      const inboxPollMatch = pathname.match(/^\/api\/inbox\/([^/]+)\/poll$/);
      if (inboxPollMatch && method === 'POST') {
        const botName = decodeURIComponent(inboxPollMatch[1]);
        // Long-poll: handler writes the response directly.
        const body = await parseJsonBody(req).catch(() => ({} as Record<string, unknown>));
        const chatIdQ = query.get('chatId');
        const chatId = chatIdQ !== null
          ? chatIdQ
          : (typeof body.chatId === 'string' ? body.chatId : undefined);
        const waitMs = inboxRoutes.parsePollWaitMs(
          query.get('wait') ?? body.wait,
        );
        inboxRoutes.pollInbox(
          { inbox: inboxStore, agents: agentStore },
          { botName, chatId, waitMs, cred, req, res },
        );
        return;
      }
      const inboxMatch = pathname.match(/^\/api\/inbox\/([^/]+)$/);
      if (inboxMatch && method === 'POST') {
        const botName = decodeURIComponent(inboxMatch[1]);
        const body = await parseJsonBody(req);
        return jsonResult(res, inboxRoutes.enqueueInbox(inboxStore, agentStore, botName, body, cred));
      }
      if (inboxMatch && method === 'GET') {
        const botName = decodeURIComponent(inboxMatch[1]);
        return jsonResult(res, inboxRoutes.peekInbox(inboxStore, agentStore, botName, query, cred));
      }
      if (inboxMatch && method === 'DELETE') {
        const botName = decodeURIComponent(inboxMatch[1]);
        return jsonResult(res, inboxRoutes.clearInbox(inboxStore, agentStore, botName, query, cred));
      }

      jsonResponse(res, 404, { error: 'not_found' });
    } catch (err: unknown) {
      const sc = (err as { statusCode?: number }).statusCode;
      if (typeof sc === 'number') {
        jsonResponse(res, sc, { error: (err as Error).message || 'error' });
        return;
      }
      logger.error({ err, method, url: rawUrl }, 'request error');
      jsonResponse(res, 500, { error: 'internal' });
    }
  });

  server.listen(port, host, () => {
    logger.info({ host, port, dbPath }, 'luckagent-core server started');
  });

  return {
    server,
    db,
    credentialsStore,
    memoryStore,
    skillStore,
    agentStore,
    inboxStore,
    auditLog,
    startedAt,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      credentialsStore.close();
      db.close();
    },
  };
}

function jsonResult(res: http.ServerResponse, result: { status: number; body: unknown }): void {
  jsonResponse(res, result.status, result.body);
}

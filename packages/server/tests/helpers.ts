import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import type { Logger } from 'pino';
import Database from 'better-sqlite3';
import { CredentialsStore } from '../src/auth/credentials-store.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import { AgentStore } from '../src/agents/agent-store.js';
import { SkillStore } from '../src/skills/skill-store.js';
import { AuditLog } from '../src/observability/audit-log.js';
import { startServer, type ServerHandle } from '../src/server.js';

export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}

export function makeTmpDir(label = 'luckagent-core-test'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
}

export function openDb(dir: string): Database.Database {
  const dbPath = path.join(dir, 'central.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export interface TestKit {
  dir: string;
  db: Database.Database;
  logger: Logger;
  credentials: CredentialsStore;
  memory: MemoryStore;
  agents: AgentStore;
  skills: SkillStore;
  audit: AuditLog;
  cleanup(): void;
}

export function makeKit(label?: string): TestKit {
  const dir = makeTmpDir(label);
  const logger = silentLogger();
  const db = openDb(dir);
  const credentials = new CredentialsStore(db, logger);
  const memory = new MemoryStore(db, logger);
  const agents = new AgentStore(db, logger);
  const skills = new SkillStore(db, logger);
  const audit = new AuditLog({ dir: path.join(dir, 'audit'), enabled: true, logger });
  return {
    dir, db, logger, credentials, memory, agents, skills, audit,
    cleanup() {
      try { credentials.close(); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export interface ServerKit {
  handle: ServerHandle;
  dir: string;
  port: number;
  baseUrl: string;
  adminToken: string;
  cleanup(): Promise<void>;
}

export async function startTestServer(label?: string): Promise<ServerKit> {
  const dir = makeTmpDir(label);
  // Bind to port 0 so the OS picks a free ephemeral port — robust under
  // vitest file parallelism inside a singleFork pool.
  const handle = startServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    logger: silentLogger(),
  });
  await new Promise<void>((resolve) => {
    if (handle.server.listening) return resolve();
    handle.server.once('listening', () => resolve());
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const tokenFile = path.join(dir, 'admin-bootstrap-token.txt');
  const adminToken = fs.readFileSync(tokenFile, 'utf-8').trim();
  return {
    handle,
    dir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    adminToken,
    async cleanup() {
      await handle.close();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

export interface HttpResult {
  status: number;
  body: any;
}

export async function call(
  baseUrl: string,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = text;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed };
}

export interface RawHttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Raw HTTP request using node:http so the caller can set arbitrary headers
 * (including Host, which the global fetch ignores). Used by static-serve
 * tests that need to exercise host-based dispatch.
 */
export function rawRequest(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<RawHttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: { Connection: 'close', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

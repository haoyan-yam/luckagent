import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pino from 'pino';
import Database from 'better-sqlite3';
import { makeKit, makeTmpDir, openDb, silentLogger, startTestServer, call, type TestKit, type ServerKit } from './helpers.js';
import { MemoryStore } from '../src/memory/memory-store.js';
import type { Credential } from '../src/auth/credentials.js';

let kit: TestKit | undefined;
let server: ServerKit | undefined;

afterEach(async () => {
  kit?.cleanup();
  kit = undefined;
  if (server) {
    await server.cleanup();
    server = undefined;
  }
});

function issue(k: TestKit, name: string, role: 'admin' | 'member'): Credential {
  const { credential } = k.credentials.issue({ botName: name, ownerName: name, role });
  return k.credentials.findById(credential.id)!;
}

describe('content_type — MemoryStore', () => {
  it('defaults to text/markdown when not supplied', () => {
    kit = makeKit('ct-default');
    const admin = issue(kit, 'admin', 'admin');
    const doc = kit.memory.createDocument({
      title: 'plain', path: '/shared/notes/plain', content: '# md',
    }, admin);
    expect(doc.content_type).toBe('text/markdown');
    const fetched = kit.memory.getDocument(doc.path, admin);
    expect(fetched?.content_type).toBe('text/markdown');
  });

  it('persists text/html and preserves content verbatim', () => {
    kit = makeKit('ct-html');
    const admin = issue(kit, 'admin', 'admin');
    const html = '<h1>hello</h1><p>roundtrip</p>';
    const doc = kit.memory.createDocument({
      title: 'page', path: '/shared/notes/page', content: html,
      content_type: 'text/html',
    }, admin);
    expect(doc.content_type).toBe('text/html');
    expect(doc.content).toBe(html);
    const fetched = kit.memory.getDocument(doc.path, admin);
    expect(fetched?.content_type).toBe('text/html');
    expect(fetched?.content).toBe(html);
  });

  it('rejects unsupported content_type at the store layer', () => {
    kit = makeKit('ct-reject');
    const admin = issue(kit, 'admin', 'admin');
    expect(() => kit!.memory.createDocument({
      title: 'bad', path: '/shared/notes/bad', content: 'x',
      content_type: 'text/plain',
    }, admin)).toThrow(/unsupported_content_type/);
  });

  it('update preserves content_type when not supplied; can switch when supplied', () => {
    kit = makeKit('ct-update');
    const admin = issue(kit, 'admin', 'admin');
    const md = kit.memory.createDocument({
      title: 'doc', path: '/shared/notes/doc', content: '# md',
    }, admin);
    // Update content only — content_type stays text/markdown.
    const after = kit.memory.updateDocument(md.id, { content: '# md2' }, admin);
    expect(after?.content_type).toBe('text/markdown');
    // Switch to html.
    const switched = kit.memory.updateDocument(md.id, {
      content: '<h1>html</h1>', content_type: 'text/html',
    }, admin);
    expect(switched?.content_type).toBe('text/html');
    expect(switched?.content).toBe('<h1>html</h1>');
    // Invalid switch rejected.
    expect(() => kit!.memory.updateDocument(md.id, {
      content_type: 'application/pdf',
    }, admin)).toThrow(/unsupported_content_type/);
  });

  it('list + search results include content_type', () => {
    kit = makeKit('ct-list-search');
    const admin = issue(kit, 'admin', 'admin');
    kit.memory.createDocument({
      title: 'm', path: '/shared/x/md', content: 'hello-token markdown',
    }, admin);
    kit.memory.createDocument({
      title: 'h', path: '/shared/x/html', content: '<p>hello-token html</p>',
      content_type: 'text/html',
    }, admin);

    const listed = kit.memory.listDocuments({ prefix: '/shared/x' }, admin);
    const summaries = Object.fromEntries(listed.map((d) => [d.path, d.content_type]));
    expect(summaries['/shared/x/md']).toBe('text/markdown');
    expect(summaries['/shared/x/html']).toBe('text/html');

    const results = kit.memory.searchDocuments('hello-token', 20, admin);
    const byPath = Object.fromEntries(results.map((r) => [r.path, r.content_type]));
    expect(byPath['/shared/x/md']).toBe('text/markdown');
    expect(byPath['/shared/x/html']).toBe('text/html');
  });

  it('idempotent migration adds content_type to a pre-existing schema', () => {
    const dir = makeTmpDir('ct-migration');
    const logger = silentLogger();
    const dbPath = path.join(dir, 'central.db');

    // Hand-craft the OLD schema (no content_type column) and seed a row.
    const oldDb = new Database(dbPath);
    oldDb.pragma('journal_mode = WAL');
    oldDb.pragma('foreign_keys = ON');
    oldDb.exec(`
      CREATE TABLE folders (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id),
        path TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO folders VALUES ('root', 'Root', NULL, '/', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, title TEXT NOT NULL,
        folder_id TEXT NOT NULL DEFAULT 'root' REFERENCES folders(id),
        path TEXT UNIQUE NOT NULL,
        content BLOB NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO documents (id, title, folder_id, path, content, tags, created_by, created_at, updated_at)
      VALUES ('legacy-1', 'legacy', 'root', '/legacy-note', '# legacy', '[]', 'old-bot',
              '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    // Sanity — column does not exist yet.
    const before = (oldDb.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map((c) => c.name);
    expect(before).not.toContain('content_type');
    oldDb.close();

    // Open via MemoryStore — initSchema() should add the column idempotently
    // and existing rows should get the default.
    const newDb = openDb(dir);
    new MemoryStore(newDb, logger);
    const after = (newDb.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map((c) => c.name);
    expect(after).toContain('content_type');
    const row = newDb.prepare('SELECT content_type FROM documents WHERE id = ?').get('legacy-1') as { content_type: string };
    expect(row.content_type).toBe('text/markdown');

    // Re-running initSchema() must not fail (idempotent).
    new MemoryStore(newDb, logger);
    newDb.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

describe('content_type — HTTP', () => {
  it('manifest advertises supported content types', async () => {
    server = await startTestServer('ct-manifest');
    const { baseUrl } = server;
    const res = await call(baseUrl, 'GET', '/api/manifest', null);
    expect(res.status).toBe(200);
    expect(res.body.capabilities.content_types).toEqual(['text/markdown', 'text/html']);
  });

  it('create HTML doc → roundtrip via GET preserves content + content_type', async () => {
    server = await startTestServer('ct-http-roundtrip');
    const { baseUrl, adminToken } = server;
    const html = '<h1>hi</h1><p>web ui</p>';
    const createRes = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/ui/page',
      title: 'page',
      content: html,
      content_type: 'text/html',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.content_type).toBe('text/html');
    expect(createRes.body.content).toBe(html);

    const getRes = await call(baseUrl, 'GET', '/api/memory/documents/' + encodeURIComponent('/shared/ui/page'), adminToken);
    expect(getRes.status).toBe(200);
    expect(getRes.body.content_type).toBe('text/html');
    expect(getRes.body.content).toBe(html);
  });

  it('create without content_type defaults to text/markdown in response', async () => {
    server = await startTestServer('ct-http-default');
    const { baseUrl, adminToken } = server;
    const createRes = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/ui/md',
      title: 'md',
      content: '# hi',
    });
    expect(createRes.status).toBe(201);
    expect(createRes.body.content_type).toBe('text/markdown');
  });

  it('rejects bogus content_type via the route layer with 400', async () => {
    server = await startTestServer('ct-http-reject');
    const { baseUrl, adminToken } = server;
    const res = await call(baseUrl, 'POST', '/api/memory/documents', adminToken, {
      path: '/shared/bad/doc',
      title: 'doc',
      content: 'x',
      content_type: 'application/pdf',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_content_type');
  });
});

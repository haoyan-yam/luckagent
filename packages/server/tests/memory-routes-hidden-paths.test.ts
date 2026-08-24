import { describe, it, expect, afterEach } from 'vitest';
import { makeKit, type TestKit } from './helpers.js';
import type { Credential } from '../src/auth/credentials.js';
import * as memoryRoutes from '../src/memory/memory-routes.js';
import { isHiddenFromMemoryView } from '../src/memory/hidden-paths.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function issue(kit: TestKit, name: string, role: 'admin' | 'member'): Credential {
  const { credential } = kit.credentials.issue({
    botName: name, ownerName: name, role,
  });
  return kit.credentials.findById(credential.id)!;
}

describe('isHiddenFromMemoryView', () => {
  it('matches /t5t and all descendants', () => {
    expect(isHiddenFromMemoryView('/t5t')).toBe(true);
    expect(isHiddenFromMemoryView('/t5t/projects')).toBe(true);
    expect(isHiddenFromMemoryView('/t5t/projects/foo')).toBe(true);
    expect(isHiddenFromMemoryView('/t5t/entries/2026-05-27-x')).toBe(true);
  });

  it('does not match similarly-prefixed paths', () => {
    expect(isHiddenFromMemoryView('/t5t-archive')).toBe(false);
    expect(isHiddenFromMemoryView('/users/x/t5t')).toBe(false);
    expect(isHiddenFromMemoryView('/t5')).toBe(false);
  });

  it('does not match unrelated roots', () => {
    expect(isHiddenFromMemoryView('/users/x')).toBe(false);
    expect(isHiddenFromMemoryView('/shared/y')).toBe(false);
    expect(isHiddenFromMemoryView('/bots/trunks')).toBe(false);
  });
});

describe('memory-routes hide /t5t from listFolders / getFolderTree / getFolder', () => {
  function seed(): TestKit {
    const k = makeKit('mem-hidden-folders');
    const admin = issue(k, 'admin', 'admin');
    // t5t-store would create these at boot via ensureFolderPath; emulate.
    k.memory.createFolder({ path: '/t5t' }, admin);
    k.memory.createFolder({ path: '/t5t/projects' }, admin);
    k.memory.createFolder({ path: '/t5t/entries' }, admin);
    k.memory.createFolder({ path: '/users' }, admin);
    k.memory.createFolder({ path: '/users/flood' }, admin);
    return k;
  }

  it('listFolders omits /t5t and any descendant', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.listFolders(kit.memory, new URLSearchParams(), admin);
    expect(res.status).toBe(200);
    const folders = (res.body as { folders: { path: string }[] }).folders;
    expect(folders.some((f) => f.path === '/t5t')).toBe(false);
    expect(folders.some((f) => f.path.startsWith('/t5t/'))).toBe(false);
    expect(folders.some((f) => f.path === '/users/flood')).toBe(true);
  });

  it('listFolders with prefix=/t5t returns empty', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const q = new URLSearchParams({ prefix: '/t5t' });
    const res = memoryRoutes.listFolders(kit.memory, q, admin);
    expect((res.body as { folders: unknown[] }).folders).toEqual([]);
  });

  it('getFolderTree prunes the /t5t subtree', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.getFolderTree(kit.memory, admin);
    const tree = res.body as { children: { path: string }[] };
    expect(tree.children.some((c) => c.path === '/t5t')).toBe(false);
    expect(tree.children.some((c) => c.path === '/users')).toBe(true);
  });

  it('getFolder by hidden path returns 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.getFolder(kit.memory, '/t5t/projects', admin);
    expect(res.status).toBe(404);
  });

  it('getFolder by hidden folder id returns 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const folder = kit.memory.findFolderByPath('/t5t/projects')!;
    const res = memoryRoutes.getFolder(kit.memory, folder.id, admin);
    expect(res.status).toBe(404);
  });
});

describe('memory-routes hide /t5t from listDocuments / getDocument / search', () => {
  function seed(): TestKit {
    const k = makeKit('mem-hidden-docs');
    const admin = issue(k, 'admin', 'admin');
    k.memory.createDocument({
      title: 't5t-entry', path: '/t5t/entries/2026-x', content: 'lookmeup unique-token',
    }, admin);
    k.memory.createDocument({
      title: 'user-note', path: '/users/admin/note', content: 'lookmeup also',
    }, admin);
    return k;
  }

  it('listDocuments omits hidden docs', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.listDocuments(kit.memory, new URLSearchParams(), admin);
    const docs = (res.body as { documents: { path: string }[] }).documents;
    expect(docs.some((d) => d.path.startsWith('/t5t/'))).toBe(false);
    expect(docs.some((d) => d.path === '/users/admin/note')).toBe(true);
  });

  it('listDocuments with folder_id of hidden folder returns empty', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const t5tEntries = kit.memory.findFolderByPath('/t5t/entries')!;
    const q = new URLSearchParams({ folder_id: t5tEntries.id });
    const res = memoryRoutes.listDocuments(kit.memory, q, admin);
    expect((res.body as { documents: unknown[] }).documents).toEqual([]);
  });

  it('listDocuments with prefix=/t5t returns empty', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const q = new URLSearchParams({ prefix: '/t5t' });
    const res = memoryRoutes.listDocuments(kit.memory, q, admin);
    expect((res.body as { documents: unknown[] }).documents).toEqual([]);
  });

  it('getDocument by hidden path returns 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.getDocument(kit.memory, '/t5t/entries/2026-x', admin);
    expect(res.status).toBe(404);
  });

  it('getDocument by hidden doc id returns 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    // store.getDocument with admin cred would succeed; we need raw lookup.
    const raw = kit.memory.findDocumentPathById('/t5t/entries/2026-x');
    expect(raw).toBe('/t5t/entries/2026-x');
    // Now also via id form: look up by SQL to fetch the id.
    const id = (kit.db.prepare('SELECT id FROM documents WHERE path = ?')
      .get('/t5t/entries/2026-x') as { id: string }).id;
    const res = memoryRoutes.getDocument(kit.memory, id, admin);
    expect(res.status).toBe(404);
  });

  it('search filters hidden results', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const q = new URLSearchParams({ q: 'lookmeup' });
    const res = memoryRoutes.search(kit.memory, q, admin);
    const results = (res.body as { results: { path: string }[] }).results;
    expect(results.some((r) => r.path.startsWith('/t5t/'))).toBe(false);
    expect(results.some((r) => r.path === '/users/admin/note')).toBe(true);
  });
});

describe('memory-routes reject writes to hidden namespace', () => {
  function seed(): TestKit {
    const k = makeKit('mem-hidden-writes');
    const admin = issue(k, 'admin', 'admin');
    k.memory.createFolder({ path: '/t5t' }, admin);
    k.memory.createFolder({ path: '/t5t/entries' }, admin);
    k.memory.createDocument({
      title: 'pre', path: '/t5t/entries/existing', content: 'pre',
    }, admin);
    return k;
  }

  it('createFolder with hidden path → 403', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.createFolder(kit.memory, { path: '/t5t/sneaky' }, admin);
    expect(res.status).toBe(403);
  });

  it('createDocument with hidden path → 403', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'sneaky', path: '/t5t/entries/sneaky', content: 'x',
    }, admin);
    expect(res.status).toBe(403);
  });

  it('createDocument targeting hidden folder_id → 403', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const folder = kit.memory.findFolderByPath('/t5t/entries')!;
    const res = memoryRoutes.createDocument(kit.memory, kit.agents, {
      title: 'sneaky', folder_id: folder.id, content: 'x',
    }, admin);
    expect(res.status).toBe(403);
  });

  it('updateDocument by hidden path → 404 (pretends absent)', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.updateDocument(kit.memory, '/t5t/entries/existing', { content: 'tampered' }, admin);
    expect(res.status).toBe(404);
  });

  it('updateDocument with target folder_id hidden → 403', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const visible = kit.memory.createDocument({
      title: 'visible', path: '/users/admin/visible', content: 'v',
    }, admin);
    const hiddenFolder = kit.memory.findFolderByPath('/t5t/entries')!;
    const res = memoryRoutes.updateDocument(kit.memory, visible.id, { folder_id: hiddenFolder.id }, admin);
    expect(res.status).toBe(403);
  });

  it('deleteDocument by hidden path → 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.deleteDocument(kit.memory, '/t5t/entries/existing', admin);
    expect(res.status).toBe(404);
  });

  it('deleteFolder by hidden path → 404', () => {
    kit = seed();
    const admin = issue(kit, 'admin', 'admin');
    const res = memoryRoutes.deleteFolder(kit.memory, '/t5t/entries', admin);
    expect(res.status).toBe(404);
  });
});

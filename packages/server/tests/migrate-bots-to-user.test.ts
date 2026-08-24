import { describe, it, expect, afterEach } from 'vitest';
import {
  buildDocPlan,
  buildFolderPlan,
  applyMigration,
  findDocCollisions,
  findFolderCollisions,
  loadDocCandidates,
  loadFolderCandidates,
} from '../src/scripts/migrate-bots-to-user.js';
import { makeKit, type TestKit } from './helpers.js';

const TARGET = 'user@example.com';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function seedDoc(k: TestKit, id: string, p: string): void {
  const segments = p.slice(1).split('/');
  const folderPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
  const folder = k.memory.ensureFolderPath(folderPath);
  const now = new Date().toISOString();
  k.db.prepare(
    'INSERT INTO documents (id, title, folder_id, path, content, content_type, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, segments[segments.length - 1], folder.id, p, '', 'text/markdown', '[]', 'trunks', now, now);
}

function pathOf(k: TestKit, table: 'documents' | 'folders', id: string): string | null {
  const row = k.db.prepare(`SELECT path FROM ${table} WHERE id = ?`).get(id) as { path: string } | undefined;
  return row?.path ?? null;
}

describe('migrate-bots-to-user — pure filter logic', () => {
  it('buildDocPlan rewrites /bots/<rest> → /users/<targetUser>/bots/<rest>', () => {
    const plan = buildDocPlan(
      [{ id: 'd1', path: '/bots/trunks/日报/2026-05-27' }],
      TARGET,
    );
    expect(plan).toEqual([
      { id: 'd1', oldPath: '/bots/trunks/日报/2026-05-27', newPath: `/users/${TARGET}/bots/trunks/日报/2026-05-27` },
    ]);
  });

  it('buildFolderPlan rewrites all levels (/bots, /bots/trunks, /bots/trunks/日报)', () => {
    const plan = buildFolderPlan(
      [
        { id: 'f1', path: '/bots' },
        { id: 'f2', path: '/bots/trunks' },
        { id: 'f3', path: '/bots/trunks/日报' },
      ],
      TARGET,
    );
    expect(plan.map((p) => p.newPath)).toEqual([
      `/users/${TARGET}/bots`,
      `/users/${TARGET}/bots/trunks`,
      `/users/${TARGET}/bots/trunks/日报`,
    ]);
  });

  it('ignores paths outside /bots', () => {
    expect(buildDocPlan([{ id: 'x', path: '/users/alice/note' }], TARGET)).toEqual([]);
    expect(buildFolderPlan([{ id: 'x', path: '/users/alice' }], TARGET)).toEqual([]);
  });

  it('respects custom target user', () => {
    const plan = buildDocPlan([{ id: 'd1', path: '/bots/x/y' }], 'someone-else@example.com');
    expect(plan[0].newPath).toBe('/users/someone-else@example.com/bots/x/y');
  });
});

describe('applyMigration — DB integration', () => {
  it('moves docs + folders, preserves UUIDs, keeps doc folder_id consistent', () => {
    kit = makeKit('migrate-bots-happy');

    // Seed legacy /bots/trunks/日报/2026-05-27
    kit.memory.ensureFolderPath('/bots/trunks/日报');
    seedDoc(kit, 'd1', '/bots/trunks/日报/2026-05-27');

    // Capture pre-migration UUIDs
    const trunksFolder = kit.memory.findFolderByPath('/bots/trunks')!;
    const ribaoFolder = kit.memory.findFolderByPath('/bots/trunks/日报')!;
    const botsFolder = kit.memory.findFolderByPath('/bots')!;

    const docCandidates = loadDocCandidates(kit.db);
    const folderCandidates = loadFolderCandidates(kit.db);
    expect(docCandidates.map((c) => c.id)).toEqual(['d1']);
    expect(folderCandidates.map((c) => c.path).sort()).toEqual(['/bots', '/bots/trunks', '/bots/trunks/日报']);

    const docPlan = buildDocPlan(docCandidates, TARGET);
    const folderPlan = buildFolderPlan(folderCandidates, TARGET);
    expect(findFolderCollisions(kit.db, folderPlan)).toEqual([]);
    expect(findDocCollisions(kit.db, docPlan)).toEqual([]);

    applyMigration(kit.db, folderPlan, docPlan, TARGET);

    // Doc relocated
    expect(pathOf(kit, 'documents', 'd1')).toBe(`/users/${TARGET}/bots/trunks/日报/2026-05-27`);

    // Folder UUIDs preserved, paths rewritten
    expect(pathOf(kit, 'folders', botsFolder.id)).toBe(`/users/${TARGET}/bots`);
    expect(pathOf(kit, 'folders', trunksFolder.id)).toBe(`/users/${TARGET}/bots/trunks`);
    expect(pathOf(kit, 'folders', ribaoFolder.id)).toBe(`/users/${TARGET}/bots/trunks/日报`);

    // Document re-points to the moved 日报 folder
    const doc = kit.db.prepare('SELECT folder_id, path FROM documents WHERE id = ?')
      .get('d1') as { folder_id: string; path: string };
    expect(doc.folder_id).toBe(ribaoFolder.id);

    // Intermediate /users/<TARGET>/ chain exists
    expect(kit.memory.findFolderByPath('/users')).toBeTruthy();
    expect(kit.memory.findFolderByPath(`/users/${TARGET}`)).toBeTruthy();
  });

  it('re-running is a no-op (idempotent)', () => {
    kit = makeKit('migrate-bots-idempotent');
    kit.memory.ensureFolderPath(`/users/${TARGET}/bots/trunks/日报`);

    const docCandidates = loadDocCandidates(kit.db);
    const folderCandidates = loadFolderCandidates(kit.db);
    expect(docCandidates).toEqual([]);
    expect(folderCandidates).toEqual([]);
  });

  it('aborts on collision when /users/<TARGET>/bots/<x> already has the destination path occupied', () => {
    kit = makeKit('migrate-bots-collision');
    seedDoc(kit, 'd1', '/bots/trunks/日报/2026-05-27');
    // Pre-seed a doc at the target location
    seedDoc(kit, 'd99', `/users/${TARGET}/bots/trunks/日报/2026-05-27`);

    const docPlan = buildDocPlan(loadDocCandidates(kit.db), TARGET);
    const collisions = findDocCollisions(kit.db, docPlan);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain(`/users/${TARGET}/bots/trunks/日报/2026-05-27`);
  });

  it('honors a custom target user', () => {
    kit = makeKit('migrate-bots-custom-target');
    const customTarget = 'custom@example.com';
    kit.memory.ensureFolderPath('/bots/foo');
    seedDoc(kit, 'd1', '/bots/foo/hello');

    const docPlan = buildDocPlan(loadDocCandidates(kit.db), customTarget);
    const folderPlan = buildFolderPlan(loadFolderCandidates(kit.db), customTarget);
    applyMigration(kit.db, folderPlan, docPlan, customTarget);

    expect(pathOf(kit, 'documents', 'd1')).toBe(`/users/${customTarget}/bots/foo/hello`);
  });
});

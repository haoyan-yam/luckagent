import { describe, it, expect, afterEach } from 'vitest';
import {
  buildPlan,
  applyMigration,
  findCollisions,
  loadCandidates,
  type DocRow,
} from '../src/scripts/migrate-agent-namespaces.js';
import { makeKit, type TestKit } from './helpers.js';

let kit: TestKit | undefined;

afterEach(() => {
  kit?.cleanup();
  kit = undefined;
});

function asRow(id: string, p: string, createdBy: string): DocRow {
  return { id, path: p, created_by: createdBy };
}

describe('buildPlan — pure filter logic', () => {
  it('moves /users/<owner>/<slug> written by agent → /users/<owner>/agents/<bot>/<slug>', () => {
    const { plan, skipped } = buildPlan([
      asRow('d1', '/users/alice-w/luckagent-cli-guide', 'alicew-cj25z'),
    ]);
    expect(skipped).toEqual([]);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      id: 'd1',
      oldPath: '/users/alice-w/luckagent-cli-guide',
      newPath: '/users/alice-w/agents/alicew-cj25z/luckagent-cli-guide',
      owner: 'alice-w',
      bot: 'alicew-cj25z',
    });
  });

  it('preserves nested tail segments', () => {
    const { plan } = buildPlan([
      asRow('d1', '/users/alice-w/notes/2026/topic.md', 'bot-x'),
    ]);
    expect(plan[0].newPath).toBe('/users/alice-w/agents/bot-x/notes/2026/topic.md');
  });

  it('skips docs already under /users/<X>/agents/<Y>/ (idempotent re-run)', () => {
    const { plan, skipped } = buildPlan([
      asRow('d1', '/users/alice/agents/bot-x/already-here', 'bot-x'),
    ]);
    expect(plan).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('already under agents/');
  });

  it('skips SSO self-writes (botName === ownerName === user-segment)', () => {
    const { plan, skipped } = buildPlan([
      asRow('d1', '/users/alice@xvi.com/my-note', 'alice@xvi.com'),
    ]);
    expect(plan).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/SSO self-write/);
  });

  it('skips empty created_by (avoids agents// double-slash trap)', () => {
    const { plan, skipped } = buildPlan([
      asRow('d1', '/users/alice/orphan-note', ''),
      asRow('d2', '/users/alice/another', '   '), // whitespace-only also counts as empty
    ]);
    expect(plan).toEqual([]);
    expect(skipped).toHaveLength(2);
    for (const s of skipped) expect(s.reason).toBe('created_by empty');
  });

  it('skips paths outside /users/', () => {
    const { plan, skipped } = buildPlan([
      asRow('d1', '/shared/bot-x/public-note', 'bot-x'),
      asRow('d2', '/projects/alpha/spec', 'bot-x'),
    ]);
    expect(plan).toEqual([]);
    expect(skipped).toHaveLength(2);
  });

  it('skips malformed /users/<X> (no trailing segment after user)', () => {
    // SQL WHERE clause already filters with `/%/%` shape, but defense-in-depth.
    const { plan, skipped } = buildPlan([
      asRow('d1', '/users/alice', 'bot-x'),
    ]);
    expect(plan).toEqual([]);
    expect(skipped).toHaveLength(1);
  });
});

describe('applyMigration — DB integration', () => {
  function seedDoc(k: TestKit, id: string, p: string, createdBy: string): void {
    // ensureFolderPath would normally be done by createDocument; do it manually
    // so we can pre-seed an "old-shape" row faithfully.
    const segments = p.slice(1).split('/');
    const folderPath = segments.length <= 1 ? '/' : '/' + segments.slice(0, -1).join('/');
    const folder = k.memory.ensureFolderPath(folderPath);
    const now = new Date().toISOString();
    k.db.prepare(
      'INSERT INTO documents (id, title, folder_id, path, content, content_type, tags, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, segments[segments.length - 1], folder.id, p, '', 'text/markdown', '[]', createdBy, now, now);
  }

  function pathOf(k: TestKit, id: string): string | null {
    const row = k.db.prepare('SELECT path FROM documents WHERE id = ?').get(id) as { path: string } | undefined;
    return row?.path ?? null;
  }

  it('relocates agent-written rows to /users/<owner>/agents/<bot>/<tail>, leaves siblings untouched', () => {
    kit = makeKit('migrate-relocate');

    seedDoc(kit, 'd1', '/users/alice-w/luckagent-cli-guide', 'alicew-cj25z');
    seedDoc(kit, 'd2', '/users/alice-w/notes/spec.md', 'alicew-cj25z');
    seedDoc(kit, 'd3', '/users/alice@xvi.com/my-note', 'alice@xvi.com');  // SSO self
    seedDoc(kit, 'd4', '/users/alice/agents/bot-x/already-migrated', 'bot-x'); // idempotent
    seedDoc(kit, 'd5', '/shared/bot-x/public', 'bot-x'); // not under /users/

    const candidates = loadCandidates(kit.db);
    // d3 is in /users/<X>/% and not under agents/% → candidate; d4 excluded by SQL
    // d5 excluded by SQL (doesn't match /users/%/%)
    // Verify SQL filter shape:
    expect(candidates.map((c) => c.id).sort()).toEqual(['d1', 'd2', 'd3']);

    const { plan, skipped } = buildPlan(candidates);
    // d3 should be skipped (SSO self), d1+d2 in plan
    expect(plan.map((p) => p.id).sort()).toEqual(['d1', 'd2']);
    expect(skipped.map((s) => s.row.id)).toEqual(['d3']);

    expect(findCollisions(kit.db, plan)).toEqual([]);
    applyMigration(kit.db, plan);

    expect(pathOf(kit, 'd1')).toBe('/users/alice-w/agents/alicew-cj25z/luckagent-cli-guide');
    expect(pathOf(kit, 'd2')).toBe('/users/alice-w/agents/alicew-cj25z/notes/spec.md');
    // Untouched:
    expect(pathOf(kit, 'd3')).toBe('/users/alice@xvi.com/my-note');
    expect(pathOf(kit, 'd4')).toBe('/users/alice/agents/bot-x/already-migrated');
    expect(pathOf(kit, 'd5')).toBe('/shared/bot-x/public');
  });

  it('re-running on an already-migrated DB is a no-op (idempotent)', () => {
    kit = makeKit('migrate-idempotent');
    seedDoc(kit, 'd1', '/users/alice/agents/bot-x/note', 'bot-x');

    const candidates = loadCandidates(kit.db);
    // SQL WHERE NOT LIKE '/users/%/agents/%' should exclude this row.
    expect(candidates).toEqual([]);

    // Belt-and-suspenders: even if it slipped through, buildPlan filters it.
    const { plan } = buildPlan([{ id: 'd1', path: '/users/alice/agents/bot-x/note', created_by: 'bot-x' }]);
    expect(plan).toEqual([]);

    expect(pathOf(kit, 'd1')).toBe('/users/alice/agents/bot-x/note');
  });

  it('creates the /users/<owner>/agents/<bot>/ intermediate folder chain', () => {
    kit = makeKit('migrate-intermediate-folders');
    seedDoc(kit, 'd1', '/users/alice-w/cli-guide', 'alicew-cj25z');

    const candidates = loadCandidates(kit.db);
    const { plan } = buildPlan(candidates);
    applyMigration(kit.db, plan);

    const agentsFolder = kit.db.prepare('SELECT id, path FROM folders WHERE path = ?')
      .get('/users/alice-w/agents') as { id: string; path: string } | undefined;
    expect(agentsFolder).toBeDefined();

    const botFolder = kit.db.prepare('SELECT id, path FROM folders WHERE path = ?')
      .get('/users/alice-w/agents/alicew-cj25z') as { id: string; path: string } | undefined;
    expect(botFolder).toBeDefined();

    const movedDoc = kit.db.prepare('SELECT folder_id, path FROM documents WHERE id = ?')
      .get('d1') as { folder_id: string; path: string };
    expect(movedDoc.path).toBe('/users/alice-w/agents/alicew-cj25z/cli-guide');
    expect(movedDoc.folder_id).toBe(botFolder!.id);
  });

  it('findCollisions detects target paths already occupied by other docs', () => {
    kit = makeKit('migrate-collision');
    seedDoc(kit, 'd1', '/users/alice-w/note', 'alicew-cj25z');
    // pre-seed an occupant at the target path (simulating partial prior migration)
    seedDoc(kit, 'd99', '/users/alice-w/agents/alicew-cj25z/note', 'alicew-cj25z');

    const { plan } = buildPlan(loadCandidates(kit.db));
    expect(plan.map((p) => p.id)).toEqual(['d1']);

    const collisions = findCollisions(kit.db, plan);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toContain('/users/alice-w/agents/alicew-cj25z/note');
    expect(collisions[0]).toContain('d99');
  });
});

/**
 * One-shot migration: relocate documents and folders living under the
 * legacy `/bots/<botName>/...` root to
 *   /users/admin@example.com/bots/<botName>/...
 *
 * Why: the memory tab now shows only `/users/...` at the top level. `/bots/*`
 * was a freelance root used by a couple of bots before user-scoped namespaces
 * existed; consolidating it under the target user's namespace removes the
 * stray sibling root without losing the data.
 *
 * Skipped (idempotent + safe):
 *   - Already under /users/...
 *   - Anything outside /bots/<x>/...
 *
 * Usage (from packages/server after `npm run build`):
 *   node dist/scripts/migrate-bots-to-user.js          # dry-run
 *   node dist/scripts/migrate-bots-to-user.js --apply  # write
 *
 * Env:
 *   LUCKAGENT_CORE_DATA_DIR (defaults to ~/.luckagent-core/data)
 *   MIGRATE_BOTS_TARGET_USER (defaults to admin@example.com)
 *
 * Re-runs are safe — `loadCandidates` returns only `/bots/*` rows, and applying
 * deletes the original `/bots` folder tree once empty.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export interface DocRow {
  id: string;
  path: string;
}

export interface FolderRow {
  id: string;
  path: string;
}

export interface DocPlanItem {
  id: string;
  oldPath: string;
  newPath: string;
}

export interface FolderPlanItem {
  id: string;
  oldPath: string;
  newPath: string;
}

function nowISO(): string {
  return new Date().toISOString();
}

function rewriteUnderTarget(oldPath: string, targetUser: string): string {
  // /bots/<rest>   →   /users/<targetUser>/bots/<rest>
  if (!oldPath.startsWith('/bots/') && oldPath !== '/bots') return oldPath;
  const rest = oldPath === '/bots' ? '' : oldPath.slice('/bots'.length); // includes leading '/'
  return `/users/${targetUser}/bots${rest}`;
}

export function buildDocPlan(rows: DocRow[], targetUser: string): DocPlanItem[] {
  return rows
    .filter((r) => r.path === '/bots' || r.path.startsWith('/bots/'))
    .map((r) => ({ id: r.id, oldPath: r.path, newPath: rewriteUnderTarget(r.path, targetUser) }));
}

export function buildFolderPlan(rows: FolderRow[], targetUser: string): FolderPlanItem[] {
  return rows
    .filter((r) => r.path === '/bots' || r.path.startsWith('/bots/'))
    .map((r) => ({ id: r.id, oldPath: r.path, newPath: rewriteUnderTarget(r.path, targetUser) }));
}

/** Mirror of MemoryStore.ensureFolderPath, inlined to keep the script self-contained. */
export function ensureFolderPath(db: Database.Database, targetPath: string): FolderRow {
  if (targetPath === '/' || targetPath === '') {
    const root = db.prepare('SELECT id, path FROM folders WHERE path = ?').get('/') as FolderRow | undefined;
    if (!root) throw new Error('root folder missing');
    return root;
  }
  const norm = targetPath.endsWith('/') ? targetPath.slice(0, -1) : targetPath;
  const parts = norm.slice(1).split('/');
  let parent = db.prepare('SELECT id, path FROM folders WHERE path = ?').get('/') as FolderRow;
  if (!parent) throw new Error('root folder missing');
  let curPath = '';
  for (const part of parts) {
    curPath += '/' + part;
    let f = db.prepare('SELECT id, path FROM folders WHERE path = ?').get(curPath) as FolderRow | undefined;
    if (!f) {
      const id = crypto.randomUUID();
      const now = nowISO();
      db.prepare(
        'INSERT INTO folders (id, name, parent_id, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, part, parent.id, curPath, now, now);
      f = { id, path: curPath };
    }
    parent = f;
  }
  return parent;
}

export function findFolderCollisions(db: Database.Database, plan: FolderPlanItem[]): string[] {
  const collisions: string[] = [];
  const stmt = db.prepare('SELECT id FROM folders WHERE path = ?');
  for (const item of plan) {
    const existing = stmt.get(item.newPath) as { id: string } | undefined;
    if (existing && existing.id !== item.id) {
      collisions.push(`folder ${item.newPath} (occupied by ${existing.id})`);
    }
  }
  return collisions;
}

export function findDocCollisions(db: Database.Database, plan: DocPlanItem[]): string[] {
  const collisions: string[] = [];
  const stmt = db.prepare('SELECT id FROM documents WHERE path = ?');
  for (const item of plan) {
    const existing = stmt.get(item.newPath) as { id: string } | undefined;
    if (existing && existing.id !== item.id) {
      collisions.push(`document ${item.newPath} (occupied by ${existing.id})`);
    }
  }
  return collisions;
}

export function loadDocCandidates(db: Database.Database): DocRow[] {
  return db.prepare(
    "SELECT id, path FROM documents WHERE path = '/bots' OR path LIKE '/bots/%' ORDER BY path",
  ).all() as DocRow[];
}

export function loadFolderCandidates(db: Database.Database): FolderRow[] {
  return db.prepare(
    "SELECT id, path FROM folders WHERE path = '/bots' OR path LIKE '/bots/%' ORDER BY path",
  ).all() as FolderRow[];
}

/**
 * Apply the migration in a single transaction:
 *   1) ensure /users/<targetUser>/bots/... target folders exist
 *   2) re-parent each /bots/* folder to its new parent and rewrite its `path` + `name`
 *   3) rewrite each document's `path` and re-point `folder_id` to the moved folder
 *   4) delete the now-orphaned old `/bots` folder (and any leftover empty
 *      ancestors that were exclusively /bots/*)
 *
 * The approach used here keeps folder UUIDs stable so that any code holding a
 * folder id (e.g. cached lookups) keeps working. Only `path`, `name`, and
 * `parent_id` change.
 */
export function applyMigration(
  db: Database.Database,
  folderPlan: FolderPlanItem[],
  docPlan: DocPlanItem[],
  targetUser: string,
): void {
  const trx = db.transaction(() => {
    // Ensure /users/<targetUser>/ exists as the destination parent. We
    // deliberately do NOT pre-create /users/<targetUser>/bots — the existing
    // legacy /bots folder is itself moved into that slot, preserving its UUID.
    ensureFolderPath(db, `/users/${targetUser}`);

    // Build a lookup: oldPath → new parent_id + new name.
    // We process folders in path-length order so the parent always exists before its child is rewritten.
    const sortedFolders = [...folderPlan].sort((a, b) => a.newPath.length - b.newPath.length);
    for (const item of sortedFolders) {
      const newName = item.newPath.slice(item.newPath.lastIndexOf('/') + 1) || 'root';
      const parentPath = item.newPath.slice(0, item.newPath.lastIndexOf('/')) || '/';
      const parent = db.prepare('SELECT id FROM folders WHERE path = ?').get(parentPath) as { id: string } | undefined;
      if (!parent) throw new Error(`parent missing for ${item.newPath} (expected ${parentPath})`);
      const updatedAt = nowISO();
      db.prepare(
        'UPDATE folders SET path = ?, name = ?, parent_id = ?, updated_at = ? WHERE id = ?',
      ).run(item.newPath, newName, parent.id, updatedAt, item.id);
    }

    // Documents: rewrite path + re-parent to the moved folder.
    for (const item of docPlan) {
      const parentPath = item.newPath.slice(0, item.newPath.lastIndexOf('/')) || '/';
      const parent = db.prepare('SELECT id FROM folders WHERE path = ?').get(parentPath) as { id: string } | undefined;
      if (!parent) throw new Error(`parent missing for ${item.newPath} (expected ${parentPath})`);
      const updatedAt = nowISO();
      const res = db.prepare(
        'UPDATE documents SET path = ?, folder_id = ?, updated_at = ? WHERE id = ?',
      ).run(item.newPath, parent.id, updatedAt, item.id);
      if (res.changes !== 1) {
        throw new Error(`UPDATE affected ${res.changes} rows for id=${item.id}`);
      }
    }
  });
  trx();
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const dataDir =
    process.env.LUCKAGENT_CORE_DATA_DIR ||
    path.join(os.homedir(), '.luckagent-core', 'data');
  const targetUser = process.env.MIGRATE_BOTS_TARGET_USER || 'admin@example.com';
  const dbPath = path.join(dataDir, 'central.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[migrate-bots-to-user] DB not found: ${dbPath}`);
    process.exit(2);
  }

  console.log(`[migrate-bots-to-user] db=${dbPath} target=/users/${targetUser}/bots mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const docCandidates = loadDocCandidates(db);
  const folderCandidates = loadFolderCandidates(db);
  const docPlan = buildDocPlan(docCandidates, targetUser);
  const folderPlan = buildFolderPlan(folderCandidates, targetUser);

  console.log('');
  console.log(`[migrate-bots-to-user] documents to move: ${docPlan.length}`);
  console.log(`[migrate-bots-to-user] folders to move:   ${folderPlan.length}`);

  if (docPlan.length === 0 && folderPlan.length === 0) {
    console.log('[migrate-bots-to-user] nothing to do.');
    db.close();
    return;
  }

  console.log('');
  console.log('Folder plan:');
  for (const f of folderPlan) console.log(`  ${f.oldPath}\n    -> ${f.newPath}`);
  console.log('');
  console.log('Document plan:');
  for (const d of docPlan) console.log(`  ${d.oldPath}\n    -> ${d.newPath}`);

  if (!apply) {
    console.log('');
    console.log('[migrate-bots-to-user] DRY-RUN complete. Re-run with --apply to write.');
    db.close();
    return;
  }

  const folderCollisions = findFolderCollisions(db, folderPlan);
  const docCollisions = findDocCollisions(db, docPlan);
  if (folderCollisions.length + docCollisions.length > 0) {
    console.error('');
    console.error('[migrate-bots-to-user] ABORT: target paths already occupied:');
    for (const c of [...folderCollisions, ...docCollisions]) console.error(`  ${c}`);
    db.close();
    process.exit(3);
  }

  applyMigration(db, folderPlan, docPlan, targetUser);

  console.log('');
  console.log(`[migrate-bots-to-user] APPLIED ${folderPlan.length} folder + ${docPlan.length} doc migration(s).`);

  const auditDir = path.join(dataDir, 'audit-logs');
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, `migration-bots-to-user-${nowISO().replace(/[:.]/g, '-')}.jsonl`);
    const lines = [
      ...folderPlan.map((p) =>
        JSON.stringify({
          ts: nowISO(),
          op: 'migration:bots-to-user',
          kind: 'folder',
          id: p.id,
          oldPath: p.oldPath,
          newPath: p.newPath,
        }),
      ),
      ...docPlan.map((p) =>
        JSON.stringify({
          ts: nowISO(),
          op: 'migration:bots-to-user',
          kind: 'document',
          id: p.id,
          oldPath: p.oldPath,
          newPath: p.newPath,
        }),
      ),
    ];
    fs.writeFileSync(auditPath, lines.join('\n') + '\n', 'utf8');
    console.log(`[migrate-bots-to-user] audit log: ${auditPath}`);
  } catch (err) {
    console.warn(`[migrate-bots-to-user] audit log write failed: ${(err as Error).message}`);
  }

  db.close();
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main();
}

/**
 * One-shot migration: relocate documents written under
 *   /users/<ownerName>/<slug>...
 * by an agent-kind cred (botName !== ownerName, stamped into `created_by`) to
 *   /users/<ownerName>/agents/<created_by>/<slug>...
 *
 * Why: after the self-namespace ACL tightening (see auth/credentials.ts,
 * `selfNamespace`), an agent cred can no longer write to its owner's user
 * root. Pre-existing docs need to be regrouped so the writer can still update
 * them and so the Web UI tree groups them under the bot subfolder.
 *
 * Skipped (idempotent + safe):
 *   - Already under /users/<X>/agents/<Y>/...
 *   - created_by empty (no attribution — would cause `agents//` and we can't
 *     reconstruct authorship)
 *   - created_by === <user-segment> (SSO-self writes — botName === ownerName,
 *     already in self namespace)
 *
 * Usage (from packages/server after `npm run build`):
 *   node dist/scripts/migrate-agent-namespaces.js          # dry-run
 *   node dist/scripts/migrate-agent-namespaces.js --apply  # write
 *
 * Env: LUCKAGENT_CORE_DATA_DIR (defaults to ~/.luckagent-core/data, same as server).
 *
 * Re-runs are safe — the WHERE clause filters out already-migrated rows.
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
  created_by: string;
}

export interface FolderRow {
  id: string;
  path: string;
}

export interface MigrationPlanItem {
  id: string;
  oldPath: string;
  newPath: string;
  owner: string;
  bot: string;
}

export interface SkippedItem {
  row: DocRow;
  reason: string;
}

function nowISO(): string {
  return new Date().toISOString();
}

/**
 * Extract the first path segment under /users/. Returns null if the path does
 * not match `/users/<segment>/...` shape.
 */
function ownerFromPath(p: string): string | null {
  if (!p.startsWith('/users/')) return null;
  const rest = p.slice('/users/'.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return rest.slice(0, slash);
}

export function buildPlan(rows: DocRow[]): { plan: MigrationPlanItem[]; skipped: SkippedItem[] } {
  const plan: MigrationPlanItem[] = [];
  const skipped: SkippedItem[] = [];

  for (const row of rows) {
    if (!row.path.startsWith('/users/')) {
      skipped.push({ row, reason: 'not under /users/' });
      continue;
    }
    if (/^\/users\/[^/]+\/agents\//.test(row.path)) {
      skipped.push({ row, reason: 'already under agents/' });
      continue;
    }
    const owner = ownerFromPath(row.path);
    if (!owner) {
      skipped.push({ row, reason: 'malformed /users/ path' });
      continue;
    }
    const createdBy = (row.created_by || '').trim();
    if (!createdBy) {
      skipped.push({ row, reason: 'created_by empty' });
      continue;
    }
    if (createdBy === owner) {
      skipped.push({ row, reason: 'SSO self-write (created_by === owner)' });
      continue;
    }

    const tail = row.path.slice(`/users/${owner}/`.length);
    const newPath = `/users/${owner}/agents/${createdBy}/${tail}`;
    plan.push({ id: row.id, oldPath: row.path, newPath, owner, bot: createdBy });
  }

  return { plan, skipped };
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

/** Detect target-path collisions (other docs already occupying the new path). */
export function findCollisions(db: Database.Database, plan: MigrationPlanItem[]): string[] {
  const collisions: string[] = [];
  const stmt = db.prepare('SELECT id FROM documents WHERE path = ?');
  for (const item of plan) {
    const existing = stmt.get(item.newPath) as { id: string } | undefined;
    if (existing && existing.id !== item.id) {
      collisions.push(`${item.newPath} (occupied by ${existing.id})`);
    }
  }
  return collisions;
}

export function loadCandidates(db: Database.Database): DocRow[] {
  return db.prepare(
    `SELECT id, path, created_by FROM documents
     WHERE path LIKE '/users/%/%'
       AND path NOT LIKE '/users/%/agents/%'
     ORDER BY path`,
  ).all() as DocRow[];
}

/** Apply the plan atomically (single transaction). Caller must pre-check collisions. */
export function applyMigration(db: Database.Database, plan: MigrationPlanItem[]): void {
  const trx = db.transaction(() => {
    for (const item of plan) {
      const parentPath = item.newPath.slice(0, item.newPath.lastIndexOf('/')) || '/';
      const parent = ensureFolderPath(db, parentPath);
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
  const dbPath = path.join(dataDir, 'central.db');

  if (!fs.existsSync(dbPath)) {
    console.error(`[migrate-agent-namespaces] DB not found: ${dbPath}`);
    process.exit(2);
  }

  console.log(`[migrate-agent-namespaces] db=${dbPath} mode=${apply ? 'APPLY' : 'DRY-RUN'}`);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  const candidates = loadCandidates(db);
  const { plan, skipped } = buildPlan(candidates);

  console.log('');
  console.log(`[migrate-agent-namespaces] candidates scanned: ${candidates.length}`);
  console.log(`[migrate-agent-namespaces] to migrate:         ${plan.length}`);
  console.log(`[migrate-agent-namespaces] skipped:            ${skipped.length}`);

  if (skipped.length > 0) {
    const byReason = new Map<string, number>();
    for (const s of skipped) {
      byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    }
    console.log('  Skipped breakdown:');
    for (const [reason, count] of byReason.entries()) {
      console.log(`    - ${reason}: ${count}`);
    }
    for (const s of skipped) {
      if (s.reason === 'created_by empty') {
        console.warn(`  WARN created_by empty: ${s.row.id} path=${s.row.path}`);
      }
    }
  }

  if (plan.length === 0) {
    console.log('');
    console.log('[migrate-agent-namespaces] nothing to do.');
    db.close();
    return;
  }

  console.log('');
  console.log('Migration plan:');
  for (const item of plan) {
    console.log(`  ${item.oldPath}`);
    console.log(`    -> ${item.newPath}`);
  }

  if (!apply) {
    console.log('');
    console.log('[migrate-agent-namespaces] DRY-RUN complete. Re-run with --apply to write.');
    db.close();
    return;
  }

  const collisions = findCollisions(db, plan);
  if (collisions.length > 0) {
    console.error('');
    console.error('[migrate-agent-namespaces] ABORT: target paths already occupied:');
    for (const c of collisions) console.error(`  ${c}`);
    db.close();
    process.exit(3);
  }

  applyMigration(db, plan);

  console.log('');
  console.log(`[migrate-agent-namespaces] APPLIED ${plan.length} migration(s).`);

  const auditDir = path.join(dataDir, 'audit-logs');
  try {
    fs.mkdirSync(auditDir, { recursive: true });
    const auditPath = path.join(auditDir, `migration-agent-namespace-${nowISO().replace(/[:.]/g, '-')}.jsonl`);
    const lines = plan.map((p) =>
      JSON.stringify({
        ts: nowISO(),
        op: 'migration:agent-namespace',
        documentId: p.id,
        oldPath: p.oldPath,
        newPath: p.newPath,
        owner: p.owner,
        bot: p.bot,
      }),
    );
    fs.writeFileSync(auditPath, lines.join('\n') + '\n', 'utf8');
    console.log(`[migrate-agent-namespaces] audit log: ${auditPath}`);
  } catch (err) {
    console.warn(`[migrate-agent-namespaces] audit log write failed: ${(err as Error).message}`);
  }

  db.close();
}

// Only run main() when invoked directly as a script (not when imported by tests).
const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main();
}

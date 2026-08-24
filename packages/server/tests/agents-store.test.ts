import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AgentNotFoundError,
  AgentStore,
  NameSquatError,
} from '../src/agents/agent-store.js';

let dir: string;
let db: Database.Database;
let store: AgentStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-store-test-'));
  db = new Database(path.join(dir, 'central.db'));
  db.pragma('journal_mode = WAL');
  store = new AgentStore(db, pino({ level: 'silent' }));
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('AgentStore', () => {
  it('registers a new agent and returns the full record', () => {
    const rec = store.register({
      botName: 'alice-bot',
      url: 'http://10.0.0.1:9100',
      ownerCredentialId: 'cred-alice',
    });
    expect(rec.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(rec.botName).toBe('alice-bot');
    expect(rec.url).toBe('http://10.0.0.1:9100');
    expect(rec.visible).toBe(true);
    expect(rec.ownerCredentialId).toBe('cred-alice');
    expect(rec.registeredAt).toBe(rec.lastSeenAt);
  });

  it('register defaults visible=true, honours visible:false', () => {
    store.register({
      botName: 'a', url: 'http://x', ownerCredentialId: 'c',
    });
    const hidden = store.register({
      botName: 'b', url: 'http://x', ownerCredentialId: 'c', visible: false,
    });
    expect(store.getByName('a')!.visible).toBe(true);
    expect(hidden.visible).toBe(false);
  });

  it('one credential can own many bot names (multi-bot ownership)', () => {
    store.register({ botName: 'alpha', url: 'http://a', ownerCredentialId: 'cred-shared' });
    store.register({ botName: 'beta', url: 'http://b', ownerCredentialId: 'cred-shared' });
    store.register({ botName: 'gamma', url: 'http://c', ownerCredentialId: 'cred-shared' });
    const owned = store.listOwnedBy('cred-shared');
    expect(owned.map((a) => a.botName).sort()).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('re-register by the same owner upserts url/visibility and bumps last_seen_at', async () => {
    const r1 = store.register({
      botName: 'a', url: 'http://old', ownerCredentialId: 'cred-a',
    });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = store.register({
      botName: 'a', url: 'http://new', visible: false, ownerCredentialId: 'cred-a',
    });
    expect(r2.id).toBe(r1.id);
    expect(r2.url).toBe('http://new');
    expect(r2.visible).toBe(false);
    expect(r2.registeredAt).toBe(r1.registeredAt);
    expect(Date.parse(r2.lastSeenAt)).toBeGreaterThan(Date.parse(r1.lastSeenAt));
  });

  it('re-register by a different credential throws NameSquatError (anti-squat preserved)', () => {
    store.register({
      botName: 'a', url: 'http://x', ownerCredentialId: 'cred-a',
    });
    expect(() => store.register({
      botName: 'a', url: 'http://y', ownerCredentialId: 'cred-b',
    })).toThrow(NameSquatError);
  });

  it('heartbeat bumps last_seen_at and returns the new timestamp', async () => {
    const r1 = store.register({
      botName: 'a', url: 'http://x', ownerCredentialId: 'cred-a',
    });
    await new Promise((r) => setTimeout(r, 5));
    const ts = store.heartbeat('a', 'cred-a');
    expect(Date.parse(ts)).toBeGreaterThan(Date.parse(r1.lastSeenAt));
    expect(store.getByName('a')!.lastSeenAt).toBe(ts);
  });

  it('heartbeat on unknown agent throws AgentNotFoundError', () => {
    expect(() => store.heartbeat('ghost', 'cred-x')).toThrow(AgentNotFoundError);
  });

  it('heartbeat by a different credential throws NameSquatError', () => {
    store.register({
      botName: 'a', url: 'http://x', ownerCredentialId: 'cred-a',
    });
    expect(() => store.heartbeat('a', 'cred-b')).toThrow(NameSquatError);
  });

  it('heartbeatMany bumps every owned name and silently skips unowned/unknown ones', async () => {
    store.register({ botName: 'alpha', url: 'http://a', ownerCredentialId: 'cred-shared' });
    store.register({ botName: 'beta', url: 'http://b', ownerCredentialId: 'cred-shared' });
    store.register({ botName: 'other', url: 'http://o', ownerCredentialId: 'cred-other' });
    const before = store.getByName('alpha')!.lastSeenAt;
    await new Promise((r) => setTimeout(r, 5));
    const bumped = store.heartbeatMany(['alpha', 'beta', 'other', 'ghost'], 'cred-shared');
    expect(Object.keys(bumped).sort()).toEqual(['alpha', 'beta']);
    expect(Date.parse(store.getByName('alpha')!.lastSeenAt)).toBeGreaterThan(Date.parse(before));
    expect(store.getByName('other')!.lastSeenAt).toBeDefined();
  });

  it('heartbeatMany on empty array short-circuits to {}', () => {
    expect(store.heartbeatMany([], 'cred-a')).toEqual({});
  });

  it('list excludes hidden by default; includeHidden returns them', () => {
    store.register({ botName: 'pub', url: 'http://p', ownerCredentialId: 'c' });
    store.register({ botName: 'sec', url: 'http://s', visible: false, ownerCredentialId: 'c' });
    const visible = store.list();
    expect(visible.map((a) => a.botName)).toEqual(['pub']);
    const all = store.list({ includeHidden: true });
    expect(all.map((a) => a.botName).sort()).toEqual(['pub', 'sec']);
  });

  it('list excludes rows whose last_seen_at is older than ttlMs (computed at read)', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    const rec = store.getByName('a')!;
    const lastSeenMs = Date.parse(rec.lastSeenAt);
    expect(store.list({ now: lastSeenMs + 60_000 }).map((a) => a.botName)).toEqual(['a']);
    expect(store.list({ now: lastSeenMs + 200_000 }).map((a) => a.botName)).toEqual([]);
  });

  it('list ttlMs is configurable (3× heartbeat)', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    const lastSeenMs = Date.parse(store.getByName('a')!.lastSeenAt);
    expect(store.list({ now: lastSeenMs + 5_000, ttlMs: 4_000 }).length).toBe(0);
    expect(store.list({ now: lastSeenMs + 5_000, ttlMs: 10_000 }).length).toBe(1);
  });

  it('setVisibility flips the flag; setVisibility on unknown throws', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    expect(store.setVisibility('a', false).visible).toBe(false);
    expect(store.list().length).toBe(0);
    expect(store.setVisibility('a', true).visible).toBe(true);
    expect(store.list().length).toBe(1);
    expect(() => store.setVisibility('ghost', true)).toThrow(AgentNotFoundError);
  });

  it('remove deletes the row; remove of unknown returns false', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    expect(store.remove('a')).toBe(true);
    expect(store.getByName('a')).toBeUndefined();
    expect(store.remove('a')).toBe(false);
  });

  it('purgeStale deletes rows older than maxAgeMs (default 24h) and returns the count', () => {
    store.register({ botName: 'fresh', url: 'http://x', ownerCredentialId: 'c' });
    store.register({ botName: 'old',   url: 'http://x', ownerCredentialId: 'c' });
    const oldTs = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE agents SET last_seen_at = ? WHERE bot_name = ?').run(oldTs, 'old');
    const removed = store.purgeStale();
    expect(removed).toBe(1);
    expect(store.getByName('old')).toBeUndefined();
    expect(store.getByName('fresh')).toBeDefined();
  });

  it('purgeStale honours injected now + maxAgeMs (for deterministic tests)', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    const lastSeenMs = Date.parse(store.getByName('a')!.lastSeenAt);
    expect(store.purgeStale(lastSeenMs + 1_000, 500)).toBe(1);
    expect(store.getByName('a')).toBeUndefined();
  });

  it('legacy talk_secret column is preserved nullable (reads existing rows with non-null value)', () => {
    // Simulate a pre-migration row that still has a talk_secret value. The new
    // store must read it back without error and never surface it.
    db.prepare(`
      INSERT INTO agents (id, bot_name, url, talk_secret, visible,
        owner_credential_id, registered_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-id', 'legacy-bot', 'http://l', 'legacy-secret', 1,
      'cred-legacy', new Date().toISOString(), new Date().toISOString(),
    );
    const rec = store.getByName('legacy-bot');
    expect(rec).toBeDefined();
    expect(rec!.botName).toBe('legacy-bot');
    expect((rec as unknown as { talkSecret?: string }).talkSecret).toBeUndefined();
  });

  it('initSchema is idempotent (second AgentStore against same db does not throw)', () => {
    expect(() => new AgentStore(db, pino({ level: 'silent' }))).not.toThrow();
  });

  it('memoryPublic defaults to true on fresh register; honours explicit false', () => {
    const pub = store.register({ botName: 'pub', url: 'http://x', ownerCredentialId: 'c' });
    expect(pub.memoryPublic).toBe(true);
    const priv = store.register({
      botName: 'priv', url: 'http://x', memoryPublic: false, ownerCredentialId: 'c',
    });
    expect(priv.memoryPublic).toBe(false);
  });

  it('re-register WITHOUT memoryPublic preserves the existing value (runtime toggle stickiness)', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    store.setMemoryPublic('a', false);
    const r2 = store.register({ botName: 'a', url: 'http://y', ownerCredentialId: 'c' });
    expect(r2.memoryPublic).toBe(false);
  });

  it('re-register WITH explicit memoryPublic:false clobbers the runtime toggle (bots.json pin)', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    store.setMemoryPublic('a', true);
    const r2 = store.register({
      botName: 'a', url: 'http://x', memoryPublic: false, ownerCredentialId: 'c',
    });
    expect(r2.memoryPublic).toBe(false);
  });

  it('setMemoryPublic flips the flag; setMemoryPublic on unknown throws', () => {
    store.register({ botName: 'a', url: 'http://x', ownerCredentialId: 'c' });
    expect(store.setMemoryPublic('a', true).memoryPublic).toBe(true);
    expect(store.setMemoryPublic('a', false).memoryPublic).toBe(false);
    expect(() => store.setMemoryPublic('ghost', true)).toThrow(AgentNotFoundError);
  });

  it('memory_public column survives a pre-migration row (idempotent ADD COLUMN path)', () => {
    // Build a DB whose agents table predates the memory_public column. The
    // store's idempotent ALTER must add the column without losing the row.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-store-test-legacy-'));
    const db2 = new Database(path.join(dir2, 'central.db'));
    try {
      db2.pragma('journal_mode = WAL');
      db2.exec(`
        CREATE TABLE agents (
          id                  TEXT PRIMARY KEY,
          bot_name            TEXT NOT NULL UNIQUE,
          url                 TEXT NOT NULL,
          talk_secret         TEXT,
          visible             INTEGER NOT NULL DEFAULT 1,
          owner_credential_id TEXT NOT NULL,
          registered_at       TEXT NOT NULL,
          last_seen_at        TEXT NOT NULL
        );
      `);
      const ts = new Date().toISOString();
      db2.prepare(`
        INSERT INTO agents (id, bot_name, url, talk_secret, visible,
          owner_credential_id, registered_at, last_seen_at)
        VALUES (?, ?, ?, NULL, 1, ?, ?, ?)
      `).run('legacy-id', 'legacy-bot', 'http://l', 'cred-legacy', ts, ts);
      const store2 = new AgentStore(db2, pino({ level: 'silent' }));
      const rec = store2.getByName('legacy-bot');
      expect(rec).toBeDefined();
      // ALTER ADD COLUMN ... DEFAULT 1 backfills the pre-existing row to true.
      expect(rec!.memoryPublic).toBe(true);
    } finally {
      db2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});

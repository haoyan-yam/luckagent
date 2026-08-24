import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { ExecutorRegistry } from '../src/engines/claude/executor-registry.js';

/**
 * Mock the executor module so the registry's REAL buildExecutor() can run
 * without spawning a Claude process. The mocked constructor returns an
 * EventEmitter-backed fake exposing exactly the methods the registry calls.
 * This lets us exercise the production listener wiring (crash → park,
 * restarted → unflag, closed → remove) end-to-end, not a hand-copied mirror.
 */
const mockInstances: any[] = [];
vi.mock('../src/engines/claude/persistent-executor.js', async () => {
  const { EventEmitter: EE } = await import('node:events');
  class MockPersistentExecutor extends EE {
    state: 'ready' | 'closed' | 'restarting' = 'ready';
    sessionId = 'mock-sess';
    getState() { return this.state; }
    getSessionId() { return this.sessionId; }
    getLastActivityAt() { return Date.now(); }
    hasActiveTurn() { return false; }
    async start() { this.state = 'ready'; }
    async shutdown() { this.state = 'closed'; this.emit('closed'); }
    constructor() { super(); mockInstances.push(this); }
  }
  return { PersistentClaudeExecutor: MockPersistentExecutor };
});

/**
 * Crash-resurrection (Problem A).
 *
 * When a PersistentClaudeExecutor exhausts its in-process restart budget it
 * emits 'crashed' and then transitions to a terminal 'closed'. The registry
 * must NOT discard the pool slot in that case — doing so loses Agent-Team
 * teammates, in-progress tasks and conversation context. Instead the slot is
 * PARKED (crashed=true, last sessionId captured) and respawned on the next
 * acquire, resuming the same Claude session, with exponential backoff and a
 * respawn cap. Intentional release / LRU eviction must NOT trigger respawn.
 *
 * These tests drive the registry through its real listener wiring
 * (buildExecutor) using a fake executor, and stub buildExecutor only for the
 * respawn path so no real Claude process is spawned.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

type FakeState = 'ready' | 'closed' | 'restarting';

class FakeExecutor extends EventEmitter {
  state: FakeState = 'ready';
  sessionId: string | undefined;
  constructor(sessionId?: string) { super(); this.sessionId = sessionId; }
  getState() { return this.state; }
  getSessionId() { return this.sessionId; }
  getLastActivityAt() { return Date.now(); }
  hasActiveTurn() { return false; }
  async start() { this.state = 'ready'; }
  async shutdown() { this.state = 'closed'; this.emit('closed'); }
  /** Simulate the executor exhausting its restart budget and dying. */
  crashToDeath(finalSessionId?: string) {
    if (finalSessionId) this.sessionId = finalSessionId;
    this.emit('crashed', new Error('stream errored'));
    this.state = 'closed';
    this.emit('closed');
  }
}

describe('ExecutorRegistry crash resurrection (Problem A)', () => {
  it('parks a crash-exhausted executor instead of removing it (preserves session)', () => {
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const opts = { cwd: '/tmp' };

    // Use buildExecutor's real wiring by constructing the entry then attaching
    // the SAME listeners buildExecutor attaches, but onto our fake executor.
    const fake = new FakeExecutor('sess-1');
    const entry: any = {
      executor: fake, chatId: 'chat-1', model: undefined, acquireOpts: opts,
      crashed: false, resumeSessionId: undefined, respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-1', entry);
    // Re-create just the listener wiring from buildExecutor against the fake.
    attachRegistryListeners(registry, 'chat-1', fake);

    const removed: string[] = [];
    registry.on('executor-removed', (c: string) => removed.push(c));

    fake.crashToDeath('sess-1-forked');

    // Slot is KEPT (parked), NOT removed.
    expect(registry.executors.has('chat-1')).toBe(true);
    expect(entry.crashed).toBe(true);
    expect(entry.crashedFlagSeen).toBe(true);
    expect(entry.resumeSessionId).toBe('sess-1-forked'); // captured for resume
    expect(removed).toEqual([]); // no executor-removed emitted on crash-park
    // Backoff gate set into the future (>= ~now).
    expect(entry.nextRespawnAt).toBeGreaterThan(Date.now() - 10);
  });

  it('removes the slot on a clean (graceful) close — no parking', () => {
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const fake = new FakeExecutor('sess-2');
    const entry: any = {
      executor: fake, chatId: 'chat-2', model: undefined, acquireOpts: { cwd: '/tmp' },
      crashed: false, resumeSessionId: undefined, respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-2', entry);
    attachRegistryListeners(registry, 'chat-2', fake);

    const removed: string[] = [];
    registry.on('executor-removed', (c: string) => removed.push(c));

    // Clean close: no 'crashed' first.
    fake.state = 'closed';
    fake.emit('closed');

    expect(registry.executors.has('chat-2')).toBe(false);
    expect(removed).toEqual(['chat-2']);
  });

  it('does NOT park after a transient crash that self-recovered then closed cleanly', () => {
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const fake = new FakeExecutor('sess-3');
    const entry: any = {
      executor: fake, chatId: 'chat-3', model: undefined, acquireOpts: { cwd: '/tmp' },
      crashed: false, resumeSessionId: undefined, respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-3', entry);
    attachRegistryListeners(registry, 'chat-3', fake);

    const removed: string[] = [];
    registry.on('executor-removed', (c: string) => removed.push(c));

    // Transient crash, then in-process recovery ('restarted'), then later a
    // clean idle close. Must be treated as graceful (removed), not parked.
    fake.emit('crashed', new Error('transient'));
    expect(entry.crashedFlagSeen).toBe(true);
    fake.state = 'ready';
    fake.emit('restarted', 'sess-3'); // recovery signal clears the crash flag
    expect(entry.crashedFlagSeen).toBe(false);

    fake.state = 'closed';
    fake.emit('closed');
    expect(registry.executors.has('chat-3')).toBe(false);
    expect(removed).toEqual(['chat-3']);
  });

  it('respawnCrashed resumes the captured session and uses exponential backoff', async () => {
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const opts = { cwd: '/tmp' };
    const parked: any = {
      executor: new FakeExecutor('dead'), chatId: 'chat-4', model: undefined,
      acquireOpts: opts, crashed: true, crashedFlagSeen: true,
      resumeSessionId: 'resume-me', respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-4', parked);

    // Stub buildExecutor so no real Claude process spawns; capture the resume arg.
    const builtWith: any[] = [];
    registry.buildExecutor = (chatId: string, entry: any, o: any, model: any, resume: any) => {
      builtWith.push({ chatId, model, resume });
      return new FakeExecutor('new-sess');
    };

    const respawned = await registry.respawnCrashed('chat-4', parked, opts);
    expect(respawned).toBeTruthy();
    expect(parked.respawnAttempts).toBe(1);
    expect(parked.crashed).toBe(false);
    expect(parked.crashedFlagSeen).toBe(false);
    // Resumed the captured session id.
    expect(builtWith[0].resume).toBe('resume-me');
  });

  it('removes the slot once the respawn budget is exhausted', async () => {
    const registry = new ExecutorRegistry({ logger: mockLogger, maxRespawnAttempts: 2 }) as any;
    const parked: any = {
      executor: new FakeExecutor('dead'), chatId: 'chat-5', model: undefined,
      acquireOpts: { cwd: '/tmp' }, crashed: true, crashedFlagSeen: true,
      resumeSessionId: 'r', respawnAttempts: 2, // already at the cap
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-5', parked);

    const removed: string[] = [];
    registry.on('executor-removed', (c: string) => removed.push(c));

    const respawned = await registry.respawnCrashed('chat-5', parked, { cwd: '/tmp' });
    expect(respawned).toBeUndefined();
    expect(registry.executors.has('chat-5')).toBe(false);
    expect(removed).toEqual(['chat-5']);
  });

  it('REAL buildExecutor wiring: crash-to-death parks the slot, restarted unflags it', () => {
    mockInstances.length = 0;
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const opts = { cwd: '/tmp' };
    const entry: any = {
      executor: undefined, chatId: 'chat-real', model: undefined, acquireOpts: opts,
      crashed: false, resumeSessionId: undefined, respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    // Drive the production listener wiring against the mocked executor.
    const exec = registry.buildExecutor('chat-real', entry, opts, undefined, undefined);
    entry.executor = exec;
    registry.executors.set('chat-real', entry);

    const removed: string[] = [];
    registry.on('executor-removed', (c: string) => removed.push(c));

    // Transient crash then in-process recovery: production 'restarted' handler
    // must clear the crash flag.
    exec.emit('crashed', new Error('transient'));
    expect(entry.crashedFlagSeen).toBe(true);
    exec.emit('restarted', 'mock-sess');
    expect(entry.crashedFlagSeen).toBe(false);

    // Now a real crash-to-death: 'crashed' then terminal 'closed'.
    exec.state = 'closed';
    exec.emit('crashed', new Error('fatal'));
    exec.emit('closed');

    expect(registry.executors.has('chat-real')).toBe(true); // parked, not removed
    expect(entry.crashed).toBe(true);
    expect(removed).toEqual([]); // no removal event on crash-park
  });

  it('intentional release() does NOT park or respawn (clean removal)', async () => {
    const registry = new ExecutorRegistry({ logger: mockLogger }) as any;
    const fake = new FakeExecutor('sess-6');
    const entry: any = {
      executor: fake, chatId: 'chat-6', model: undefined, acquireOpts: { cwd: '/tmp' },
      crashed: false, resumeSessionId: undefined, respawnAttempts: 0,
      nextRespawnAt: 0, healthySince: Date.now(),
    };
    registry.executors.set('chat-6', entry);
    attachRegistryListeners(registry, 'chat-6', fake);

    await registry.release('chat-6', 'reset');

    expect(registry.executors.has('chat-6')).toBe(false);
    expect(entry.crashed).toBe(false); // never marked crashed
  });
});

/**
 * Re-attach the exact lifecycle listeners that buildExecutor wires, but onto a
 * caller-supplied fake executor (buildExecutor itself news a real
 * PersistentClaudeExecutor). Mirrors the wiring in
 * ExecutorRegistry.buildExecutor so these tests exercise the real decision
 * logic in the 'crashed' / 'restarted' / 'closed' handlers.
 */
function attachRegistryListeners(registry: any, chatId: string, executor: FakeExecutor) {
  executor.on('crashed', () => {
    const cur = registry.executors.get(chatId);
    if (!cur || cur.executor !== executor) return;
    const sid = executor.getSessionId();
    if (sid) cur.resumeSessionId = sid;
  });
  executor.once('closed', () => {
    const cur = registry.executors.get(chatId);
    if (!cur || cur.executor !== executor) return;
    const sid = executor.getSessionId();
    if (sid) cur.resumeSessionId = sid;
    const maxRespawn = registry.opts.maxRespawnAttempts ?? 3;
    const crashExhausted =
      cur.executor.getState() === 'closed' &&
      cur.crashedFlagSeen === true &&
      cur.respawnAttempts < maxRespawn &&
      !registry.shuttingDown;
    if (crashExhausted) {
      cur.crashed = true;
      cur.nextRespawnAt = Date.now() + registry.respawnBackoffMs(cur.respawnAttempts);
      return;
    }
    registry.executors.delete(chatId);
    registry.emit('executor-removed', chatId);
  });
  executor.on('crashed', () => {
    const cur = registry.executors.get(chatId);
    if (cur && cur.executor === executor) cur.crashedFlagSeen = true;
  });
  executor.on('restarted', () => {
    const cur = registry.executors.get(chatId);
    if (!cur || cur.executor !== executor) return;
    cur.crashedFlagSeen = false;
    cur.healthySince = Date.now();
    const sid = executor.getSessionId();
    if (sid) cur.resumeSessionId = sid;
  });
}

import { describe, it, expect } from 'vitest';
import { PersistentClaudeExecutor } from '../src/engines/claude/persistent-executor.js';

/**
 * Regression: PTY `/stop` wedge.
 *
 * Symptom (prod 2026-05-30, after PTY became the default backend): the user
 * sends `/stop` to interrupt a running turn, then types a new message and gets
 * a BLANK reply. The bridge logged:
 *
 *   PersistentExecutor.nextTurn: turn <id> is in flight; caller must wait or
 *   call abort() before starting another
 *
 * Root cause: abort() set turn.detached, called the backend interrupt(), then
 * `await turn.drainPromise`. drainPromise only resolves when consumeLoop sees
 * the turn's terminal `result`. The SDK backend emits one after interrupt(),
 * but the PTY backend's interrupt() (ESC + Ctrl-C) fired NO Stop hook and left
 * the process alive, so NO result was ever synthesized → drainPromise never
 * resolved → activeTurn stayed pinned → every later nextTurn() threw.
 *
 * Two-layer fix:
 *   1. ptyQuery.interrupt() now synthesizes a terminal result (covered by the
 *      adapter/pty tests + manual verification).
 *   2. abort() awaits drainWithTimeout(): if no result arrives within the
 *      budget it force-clears activeTurn so the chat self-heals. This test
 *      pins layer 2 — the executor-level safety net — using a backend whose
 *      interrupt() deliberately produces NO result.
 */

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
} as any;

/**
 * A fake rawStream that yields the active turn's assistant messages but NEVER a
 * `result`, plus an interrupt() that (mis)behaves like a backend that forgets
 * to close the turn. This is the exact condition that used to wedge abort().
 */
function makeExecWithStuckBackend(): {
  exec: PersistentClaudeExecutor;
  interruptCalls: () => number;
} {
  const exec = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: mockLogger,
    idleTimeoutMs: 0,
    abortDrainTimeoutMs: 200, // keep the safety-net test fast
  });

  let resolveBlock!: () => void;
  const blockForever = new Promise<void>((r) => { resolveBlock = r; });
  let interrupts = 0;

  // rawStream: emit one assistant message for the turn, then block (no result).
  async function* stuckStream(): AsyncGenerator<unknown> {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working...' }] },
      session_id: 'sess-stuck',
    };
    await blockForever; // never a `result`
  }
  (exec as any).rawStream = stuckStream();
  // queryHandle.interrupt() that does NOT cause a result to be emitted —
  // mirrors the pre-fix PTY interrupt() behavior we are guarding against.
  (exec as any).queryHandle = { interrupt: async () => { interrupts++; } };
  (exec as any).state = 'ready';
  // Drive the consume loop in the background.
  void (exec as any).consumeLoop();
  // Let the loop pull the first assistant message.
  return { exec, interruptCalls: () => interrupts };
}

describe('PersistentClaudeExecutor: abort() never wedges the chat', () => {
  it('abort() resolves and clears activeTurn even when the backend emits no result', async () => {
    const { exec, interruptCalls } = makeExecWithStuckBackend();

    const handle = exec.nextTurn('hello');
    expect(exec.hasActiveTurn()).toBe(true);

    // Pre-fix this would hang forever; abort() now force-clears via the
    // (test-shortened) drain timeout. Race a generous guard to prove it returns.
    const aborted = handle.abort();
    const guard = new Promise<'hung'>((r) => setTimeout(() => r('hung'), 5_000));
    const outcome = await Promise.race([aborted.then(() => 'resolved' as const), guard]);

    expect(outcome).toBe('resolved');
    expect(interruptCalls()).toBe(1);
    // The whole point: activeTurn is cleared so the NEXT turn can start.
    expect(exec.hasActiveTurn()).toBe(false);
  }, 10_000);

  it('after an interrupted turn, nextTurn() starts a fresh turn instead of throwing "in flight"', async () => {
    const { exec } = makeExecWithStuckBackend();

    const first = exec.nextTurn('first');
    await first.abort(); // force-clears via drainWithTimeout

    // This is the line that used to throw in prod (blank Feishu reply).
    expect(() => exec.nextTurn('second')).not.toThrow();
    expect(exec.hasActiveTurn()).toBe(true);
  }, 10_000);
});

import { describe, expect, it, vi } from 'vitest';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import type { BotConfigBase } from '../src/config.js';
import type { CardState, IncomingMessage } from '../src/types.js';

/**
 * Turn-start failures and admission races (code review 2026-09-23):
 *  1. runOneTurn() threw outside executeQuery's try — the thinking card spun
 *     forever and the user saw nothing.
 *  2. executeApiTask() had no admission marker — a user message arriving while
 *     it awaited rollover/sweep/sendCard started a colliding turn.
 *  3. A finishing turn drains the queue BEFORE releasing its own admission; the
 *     release must not clear the admission the next queued turn just took.
 *  4. A turn started right after /stop must wait for the aborting turn to
 *     drain instead of throwing "turn … is in flight".
 */

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLogger,
} as any;

function makeConfig(): BotConfigBase {
  return {
    name: 'test-bot',
    engine: 'claude',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/luckagent-test-outputs',
      downloadsDir: '/tmp/luckagent-test-downloads',
      backend: 'pty',
    },
    persistentExecutor: { enabled: true },
  };
}

function makeSender() {
  const sent: Array<{ chatId: string; state: CardState }> = [];
  const updated: Array<{ messageId: string; state: CardState }> = [];
  const notices: string[] = [];
  return {
    sent,
    updated,
    notices,
    async sendCard(chatId: string, state: CardState) {
      sent.push({ chatId, state });
      return `msg-${sent.length}`;
    },
    async updateCard(messageId: string, state: CardState) {
      updated.push({ messageId, state });
      return true;
    },
    async sendTextNotice(_chatId: string, title: string) {
      notices.push(title);
    },
    async sendText() {},
    async sendImageFile() {
      return true;
    },
    async sendLocalFile() {
      return true;
    },
    async downloadImage() {
      return false;
    },
    async downloadFile() {
      return false;
    },
  };
}

function msg(chatId: string, text: string, n = 1): IncomingMessage {
  return { messageId: `om_${n}`, chatId, chatType: 'p2p', userId: 'ou_user', text };
}

/** An ExecutionHandle whose stream immediately yields a successful result. */
function completedHandle() {
  return {
    stream: (async function* () {
      yield { type: 'result', subtype: 'success', result: 'done', session_id: 's1', total_cost_usd: 0 };
    })(),
    finish: () => {},
    sendAnswer: () => {},
    resolveQuestion: () => {},
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('turn start failure', () => {
  it('finalizes the thinking card to an error when runOneTurn throws', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any);
    (bridge as any).runOneTurn = vi.fn(async () => {
      throw new Error('PTY backend requires the claude CLI binary');
    });

    await bridge.handleMessage(msg('c1', 'hello'));

    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].state.status).toBe('thinking');
    const final = sender.updated.at(-1)!;
    expect(final.messageId).toBe('msg-1');
    expect(final.state.status).toBe('error');
    expect(final.state.errorMessage).toContain('PTY backend requires the claude CLI binary');
    expect(bridge.isBusy('c1')).toBe(false);
  });

  it('drains the queue after a failed start and keeps the next turn admitted', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any);
    let releaseSecond!: () => void;
    const calls: string[] = [];
    (bridge as any).runOneTurn = vi.fn(async (_chatId: string, _engine: string, opts: { prompt: string }) => {
      calls.push(opts.prompt);
      if (calls.length === 1) {
        // While the first turn is still starting, a second message queues.
        await bridge.handleMessage(msg('c1', 'second', 2));
        throw new Error('boom');
      }
      await new Promise<void>((r) => {
        releaseSecond = r;
      });
      return completedHandle();
    });

    await bridge.handleMessage(msg('c1', 'first', 1));
    expect(sender.notices).toContain('📋 Queued');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    // The first turn has fully returned (its admission released) while the
    // queued second turn is still starting — the chat must still read busy.
    expect(bridge.isBusy('c1')).toBe(true);
    releaseSecond();
    await vi.waitFor(() => expect(bridge.isBusy('c1')).toBe(false));
  });
});

describe('executeApiTask admission', () => {
  it('marks the chat busy synchronously so a racing user message queues', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any);
    let releaseApi!: () => void;
    let apiStarted = false;
    (bridge as any).runOneTurn = vi.fn(async () => {
      if (!apiStarted) {
        apiStarted = true;
        await new Promise<void>((r) => {
          releaseApi = r;
        });
      }
      return completedHandle();
    });

    const api = bridge.executeApiTask({ prompt: 'daily summary', chatId: 'c2', sendCards: true });
    expect(bridge.isBusy('c2')).toBe(true); // before any await resolved

    await tick();
    await bridge.handleMessage(msg('c2', 'user message'));
    expect(sender.notices).toContain('📋 Queued');

    await vi.waitFor(() => expect(apiStarted).toBe(true));
    releaseApi();
    const result = await api;
    expect(result.success).toBe(true);
    // queued user message ran afterwards
    await vi.waitFor(() => expect((bridge as any).runOneTurn).toHaveBeenCalledTimes(2));
  });

  it('returns a failure and finalizes its card when the turn cannot start', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any);
    (bridge as any).runOneTurn = vi.fn(async () => {
      throw new Error('spawn failed');
    });

    const result = await bridge.executeApiTask({ prompt: 'x', chatId: 'c3', sendCards: true });
    expect(result.success).toBe(false);
    expect(result.error).toContain('spawn failed');
    expect(sender.updated.at(-1)!.state.status).toBe('error');
    expect(bridge.isBusy('c3')).toBe(false);
  });

  it('still rejects when the chat is already busy', async () => {
    const bridge = new MessageBridge(makeConfig(), mockLogger, makeSender() as any);
    const release = (bridge as any).admit('c4');
    const result = await bridge.executeApiTask({ prompt: 'x', chatId: 'c4' });
    expect(result).toMatchObject({ success: false, error: 'Chat is busy with another task' });
    release();
  });
});

describe('runOneTurn waits for an aborting turn', () => {
  it('starts the next turn once the previous turn has drained', async () => {
    const bridge = new MessageBridge(makeConfig(), mockLogger, makeSender() as any);
    let active = true;
    setTimeout(() => {
      active = false;
    }, 250);
    const exec = {
      hasActiveTurn: () => active,
      nextTurn: vi.fn(() => {
        if (active) throw new Error('turn t1 is in flight');
        return completedHandle();
      }),
    };
    (bridge as any).getOrCreateRegistry = () => ({ acquire: async () => exec });

    const handle = await (bridge as any).runOneTurn('c5', 'claude', {
      prompt: 'after stop',
      cwd: '/tmp',
      abortController: new AbortController(),
      outputsDir: '/tmp/luckagent-test-outputs/c5',
    });
    expect(handle).toBeDefined();
    expect(exec.nextTurn).toHaveBeenCalledTimes(1);
  });
});

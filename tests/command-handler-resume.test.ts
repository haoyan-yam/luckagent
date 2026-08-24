import { describe, it, expect } from 'vitest';
import { CommandHandler } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';
import type { SessionSummary } from '../src/engines/claude/session-lister.js';

/**
 * Direct `/resume <id-prefix>` form. The bare `/resume` picker lives in the
 * bridge; here we cover the command-handler path: engine gate, running-turn
 * guard, prefix matching (unique / ambiguous / none), and the swap callback.
 */

interface RecordedNotice {
  chatId: string;
  title: string;
  content: string;
  color?: string;
}

function makeSessions(): SessionSummary[] {
  return [
    { sessionId: 'abc12345-1111-1111-1111-111111111111', preview: 'first', lastActive: 3000, sizeBytes: 1, isCurrent: false },
    { sessionId: 'abc99999-2222-2222-2222-222222222222', preview: 'second', lastActive: 2000, sizeBytes: 1, isCurrent: false },
    { sessionId: 'def54321-3333-3333-3333-333333333333', preview: 'third', lastActive: 1000, sizeBytes: 1, isCurrent: false },
  ];
}

function buildHandler(opts: {
  engine?: string;
  running?: boolean;
  sessions?: SessionSummary[];
} = {}) {
  const notices: RecordedNotice[] = [];
  const resumed: string[] = [];
  const sender = {
    sendCard: async () => undefined,
    updateCard: async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText: async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile: async () => true,
  };
  const sessionManager = {
    getSession: () => ({ engine: opts.engine, workingDirectory: '/tmp/wd', sessionId: undefined }),
  } as any;
  const handler = new CommandHandler(
    { name: 'test-bot', claude: {} } as any,
    { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender as any,
    sessionManager,
    {} as any,
    { log: () => {} } as any,
    () => (opts.running ? { startTime: Date.now() } : undefined),
    () => {},
    () => 0,
    async () => {},
    () => opts.sessions ?? makeSessions(),
    async (_chatId: string, sessionId: string) => { resumed.push(sessionId); },
  );
  return { handler, notices, resumed };
}

function msg(text: string): IncomingMessage {
  return {
    messageId: 'm1', chatId: 'c1', chatType: 'p2p', userId: 'u1',
    text, timestamp: Date.now(), isBotMentioned: true,
  } as IncomingMessage;
}

describe('CommandHandler /resume', () => {
  it('resumes on a unique prefix and confirms green', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'claude' });
    const handled = await handler.handle(msg('/resume def'));
    expect(handled).toBe(true);
    expect(resumed).toEqual(['def54321-3333-3333-3333-333333333333']);
    expect(notices.at(-1)?.color).toBe('green');
  });

  it('matches an exact full session id even when prefixes overlap', async () => {
    const { handler, resumed } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/resume abc12345-1111-1111-1111-111111111111'));
    expect(resumed).toEqual(['abc12345-1111-1111-1111-111111111111']);
  });

  it('refuses an ambiguous prefix (orange) without resuming', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/resume abc'));
    expect(resumed).toEqual([]);
    expect(notices.at(-1)?.color).toBe('orange');
    expect(notices.at(-1)?.title).toContain('Ambiguous');
  });

  it('reports no match (red) for an unknown prefix', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/resume zzz'));
    expect(resumed).toEqual([]);
    expect(notices.at(-1)?.color).toBe('red');
  });

  it('is gated to the claude engine (red) on a kimi chat', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'kimi' });
    await handler.handle(msg('/resume abc12345'));
    expect(resumed).toEqual([]);
    expect(notices.at(-1)?.color).toBe('red');
    expect(notices.at(-1)?.title).toContain('Claude-only');
  });

  it('refuses while a turn is running (orange)', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'claude', running: true });
    await handler.handle(msg('/resume def'));
    expect(resumed).toEqual([]);
    expect(notices.at(-1)?.color).toBe('orange');
  });

  it('shows usage for a bare /resume (defensive fallback)', async () => {
    const { handler, notices, resumed } = buildHandler({ engine: 'claude' });
    await handler.handle(msg('/resume'));
    expect(resumed).toEqual([]);
    expect(notices.at(-1)?.title).toContain('Resume');
  });
});

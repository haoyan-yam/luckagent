import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import type { CardState } from '../src/types.js';
import type { IMessageSender } from '../src/bridge/message-sender.interface.js';
import { sendCompletionNotice } from '../src/bridge/notification-policy.js';

function makeConfig(overrides: Partial<BotConfigBase> = {}): BotConfigBase {
  return {
    name: 'test',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/outputs',
      downloadsDir: '/tmp/downloads',
      backend: 'pty',
    },
    ...overrides,
  };
}

function makeState(status: CardState['status']): CardState {
  return {
    status,
    userPrompt: 'prompt',
    responseText: 'response',
    toolCalls: [],
  };
}

function makeSender(overrides: Partial<IMessageSender> = {}): IMessageSender {
  return {
    sendCard: vi.fn(),
    updateCard: vi.fn(),
    sendTextNotice: vi.fn(),
    sendText: vi.fn(),
    sendImageFile: vi.fn(),
    sendLocalFile: vi.fn(),
    downloadImage: vi.fn(),
    downloadFile: vi.fn(),
    ...overrides,
  };
}

describe('sendCompletionNotice', () => {
  afterEach(() => {
    delete process.env.LUCKAGENT_VOICE_REPLY;
    delete process.env.FEISHU_VOICE_REPLY;
    delete process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON;
    vi.restoreAllMocks();
  });

  it('skips short tasks', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 9_999,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('skips senders that already route final responses separately', async () => {
    const sender = makeSender({ skipCompletionNotice: true });
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('skips successful tasks when voice reply is enabled', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig({ voiceReply: { enabled: true } }),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(sender.sendText).not.toHaveBeenCalled();
  });

  it('sends Done for long successful tasks without voice reply', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    // [design-note D] sendText 第 3 参是可选 replyToMessageId；未传时为 undefined
    expect(sender.sendText).toHaveBeenCalledWith('chat', '✅ Done', undefined);
  });

  it('sends Failed for long failed tasks', async () => {
    const sender = makeSender();
    await sendCompletionNotice({
      sender,
      config: makeConfig({ voiceReply: { enabled: true } }),
      logger: { warn: vi.fn() } as any,
      chatId: 'chat',
      state: makeState('error'),
      durationMs: 10_000,
    });

    // [design-note D] 同上：断言带上可选第 3 参
    expect(sender.sendText).toHaveBeenCalledWith('chat', '❌ Failed', undefined);
  });

  it('logs and swallows send failures', async () => {
    const logger = { warn: vi.fn() };
    const sender = makeSender({ sendText: vi.fn().mockRejectedValue(new Error('nope')) });
    await sendCompletionNotice({
      sender,
      config: makeConfig(),
      logger: logger as any,
      chatId: 'chat',
      state: makeState('complete'),
      durationMs: 10_000,
    });

    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'chat' }), 'Failed to send completion notice');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { FeishuSenderAdapter } from '../src/feishu/feishu-sender-adapter.js';
import type { CardState } from '../src/types.js';

/**
 * Feishu sender adapter — verifies that AskUserQuestion cards always go
 * through Card Schema 1.0, even when v2 is the global default.
 *
 * Why this matters:
 *   Feishu mobile App silently drops `tag: action` button blocks under
 *   Schema 2.0, so question buttons become invisible on iOS/Android. v1
 *   button rendering is verified working on mobile (PR #199). The bridge
 *   sends questions on a SEPARATE card (Feishu refuses to patch a v2 card
 *   with v1 content — ErrCode 200830 schemaV2 can not change schemaV1),
 *   so the v1 question card coexists alongside the v2 streaming card.
 *
 * Don't relax this: removing the v1 hardwire here AskUserQuestion stops
 * working on the Feishu mobile App, regardless of `CARD_SCHEMA_V2`.
 *
 * See memory: bug-feishu-v2-mobile-action-buttons.
 */
describe('FeishuSenderAdapter.sendQuestionCard / updateQuestionCard', () => {
  function makeAdapter() {
    const sendCard = vi.fn().mockResolvedValue('msg_123');
    const updateCard = vi.fn().mockResolvedValue(true);
    const fakeSender = {
      sendCard,
      updateCard,
      sendText: vi.fn(),
      sendImageFile: vi.fn(),
      sendLocalFile: vi.fn(),
      sendAudioFile: vi.fn(),
      downloadImage: vi.fn(),
      downloadFile: vi.fn(),
    } as any;
    return { adapter: new FeishuSenderAdapter(fakeSender), sendCard, updateCard, fakeSender };
  }

  const questionState: CardState = {
    status: 'waiting_for_input',
    userPrompt: 'Question',
    responseText: '',
    toolCalls: [],
    pendingQuestion: {
      toolUseId: 'toolu_test',
      questions: [{
        question: '今晚吃什么？',
        header: '今晚晚餐',
        options: [
          { label: '吃鸡', description: '炸鸡' },
          { label: '吃鸭', description: '烤鸭' },
        ],
        multiSelect: false,
      }],
    },
  };

  it('sendQuestionCard always builds a v1 card (no schema:"2.0")', async () => {
    const { adapter, sendCard } = makeAdapter();
    await adapter.sendQuestionCard('oc_test', questionState);
    expect(sendCard).toHaveBeenCalledOnce();
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"schema":"2.0"');
    expect(cardJson).toContain('吃鸡');
    expect(cardJson).toContain('吃鸭');
  });

  it('question cards render text-only — no `tag: action` button block, no `answer_question` callback', () => {
    // Buttons were removed because mobile Feishu has unfixable click
    // problems on both schemas (v2 doesn't render, v1 returns code 200340).
    // The typed-answer path works reliably; don't reintroduce buttons
    // without first verifying the underlying mobile-render / v1-callback
    // bugs are fixed Feishu-side.
    const { adapter, sendCard } = makeAdapter();
    void adapter.sendQuestionCard('oc_test', questionState);
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"tag":"action"');
    expect(cardJson).not.toContain('answer_question');
    // Numbered options + typed-reply prompt must still be present so users
    // know HOW to answer without buttons.
    expect(cardJson).toContain('**1.** 吃鸡');
    expect(cardJson).toContain('**2.** 吃鸭');
    expect(cardJson).toContain('请回复数字');
  });

  it('updateQuestionCard always builds a v1 card', async () => {
    const { adapter, updateCard } = makeAdapter();
    await adapter.updateQuestionCard('msg_test', questionState);
    expect(updateCard).toHaveBeenCalledOnce();
    const cardJson = updateCard.mock.calls[0][1] as string;
    expect(cardJson).not.toContain('"schema":"2.0"');
  });

  it('regular sendCard still uses v2 default (sanity)', async () => {
    const { adapter, sendCard } = makeAdapter();
    await adapter.sendCard('oc_test', {
      status: 'running',
      userPrompt: 'a thing',
      responseText: 'working',
      toolCalls: [],
    });
    const cardJson = sendCard.mock.calls[0][1] as string;
    expect(cardJson).toContain('"schema":"2.0"');
  });

  it('sendQuestionCard returns the underlying messageId from sender.sendCard', async () => {
    const { adapter, sendCard } = makeAdapter();
    sendCard.mockResolvedValueOnce('msg_specific');
    const id = await adapter.sendQuestionCard('oc_test', questionState);
    expect(id).toBe('msg_specific');
  });

  it('sendAudioFile forwards native audio sends to the Feishu sender', async () => {
    const { adapter, fakeSender } = makeAdapter();
    fakeSender.sendAudioFile.mockResolvedValueOnce(true);
    await expect(adapter.sendAudioFile('oc_test', '/tmp/reply.opus')).resolves.toBe(true);
    expect(fakeSender.sendAudioFile).toHaveBeenCalledWith('oc_test', '/tmp/reply.opus', 'reply.opus');
  });
});

/**
 * [design-note P] 出站台账写入收口在 adapter。锁定：
 *   - 每类出站消息按正确 kind + 语义内容登记；
 *   - updateCard 成功后 updateText（流式卡终版内容赢）、失败不写；
 *   - 底层没返回 message_id 时不登记也不影响发送结果；
 *   - 不传 ledger（1 参构造）时零行为变化（上面的旧用例即回归）。
 */
describe('FeishuSenderAdapter outbound ledger recording (patch P)', () => {
  function makeLedgerAdapter() {
    const record = vi.fn();
    const updateText = vi.fn();
    const ledger = { record, updateText, get: vi.fn() } as any;
    const sendCard = vi.fn().mockResolvedValue('om_card');
    const updateCard = vi.fn().mockResolvedValue(true);
    const fakeSender = {
      sendCard,
      updateCard,
      sendText: vi.fn().mockResolvedValue('om_text'),
      sendImageFile: vi.fn().mockResolvedValue({ messageId: 'om_img', mediaKey: 'img_k' }),
      sendLocalFile: vi.fn().mockResolvedValue({ messageId: 'om_file', mediaKey: 'file_k' }),
      sendAudioFile: vi.fn().mockResolvedValue({ messageId: 'om_audio', mediaKey: 'audio_k' }),
      downloadImage: vi.fn(),
      downloadFile: vi.fn(),
      fetchMessage: vi.fn(),
    } as any;
    const adapter = new FeishuSenderAdapter(fakeSender, { ledger, botName: 'botA' });
    return { adapter, fakeSender, record, updateText, sendCard, updateCard };
  }

  const runningState: CardState = { status: 'running', userPrompt: 'p', responseText: '干活中', toolCalls: [] };

  it('sendCard records kind card with the responseText', async () => {
    const { adapter, record } = makeLedgerAdapter();
    await adapter.sendCard('oc_1', runningState);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 'om_card', botName: 'botA', chatId: 'oc_1', kind: 'card', text: '干活中',
    }));
  });

  it('updateCard success updates the ledger text (final content wins); failure does not', async () => {
    const { adapter, updateText, updateCard } = makeLedgerAdapter();
    await adapter.updateCard('om_card', { ...runningState, responseText: '终版答案' });
    expect(updateText).toHaveBeenCalledWith('om_card', '终版答案');
    updateCard.mockResolvedValueOnce(false);
    updateText.mockClear();
    await adapter.updateCard('om_card', runningState);
    expect(updateText).not.toHaveBeenCalled();
  });

  it('question cards with empty responseText record the question summary', async () => {
    const { adapter, record } = makeLedgerAdapter();
    const qState: CardState = {
      status: 'waiting_for_input', userPrompt: 'Question', responseText: '', toolCalls: [],
      pendingQuestion: {
        toolUseId: 'toolu_q',
        questions: [{
          question: '今晚吃什么？', header: '晚餐',
          options: [{ label: '吃鸡', description: '' }, { label: '吃鸭', description: '' }],
          multiSelect: false,
        }],
      },
    };
    await adapter.sendQuestionCard('oc_1', qState);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'card' }));
    const text = record.mock.calls[0][0].text as string;
    expect(text).toContain('今晚吃什么');
    expect(text).toContain('吃鸡');
  });

  it('sendTextNotice records kind notice with title and body', async () => {
    const { adapter, record } = makeLedgerAdapter();
    await adapter.sendTextNotice('oc_1', '📋 Queued', 'position #1', 'blue');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'notice', text: '📋 Queued\nposition #1' }));
  });

  it('sendText records only when the raw sender returned an id', async () => {
    const { adapter, record, fakeSender } = makeLedgerAdapter();
    await adapter.sendText('oc_1', 'hello');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ kind: 'text', text: 'hello', messageId: 'om_text' }));
    record.mockClear();
    fakeSender.sendText.mockResolvedValueOnce(undefined);
    await adapter.sendText('oc_1', 'lost');
    expect(record).not.toHaveBeenCalled();
  });

  it('media sends record filePath + mediaKey and keep the boolean interface result', async () => {
    const { adapter, record } = makeLedgerAdapter();
    await expect(adapter.sendImageFile('oc_1', '/tmp/a.png')).resolves.toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image', messageId: 'om_img', filePath: '/tmp/a.png', mediaKey: 'img_k',
    }));
    record.mockClear();
    await expect(adapter.sendLocalFile('oc_1', '/tmp/r.pdf', 'r.pdf')).resolves.toBe(true);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'file', messageId: 'om_file', filePath: '/tmp/r.pdf', fileName: 'r.pdf', mediaKey: 'file_k',
    }));
  });

  it('media send failure returns false and records nothing', async () => {
    const { adapter, record, fakeSender } = makeLedgerAdapter();
    fakeSender.sendImageFile.mockResolvedValueOnce(false);
    await expect(adapter.sendImageFile('oc_1', '/tmp/a.png')).resolves.toBe(false);
    expect(record).not.toHaveBeenCalled();
  });
});

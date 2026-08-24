import { describe, it, expect, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';

/**
 * [design-note P] MessageSender 的出站 id 捕获与 fetchMessage。
 *
 * 锁定：
 *   1. sendText 两分支（reply / create）都把 message_id 带回（原为 void 丢弃）；
 *   2. 媒体发送成功返回 { messageId, mediaKey }（对象 truthy，旧真值判断兼容），
 *      失败仍为 false——「成功但响应缺 id」不得谎报失败（会误触发design-note L 通知）；
 *   3. fetchMessage 三态：items 正常映射 / 空 items → undefined / 抛错 → undefined。
 */

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

function makeClient(overrides: Record<string, any> = {}) {
  const reply = vi.fn().mockResolvedValue({ data: { message_id: 'om_reply' } });
  const create = vi.fn().mockResolvedValue({ data: { message_id: 'om_create' } });
  const get = vi.fn().mockResolvedValue({
    data: {
      items: [{
        message_id: 'om_parent',
        msg_type: 'text',
        body: { content: '{"text":"hello"}' },
        sender: { id: 'ou_sender', id_type: 'open_id', sender_type: 'user' },
        deleted: false,
      }],
    },
  });
  const client = { im: { v1: { message: { reply, create, get, patch: vi.fn() } } } } as any;
  return { client: { ...client, ...overrides }, reply, create, get };
}

describe('MessageSender outbound ids + fetchMessage (patch P)', () => {
  it('sendText returns the created message id (create branch)', async () => {
    const { client, create, reply } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendText('oc_1', 'hi')).resolves.toBe('om_create');
    expect(create).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('sendText returns the reply message id (quote-reply branch, patch D preserved)', async () => {
    const { client, reply, create } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendText('oc_1', 'done', 'om_trigger')).resolves.toBe('om_reply');
    expect(reply.mock.calls[0][0].path.message_id).toBe('om_trigger');
    expect(create).not.toHaveBeenCalled();
  });

  it('sendText reply failure falls back to create and still returns an id', async () => {
    const { client, reply, create } = makeClient();
    reply.mockRejectedValueOnce(new Error('recalled'));
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendText('oc_1', 'done', 'om_trigger')).resolves.toBe('om_create');
    expect(create).toHaveBeenCalledOnce();
  });

  it('sendImage / sendFile / sendAudio return { messageId, mediaKey } on success', async () => {
    const { client } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendImage('oc_1', 'img_k')).resolves.toEqual({ messageId: 'om_create', mediaKey: 'img_k' });
    await expect(sender.sendFile('oc_1', 'file_k')).resolves.toEqual({ messageId: 'om_create', mediaKey: 'file_k' });
    await expect(sender.sendAudio('oc_1', 'audio_k')).resolves.toEqual({ messageId: 'om_create', mediaKey: 'audio_k' });
  });

  it('media send with a missing response id still succeeds (truthy outcome, undefined messageId)', async () => {
    const { client, create } = makeClient();
    create.mockResolvedValue({ data: {} });
    const sender = new MessageSender(client, mockLogger);
    const res = await sender.sendImage('oc_1', 'img_k');
    expect(res).toEqual({ messageId: undefined, mediaKey: 'img_k' });
    expect(res).toBeTruthy(); // 旧真值判断（output-handler / design-note L）不会误判失败
  });

  it('media send API failure returns false', async () => {
    const { client, create } = makeClient();
    create.mockRejectedValue(new Error('502'));
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.sendImage('oc_1', 'img_k')).resolves.toBe(false);
  });

  it('fetchMessage maps items[0] into a FetchedMessage', async () => {
    const { client } = makeClient();
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.fetchMessage('om_parent')).resolves.toEqual({
      msgType: 'text',
      content: '{"text":"hello"}',
      senderId: 'ou_sender',
      senderIdType: 'open_id',
      senderType: 'user',
      deleted: false,
    });
  });

  it('fetchMessage returns undefined on empty items (business error without throw)', async () => {
    const { client, get } = makeClient();
    get.mockResolvedValue({ code: 99991672, msg: 'no permission', data: {} });
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.fetchMessage('om_parent')).resolves.toBeUndefined();
  });

  it('fetchMessage returns undefined when the API throws', async () => {
    const { client, get } = makeClient();
    get.mockRejectedValue(new Error('network'));
    const sender = new MessageSender(client, mockLogger);
    await expect(sender.fetchMessage('om_parent')).resolves.toBeUndefined();
  });
});

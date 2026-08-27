import { describe, expect, it } from 'vitest';
import { restItemToEvent, shouldReplay } from '../src/feishu/backfill.js';

describe('shouldReplay', () => {
  const base = { message_id: 'om_1', msg_type: 'file', sender: { id: 'ou_1', id_type: 'open_id', sender_type: 'user' } };
  it('accepts user text/post/image/file; rejects bots, deleted, unknown types', () => {
    expect(shouldReplay(base)).toBe(true);
    expect(shouldReplay({ ...base, msg_type: 'sticker' })).toBe(false);
    expect(shouldReplay({ ...base, deleted: true })).toBe(false);
    expect(shouldReplay({ ...base, sender: { id: 'app', sender_type: 'app' } })).toBe(false);
    expect(shouldReplay({ ...base, sender: undefined })).toBe(false);
  });
});

describe('restItemToEvent', () => {
  it('maps REST list items into receive_v1-shaped payloads', () => {
    const ev: any = restItemToEvent({
      message_id: 'om_x', msg_type: 'text', chat_id: 'oc_1', create_time: '123',
      parent_id: 'om_p',
      sender: { id: 'ou_9', id_type: 'open_id', sender_type: 'user' },
      body: { content: '{"text":"@bot hi"}' },
      mentions: [{ key: '@_user_1', id: 'ou_bot', name: 'bot' }],
    }, 'group');
    expect(ev.message.chat_type).toBe('group');
    expect(ev.message.message_type).toBe('text');
    expect(ev.message.content).toBe('{"text":"@bot hi"}');
    expect(ev.message.mentions[0].id.open_id).toBe('ou_bot');
    expect(ev.sender.sender_id.open_id).toBe('ou_9');
    expect(restItemToEvent({}, 'p2p').message.chat_type).toBe('p2p');
  });
});

import { describe, it, expect } from 'vitest';
import {
  pickRound, mapMessage, fetchRoundContext, buildRoundPrompt,
  ROUND_MAX_AGE_MS, ROUND_MAX_MESSAGES,
  type ListedMessage, type ListPage, type RoundQuery,
} from '../src/feishu/round-context.js';
import { extractTextFromPost, extractImagesFromPost } from '../src/feishu/event-handler.js';

/**
 * [design-note S] 本轮上下文拉取 — 纯函数层。夹具按 2026-09-05 真实 im.message.list
 * 返回结构写（sender.sender_type user/app、mentions[].id、create_time 为 ms 字符串）。
 */

const BOT = 'ou_bot';
const KK = 'ou_kk';
const T0 = Date.parse('2026-09-05T15:49:00+08:00');
const deps = { extractPostText: extractTextFromPost, extractPostImages: extractImagesFromPost };

let n = 0;
function msg(o: Partial<ListedMessage> & { at: number; from?: 'kk' | 'bot' | 'other'; type?: string; content?: unknown; at_bot?: boolean }): ListedMessage {
  const who = o.from ?? 'kk';
  return {
    message_id: o.message_id ?? `om_${++n}`,
    msg_type: o.type ?? 'text',
    create_time: String(o.at),
    parent_id: o.parent_id,
    deleted: o.deleted,
    sender: who === 'bot'
      ? { id: 'cli_app', id_type: 'app_id', sender_type: 'app' }
      : { id: who === 'kk' ? KK : 'ou_other', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify(o.content ?? { text: o.at_bot ? '@_user_1 go' : `t${n}` }) },
    mentions: o.at_bot ? [{ key: '@_user_1', id: BOT, name: 'bot' }] : [],
  };
}
const q = (trigger: ListedMessage): RoundQuery => ({
  chatId: 'oc_1', triggerMessageId: trigger.message_id!, triggerTimeMs: Number(trigger.create_time), senderId: KK, botOpenId: BOT,
});
const desc = (items: ListedMessage[]) => [...items].sort((a, b) => Number(b.create_time) - Number(a.create_time));

describe('pickRound — 本轮边界', () => {
  it('stops at the sender\'s previous @bot; bot replies and other people do not cut the round', () => {
    const prevAt = msg({ at: T0 - 3 * 3600e3, at_bot: true });
    const botReply = msg({ at: T0 - 3 * 3600e3 + 60e3, from: 'bot', type: 'interactive', content: {} });
    const a = msg({ at: T0 - 2 * 3600e3, type: 'image', content: { image_key: 'img_a' } });
    const other = msg({ at: T0 - 90 * 60e3, from: 'other' });
    const b = msg({ at: T0 - 60 * 60e3 });
    const trigger = msg({ at: T0, at_bot: true });
    const older = msg({ at: T0 - 5 * 3600e3 });
    const r = pickRound(desc([older, prevAt, botReply, a, other, b, trigger]), q(trigger), T0 - ROUND_MAX_AGE_MS);
    expect(r.boundaryHit).toBe(true);
    expect(r.tooOld).toBe(false);
    expect(r.picked.map((m) => m.message_id)).toEqual([b.message_id, a.message_id]); // desc order, trigger/other/bot excluded
  });

  it('messages after the trigger are ignored; hitting the age floor reports tooOld', () => {
    const trigger = msg({ at: T0, at_bot: true });
    const later = msg({ at: T0 + 10e3 });
    const inRange = msg({ at: T0 - 10e3 });
    const ancient = msg({ at: T0 - ROUND_MAX_AGE_MS - 1 });
    const r = pickRound(desc([later, trigger, inRange, ancient]), q(trigger), T0 - ROUND_MAX_AGE_MS);
    expect(r.picked.map((m) => m.message_id)).toEqual([inRange.message_id]);
    expect(r.tooOld).toBe(true);
    expect(r.boundaryHit).toBe(false);
  });

  it('without botOpenId any mention counts as the boundary', () => {
    const prev = msg({ at: T0 - 100e3 });
    prev.mentions = [{ key: '@_user_1', id: 'ou_whoever', name: 'x' }];
    const a = msg({ at: T0 - 50e3 });
    const trigger = msg({ at: T0, at_bot: true });
    const r = pickRound(desc([prev, a, trigger]), { ...q(trigger), botOpenId: undefined }, 0);
    expect(r.boundaryHit).toBe(true);
    expect(r.picked.map((m) => m.message_id)).toEqual([a.message_id]);
  });
});

describe('mapMessage — 单条映射', () => {
  it('text: mention tags stripped, quote parent kept', () => {
    const m = msg({ at: T0, content: { text: '@_user_2 看这个' }, parent_id: 'om_q' });
    expect(mapMessage(m, deps)).toEqual({ text: { messageId: m.message_id, text: '看这个', parentId: 'om_q' }, media: [] });
  });
  it('post: text with link URL, embedded images become media', () => {
    const m = msg({ at: T0, type: 'post', content: { zh_cn: { title: '', content: [
      [{ tag: 'a', text: '纪要', href: 'https://x.feishu.cn/docx/A' }],
      [{ tag: 'img', image_key: 'img_p' }],
    ] } } });
    const r = mapMessage(m, deps);
    expect(r.text?.text).toBe('纪要 (https://x.feishu.cn/docx/A)');
    expect(r.media).toEqual([{ messageId: m.message_id, imageKey: 'img_p' }]);
  });
  it('image / file → media only', () => {
    const i = msg({ at: T0, type: 'image', content: { image_key: 'img_1' } });
    const f = msg({ at: T0, type: 'file', content: { file_key: 'file_1', file_name: 'a.xlsx' } });
    expect(mapMessage(i, deps)).toEqual({ media: [{ messageId: i.message_id, imageKey: 'img_1' }] });
    expect(mapMessage(f, deps)).toEqual({ media: [{ messageId: f.message_id, fileKey: 'file_1', fileName: 'a.xlsx' }] });
  });
  it('deleted / sticker / audio / interactive / bad JSON → nothing', () => {
    expect(mapMessage(msg({ at: T0, deleted: true }), deps)).toEqual({ media: [] });
    expect(mapMessage(msg({ at: T0, type: 'sticker', content: { file_key: 'x' } }), deps)).toEqual({ media: [] });
    expect(mapMessage(msg({ at: T0, type: 'audio', content: { file_key: 'x' } }), deps)).toEqual({ media: [] });
    expect(mapMessage(msg({ at: T0, type: 'interactive', content: {} }), deps)).toEqual({ media: [] });
    const bad = msg({ at: T0 }); bad.body = { content: '{oops' };
    expect(mapMessage(bad, deps)).toEqual({ media: [] });
  });
  it('empty text after stripping → no text entry', () => {
    expect(mapMessage(msg({ at: T0, content: { text: '@_user_1 ' } }), deps)).toEqual({ media: [] });
  });
});

describe('fetchRoundContext — 分页、顺序、上限、失败', () => {
  function fakeList(pages: ListedMessage[][], opts: { hasMoreAfterLast?: boolean } = {}) {
    const calls: Array<{ start: string; end: string; token?: string }> = [];
    const list = async (_c: string, start: string, end: string, token?: string): Promise<ListPage> => {
      calls.push({ start, end, token });
      const idx = token ? Number(token.slice(1)) : 0;
      const items = pages[idx] ?? [];
      const more = idx < pages.length - 1 || (idx === pages.length - 1 && Boolean(opts.hasMoreAfterLast));
      return { items, hasMore: more, pageToken: more ? `p${idx + 1}` : undefined };
    };
    return { list, calls };
  }

  it('the KK shape: images + text hours earlier, @ now → all of it, ascending, trigger excluded', async () => {
    const prevAt = msg({ at: T0 - 4 * 3600e3, at_bot: true });
    const i1 = msg({ at: T0 - 3 * 3600e3, type: 'image', content: { image_key: 'img_1' } });
    const i2 = msg({ at: T0 - 3 * 3600e3 + 1e3, type: 'image', content: { image_key: 'img_2' } });
    const t1 = msg({ at: T0 - 3 * 3600e3 + 30e3, content: { text: '帮我看看岛台颜色' } });
    const trigger = msg({ at: T0, at_bot: true, content: { text: '@_user_1 处理以上问题' } });
    const { list, calls } = fakeList([desc([prevAt, i1, i2, t1, trigger])]);
    const r = await fetchRoundContext(list, q(trigger), deps);
    expect(r.error).toBeUndefined();
    expect(r.truncated).toBe(false);
    expect(r.texts.map((t) => t.text)).toEqual(['帮我看看岛台颜色']);
    expect(r.media.map((m) => m.imageKey)).toEqual(['img_1', 'img_2']);
    expect(calls).toHaveLength(1);
    expect(Number(calls[0].end) * 1000).toBeGreaterThanOrEqual(T0);
    expect(Number(calls[0].start) * 1000).toBeLessThanOrEqual(T0 - ROUND_MAX_AGE_MS);
  });

  it('pages until the boundary; second page is not fetched once the previous @ is found', async () => {
    const trigger = msg({ at: T0, at_bot: true });
    const a = msg({ at: T0 - 10e3 });
    const prevAt = msg({ at: T0 - 20e3, at_bot: true });
    const stale = msg({ at: T0 - 30e3 });
    const { list, calls } = fakeList([desc([trigger, a, prevAt]), [stale]]);
    const r = await fetchRoundContext(list, q(trigger), deps);
    expect(r.texts.map((t) => t.messageId)).toEqual([a.message_id]);
    expect(calls).toHaveLength(1);
  });

  it('crosses pages when the boundary is further back', async () => {
    const trigger = msg({ at: T0, at_bot: true });
    const a = msg({ at: T0 - 10e3 });
    const b = msg({ at: T0 - 20e3 });
    const prevAt = msg({ at: T0 - 30e3, at_bot: true });
    const { list, calls } = fakeList([desc([trigger, a]), desc([b, prevAt])]);
    const r = await fetchRoundContext(list, q(trigger), deps);
    expect(r.texts.map((t) => t.messageId)).toEqual([b.message_id, a.message_id]);
    expect(calls).toHaveLength(2);
    expect(r.truncated).toBe(false);
  });

  it('no previous @ within the window → truncated, but everything in range is returned', async () => {
    const trigger = msg({ at: T0, at_bot: true });
    const a = msg({ at: T0 - 10e3 });
    const { list } = fakeList([desc([trigger, a])], { hasMoreAfterLast: false });
    const r = await fetchRoundContext(list, q(trigger), deps);
    expect(r.texts.map((t) => t.messageId)).toEqual([a.message_id]);
    expect(r.truncated).toBe(false); // list exhausted cleanly = nothing older exists
    const ancient = msg({ at: T0 - ROUND_MAX_AGE_MS - 5e3 });
    const r2 = await fetchRoundContext(fakeList([desc([trigger, a, ancient])]).list, q(trigger), deps);
    expect(r2.truncated).toBe(true);
    expect(r2.texts.map((t) => t.messageId)).toEqual([a.message_id]);
  });

  it('caps at ROUND_MAX_MESSAGES and flags truncation', async () => {
    const trigger = msg({ at: T0, at_bot: true });
    const many = Array.from({ length: ROUND_MAX_MESSAGES + 20 }, (_, i) => msg({ at: T0 - (i + 1) * 1e3 }));
    const pages: ListedMessage[][] = [];
    const all = desc([trigger, ...many]);
    for (let i = 0; i < all.length; i += 50) pages.push(all.slice(i, i + 50));
    const r = await fetchRoundContext(fakeList(pages).list, q(trigger), deps);
    expect(r.texts).toHaveLength(ROUND_MAX_MESSAGES);
    expect(r.truncated).toBe(true);
  });

  it('list returning undefined or throwing → error, nothing injected, no throw', async () => {
    const trigger = msg({ at: T0, at_bot: true });
    const r1 = await fetchRoundContext(async () => undefined, q(trigger), deps);
    expect(r1.error).toBeTruthy();
    expect(r1.texts).toEqual([]);
    const r2 = await fetchRoundContext(async () => { throw new Error('boom 99991672'); }, q(trigger), deps);
    expect(r2.error).toContain('boom');
  });
});

describe('buildRoundPrompt', () => {
  const base = { media: [], truncated: false, scanned: 0 };
  it('texts before, trigger last, with the marker lines', () => {
    const p = buildRoundPrompt({ ...base, texts: [{ messageId: 'a', text: 'A' }, { messageId: 'b', text: 'B' }] }, 'go');
    expect(p).toBe('[以下是你本轮早先发来的内容，按时间顺序]\n\nA\n\nB\n\n[本条]\n\ngo');
  });
  it('nothing cached → trigger text only', () => {
    expect(buildRoundPrompt({ ...base, texts: [] }, 'go')).toBe('go');
  });
  it('truncated marker and failure note', () => {
    expect(buildRoundPrompt({ ...base, texts: [{ messageId: 'a', text: 'A' }], truncated: true }, 'go')).toContain('已超出拉取范围');
    expect(buildRoundPrompt({ ...base, texts: [], error: 'x' }, 'go')).toBe('[本轮历史拉取失败，需要材料请让用户重发]\n\ngo');
  });
});

import { describe, it, expect } from 'vitest';
import { createReceiveHandler } from '../src/feishu/event-handler.js';
import { restItemToEvent } from '../src/feishu/backfill.js';
import type { BotConfig } from '../src/config.js';
import type { IncomingMessage } from '../src/types.js';

/**
 * [design-note S] @mention gating across chat types.
 *
 * The receive handler keeps module-level caches keyed by message_id (dedupe),
 * chat_id (member count) and chat_id:user_id (pending media), so every case
 * below uses fresh ids to stay independent of test order.
 */

const BOT = 'ou_bot';
const logger: any = { debug() {}, info() {}, warn() {}, error() {} };

let seq = 0;
const fresh = (prefix: string) => `${prefix}_${process.pid}_${Date.now()}_${++seq}`;

interface EvOpts {
  chatId: string;
  chatType: 'p2p' | 'group';
  userId?: string;
  mention?: boolean;
}

function textEvent(o: EvOpts & { text: string }) {
  return {
    message: {
      message_id: fresh('om'),
      chat_id: o.chatId,
      chat_type: o.chatType,
      message_type: 'text',
      content: JSON.stringify({ text: o.mention ? `@_user_1 ${o.text}` : o.text }),
      mentions: o.mention ? [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }] : [],
    },
    sender: { sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' },
  };
}

function imageEvent(o: EvOpts & { imageKey: string }) {
  return {
    message: {
      message_id: fresh('om'),
      chat_id: o.chatId,
      chat_type: o.chatType,
      message_type: 'image',
      content: JSON.stringify({ image_key: o.imageKey }),
      mentions: o.mention ? [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }] : [],
    },
    sender: { sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' },
  };
}

function fileEvent(o: EvOpts & { fileKey: string; fileName: string }) {
  return {
    message: {
      message_id: fresh('om'),
      chat_id: o.chatId,
      chat_type: o.chatType,
      message_type: 'file',
      content: JSON.stringify({ file_key: o.fileKey, file_name: o.fileName }),
      mentions: [],
    },
    sender: { sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' },
  };
}

function makeHandler(cfg: Partial<BotConfig> = {}, memberCount?: number) {
  const received: IncomingMessage[] = [];
  const sent: string[] = [];
  const sender: any = {
    sendText: async (_chatId: string, text: string) => { sent.push(text); },
    getChatMemberCount: async () => memberCount,
  };
  const config = { name: 'demo', feishu: { appId: 'a', appSecret: 'b' }, ...cfg } as BotConfig;
  const handle = createReceiveHandler(config, logger, (m) => received.push(m), BOT, sender);
  return { handle, received, sent };
}

describe('[design-note S] privateRequireMention — private chats', () => {
  it('default (switch off): p2p answers without @mention (upstream behaviour)', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'hi' }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('hi');
    expect(h.received[0].chatType).toBe('p2p');
  });

  it('switch on: p2p without @mention is silently dropped (no hint reply)', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it('switch on: p2p with @mention is processed and the mention tag is stripped', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('hi');
  });

  it('switch on: a mention of someone else does not count', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const ev = textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true });
    ev.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other' }, name: 'x' }];
    await h.handle(ev);
    expect(h.received).toHaveLength(0);
  });

  it('switch on: p2p image/file without @ are cached and attached to the next @mention, once', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(imageEvent({ chatId, chatType: 'p2p', imageKey: 'img_1' }));
    await h.handle(fileEvent({ chatId, chatType: 'p2p', fileKey: 'file_1', fileName: 'a.pdf' }));
    expect(h.received).toHaveLength(0);

    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'look', mention: true }));
    expect(h.received).toHaveLength(1);
    const extra = h.received[0].extraMedia ?? [];
    expect(extra.map((m) => m.imageKey ?? m.fileKey)).toEqual(['img_1', 'file_1']);
    expect(extra[1].fileName).toBe('a.pdf');

    // Cache is consumed — a second @mention carries nothing extra.
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'again', mention: true }));
    expect(h.received).toHaveLength(2);
    expect(h.received[1].extraMedia).toBeUndefined();
  });

  it('switch on: cached media is per sender, not per chat', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(imageEvent({ chatId, chatType: 'p2p', imageKey: 'img_a', userId: 'ou_a' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'go', mention: true, userId: 'ou_b' }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].extraMedia).toBeUndefined();
  });

  it('switch on: groupNoMention does not leak into p2p', async () => {
    const h = makeHandler({ privateRequireMention: true, groupNoMention: true });
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi' }));
    expect(h.received).toHaveLength(0);
  });

  it('switch on + groupOnly: whitelist gate still runs first, then the @ gate', async () => {
    const h = makeHandler({ privateRequireMention: true, groupOnly: true, groupOnlyAllowUsers: ['ou_admin'] });
    // Not whitelisted: refused with the groupOnly hint even when @mentioned.
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true, userId: 'ou_x' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    // Whitelisted but no @: silently dropped, no hint.
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', userId: 'ou_admin' }));
    expect(h.received).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
    // Whitelisted and @: processed.
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'p2p', text: 'hi', mention: true, userId: 'ou_admin' }));
    expect(h.received).toHaveLength(1);
  });
});

describe('[design-note S] privateRequireMention — 2-member groups', () => {
  it('switch off: 2-member group answers without @mention (private-like exemption)', async () => {
    const h = makeHandler({}, 2);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(1);
  });

  it('switch on: 2-member group follows normal group rules — @ required', async () => {
    const h = makeHandler({ privateRequireMention: true }, 2);
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
  });

  it('switch on: 2-member group still honours groupNoMention (it is a group)', async () => {
    const h = makeHandler({ privateRequireMention: true, groupNoMention: true }, 2);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(1);
  });
});

describe('group gating unchanged by the switch (regression guard)', () => {
  it('default: 3+ member group requires @; media cached and attached on @', async () => {
    const h = makeHandler({}, 5);
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    await h.handle(imageEvent({ chatId, chatType: 'group', imageKey: 'img_g' }));
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].extraMedia?.[0].imageKey).toBe('img_g');
  });

  it('switch on: 3+ member group behaves exactly as before', async () => {
    const h = makeHandler({ privateRequireMention: true }, 5);
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'group', text: 'hi', mention: true }));
    expect(h.received).toHaveLength(1);
  });

  it('groupNoMention: 3+ member group answers without @ regardless of the switch', async () => {
    const h = makeHandler({ privateRequireMention: true, groupNoMention: true }, 5);
    await h.handle(textEvent({ chatId: fresh('oc'), chatType: 'group', text: 'hi' }));
    expect(h.received).toHaveLength(1);
  });
});

describe('[design-note S] backfill replay goes through the same gate', () => {
  const item = (mentions: Array<{ key: string; id: string; name: string }>) => ({
    message_id: fresh('om'), msg_type: 'text', chat_id: fresh('oc'), create_time: '1',
    sender: { id: 'ou_u1', id_type: 'open_id', sender_type: 'user' },
    body: { content: JSON.stringify({ text: mentions.length ? '@_user_1 hi' : 'hi' }) },
    mentions,
  });

  it('switch on: replayed p2p message without @ is dropped, with @ is processed', async () => {
    const h = makeHandler({ privateRequireMention: true });
    await h.handle(restItemToEvent(item([]), 'p2p'));
    expect(h.received).toHaveLength(0);
    await h.handle(restItemToEvent(item([{ key: '@_user_1', id: BOT, name: 'bot' }]), 'p2p'));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('hi');
  });

  it('switch off: replayed p2p message without @ is processed', async () => {
    const h = makeHandler();
    await h.handle(restItemToEvent(item([]), 'p2p'));
    expect(h.received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Config plumbing: bots.json → BotConfig, and the admin writer round-trip.
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach } from 'vitest';
import { loadAppConfig } from '../src/config.js';
import { addBot, updateBot, readBotsConfig } from '../src/api/bots-config-writer.js';

describe('[design-note S] privateRequireMention config plumbing', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['BOTS_CONFIG', 'DOWNLOADS_DIR', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-prm-'));
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bots.json true → BotConfig true; absent/false → absent (upstream default)', () => {
    const cfgPath = path.join(dir, 'bots.json');
    const base = { feishuAppId: 'cli_x', feishuAppSecret: 's', defaultWorkingDirectory: dir };
    fs.writeFileSync(cfgPath, JSON.stringify({ feishuBots: [
      { name: 'on', ...base, privateRequireMention: true },
      { name: 'off', ...base, privateRequireMention: false },
      { name: 'unset', ...base },
    ] }));
    process.env.BOTS_CONFIG = cfgPath;
    const app = loadAppConfig();
    const byName = Object.fromEntries(app.feishuBots.map((b) => [b.name, b]));
    expect(byName.on.privateRequireMention).toBe(true);
    expect(byName.off.privateRequireMention).toBeUndefined();
    expect(byName.unset.privateRequireMention).toBeUndefined();
    // Independent of the neighbouring switches.
    expect(byName.on.groupNoMention).toBeUndefined();
    expect(byName.on.groupOnly).toBeUndefined();
  });

  it('admin writer: true/false persist as booleans, "" deletes the key, others untouched', () => {
    const cfgPath = path.join(dir, 'bots.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ feishuBots: [] }));
    addBot(cfgPath, 'feishu', {
      name: 'demo', feishuAppId: 'cli_test', feishuAppSecret: 's', defaultWorkingDirectory: '/tmp/demo',
      groupNoMention: true,
    } as any);
    const entry = () => readBotsConfig(cfgPath).feishuBots![0] as any;

    updateBot(cfgPath, 'demo', { privateRequireMention: true });
    expect(entry().privateRequireMention).toBe(true);
    expect(entry().groupNoMention).toBe(true);

    updateBot(cfgPath, 'demo', { privateRequireMention: false });
    expect(entry().privateRequireMention).toBe(false);

    updateBot(cfgPath, 'demo', { privateRequireMention: '' });
    expect(entry().privateRequireMention).toBeUndefined();
    expect(entry().groupNoMention).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [design-note S] Un-@ private TEXT is cached and prepended on the next @mention
// (the "send links/brief first, @ last" workflow the switch exists for), and
// rich-text links keep their URL.
// ---------------------------------------------------------------------------
import { extractTextFromPost } from '../src/feishu/event-handler.js';

function postEvent(o: EvOpts & { paragraphs: unknown[][] }) {
  return {
    message: {
      message_id: fresh('om'), chat_id: o.chatId, chat_type: o.chatType, message_type: 'post',
      content: JSON.stringify({ zh_cn: { title: '', content: o.paragraphs } }),
      mentions: o.mention ? [{ key: '@_user_1', id: { open_id: BOT }, name: 'bot' }] : [],
    },
    sender: { sender_id: { open_id: o.userId ?? 'ou_u1' }, sender_type: 'user' },
  };
}

describe('[design-note S] un-@ private text is cached and prepended on the next @', () => {
  it('link + brief first, "@bot go" last → prompt carries all three in order', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'https://x.feishu.cn/docx/AAA' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '根据会议纪要出一份工作安排' }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '处理以上需求', mention: true }));
    expect(h.received).toHaveLength(1);
    expect(h.received[0].text).toBe('https://x.feishu.cn/docx/AAA\n\n根据会议纪要出一份工作安排\n\n处理以上需求');
  });

  it('text and media interleave: texts joined in order, media become extraMedia; consumed once', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'A' }));
    await h.handle(imageEvent({ chatId, chatType: 'p2p', imageKey: 'img_1' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'B' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'go', mention: true }));
    expect(h.received[0].text).toBe('A\n\nB\n\ngo');
    expect(h.received[0].extraMedia?.map((m) => m.imageKey)).toEqual(['img_1']);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'again', mention: true }));
    expect(h.received[1].text).toBe('again');
    expect(h.received[1].extraMedia).toBeUndefined();
  });

  it('an un-@ quote-reply passes its parentId to the trigger; the trigger\'s own wins', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    const ev = textEvent({ chatId, chatType: 'p2p', text: '看这个' });
    (ev.message as any).parent_id = 'om_quoted';
    await h.handle(ev);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '处理', mention: true }));
    expect(h.received[0].parentId).toBe('om_quoted');
    expect(h.received[0].text).toBe('看这个\n\n处理');

    const ev2 = textEvent({ chatId, chatType: 'p2p', text: '看这个' });
    (ev2.message as any).parent_id = 'om_old';
    await h.handle(ev2);
    const trig = textEvent({ chatId, chatType: 'p2p', text: '处理', mention: true });
    (trig.message as any).parent_id = 'om_new';
    await h.handle(trig);
    expect(h.received[1].parentId).toBe('om_new');
  });

  it('un-@ post in p2p: text cached, its images cached as media', async () => {
    const h = makeHandler({ privateRequireMention: true });
    const chatId = fresh('oc');
    await h.handle(postEvent({ chatId, chatType: 'p2p', paragraphs: [
      [{ tag: 'text', text: '参考图' }], [{ tag: 'img', image_key: 'img_p1' }], [{ tag: 'img', image_key: 'img_p2' }],
    ] }));
    expect(h.received).toHaveLength(0);
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: '出图', mention: true }));
    expect(h.received[0].text).toBe('参考图\n\n出图');
    expect(h.received[0].extraMedia?.map((m) => m.imageKey)).toEqual(['img_p1', 'img_p2']);
  });

  it('switch off: nothing is ever cached in p2p (messages are answered directly)', async () => {
    const h = makeHandler();
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'A' }));
    await h.handle(textEvent({ chatId, chatType: 'p2p', text: 'B' }));
    expect(h.received.map((m) => m.text)).toEqual(['A', 'B']);
  });

  it('group text is never cached (switch on or off); group media still is', async () => {
    const h = makeHandler({ privateRequireMention: true }, 5);
    const chatId = fresh('oc');
    await h.handle(textEvent({ chatId, chatType: 'group', text: '闲聊' }));
    await h.handle(imageEvent({ chatId, chatType: 'group', imageKey: 'img_g' }));
    await h.handle(textEvent({ chatId, chatType: 'group', text: '看图', mention: true }));
    expect(h.received[0].text).toBe('看图');
    expect(h.received[0].extraMedia?.[0].imageKey).toBe('img_g');
  });
});

describe('[design-note S] rich-text links keep their URL', () => {
  const post = (paragraphs: unknown[][]) => ({ zh_cn: { title: '', content: paragraphs } });

  it('label + href → "label (href)"; URL-as-label not duplicated; no href → label', () => {
    expect(extractTextFromPost(post([[
      { tag: 'text', text: '见 ' }, { tag: 'a', text: '会议纪要', href: 'https://x.feishu.cn/docx/AAA' },
    ]]))).toBe('见 会议纪要 (https://x.feishu.cn/docx/AAA)');
    expect(extractTextFromPost(post([[
      { tag: 'a', text: 'https://x.feishu.cn/docx/AAA', href: 'https://x.feishu.cn/docx/AAA' },
    ]]))).toBe('https://x.feishu.cn/docx/AAA');
    expect(extractTextFromPost(post([[{ tag: 'a', text: 'no-href' }]]))).toBe('no-href');
  });

  it('the URL survives the whole pipeline into the prompt', async () => {
    const h = makeHandler();
    await h.handle(postEvent({ chatId: fresh('oc'), chatType: 'p2p', mention: true, paragraphs: [[
      { tag: 'a', text: '会议纪要', href: 'https://x.feishu.cn/docx/AAA' },
    ]] }));
    expect(h.received[0].text).toContain('https://x.feishu.cn/docx/AAA');
  });
});

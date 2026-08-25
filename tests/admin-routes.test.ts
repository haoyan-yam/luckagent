import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  tailLogFile,
  collectBotChats,
  collectChatMembers,
  readSummaryPrefs,
  writeSummaryPrefs,
} from '../src/api/routes/admin-routes.js';
import { redactBotEntry, stripMaskedSecrets } from '../src/api/routes/bot-routes.js';
import { addBot, updateBot, readBotsConfig } from '../src/api/bots-config-writer.js';

describe('tailLogFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-admin-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for a missing file', () => {
    const r = tailLogFile(path.join(dir, 'nope.log'), 100);
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('returns the last N lines', () => {
    const p = path.join(dir, 'a.log');
    fs.writeFileSync(p, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n');
    const r = tailLogFile(p, 10);
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]).toBe('line-40');
    expect(r.lines[9]).toBe('line-49');
    expect(r.truncated).toBe(true);
  });

  it('caps the requested line count at 1000', () => {
    const p = path.join(dir, 'b.log');
    fs.writeFileSync(p, Array.from({ length: 1500 }, (_, i) => `l${i}`).join('\n') + '\n');
    const r = tailLogFile(p, 999999);
    expect(r.lines).toHaveLength(1000);
    expect(r.lines[999]).toBe('l1499');
  });

  it('reads only the tail of a very large file and drops the partial first line', () => {
    const p = path.join(dir, 'c.log');
    // ~600KB of lines; the byte cap is 512KB so the head must be skipped.
    const line = 'x'.repeat(100);
    fs.writeFileSync(p, Array.from({ length: 6000 }, (_, i) => `${i}:${line}`).join('\n') + '\n');
    const r = tailLogFile(p, 1000);
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(1000);
    // Every returned line must be complete (starts with an index prefix).
    expect(r.lines[0]).toMatch(/^\d+:x+$/);
    expect(r.lines[999]).toBe(`5999:${line}`);
  });
});

describe('bot secret redaction', () => {
  it('masks feishuAppSecret and nested apiKey, keeps other fields', () => {
    const entry = {
      name: 'demo',
      feishuAppId: 'cli_test1234567890ab',
      feishuAppSecret: 'supersecretvalue9876',
      defaultWorkingDirectory: '/tmp/demo',
      codex: { model: 'gpt-5.5', apiKey: 'sk-abcdef123456' },
    };
    const out = redactBotEntry(entry);
    expect(out.feishuAppSecret).toBe('••••9876');
    expect((out.codex as any).apiKey).toBe('••••3456');
    expect(out.feishuAppId).toBe('cli_test1234567890ab');
    expect(out.name).toBe('demo');
    // The original object must be untouched (deep copy).
    expect(entry.feishuAppSecret).toBe('supersecretvalue9876');
  });

  it('stripMaskedSecrets removes echoed masks so they can never be written back', () => {
    const body: Record<string, unknown> = {
      description: 'updated',
      feishuAppSecret: '••••9876',
      codex: { model: 'gpt-5.5', apiKey: '••••3456' },
    };
    stripMaskedSecrets(body);
    expect(body.feishuAppSecret).toBeUndefined();
    expect((body.codex as any).apiKey).toBeUndefined();
    expect((body.codex as any).model).toBe('gpt-5.5');
    expect(body.description).toBe('updated');
  });

  it('stripMaskedSecrets keeps genuinely new secret values', () => {
    const body: Record<string, unknown> = { feishuAppSecret: 'brand-new-secret' };
    stripMaskedSecrets(body);
    expect(body.feishuAppSecret).toBe('brand-new-secret');
  });
});

describe('feishu chat/member collectors (pagination)', () => {
  const chatPage = (ids: string[], pageToken?: string) => ({
    code: 0,
    data: {
      items: ids.map((id) => ({ chat_id: id, name: `群-${id}` })),
      has_more: !!pageToken,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });

  it('collectBotChats follows page tokens and flattens items', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const client = {
      im: {
        chat: {
          list: async (payload?: { params?: Record<string, unknown> }) => {
            calls.push(payload?.params);
            return calls.length === 1 ? chatPage(['oc_a', 'oc_b'], 'tok2') : chatPage(['oc_c']);
          },
        },
        chatMembers: { get: async () => ({ code: 0, data: {} }) },
      },
    };
    const chats = await collectBotChats(client);
    expect(chats.map((c) => c.chatId)).toEqual(['oc_a', 'oc_b', 'oc_c']);
    expect(chats[0].name).toBe('群-oc_a');
    expect(calls[1]?.page_token).toBe('tok2');
  });

  it('collectBotChats throws on a Feishu error code', async () => {
    const client = {
      im: {
        chat: { list: async () => ({ code: 99991663, msg: 'app not available' }) },
        chatMembers: { get: async () => ({ code: 0, data: {} }) },
      },
    };
    await expect(collectBotChats(client)).rejects.toThrow('app not available');
  });

  it('collectChatMembers maps member_id → openId with names', async () => {
    const client = {
      im: {
        chat: { list: async () => ({ code: 0, data: {} }) },
        chatMembers: {
          get: async (payload?: { params?: Record<string, unknown>; path: { chat_id: string } }) => {
            expect(payload?.path.chat_id).toBe('oc_x');
            expect(payload?.params?.member_id_type).toBe('open_id');
            return { code: 0, data: { items: [{ member_id: 'ou_1', name: '张三' }, { member_id: 'ou_2', name: '李四' }], has_more: false } };
          },
        },
      },
    };
    const members = await collectChatMembers(client, 'oc_x');
    expect(members).toEqual([
      { openId: 'ou_1', name: '张三' },
      { openId: 'ou_2', name: '李四' },
    ]);
  });
});

describe('group-summary prefs store', () => {
  let dir: string;
  const OLD = process.env.SESSION_STORE_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-summary-'));
    process.env.SESSION_STORE_DIR = dir;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.SESSION_STORE_DIR;
    else process.env.SESSION_STORE_DIR = OLD;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('roundtrips per-bot excluded lists and tolerates a missing file', () => {
    expect(readSummaryPrefs()).toEqual({});
    writeSummaryPrefs({ 'bot-a': { excluded: ['oc_1', 'oc_2'] } });
    expect(readSummaryPrefs()).toEqual({ 'bot-a': { excluded: ['oc_1', 'oc_2'] } });
    // Update one bot without clobbering another.
    const prefs = readSummaryPrefs();
    prefs['bot-b'] = { excluded: ['oc_9'] };
    writeSummaryPrefs(prefs);
    expect(readSummaryPrefs()['bot-a'].excluded).toEqual(['oc_1', 'oc_2']);
    expect(readSummaryPrefs()['bot-b'].excluded).toEqual(['oc_9']);
  });

  it('returns {} on a corrupt file instead of throwing', () => {
    fs.writeFileSync(path.join(dir, 'group-summary.json'), 'not-json{{{');
    expect(readSummaryPrefs()).toEqual({});
  });
});

describe('updateBot clear semantics (whitelist can be emptied from the UI)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-botscfg-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sending '' deletes groupOnlyAllowUsers; omitting the key keeps it", () => {
    const cfgPath = path.join(dir, 'bots.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ feishuBots: [] }));
    addBot(cfgPath, 'feishu', {
      name: 'demo',
      feishuAppId: 'cli_test',
      feishuAppSecret: 's',
      defaultWorkingDirectory: '/tmp/demo',
      groupOnly: true,
      groupOnlyAllowUsers: ['ou_admin'],
    } as any);

    // Omit → unchanged
    updateBot(cfgPath, 'demo', { description: 'x' });
    let entry = readBotsConfig(cfgPath).feishuBots![0] as any;
    expect(entry.groupOnlyAllowUsers).toEqual(['ou_admin']);

    // '' → key deleted (UI "cleared the whitelist")
    updateBot(cfgPath, 'demo', { groupOnlyAllowUsers: '' });
    entry = readBotsConfig(cfgPath).feishuBots![0] as any;
    expect(entry.groupOnlyAllowUsers).toBeUndefined();
    expect(entry.groupOnly).toBe(true);
  });
});

describe('updateBot deep-merges nested engine blocks (masked-secret survival)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-merge-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a nested block arriving without its stripped apiKey keeps the stored secret', () => {
    const cfgPath = path.join(dir, 'bots.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ feishuBots: [] }));
    addBot(cfgPath, 'feishu', {
      name: 'ds', feishuAppId: 'cli_x', feishuAppSecret: 's',
      defaultWorkingDirectory: '/tmp/ds', engine: 'deepseek',
      deepseek: { apiKey: 'sk-ds-real', model: 'deepseek-v4-flash' },
    } as any);

    // UI edit: description changed; deepseek block re-sent WITHOUT apiKey
    // (mask stripped client-side) but WITH its sibling model field.
    updateBot(cfgPath, 'ds', { description: 'x', deepseek: { model: 'deepseek-v4-pro' } });
    const entry = readBotsConfig(cfgPath).feishuBots![0] as any;
    expect(entry.deepseek.apiKey).toBe('sk-ds-real');   // survived
    expect(entry.deepseek.model).toBe('deepseek-v4-pro'); // updated

    // Nested '' still deletes that one key only.
    updateBot(cfgPath, 'ds', { deepseek: { model: '' } });
    const entry2 = readBotsConfig(cfgPath).feishuBots![0] as any;
    expect(entry2.deepseek.model).toBeUndefined();
    expect(entry2.deepseek.apiKey).toBe('sk-ds-real');
  });
});

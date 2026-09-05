import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { _resetScanCache, transcriptPathFor } from '../src/bridge/session-rollover.js';
import type { BotConfigBase } from '../src/config.js';

/**
 * [design-note T] 桥接层编排：群消息入口与 API/定时任务入口共用 maybeRolloverSession。锁定：
 *   - 条件满足 → 清 sessionId、审计 session_rollover、交接块来自 SessionRegistry；
 *   - 条件不满足 → 原样 resume；
 *   - executeApiTask（定时日报/API 任务）也换新：runOneTurn 收到 freshSession=true 且 prompt 顶部是交接块；
 *   - 带 maxTurns 的受限回合（语音）不参与。
 */

const COMPACT_LINE = '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted"}\n';
const H = 3_600_000;
const SID = '22222222-3333-4444-8555-666666666666';

let tmp: string;
let savedHome: string | undefined;
let savedStore: string | undefined;
const auditCalls: any[] = [];

const logger: any = {
  debug: () => {},
  info: (obj: any) => {
    if (obj && obj.audit === true && obj.event) auditCalls.push(obj);
  },
  warn: () => {},
  error: () => {},
  child: (bindings: any) => ({
    ...logger,
    info: (obj: any, msg?: string) => {
      const merged = { ...bindings, ...obj };
      if (merged.audit === true) auditCalls.push({ ...merged, msg });
    },
  }),
};

function makeConfig(cwd: string): BotConfigBase {
  return {
    name: 'test-bot',
    engine: 'claude',
    claude: {
      defaultWorkingDirectory: cwd,
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: path.join(tmp, 'outputs'),
      downloadsDir: path.join(tmp, 'downloads'),
      backend: 'pty',
    },
    persistentExecutor: { enabled: true },
  } as BotConfigBase;
}

function makeSender() {
  return {
    async sendCard() {
      return 'msg-1';
    },
    async updateCard() {
      return true;
    },
    async sendQuestionCard() {
      return 'q-1';
    },
    async updateQuestionCard() {
      return true;
    },
    async sendTextNotice() {},
    async sendText() {
      return 'txt-1';
    },
  } as any;
}

function writeTranscript(cwd: string, ageMs: number, compacted: boolean) {
  const p = transcriptPathFor(cwd, SID);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"type":"user"}\n' + (compacted ? COMPACT_LINE : '') + '{"type":"user"}\n');
  const t = (Date.now() - ageMs) / 1000;
  fs.utimesSync(p, t, t);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rollover-bridge-'));
  savedHome = process.env.HOME;
  savedStore = process.env.SESSION_STORE_DIR;
  process.env.HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  process.env.SESSION_STORE_DIR = path.join(tmp, 'store');
  auditCalls.length = 0;
  _resetScanCache();
});

afterEach(() => {
  process.env.HOME = savedHome;
  if (savedStore === undefined) delete process.env.SESSION_STORE_DIR;
  else process.env.SESSION_STORE_DIR = savedStore;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeBridge(cwd: string) {
  const bridge = new MessageBridge(makeConfig(cwd), logger, makeSender()) as any;
  bridge.releaseChatExecutor = vi.fn(async () => {});
  return bridge;
}

describe('maybeRolloverSession (shared orchestration)', () => {
  it('rolls over an idle+compacted session: clears sessionId, audits, renders handoff from registry', async () => {
    const cwd = path.join(tmp, 'proj');
    writeTranscript(cwd, 5 * H, true);
    const bridge = makeBridge(cwd);
    bridge.sessionManager.setSessionId('chat-a', SID, 'claude');
    bridge.sessionRegistry = {
      findByChatId: () => ({ id: 'reg-1' }),
      getMessages: () => [
        { role: 'user', text: '帮我出三张海报', timestamp: 1 },
        { role: 'assistant', text: '三张海报做好了', timestamp: 2 },
      ],
    };
    const session = bridge.sessionManager.getSession('chat-a');
    const r = await bridge.maybeRolloverSession('chat-a', session, 'claude', 'u1', 'api');
    expect(r.rolledOver).toBe(true);
    expect(r.handoffReminder).toContain('<system-reminder>');
    expect(r.handoffReminder).toContain('三张海报做好了');
    expect(bridge.sessionManager.getSession('chat-a').sessionId).toBeUndefined();
    expect(bridge.releaseChatExecutor).toHaveBeenCalledWith('chat-a', 'idle-compacted-rollover');
    const ev = auditCalls.find((c) => c.event === 'session_rollover');
    expect(ev).toBeTruthy();
    expect(ev.source).toBe('api'); // AuditLogger 把 meta 摊平到顶层
    expect(ev.previousSessionId).toBe(SID);
    try {
      bridge.destroy();
    } catch {
      /* ignore */
    }
  });

  it('leaves a never-compacted or recently-used session alone', async () => {
    const cwd = path.join(tmp, 'proj');
    const bridge = makeBridge(cwd);
    bridge.sessionManager.setSessionId('chat-b', SID, 'claude');
    const session = bridge.sessionManager.getSession('chat-b');

    writeTranscript(cwd, 5 * H, false); // idle but never compacted
    expect((await bridge.maybeRolloverSession('chat-b', session, 'claude', 'u1', 'message')).rolledOver).toBe(false);
    _resetScanCache();
    writeTranscript(cwd, 10 * 60_000, true); // compacted but used 10 min ago
    expect((await bridge.maybeRolloverSession('chat-b', session, 'claude', 'u1', 'message')).rolledOver).toBe(false);
    expect(bridge.sessionManager.getSession('chat-b').sessionId).toBe(SID);
    expect(auditCalls.find((c) => c.event === 'session_rollover')).toBeUndefined();
    try {
      bridge.destroy();
    } catch {
      /* ignore */
    }
  });

  it('never throws: a failing registry still rolls over without handoff', async () => {
    const cwd = path.join(tmp, 'proj');
    writeTranscript(cwd, 5 * H, true);
    const bridge = makeBridge(cwd);
    bridge.sessionManager.setSessionId('chat-c', SID, 'claude');
    bridge.sessionRegistry = {
      findByChatId: () => {
        throw new Error('db gone');
      },
    };
    const r = await bridge.maybeRolloverSession(
      'chat-c',
      bridge.sessionManager.getSession('chat-c'),
      'claude',
      undefined,
      'api',
    );
    expect(r.rolledOver).toBe(true);
    expect(r.handoffReminder).toBeUndefined();
    try {
      bridge.destroy();
    } catch {
      /* ignore */
    }
  });
});

describe('executeApiTask (scheduled daily report / API tasks) honours rollover', () => {
  it('passes freshSession=true and prepends the handoff block to the task prompt', async () => {
    const cwd = path.join(tmp, 'proj');
    writeTranscript(cwd, 5 * H, true);
    const bridge = makeBridge(cwd);
    bridge.sessionManager.setSessionId('chat-d', SID, 'claude');
    bridge.sessionRegistry = {
      findByChatId: () => ({ id: 'reg-1' }),
      getMessages: () => [{ role: 'assistant', text: '昨天的日报已发', timestamp: 2 }],
    };
    let captured: any;
    bridge.runOneTurn = vi.fn(async (_chatId: string, _engine: string, opts: any) => {
      captured = opts;
      throw new Error('stop-here');
    });
    await expect(bridge.executeApiTask({ prompt: '请生成本群昨日日报', chatId: 'chat-d' })).rejects.toThrow(
      'stop-here',
    );
    expect(captured.freshSession).toBe(true);
    expect(captured.prompt.startsWith('<system-reminder>')).toBe(true);
    expect(captured.prompt).toContain('昨天的日报已发');
    expect(captured.prompt.trimEnd().endsWith('请生成本群昨日日报')).toBe(true);
    expect(bridge.sessionManager.getSession('chat-d').sessionId).toBeUndefined();
    try {
      bridge.destroy();
    } catch {
      /* ignore */
    }
  });

  it('skips rollover for constrained turns (maxTurns / allowedTools, e.g. voice)', async () => {
    const cwd = path.join(tmp, 'proj');
    writeTranscript(cwd, 5 * H, true);
    const bridge = makeBridge(cwd);
    bridge.sessionManager.setSessionId('chat-e', SID, 'claude');
    let captured: any;
    bridge.runOneTurn = vi.fn(async (_c: string, _e: string, opts: any) => {
      captured = opts;
      throw new Error('stop-here');
    });
    await expect(bridge.executeApiTask({ prompt: 'hi', chatId: 'chat-e', maxTurns: 1 })).rejects.toThrow('stop-here');
    expect(captured.freshSession).toBe(false);
    expect(captured.prompt).toBe('hi');
    expect(bridge.sessionManager.getSession('chat-e').sessionId).toBe(SID);
    try {
      bridge.destroy();
    } catch {
      /* ignore */
    }
  });
});

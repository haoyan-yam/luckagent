import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MessageBridge,
  effectiveTurnBackend,
  isStaleSessionError,
  extractSpontaneousSnippet,
  formatSpontaneousCardBody,
  resolvePersistentExecutorEnvDefault,
} from '../src/bridge/message-bridge.js';
import { classifyBurstSource } from '../src/engines/claude/persistent-executor.js';
import type { BotConfigBase } from '../src/config.js';
import type { CardState } from '../src/types.js';

afterEach(() => {
  vi.useRealTimers();
});

const mockLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
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
  const sender = {
    sent,
    updated,
    async sendCard(chatId: string, state: CardState) {
      sent.push({ chatId, state });
      return `msg-${sent.length}`;
    },
    async updateCard(messageId: string, state: CardState) {
      updated.push({ messageId, state });
      return true;
    },
    async sendQuestionCard(chatId: string, state: CardState) {
      sent.push({ chatId, state });
      return `qmsg-${sent.length}`;
    },
    async updateQuestionCard(messageId: string, state: CardState) {
      updated.push({ messageId, state });
      return true;
    },
    async sendTextNotice() {},
    async sendText() {},
    async sendImageFile() { return true; },
    async sendLocalFile() { return true; },
    async downloadImage() { return false; },
    async downloadFile() { return false; },
  };
  return sender;
}

describe('isStaleSessionError', () => {
  it('matches the GitHub issue error text', () => {
    expect(
      isStaleSessionError('Error: No conversation found with session ID: d0cfbde2-1357-4da0-acd6-ee36d1da056c'),
    ).toBe(true);
  });

  it('matches other stale session variants', () => {
    expect(isStaleSessionError('invalid session provided')).toBe(true);
    expect(isStaleSessionError('Conversation not found')).toBe(true);
  });

  it('matches conversation corruption errors (duplicate tool_result)', () => {
    expect(
      isStaleSessionError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.148.content.1: each tool_use must have a single result. Found multiple `tool_result` blocks with id: toolu_01TPsHXcmpuz5cAY97fM5vXv"}}'),
    ).toBe(true);
    expect(
      isStaleSessionError('each tool_use must have a single result'),
    ).toBe(true);
    expect(
      isStaleSessionError('Found multiple tool_result blocks with id: toolu_abc'),
    ).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isStaleSessionError('Task timed out (24 hour limit)')).toBe(false);
    expect(isStaleSessionError('permission denied')).toBe(false);
    expect(isStaleSessionError(undefined)).toBe(false);
  });
});

describe('MessageBridge between-turn questions', () => {
  it('mirrors /goal text into session state so cards can badge it', () => {
    const sender = makeSender() as any;
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any);
    const sm = bridge.getSessionManager();

    (bridge as any).mirrorGoalCommand('chat-1', '/goal ship the release');
    expect(sm.getSession('chat-1').activeGoal).toBe('ship the release');

    // clear synonyms unset it
    (bridge as any).mirrorGoalCommand('chat-1', '/goal clear');
    expect(sm.getSession('chat-1').activeGoal).toBeUndefined();

    // non-goal text is ignored
    (bridge as any).mirrorGoalCommand('chat-1', 'hello /goal-ish');
    expect(sm.getSession('chat-1').activeGoal).toBeUndefined();
  });

  it('treats a bare reset message as /reset instead of queueing it', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const handledTexts: string[] = [];
    bridge.commandHandler = {
      handle: async (msg: { text: string }) => {
        handledTexts.push(msg.text);
        return true;
      },
    };

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: 'reset',
    });

    expect(handledTexts).toEqual(['/reset']);
  });

  it('advances multi-question cards and resolves only after the last answer', async () => {
    vi.useFakeTimers();
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const resolved: Array<{ toolUseId: string; answers: Record<string, string> }> = [];
    bridge.persistentRegistry = {
      peek: () => ({
        resolveQuestion: (toolUseId: string, answers: Record<string, string>) => {
          resolved.push({ toolUseId, answers });
        },
      }),
    };

    await bridge.handleBetweenTurnQuestion('chat-1', {
      toolUseId: 'toolu_multi',
      questions: [
        {
          question: 'Pick a color',
          header: 'Color',
          options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }],
          multiSelect: false,
        },
        {
          question: 'Why?',
          header: 'Reason',
          options: [],
          multiSelect: false,
        },
      ],
    });

    expect(sender.sent[0].state.userPrompt).toBe('Question (1/2)');
    expect(sender.sent[0].state.pendingQuestion?.questions[0].question).toBe('Pick a color');

    await bridge.handleMessage({
      messageId: 'm1',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: '1',
    });

    expect(resolved).toEqual([]);
    expect(sender.updated.at(-1)?.state.userPrompt).toBe('Question (2/2)');
    expect(sender.updated.at(-1)?.state.responseText).toBe('> **Reply:** Red');
    expect(sender.updated.at(-1)?.state.pendingQuestion?.questions[0].question).toBe('Why?');

    await bridge.handleMessage({
      messageId: 'm2',
      chatId: 'chat-1',
      chatType: 'private',
      userId: 'u1',
      text: 'Because it is visible',
    });

    expect(resolved).toEqual([
      {
        toolUseId: 'toolu_multi',
        answers: {
          'Pick a color': 'Red',
          'Why?': 'Because it is visible',
        },
      },
    ]);
    expect(sender.updated.at(-1)?.state.status).toBe('complete');
    expect(sender.updated.at(-1)?.state.responseText).toBe('> **Reply:** Red, Because it is visible');
  });
});

describe('MessageBridge chatId cleanup (memory leak guard)', () => {
  it('sweepStaleChatIdEntries evicts only entries older than the TTL', () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    const now = Date.now();
    const TTL = 24 * 60 * 60 * 1000;

    bridge.recentQuestionCard.set('stale', { cardMessageId: 'old', at: now - TTL - 1000 });
    bridge.recentQuestionCard.set('fresh', { cardMessageId: 'new', at: now });

    bridge.sweepStaleChatIdEntries();

    expect(bridge.recentQuestionCard.has('stale')).toBe(false);
    expect(bridge.recentQuestionCard.has('fresh')).toBe(true);

    bridge.destroy();
  });

  it('destroy() clears all per-chat bookkeeping and the cleanup timer', () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;

    bridge.recentQuestionCard.set('chat-1', { cardMessageId: 'm', at: Date.now() });
    bridge.exitPlanCardsShown.add('chat-1');
    bridge.spontaneousSubscribed.add('chat-1');
    bridge.messageQueues.set('chat-1', []);
    const clearedTimers: Array<ReturnType<typeof setTimeout>> = [];
    const bufTimer = setTimeout(() => {}, 60_000);
    bridge.spontaneousBuffers.set('chat-1', { teamState: { teammates: [], tasks: [] }, snippets: [], timer: bufTimer });
    const qTimer = setTimeout(() => {}, 60_000);
    bridge.pendingBetweenTurnQuestions.set('chat-1', {
      toolUseId: 't', questions: [], cardMessageId: 'm', currentQuestionIndex: 0,
      collectedAnswers: {}, timeoutId: qTimer,
    });

    expect(bridge.chatIdCleanupTimer).toBeDefined();

    bridge.destroy();

    expect(bridge.recentQuestionCard.size).toBe(0);
    expect(bridge.exitPlanCardsShown.size).toBe(0);
    expect(bridge.spontaneousSubscribed.size).toBe(0);
    expect(bridge.spontaneousBuffers.size).toBe(0);
    expect(bridge.pendingBetweenTurnQuestions.size).toBe(0);
    expect(bridge.messageQueues.size).toBe(0);
    expect(bridge.chatIdCleanupTimer).toBeUndefined();

    clearTimeout(bufTimer);
    clearTimeout(qTimer);
    void clearedTimers;
  });
});

/**
 * [design-note P] 引用回复的排队合并守卫：引用不同消息的连发不合并
 * （否则一条合并消息只带一个 parentId，第二条的引文会被静默吃掉）；
 * 引用同一条消息、或都不带引用（undefined === undefined）时照旧合并。
 */
describe('MessageBridge quote-reply queue guard (patch P)', () => {
  function fakeRunningTask() {
    return { executionHandle: { finish() {} }, abortController: new AbortController() };
  }

  it('does not merge queued messages quoting different parents', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    bridge.runningTasks.set('chat-1', fakeRunningTask());

    await bridge.handleMessage({ messageId: 'm1', chatId: 'chat-1', chatType: 'group', userId: 'u1', parentId: 'om_a', text: 'tweak A' });
    await bridge.handleMessage({ messageId: 'm2', chatId: 'chat-1', chatType: 'group', userId: 'u1', parentId: 'om_b', text: 'tweak B' });
    await bridge.handleMessage({ messageId: 'm3', chatId: 'chat-1', chatType: 'group', userId: 'u1', parentId: 'om_b', text: 'more detail for B' });
    await bridge.handleMessage({ messageId: 'm4', chatId: 'chat-1', chatType: 'group', userId: 'u1', text: 'plain follow-up' });

    const queue = bridge.messageQueues.get('chat-1');
    expect(queue).toHaveLength(3); // om_a ｜ om_b（m3 并入）｜ 无引用
    expect(queue[0].parentId).toBe('om_a');
    expect(queue[1].parentId).toBe('om_b');
    expect(queue[1].text).toContain('tweak B');
    expect(queue[1].text).toContain('more detail for B');
    expect(queue[2].parentId).toBeUndefined();

    bridge.runningTasks.delete('chat-1');
    bridge.destroy();
  });

  it('plain (no-quote) rapid-fire messages still merge as before (patch C regression)', async () => {
    const sender = makeSender();
    const bridge = new MessageBridge(makeConfig(), mockLogger, sender as any) as any;
    bridge.runningTasks.set('chat-1', fakeRunningTask());

    await bridge.handleMessage({ messageId: 'm1', chatId: 'chat-1', chatType: 'group', userId: 'u1', text: 'first' });
    await bridge.handleMessage({ messageId: 'm2', chatId: 'chat-1', chatType: 'group', userId: 'u1', text: 'second' });

    expect(bridge.messageQueues.get('chat-1')).toHaveLength(1);

    bridge.runningTasks.delete('chat-1');
    bridge.destroy();
  });
});

/**
 * Spontaneous-card helpers — extracted so the snippet generator and card
 * title are unit-testable without booting a real MessageBridge.
 *
 * The history these tests guard against: an earlier version included a
 * `msg.type === 'result'` branch in the snippet generator, which produced
 * a `🤖 ...` snippet on top of the assistant text snippet for the same
 * underlying agent reply — flooding the card with duplicates. And the
 * card title used to say "Background activity from your agent team /
 * long-running task", which made users think the agent was *still*
 * running when in fact the card is emitted at the END of a quiet burst.
 */
describe('extractSpontaneousSnippet', () => {
  it('returns assistant text as snippet', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '  Weather is sunny  ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('Weather is sunny');
  });

  // Tool-use blocks used to render as `🔧 <ToolName>` lines in the
  // spontaneous card. That's the exact intermediate noise we hid from the
  // main card in PR #268 — surfacing it between turns would just put it
  // right back. extractSpontaneousSnippet now drops tool_use blocks
  // entirely; only text snippets (the agent's actual conclusion) survive.
  it('returns null for tool_use-only assistant messages (intermediate noise dropped)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('returns text and ignores adjacent tool_use blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    };
    expect(extractSpontaneousSnippet(msg)).toBe('hello');
  });

  it('returns null when only tool_use blocks are present (text-less burst)', () => {
    const msg = {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'Read' },
        { type: 'tool_use', name: 'Bash' },
      ] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('truncates very long text at the snippet cap with an ellipsis marker', () => {
    // The cap is 4000 (raised from 400, which cut off ordinary multi-paragraph
    // replies mid-sentence — see "经常显示不全" bug). Snippets above the cap
    // are still tagged with an ellipsis so the reader knows truncation happened.
    const long = 'x'.repeat(8000);
    const out = extractSpontaneousSnippet({
      type: 'assistant',
      message: { content: [{ type: 'text', text: long }] },
    });
    expect(out).toHaveLength(4001); // 4000 + the trailing ellipsis char
    expect(out!.endsWith('…')).toBe(true);
  });

  it('does not touch text shorter than the snippet cap (no ellipsis appended)', () => {
    const ordinary = 'A two-paragraph reply.\n\nWith another paragraph that is well under 4 KB.';
    const out = extractSpontaneousSnippet({
      type: 'assistant',
      message: { content: [{ type: 'text', text: ordinary }] },
    });
    expect(out).toBe(ordinary);
    expect(out!.endsWith('…')).toBe(false);
  });

  // Regression for Bug B (duplicate snippets): result-type messages MUST be
  // ignored. SDK's `result.result` is a verbatim echo of the last assistant
  // text block — including it produced two snippets for the same content.
  it('returns null for result-type messages (regression: no duplicate result snippet)', () => {
    expect(extractSpontaneousSnippet({ type: 'result', result: 'Weather is sunny' })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'result', result: 'anything' })).toBeNull();
  });

  it('returns null for user/system/other message types', () => {
    expect(extractSpontaneousSnippet({ type: 'user', message: { content: [] } })).toBeNull();
    expect(extractSpontaneousSnippet({ type: 'system' })).toBeNull();
    expect(extractSpontaneousSnippet(null)).toBeNull();
    expect(extractSpontaneousSnippet({})).toBeNull();
  });

  it('returns null for assistant messages with no usable text content', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', text: 'silent' }, { type: 'image' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });

  it('skips empty text blocks', () => {
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: '   ' }] },
    };
    expect(extractSpontaneousSnippet(msg)).toBeNull();
  });
});

describe('formatSpontaneousCardBody', () => {
  // The card body renders ALL snippets (chronological), separated by a
  // horizontal rule. Earlier behavior was "show only the latest + a
  // (N coalesced) footer" — that turned out to drop most of the useful
  // content (the "经常显示不全" bug) because teammate pings, /loop
  // iterations, and cron tasks each emit their own snippet and the user
  // needs to see all of them. Total length is capped at
  // SPONTANEOUS_BODY_MAX_CHARS; overflow drops the oldest snippets and
  // prepends a one-line summary of how many were omitted.
  //
  // The body never carries a header caption when nothing was dropped —
  // the card itself is sent with the `agent_activity` status, which
  // renders a blue "Agent activity" title at the top. Don't re-add a
  // body header without confirming the card-status signal is no longer
  // sufficient.
  it('renders the single snippet verbatim with no header caption', () => {
    const body = formatSpontaneousCardBody(['Weather is sunny']);
    expect(body).toBe('Weather is sunny');
  });

  it('renders ALL snippets chronologically with a horizontal-rule separator', () => {
    const body = formatSpontaneousCardBody([
      'Looking at the PR comments…',
      'Found 3 things to address.',
      'Pushed commit abc1234 to the branch.',
    ]);
    // All three must appear, in order.
    const idxA = body.indexOf('Looking at the PR comments');
    const idxB = body.indexOf('Found 3 things to address');
    const idxC = body.indexOf('Pushed commit abc1234');
    expect(idxA).toBeGreaterThanOrEqual(0);
    expect(idxB).toBeGreaterThan(idxA);
    expect(idxC).toBeGreaterThan(idxB);
    // Snippets are separated by `---` rules (two between three snippets).
    expect((body.match(/^---$/gm) ?? []).length).toBe(2);
    // No body-level "between turns" / "long-running" caption, and no
    // "N events coalesced; showing latest" footer (that's the old behavior).
    expect(body).not.toMatch(/coalesced/i);
    expect(body).not.toMatch(/between turns/i);
    expect(body).not.toMatch(/long-running/i);
    expect(body).not.toMatch(/showing latest/i);
  });

  it('drops the oldest snippets and prepends an "omitted" notice when total exceeds the body budget', () => {
    // Each snippet ~3500 chars; 5 of them = ~17500 chars total → over the
    // 12000 budget. We should keep the most recent N that fit, drop the rest.
    const big = (label: string) => label + ' ' + 'x'.repeat(3500);
    const snippets = ['old1', 'old2', 'old3', 'old4', 'newest'].map(big);
    const body = formatSpontaneousCardBody(snippets);
    // newest MUST be present (most relevant).
    expect(body).toContain('newest');
    // At least the oldest one MUST be omitted, with an "omitted" notice.
    expect(body).toMatch(/^_\(\d+ earlier events? omitted; \d+ shown\)_/);
    expect(body).not.toContain('old1');
  });

  it('returns an empty string when the snippets array is empty', () => {
    expect(formatSpontaneousCardBody([])).toBe('');
  });
});

/**
 * Burst-source classifier — distinguishes SDK-initiated continuation turns
 * (the agent waking up to summarise a `run_in_background` Bash return) from
 * everything else that arrives between user turns (teammate pings, /goal
 * Stop-hook user messages, system status events).
 *
 * The classification matters for UX:
 *   - continuation → render as a fresh streaming card (looks like a user
 *     turn) so the user reads the burst as "the agent continued its work"
 *   - spontaneous  → coalesce into the "Agent activity between turns" card
 *     so multiple ambient pings don't spam the chat
 *
 * The signal we key on is the SDK's `origin.kind === 'task-notification'`
 * field on the FIRST message of a between-turn burst. Don't relax the
 * classifier to also fire on assistant text alone — both buckets see
 * assistant messages after the burst opens; only the OPENING message
 * carries the origin marker.
 */
describe('classifyBurstSource', () => {
  it('returns continuation for a user message with task-notification origin', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'background task finished' },
      origin: { kind: 'task-notification' },
    };
    expect(classifyBurstSource(msg)).toBe('continuation');
  });

  it('returns spontaneous for a user message with no origin (e.g. /goal Stop hook synthesis)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'Goal evaluator says: continue' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for a user message with peer origin (teammate SendMessage)', () => {
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hi from teammate' },
      origin: { kind: 'peer', from: 'researcher' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for human-origin user message (manual injection, defensive)', () => {
    // Shouldn't happen in the consumeLoop path (humans go through nextTurn),
    // but the classifier must be conservative — anything not explicitly a
    // task-notification falls back to the coalesced bucket.
    const msg = {
      type: 'user',
      message: { role: 'user', content: 'hello' },
      origin: { kind: 'human' },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for assistant text (e.g. teammate burst opening with assistant)', () => {
    // origin is on USER messages, not assistant. An assistant-led burst is
    // either a continuation already in progress (handled by activeTurn) or
    // a teammate ping (spontaneous).
    const msg = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'doing the thing' }] },
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('returns spontaneous for system task_notification system message (the SDK status event itself)', () => {
    // The SDKTaskNotificationMessage (type:'system' subtype:'task_notification')
    // is the SETTLE event, NOT the wake-up. The wake-up is the follow-up
    // user-role message with origin.kind === 'task-notification'. Keep this
    // routed to spontaneous so the status doesn't accidentally open a card
    // by itself.
    const msg = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 't1',
      status: 'completed',
      summary: 'done',
    };
    expect(classifyBurstSource(msg)).toBe('spontaneous');
  });

  it('handles malformed input defensively (null / missing fields → spontaneous)', () => {
    expect(classifyBurstSource(null)).toBe('spontaneous');
    expect(classifyBurstSource(undefined)).toBe('spontaneous');
    expect(classifyBurstSource({})).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user' })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: {} })).toBe('spontaneous');
    expect(classifyBurstSource({ type: 'user', origin: { kind: 'unknown-future' } })).toBe('spontaneous');
  });

  it('requires BOTH type==="user" AND origin.kind to fire continuation (not type alone)', () => {
    // Defensive: don't open a continuation just because origin happens to be
    // present on a non-user message — origin lives on user/result types per
    // the SDK type defs, and assistants/system never carry task-notification.
    expect(classifyBurstSource({
      type: 'assistant',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
    expect(classifyBurstSource({
      type: 'result',
      origin: { kind: 'task-notification' },
    })).toBe('spontaneous');
  });
});

/**
 * The persistent executor pool is the load-bearing piece behind background
 * tasks, Agent Teams continuity, and `/goal` multi-turn auto-drive. As of
 * 2026-05-13 it's the DEFAULT — installs that haven't set the env var still
 * get the right behaviour. Opt out with LUCKAGENT_PERSISTENT_EXECUTOR=false (or
 * '0').
 *
 * Don't flip the default back to off without a real reason: the card UI now
 * advertises background tasks, and silently disabling them would surprise
 * users who installed-and-went.
 */
describe('resolvePersistentExecutorEnvDefault', () => {
  it('returns true when env var is undefined (the new default)', () => {
    expect(resolvePersistentExecutorEnvDefault(undefined)).toBe(true);
  });

  it('returns true for empty string (env var present but unset value)', () => {
    expect(resolvePersistentExecutorEnvDefault('')).toBe(true);
  });

  it('returns true for explicit on values (back-compat with old opt-in syntax)', () => {
    expect(resolvePersistentExecutorEnvDefault('true')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('1')).toBe(true);
  });

  it('returns false for explicit opt-out values', () => {
    expect(resolvePersistentExecutorEnvDefault('false')).toBe(false);
    expect(resolvePersistentExecutorEnvDefault('0')).toBe(false);
  });

  it('returns true for unrecognised values (do not silently disable a load-bearing feature on a typo)', () => {
    // Anything that isn't an explicit opt-out should keep persistent on.
    // Better to leave a typo-set var on than to silently drop background
    // tasks; the symptom of "off" is much worse (silent breakage) than the
    // symptom of "on" (slightly more memory).
    expect(resolvePersistentExecutorEnvDefault('off')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('no')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('disabled')).toBe(true);
    expect(resolvePersistentExecutorEnvDefault('truee')).toBe(true);
  });
});

describe('effectiveTurnBackend', () => {
  it('legacy per-turn execution is always SDK, regardless of config', () => {
    expect(effectiveTurnBackend(false, 'claude', 'pty')).toBe('sdk');
    expect(effectiveTurnBackend(false, 'deepseek', 'pty')).toBe('sdk');
    expect(effectiveTurnBackend(false, 'minimax', 'pty')).toBe('sdk');
  });
  it('persistent pool follows config for claude, forced sdk for compat engines', () => {
    expect(effectiveTurnBackend(true, 'claude', 'pty')).toBe('pty');
    expect(effectiveTurnBackend(true, 'claude', 'sdk')).toBe('sdk');
    expect(effectiveTurnBackend(true, 'deepseek', 'pty')).toBe('sdk');
    expect(effectiveTurnBackend(true, 'minimax', 'pty')).toBe('sdk');
  });
});

describe('admitting marker (download-phase busy)', () => {
  it('isBusy is true while a chat is admitted but not yet running', () => {
    const bridge = new MessageBridge(makeConfig(), mockLogger, makeSender() as any);
    expect(bridge.isBusy('c1')).toBe(false);
    (bridge as any).admitting.add('c1');
    expect(bridge.isBusy('c1')).toBe(true);
    (bridge as any).admitting.delete('c1');
    expect(bridge.isBusy('c1')).toBe(false);
  });
});

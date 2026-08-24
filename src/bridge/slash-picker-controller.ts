import type { BotConfigBase } from '../config.js';
import type { CodexReasoningEffort } from '../config.js';
import type { EngineName, ExecutionHandle, SessionManager } from '../engines/index.js';
import { resolveEngineName } from '../engines/index.js';
import type { IncomingMessage, CardState, PendingQuestion } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { SessionSummary } from '../engines/claude/session-lister.js';
import type { IMessageSender } from './message-sender.interface.js';
import type { OutputsManager } from './outputs-manager.js';

const SLASH_PICKERS: Record<string, { question: string; header: string; options: Array<{ label: string; description: string }> }> = {
  '/effort': {
    question: 'Set the reasoning effort level',
    header: 'Effort',
    options: [
      { label: 'xhigh', description: 'Maximum Codex-supported effort for deep agentic/coding work' },
      { label: 'high', description: 'Complex reasoning — quality over speed/cost' },
      { label: 'medium', description: 'Balanced speed, cost & performance (default)' },
      { label: 'low', description: 'Fastest — high-volume / latency-sensitive work' },
    ],
  },
};

interface PendingSlashPicker {
  command: string;
  options: string[];
  cardMessageId: string;
}

export class SlashPickerController {
  private pending = new Map<string, PendingSlashPicker>();

  constructor(
    private readonly deps: {
      config: BotConfigBase;
      logger: Logger;
      sender: IMessageSender;
      sessionManager: SessionManager;
      outputsManager: OutputsManager;
      listSessionsForChat: (chatId: string) => SessionSummary[];
      applyResume: (chatId: string, sessionId: string) => Promise<void>;
      finalizeQuestionCard: (messageId: string, state: CardState) => Promise<void>;
      handleMessage: (msg: IncomingMessage) => Promise<void>;
      isBusy: (chatId: string) => boolean;
      prepareSessionForExecution: (chatId: string) => { session: any; engineName: EngineName };
      runOneTurn: (
        chatId: string,
        engineName: EngineName,
        options: {
          prompt: string;
          cwd: string;
          abortController: AbortController;
          outputsDir: string;
          apiContext?: { botName: string; chatId: string };
          model?: string;
        },
      ) => Promise<ExecutionHandle>;
    },
  ) {}

  async tryOpen(msg: IncomingMessage): Promise<boolean> {
    const { chatId, text } = msg;
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 1) return false;
    const cmd = parts[0].toLowerCase();
    if (cmd === '/resume') return this.openResumePicker(msg);
    const spec = SLASH_PICKERS[cmd];
    if (!spec) return false;

    const pendingQuestion: PendingQuestion = {
      toolUseId: `slash-picker:${cmd}`,
      questions: [
        { question: spec.question, header: spec.header, options: spec.options, multiSelect: false },
      ],
    };
    const card: CardState = {
      status: 'waiting_for_input',
      userPrompt: cmd,
      responseText: '',
      toolCalls: [],
      pendingQuestion,
    };

    const cardMessageId = await this.sendPickerCard(chatId, card, { cmd });
    if (!cardMessageId) return false;

    this.pending.set(chatId, {
      command: cmd,
      options: spec.options.map((o) => o.label),
      cardMessageId,
    });
    this.deps.logger.info({ chatId, cmd, cardMessageId }, 'MessageBridge: slash picker card opened');
    return true;
  }

  async tryHandleReply(msg: IncomingMessage): Promise<boolean> {
    const { chatId, text } = msg;
    const pending = this.pending.get(chatId);
    if (!pending) return false;

    const trimmed = text.trim();
    let choice: string | undefined;
    const num = parseInt(trimmed, 10);
    if (Number.isFinite(num) && num >= 1 && num <= pending.options.length) {
      choice = pending.options[num - 1];
    } else {
      const lower = trimmed.toLowerCase();
      choice = pending.options.find((o) => o.toLowerCase() === lower);
    }

    if (!choice) {
      await this.deps.sender.sendText(
        chatId,
        `请回复选项编号（1-${pending.options.length}）或选项名（${pending.options.join(' / ')}）。`,
      );
      return true;
    }

    this.pending.delete(chatId);

    if (pending.command === '/resume') {
      await this.deps.applyResume(chatId, choice);
      await this.deps.finalizeQuestionCard(pending.cardMessageId, {
        status: 'complete',
        userPrompt: '/resume',
        responseText: `✅ Resumed session \`${choice.slice(0, 8)}\`. Your next message continues that conversation.`,
        toolCalls: [],
      });
      return true;
    }

    if (pending.command === '/effort') {
      const session = this.deps.sessionManager.getSession(chatId);
      const activeEngine = session.engine ?? resolveEngineName(this.deps.config);
      if (activeEngine !== 'codex') {
        await this.deps.finalizeQuestionCard(pending.cardMessageId, {
          status: 'complete',
          userPrompt: '/effort',
          responseText: `ℹ️ This chat is on \`${activeEngine}\`. Use \`/model codex\` before setting Codex effort.`,
          toolCalls: [],
        });
        return true;
      }
      const effort = normalizeCodexEffort(choice);
      if (!effort || effort === 'reset') {
        await this.deps.finalizeQuestionCard(pending.cardMessageId, {
          status: 'error',
          userPrompt: '/effort',
          responseText: `Invalid effort: \`${choice}\``,
          toolCalls: [],
        });
        return true;
      }
      this.deps.sessionManager.setReasoningEffort(chatId, effort);
      await this.deps.finalizeQuestionCard(pending.cardMessageId, {
        status: 'complete',
        userPrompt: '/effort',
        responseText: `✅ **effort** set to \`${effort}\``,
        toolCalls: [],
      });
      return true;
    }

    const injected = `${pending.command} ${choice}`;
    if (this.deps.isBusy(chatId)) {
      this.deps.logger.info({ chatId, command: pending.command, choice }, 'MessageBridge: slash picker resolved while busy — re-injecting via queue');
      await this.deps.finalizeQuestionCard(pending.cardMessageId, {
        status: 'complete',
        userPrompt: pending.command,
        responseText: `> **Selected:** ${choice}`,
        toolCalls: [],
      });
      await this.deps.handleMessage({ ...msg, text: injected });
      return true;
    }

    this.deps.logger.info({ chatId, command: pending.command, choice }, 'MessageBridge: slash picker resolved — submitting silently');
    await this.submitSilentSlashCommand(chatId, injected);
    await this.deps.finalizeQuestionCard(pending.cardMessageId, {
      status: 'complete',
      userPrompt: pending.command,
      responseText: `✅ **${pending.command.slice(1)}** set to \`${choice}\``,
      toolCalls: [],
    });
    return true;
  }

  private async openResumePicker(msg: IncomingMessage): Promise<boolean> {
    const { chatId } = msg;
    const session = this.deps.sessionManager.getSession(chatId);
    const activeEngine = session.engine ?? resolveEngineName(this.deps.config);
    if (activeEngine !== 'claude') {
      await this.deps.sender.sendTextNotice(
        chatId,
        'ℹ️ /resume is Claude-only',
        `This chat is on the \`${activeEngine}\` engine. Session resume is only available for the Claude engine.`,
        'blue',
      );
      return true;
    }

    const sessions = this.deps.listSessionsForChat(chatId);
    if (sessions.length === 0) {
      await this.deps.sender.sendTextNotice(
        chatId,
        'ℹ️ No Previous Sessions',
        'No earlier Claude sessions were found for this chat\'s working directory.',
        'blue',
      );
      return true;
    }

    const options = sessions.map((s) => {
      const rel = formatRelativeTime(s.lastActive);
      const marker = s.isCurrent ? ' · current' : '';
      return {
        label: s.sessionId.slice(0, 8),
        description: `${s.preview} · ${rel}${marker}`,
      };
    });

    const pendingQuestion: PendingQuestion = {
      toolUseId: 'slash-picker:/resume',
      questions: [
        { question: 'Pick a session to resume', header: 'Resume', options, multiSelect: false },
      ],
    };
    const card: CardState = {
      status: 'waiting_for_input',
      userPrompt: '/resume',
      responseText: '',
      toolCalls: [],
      pendingQuestion,
    };

    const cardMessageId = await this.sendPickerCard(chatId, card, { resume: true });
    if (!cardMessageId) return false;

    this.pending.set(chatId, {
      command: '/resume',
      options: sessions.map((s) => s.sessionId),
      cardMessageId,
    });
    this.deps.logger.info({ chatId, count: sessions.length, cardMessageId }, 'MessageBridge: /resume picker card opened');
    return true;
  }

  private async sendPickerCard(chatId: string, card: CardState, logContext: Record<string, unknown>): Promise<string | undefined> {
    const send = this.deps.sender.sendQuestionCard
      ? this.deps.sender.sendQuestionCard.bind(this.deps.sender)
      : this.deps.sender.sendCard.bind(this.deps.sender);
    try {
      const cardMessageId = await send(chatId, card);
      if (!cardMessageId) {
        this.deps.logger.warn({ chatId, ...logContext }, 'MessageBridge: slash picker card returned no messageId');
      }
      return cardMessageId;
    } catch (err) {
      this.deps.logger.error({ err, chatId, ...logContext }, 'MessageBridge: failed to send slash picker card');
      return undefined;
    }
  }

  private async submitSilentSlashCommand(chatId: string, command: string): Promise<void> {
    const { session, engineName } = this.deps.prepareSessionForExecution(chatId);
    const abortController = new AbortController();
    const outputsDir = this.deps.outputsManager.prepareDir(chatId);
    const apiContext = { botName: this.deps.config.name, chatId };

    let handle: ExecutionHandle | undefined;
    const safety = setTimeout(() => {
      try { handle?.finish(); } catch { /* ignore */ }
      abortController.abort();
    }, 30_000);

    try {
      handle = await this.deps.runOneTurn(chatId, engineName, {
        prompt: command,
        cwd: session.workingDirectory,
        abortController,
        outputsDir,
        apiContext,
        model: session.model,
      });
      for await (const message of handle.stream) {
        if (abortController.signal.aborted) break;
        const sid = (message as { session_id?: string }).session_id;
        if (sid && (sid !== session.sessionId || session.sessionIdEngine !== engineName)) {
          this.deps.sessionManager.setSessionId(chatId, sid, engineName);
        }
        if (message.type === 'result') break;
      }
    } catch (err) {
      this.deps.logger.warn({ err, chatId, command }, 'MessageBridge: silent slash command errored');
    } finally {
      clearTimeout(safety);
      try { handle?.finish(); } catch { /* ignore */ }
      try { this.deps.outputsManager.cleanup(outputsDir); } catch { /* ignore */ }
    }
  }
}

function normalizeCodexEffort(value: string): CodexReasoningEffort | 'reset' | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'reset' || normalized === 'clear' || normalized === 'default') return 'reset';
  if (normalized === 'max') return 'xhigh';
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'xhigh') return normalized;
  return undefined;
}

export function formatRelativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

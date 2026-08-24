import type { BotConfigBase } from '../config.js';
import type { EngineName, ExecutionHandle } from '../engines/index.js';
import { DEFAULT_CODEX_GOAL_MAX_ITERATIONS, StreamProcessor, SessionManager } from '../engines/index.js';
import type { IncomingMessage, CardState } from '../types.js';
import type { AuditLogger } from '../utils/audit-logger.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import type { OutputHandler } from './output-handler.js';
import type { OutputsManager } from './outputs-manager.js';
import {
  buildCodexGoalPrompt,
  parseCodexGoalStatus,
  truncateBlock,
  truncateLine,
} from './codex-goal-policy.js';

interface CodexBackgroundTask {
  id: string;
  chatId: string;
  internalChatId: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  updatedAt: number;
  responseText?: string;
  errorMessage?: string;
  abortController: AbortController;
  executionHandle?: ExecutionHandle;
}

type RunOneTurn = (
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

export class CodexCommandController {
  private backgroundTasks = new Map<string, CodexBackgroundTask>();
  private backgroundSeq = 0;

  constructor(
    private readonly deps: {
      config: BotConfigBase;
      logger: Logger;
      sender: IMessageSender;
      sessionManager: SessionManager;
      outputsManager: OutputsManager;
      outputHandler: OutputHandler;
      audit: AuditLogger;
      runOneTurn: RunOneTurn;
      executeQuery: (msg: IncomingMessage) => Promise<void>;
      hasRunningTask: (chatId: string) => boolean;
      hasQueuedMessages: (chatId: string) => boolean;
    },
  ) {}

  mirrorGoalCommand(chatId: string, text: string): void {
    const trimmed = text.trim();
    if (!/^\/goal(\s|$)/i.test(trimmed)) return;
    const rest = trimmed.replace(/^\/goal\s*/i, '').trim();
    if (!rest) return;
    const lowered = rest.toLowerCase();
    if (['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(lowered)) {
      this.deps.sessionManager.setGoal(chatId, undefined);
      return;
    }
    this.deps.sessionManager.setGoal(chatId, rest);
  }

  async tryHandleBridgeCommand(msg: IncomingMessage): Promise<boolean> {
    const trimmed = msg.text.trim();
    const cmd = trimmed.split(/\s+/, 1)[0]?.toLowerCase();
    if (cmd === '/goal') {
      await this.handleGoalCommand(msg, trimmed.slice('/goal'.length).trim());
      return true;
    }
    if (cmd === '/background' || cmd === '/bg') {
      const prefix = cmd === '/bg' ? '/bg' : '/background';
      await this.handleBackgroundCommand(msg, trimmed.slice(prefix.length).trim());
      return true;
    }
    return false;
  }

  maybeScheduleGoalContinuation(
    original: IncomingMessage,
    lastState: CardState,
    engineName: EngineName,
    iteration: number,
    maxIterations: number,
  ): void {
    if (engineName !== 'codex') return;
    const session = this.deps.sessionManager.getSession(original.chatId);
    const goal = session.activeGoal;
    if (!goal || lastState.status !== 'complete') return;

    const status = parseCodexGoalStatus(lastState.responseText) ?? 'continue';
    if (status === 'complete') {
      this.deps.sessionManager.setGoal(original.chatId, undefined);
      void this.deps.sender.sendTextNotice(original.chatId, '✅ Goal Complete', goal, 'green');
      return;
    }
    if (status === 'blocked') {
      void this.deps.sender.sendTextNotice(
        original.chatId,
        '⏸️ Goal Blocked',
        `Codex reported the goal is blocked and needs input.\n\n**Goal:** ${goal}`,
        'orange',
      );
      return;
    }
    if (iteration >= maxIterations) {
      void this.deps.sender.sendTextNotice(
        original.chatId,
        '⏸️ Goal Paused',
        `Reached the Codex goal safety cap (${maxIterations} iterations). Use \`/goal status\` or send a normal message to continue manually.`,
        'orange',
      );
      return;
    }
    if (this.deps.hasRunningTask(original.chatId) || this.deps.hasQueuedMessages(original.chatId)) return;

    const next: IncomingMessage = {
      ...original,
      messageId: `${original.messageId || 'goal'}-goal-${iteration + 1}`,
      text: `Continue working toward the active goal: ${goal}`,
      timestamp: Date.now(),
    };
    setTimeout(() => {
      this.deps.executeQuery(next).catch((err) => {
        this.deps.logger.error({ err, chatId: original.chatId }, 'Codex goal continuation failed');
      });
    }, 1000);
  }

  private async handleGoalCommand(msg: IncomingMessage, args: string): Promise<void> {
    const { chatId } = msg;
    const session = this.deps.sessionManager.getSession(chatId);
    if (!args || args.toLowerCase() === 'status') {
      const body = session.activeGoal
        ? [
            `**Goal:** ${session.activeGoal}`,
            `**Iterations:** ${session.goalIterations ?? 0}/${session.goalMaxIterations ?? DEFAULT_CODEX_GOAL_MAX_ITERATIONS}`,
            '',
            'Use `/goal clear` to stop it.',
          ].join('\n')
        : 'No active Codex goal. Use `/goal <description>` to start one.';
      await this.deps.sender.sendTextNotice(chatId, '🎯 Codex Goal', body, 'blue');
      return;
    }

    const lowered = args.toLowerCase();
    if (['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(lowered)) {
      this.deps.sessionManager.setGoal(chatId, undefined);
      await this.deps.sender.sendTextNotice(chatId, '✅ Goal Cleared', 'Codex auto-drive is stopped for this chat.', 'green');
      return;
    }

    this.deps.sessionManager.setGoal(chatId, args);
    const maxIterations = this.deps.sessionManager.getSession(chatId).goalMaxIterations ?? DEFAULT_CODEX_GOAL_MAX_ITERATIONS;
    await this.deps.sender.sendTextNotice(
      chatId,
      '🎯 Goal Set',
      [
        args,
        '',
        `Codex will keep working across turns until it reports complete, blocked, or reaches ${maxIterations} iterations.`,
      ].join('\n'),
      'green',
    );

    this.scheduleGoalStart(msg, args);
  }

  private scheduleGoalStart(original: IncomingMessage, goal: string): void {
    if (this.deps.hasRunningTask(original.chatId) || this.deps.hasQueuedMessages(original.chatId)) return;

    const next: IncomingMessage = {
      ...original,
      messageId: `${original.messageId || 'goal'}-goal-start`,
      text: `Start working toward the active goal: ${goal}`,
      timestamp: Date.now(),
    };
    setTimeout(() => {
      this.deps.executeQuery(next).catch((err) => {
        this.deps.logger.error({ err, chatId: original.chatId }, 'Codex goal initial turn failed');
      });
    }, 100);
  }

  private async handleBackgroundCommand(msg: IncomingMessage, args: string): Promise<void> {
    const { chatId } = msg;
    const [subCmdRaw, ...rest] = args.split(/\s+/).filter(Boolean);
    const subCmd = subCmdRaw?.toLowerCase();
    const managementCommands = new Set(['list', 'ls', 'stop', 'cancel', 'logs', 'show']);

    if (!subCmd || subCmd === 'list' || subCmd === 'ls') {
      const tasks = [...this.backgroundTasks.values()]
        .filter((t) => t.chatId === chatId)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 10);
      const body = tasks.length === 0
        ? 'No Codex background tasks for this chat.'
        : tasks.map((t) => {
            const age = Math.max(0, Math.round((Date.now() - t.startedAt) / 1000));
            return `- \`${t.id}\` ${t.status} (${age}s) — ${truncateLine(t.prompt, 90)}`;
          }).join('\n');
      await this.deps.sender.sendTextNotice(chatId, '🧵 Codex Background', body, 'blue');
      return;
    }

    if (!managementCommands.has(subCmd)) {
      await this.startBackgroundTask(msg, args);
      return;
    }

    if (subCmd === 'stop' || subCmd === 'cancel') {
      const id = rest[0];
      const task = id ? this.backgroundTasks.get(id) : undefined;
      if (!task || task.chatId !== chatId) {
        await this.deps.sender.sendTextNotice(chatId, '❌ Background Task Not Found', 'Usage: `/background stop <id>`', 'red');
        return;
      }
      task.status = 'stopped';
      task.updatedAt = Date.now();
      task.errorMessage = 'Stopped by user';
      task.executionHandle?.finish();
      task.abortController.abort();
      await this.deps.sender.sendTextNotice(chatId, '🛑 Background Task Stopped', `Stopped \`${task.id}\`.`, 'orange');
      return;
    }

    if (subCmd === 'logs' || subCmd === 'show') {
      const id = rest[0];
      const task = id ? this.backgroundTasks.get(id) : undefined;
      if (!task || task.chatId !== chatId) {
        await this.deps.sender.sendTextNotice(chatId, '❌ Background Task Not Found', 'Usage: `/background logs <id>`', 'red');
        return;
      }
      await this.deps.sender.sendTextNotice(
        chatId,
        `🧵 Background ${task.id}`,
        [
          `**Status:** ${task.status}`,
          `**Prompt:** ${task.prompt}`,
          task.errorMessage ? `**Error:** ${task.errorMessage}` : '',
          task.responseText ? `\n${truncateBlock(task.responseText, 3000)}` : '',
        ].filter(Boolean).join('\n'),
        task.status === 'failed' ? 'red' : task.status === 'running' ? 'blue' : 'green',
      );
    }
  }

  private async startBackgroundTask(msg: IncomingMessage, prompt: string): Promise<void> {
    const { chatId, userId } = msg;
    const id = `bg-${Date.now().toString(36)}-${++this.backgroundSeq}`;
    const internalChatId = `${chatId}::codex-bg::${id}`;
    const abortController = new AbortController();
    const task: CodexBackgroundTask = {
      id,
      chatId,
      internalChatId,
      prompt,
      status: 'running',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      abortController,
    };
    this.backgroundTasks.set(id, task);
    await this.deps.sender.sendTextNotice(
      chatId,
      '🧵 Background Started',
      `Started \`${id}\`.\nUse \`/background list\`, \`/background logs ${id}\`, or \`/background stop ${id}\`.`,
      'blue',
    );

    void this.runBackgroundTask(task, userId).catch((err) => {
      this.deps.logger.error({ err, chatId, taskId: id }, 'Codex background task crashed');
    });
  }

  private async runBackgroundTask(task: CodexBackgroundTask, userId: string): Promise<void> {
    const baseSession = this.deps.sessionManager.getSession(task.chatId);
    const bgSession = this.deps.sessionManager.getSession(task.internalChatId);
    bgSession.engine = 'codex';
    bgSession.workingDirectory = baseSession.workingDirectory;
    bgSession.model = baseSession.model;
    bgSession.modelEngine = baseSession.modelEngine;

    const cwd = bgSession.workingDirectory;
    const outputsDir = this.deps.outputsManager.prepareDir(task.internalChatId);
    const processor = new StreamProcessor(task.prompt);
    const apiContext = { botName: this.deps.config.name, chatId: task.chatId };
    const activeGoal = baseSession.activeGoal;
    const prompt = activeGoal
      ? buildCodexGoalPrompt(
          task.prompt,
          activeGoal,
          baseSession.goalIterations ?? 0,
          baseSession.goalMaxIterations ?? DEFAULT_CODEX_GOAL_MAX_ITERATIONS,
        )
      : task.prompt;
    let lastState: CardState = {
      status: 'thinking',
      userPrompt: task.prompt,
      responseText: '',
      toolCalls: [],
      goalCondition: activeGoal,
    };

    const handle = await this.deps.runOneTurn(task.internalChatId, 'codex', {
      prompt,
      cwd,
      abortController: task.abortController,
      outputsDir,
      apiContext,
      model: bgSession.model,
    });
    task.executionHandle = handle;

    try {
      for await (const message of handle.stream) {
        if (task.abortController.signal.aborted) break;
        lastState = processor.processMessage(message);
        if (activeGoal) lastState.goalCondition = activeGoal;
        const sid = processor.getSessionId();
        if (sid) this.deps.sessionManager.setSessionId(task.internalChatId, sid, 'codex');
        if (lastState.status === 'complete' || lastState.status === 'error') break;
      }
      if (task.status === 'stopped') return;
      if (lastState.status !== 'complete' && lastState.status !== 'error') {
        lastState = {
          ...lastState,
          status: lastState.responseText ? 'complete' : 'error',
          errorMessage: lastState.responseText ? undefined : 'Codex background task ended unexpectedly',
        };
      }
      task.status = lastState.status === 'complete' ? 'completed' : 'failed';
      task.responseText = lastState.responseText;
      task.errorMessage = lastState.errorMessage;
      task.updatedAt = Date.now();
      await this.deps.sender.sendCard(task.chatId, {
        ...lastState,
        userPrompt: `[Background ${task.id}] ${task.prompt}`,
      });
      await this.deps.outputHandler.sendOutputFiles(task.chatId, outputsDir, processor, lastState);
      this.deps.audit.log({
        event: task.status === 'completed' ? 'task_complete' : 'task_error',
        botName: this.deps.config.name,
        chatId: task.chatId,
        userId,
        prompt: task.prompt,
        error: task.errorMessage,
        meta: { backgroundTaskId: task.id, engine: 'codex' },
      });
    } finally {
      try { handle.finish(); } catch { /* ignore */ }
      try { this.deps.outputsManager.cleanup(outputsDir); } catch { /* ignore */ }
    }
  }
}

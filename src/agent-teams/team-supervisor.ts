import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { MessageBridge } from '../bridge/message-bridge.js';
import type { Logger } from '../utils/logger.js';
import type { AgentTeamStore, TeamAgent, TeamMessage, TeamRun, TeamTask } from './team-store.js';

export interface AgentTeamSupervisorOptions {
  registry: BotRegistry;
  store: AgentTeamStore;
  logger: Logger;
  intervalMs?: number;
}

interface RunnableAgent {
  agent: TeamAgent;
  messages: TeamMessage[];
  tasks: TeamTask[];
  key: string;
  isolatedSession: boolean;
}

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_PARALLEL_PER_AGENT = 4;

export class AgentTeamSupervisor {
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly maxParallelPerAgent: number;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private tickInProgress = false;
  private readonly inFlight = new Set<string>();
  private readonly inFlightRuns = new Map<string, { teamName: string; agentName: string; chatId: string; bridge: MessageBridge; taskIds: number[] }>();
  private readonly teamsAwaitingIdleDigest = new Set<string>();

  constructor(private readonly options: AgentTeamSupervisorOptions) {
    this.logger = options.logger.child({ module: 'agent-team-supervisor' });
    const envInterval = Number(process.env.LUCKAGENT_AGENT_TEAM_SUPERVISOR_INTERVAL_MS);
    this.intervalMs = Math.max(1_000, options.intervalMs ?? (Number.isFinite(envInterval) && envInterval > 0 ? envInterval : DEFAULT_INTERVAL_MS));
    const envMaxParallel = Number(process.env.LUCKAGENT_AGENT_TEAM_MAX_PARALLEL_PER_AGENT);
    this.maxParallelPerAgent = Math.max(
      1,
      Number.isFinite(envMaxParallel) && envMaxParallel > 0
        ? Math.floor(envMaxParallel)
        : DEFAULT_MAX_PARALLEL_PER_AGENT,
    );
  }

  start(): void {
    if (this.timer || process.env.LUCKAGENT_AGENT_TEAM_SUPERVISOR === '0') return;
    this.stopped = false;
    this.recoverStaleRunningRuns();
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.error({ err }, 'Agent team supervisor tick failed');
      });
    }, this.intervalMs);
    this.timer.unref?.();
    void this.tick().catch((err) => {
      this.logger.error({ err }, 'Agent team supervisor initial tick failed');
    });
    this.logger.info({ intervalMs: this.intervalMs }, 'Agent team supervisor started');
  }

  destroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const run of this.inFlightRuns.values()) {
      run.bridge.stopChatTask(run.chatId);
    }
    this.inFlightRuns.clear();
  }

  stopRun(teamName: string, runId: string): TeamRun | undefined {
    const run = this.options.store.updateRun(teamName, runId, { status: 'stopped' });
    if (!run) return undefined;
    const inFlight = this.inFlightRuns.get(runId);
    if (inFlight) {
      inFlight.bridge.stopChatTask(inFlight.chatId);
      for (const taskId of inFlight.taskIds) {
        const task = this.options.store.getTask(teamName, taskId);
        if (task?.status === 'in_progress') {
          this.options.store.updateTask(teamName, taskId, {
            status: 'pending',
            result: `Stopped run ${runId}; task requeued.`,
          });
        }
      }
    }
    return run;
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      const bot = this.selectExecutionBot();
      if (!bot) return;
      for (const team of this.options.store.listTeams()) {
        if (team.status !== 'active') continue;
        this.markOpenWorkForIdleDigest(team.name);
        if (!this.hasActiveLeadAgent(team.name)) {
          this.drainLeaderActivityInbox(team.name);
        }
        const agents = this.options.store.listAgents(team.name).filter((agent) => agent.status !== 'stopped');
        for (const agent of agents) {
          const runnables = this.findRunnableAgents(team.name, agent);
          for (const runnable of runnables) {
            const key = `${team.name}:${agent.name}:${runnable.key}`;
            if (this.inFlight.has(key)) continue;
            this.inFlight.add(key);
            void this.runAgent(bot, team.name, runnable).finally(() => {
              this.inFlight.delete(key);
              this.maybeEmitIdleDigest(team.name);
            });
          }
        }
        this.maybeEmitIdleDigest(team.name);
      }
    } finally {
      this.tickInProgress = false;
    }
  }

  private selectExecutionBot(): RegisteredBot | undefined {
    return this.options.registry.get('luckagent') ?? this.options.registry.listRegistered()[0];
  }

  private recoverStaleRunningRuns(): void {
    for (const team of this.options.store.listTeams()) {
      for (const run of this.options.store.listRuns(team.name)) {
        if (run.status !== 'running') continue;
        const message = 'Bridge restarted before this Agent Team run completed; marking stale run failed and requeueing assigned task.';
        this.options.store.updateRun(team.name, run.id, {
          status: 'failed',
          error: message,
        });
        if (run.taskId != null) {
          const task = this.options.store.getTask(team.name, run.taskId);
          if (task?.status === 'in_progress') {
            this.options.store.updateTask(team.name, run.taskId, {
              status: 'pending',
              result: `${message} Run: ${run.id}`,
            });
          }
        }
        if (run.agentName) {
          this.options.store.setAgentStatus(team.name, run.agentName, 'idle');
          if (run.agentName !== 'lead') {
            this.options.store.sendMessage(team.name, {
              fromName: run.agentName,
              toName: 'lead',
              summary: `Recovered stale run ${run.id}`,
              body: `Agent ${run.agentName} had stale running run ${run.id} after bridge restart. The run was marked failed and its assigned task was requeued if it was still in progress.`,
            });
            this.notifyTeamActivity(team.name, run.agentName, `Recovered stale run ${run.id}; assigned task was requeued if it was still in progress.`);
          }
        }
      }
    }
  }

  private findRunnableAgents(teamName: string, agent: TeamAgent): RunnableAgent[] {
    const runningCount = this.options.store.listRuns(teamName)
      .filter((run) => run.agentName === agent.name && run.status === 'running')
      .length;
    const capacity = this.maxParallelPerAgent - runningCount;
    if (capacity <= 0) return [];

    const messages = this.options.store.listMessages(teamName, agent.name, true);
    const tasks = this.options.store.listTasks(teamName)
      .filter((task) => task.owner === agent.name && task.status === 'pending' && task.blockedBy.length === 0);
    if (messages.length === 0 && tasks.length === 0) return [];

    const runnables: RunnableAgent[] = [];
    const usedMessageIds = new Set<number>();
    for (const task of tasks.slice(0, capacity)) {
      const taskMessages = messages.filter((message) => messageReferencesTask(message, task.id));
      for (const message of taskMessages) usedMessageIds.add(message.id);
      runnables.push({
        agent,
        messages: taskMessages,
        tasks: [task],
        key: `task:${task.id}`,
        isolatedSession: false,
      });
    }

    const unmatchedMessages = messages.filter((message) => !usedMessageIds.has(message.id));
    if (unmatchedMessages.length > 0 && runnables.length < capacity) {
      runnables.push({
        agent,
        messages: unmatchedMessages,
        tasks: [],
        key: 'messages',
        isolatedSession: false,
      });
    }

    const shouldIsolateSessions = runningCount > 0 || runnables.length > 1;
    return runnables.map((runnable) => ({
      ...runnable,
      isolatedSession: shouldIsolateSessions,
    }));
  }

  private async runAgent(bot: RegisteredBot, teamName: string, runnable: RunnableAgent): Promise<void> {
    const { agent, messages, tasks, isolatedSession } = runnable;
    const run = this.options.store.createRun(teamName, {
      agentName: agent.name,
      taskId: tasks[0]?.id,
    });
    const chatId = isolatedSession
      ? `team:${teamName}:${agent.name}:${run.id}`
      : `team:${teamName}:${agent.name}`;
    this.inFlightRuns.set(run.id, {
      teamName,
      agentName: agent.name,
      chatId,
      bridge: bot.bridge,
      taskIds: tasks.map((task) => task.id),
    });
    this.options.store.setAgentStatus(teamName, agent.name, 'working');
    for (const task of tasks) {
      this.options.store.updateTask(teamName, task.id, { status: 'in_progress' });
    }
    if (messages.length > 0) {
      this.options.store.markMessagesReadById(teamName, agent.name, messages.map((message) => message.id));
    }
    const leadMessageIdsBeforeRun = new Set(
      agent.name === 'lead'
        ? []
        : this.options.store.listMessages(teamName, 'lead').map((message) => message.id),
    );

    try {
      this.applyAgentSession(bot.bridge, chatId, agent, !isolatedSession);
      const result = await bot.bridge.executeApiTask({
        chatId,
        userId: 'agent-team-supervisor',
        sendCards: false,
        prompt: this.buildPrompt(teamName, agent, messages, tasks),
        onUpdate: (state) => {
          const current = this.options.store.getRun(teamName, run.id);
          if (!current || current.status !== 'running') return;
          const output = state.responseText?.trim();
          if (output) {
            this.options.store.appendRunOutput(teamName, run.id, output);
          } else {
            this.options.store.updateRun(teamName, run.id, {});
          }
        },
      });
      const currentRun = this.options.store.getRun(teamName, run.id);
      if (currentRun?.status === 'stopped') {
        this.requeueInProgressTasks(teamName, tasks, `Stopped run ${run.id}; task requeued.`);
        return;
      }
      if (result.sessionId && !isolatedSession) {
        this.options.store.setAgentSessionId(teamName, agent.name, result.sessionId, agent.engine);
      }
      this.options.store.updateRun(teamName, run.id, {
        status: result.success ? 'completed' : 'failed',
        output: result.responseText,
        error: result.error,
      });
      const memberLeadMessage = agent.name === 'lead'
        ? undefined
        : this.findLatestMemberLeadMessage(teamName, agent.name, leadMessageIdsBeforeRun);
      if (memberLeadMessage && !this.hasActiveLeadAgent(teamName)) {
        this.options.store.markMessagesRead(teamName, 'lead');
        this.notifyTeamActivity(teamName, 'lead', truncateActivity(memberLeadMessage.body));
      } else if (agent.name !== 'lead' || messages.length > 0) {
        this.notifyTeamActivity(
          teamName,
          agent.name,
          result.success
            ? truncateActivity(result.responseText)
            : `Run ${run.id} failed${result.error ? `: ${result.error}` : ''}.\n\n${truncateActivity(result.responseText)}`,
        );
      }
      if (result.success) {
        for (const task of tasks) {
          const latest = this.options.store.getTask(teamName, task.id);
          if (latest?.status === 'in_progress') {
            this.options.store.updateTask(teamName, task.id, {
              status: 'completed',
              result: result.responseText,
            });
          }
        }
      } else {
        this.requeueInProgressTasks(teamName, tasks, `Run ${run.id} failed${result.error ? `: ${result.error}` : ''}`);
      }
      if (agent.name !== 'lead' && !memberLeadMessage) {
        this.options.store.sendMessage(teamName, {
          fromName: agent.name,
          toName: 'lead',
          summary: result.success ? `Completed run ${run.id}` : `Run ${run.id} failed`,
          body: [
            `Agent ${agent.name} finished run ${run.id}.`,
            result.success ? 'Status: completed' : `Status: failed${result.error ? ` (${result.error})` : ''}`,
            result.responseText ? `\nReport:\n${result.responseText}` : '',
          ].filter(Boolean).join('\n'),
        });
      }
    } catch (err: any) {
      const currentRun = this.options.store.getRun(teamName, run.id);
      if (currentRun?.status === 'stopped') {
        this.requeueInProgressTasks(teamName, tasks, `Stopped run ${run.id}; task requeued.`);
        return;
      }
      this.options.store.updateRun(teamName, run.id, {
        status: 'failed',
        error: err?.message || String(err),
      });
      this.requeueInProgressTasks(teamName, tasks, `Run ${run.id} crashed: ${err?.message || String(err)}`);
      this.notifyTeamActivity(teamName, agent.name, `Run ${run.id} crashed: ${err?.message || String(err)}`);
      if (agent.name !== 'lead') {
        this.options.store.sendMessage(teamName, {
          fromName: agent.name,
          toName: 'lead',
          summary: `Run ${run.id} crashed`,
          body: `Agent ${agent.name} crashed in run ${run.id}: ${err?.message || String(err)}`,
        });
      }
      this.logger.error({ err, teamName, agentName: agent.name, runId: run.id }, 'Agent team member run failed');
    } finally {
      this.setAgentIdleIfNoRunningRuns(teamName, agent.name);
      this.inFlightRuns.delete(run.id);
      this.maybeEmitIdleDigest(teamName);
    }
  }

  private applyAgentSession(bridge: MessageBridge, chatId: string, agent: TeamAgent, reuseSession: boolean): void {
    const sessionManager = bridge.getSessionManager();
    if (agent.engine) sessionManager.setSessionEngine(chatId, agent.engine);
    if (reuseSession && agent.sessionId) sessionManager.setSessionId(chatId, agent.sessionId, agent.engine);
  }

  private setAgentIdleIfNoRunningRuns(teamName: string, agentName: string): void {
    const agent = this.options.store.getAgent(teamName, agentName);
    if (!agent || agent.status === 'stopped') return;
    if (this.options.store.getRunningRun(teamName, agentName)) return;
    this.options.store.setAgentStatus(teamName, agentName, 'idle');
  }

  private requeueInProgressTasks(teamName: string, tasks: TeamTask[], result: string): void {
    for (const task of tasks) {
      const latest = this.options.store.getTask(teamName, task.id);
      if (latest?.status === 'in_progress') {
        this.options.store.updateTask(teamName, task.id, {
          status: 'pending',
          result,
        });
      }
    }
  }

  private findLatestMemberLeadMessage(teamName: string, agentName: string, idsBeforeRun: Set<number>): TeamMessage | undefined {
    return this.options.store.listMessages(teamName, 'lead')
      .filter((message) => message.fromName === agentName && !idsBeforeRun.has(message.id))
      .at(-1);
  }

  private hasActiveLeadAgent(teamName: string): boolean {
    const lead = this.options.store.getAgent(teamName, 'lead');
    return !!lead && lead.status !== 'stopped';
  }

  private drainLeaderActivityInbox(teamName: string): void {
    const messages = this.options.store.listMessages(teamName, 'lead', true);
    if (messages.length === 0) return;
    const latest = messages.at(-1);
    if (!latest) return;
    this.options.store.markMessagesRead(teamName, 'lead');
    this.notifyTeamActivity(teamName, 'lead', truncateActivity(latest.body));
  }

  private markOpenWorkForIdleDigest(teamName: string): void {
    if (this.hasOpenWork(teamName)) {
      this.teamsAwaitingIdleDigest.add(teamName);
    }
  }

  private maybeEmitIdleDigest(teamName: string): void {
    if (!this.teamsAwaitingIdleDigest.has(teamName)) return;
    const team = this.options.store.getTeam(teamName);
    if (!team || team.status !== 'active') {
      this.teamsAwaitingIdleDigest.delete(teamName);
      return;
    }
    if (this.hasOpenWork(teamName)) return;
    this.teamsAwaitingIdleDigest.delete(teamName);
    this.notifyTeamActivity(teamName, 'idle digest', this.buildIdleDigest(teamName));
  }

  private hasOpenWork(teamName: string): boolean {
    const hasWorkingAgent = this.options.store.listAgents(teamName)
      .some((agent) => agent.status === 'working');
    if (hasWorkingAgent) return true;
    const hasOpenTask = this.options.store.listTasks(teamName)
      .some((task) => task.status === 'pending' || task.status === 'in_progress');
    if (hasOpenTask) return true;
    const hasRunningRun = this.options.store.listRuns(teamName)
      .some((run) => run.status === 'running');
    if (hasRunningRun) return true;
    const hasInFlightRun = [...this.inFlightRuns.values()]
      .some((run) => run.teamName === teamName);
    if (hasInFlightRun) return true;
    return this.options.store.listMessages(teamName, 'lead', true).length > 0;
  }

  private buildIdleDigest(teamName: string): string {
    const agents = this.options.store.listAgents(teamName).filter((agent) => agent.status !== 'stopped');
    const completedTasks = this.options.store.listTasks(teamName).filter((task) => task.status === 'completed');
    const recentRuns = this.options.store.listRuns(teamName).slice(0, 3);
    const runSummary = recentRuns.length
      ? recentRuns.map((run) => `${run.agentName ?? 'agent'} ${run.status}`).join(', ')
      : 'no recent runs';
    return [
      'Team is idle.',
      `Members idle: ${agents.length}. Open tasks: 0. Running runs: 0. Unread lead messages: 0.`,
      `Completed tasks: ${completedTasks.length}. Recent runs: ${runSummary}.`,
    ].join('\n');
  }

  private notifyTeamActivity(teamName: string, agentName: string, body: string): void {
    const team = this.options.store.getTeam(teamName);
    if (!team || team.status !== 'active') return;
    const chatIds = team.displayChatIds;
    if (chatIds.length === 0) return;
    const bot = this.selectExecutionBot();
    const bridge = bot?.bridge as MessageBridge & { sendAgentActivityCard?: (chatId: string, body: string) => Promise<void> };
    if (!bridge?.sendAgentActivityCard) return;
    const cardBody = [
      `**${teamName} / ${agentName}**`,
      body,
    ].join('\n\n');
    for (const chatId of chatIds) {
      void Promise.resolve(bridge.sendAgentActivityCard(chatId, cardBody)).catch((err) => {
        this.logger.warn({ err, teamName, agentName, chatId }, 'Agent team activity card failed');
      });
    }
  }

  private buildPrompt(teamName: string, agent: TeamAgent, messages: TeamMessage[], tasks: TeamTask[]): string {
    const role = agent.role ? `Role: ${agent.role}` : 'Role: team member';
    const customPrompt = agent.prompt ? `\nMember instructions:\n${agent.prompt}\n` : '';
    const messageBlock = messages.length
      ? messages.map((message) => `- #${message.id} from ${message.fromName ?? 'system'}: ${message.summary ? `${message.summary}\n  ` : ''}${message.body}`).join('\n')
      : '- none';
    const taskBlock = tasks.length
      ? tasks.map((task) => [
        `- #${task.id} ${task.subject}`,
        task.description ? `  ${task.description}` : undefined,
      ].filter(Boolean).join('\n')).join('\n')
      : '- none';

    if (agent.name === 'lead') {
      return [
        `You are Luckagent Agent Team lead in team "${teamName}".`,
        role,
        customPrompt,
        'You were woken in the background by Agent Team messages between user turns.',
        'Your response will be sent to the user as an Agent Activity card.',
        'Write only the final user-facing answer or concise status the user needs.',
        'Do not include internal bookkeeping such as run ids, touched ids, inbox ids, "blocked", or implementation notes unless the user explicitly needs them.',
        'Do not create new tasks or handoffs unless the incoming message asks for follow-up work.',
        '',
        'Unread team messages:',
        messageBlock,
        '',
        'Assigned pending tasks now moved to in_progress:',
        taskBlock,
      ].join('\n');
    }

    return [
      `You are Luckagent Agent Team member "${agent.name}" in team "${teamName}".`,
      role,
      customPrompt,
      'You run in an independent persistent chat session. Coordinate through the Luckagent teams CLI, not through user chat.',
      '',
      'Unread team messages:',
      messageBlock,
      '',
      'Assigned pending tasks now moved to in_progress:',
      taskBlock,
      '',
      'When useful, update task status/results with `luckagent teams tasks update`, send messages with `luckagent teams send`, and create more tasks for other members.',
      'Finish this turn with a concise report of what you did, what remains blocked, and which team task/message IDs you touched.',
    ].join('\n');
  }
}

function truncateActivity(text: string | undefined, max = 800): string {
  const value = text?.trim();
  if (!value) return '';
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function messageReferencesTask(message: TeamMessage, taskId: number): boolean {
  const text = `${message.summary ?? ''}\n${message.body ?? ''}`;
  return text.includes(`#${taskId}`) || text.includes(`task ${taskId}`) || text.includes(`Task ${taskId}`);
}

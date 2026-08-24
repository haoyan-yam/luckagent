import { parseArgs, print } from '@luckagent/cli-core';

interface BridgeConfig {
  url: string;
  token: string;
}

interface TeamTask {
  id: number;
  subject: string;
  description?: string;
  status: string;
  owner?: string;
  blockedBy?: number[];
  result?: string;
}

interface TeamAgent {
  name: string;
  role?: string;
  engine?: string;
  status?: string;
}

interface TeamMessage {
  id: number;
  fromName?: string;
  toName: string;
  summary?: string;
  body: string;
  readAt?: number;
}

interface TeamRun {
  id: string;
  agentName?: string;
  taskId?: number;
  status: string;
  output?: string;
  error?: string;
}

function loadBridgeConfig(): BridgeConfig {
  const port = process.env.API_PORT || '9100';
  const url = (process.env.LUCKAGENT_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  const token = process.env.API_SECRET || 'changeme';
  return { url, token };
}

async function bridgeRequest<T = unknown>(
  cfg: BridgeConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(cfg.url + path, { method, headers, body: payload });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try { parsed = JSON.parse(text); } catch { /* leave raw */ }
  }
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed && 'error' in parsed
      ? String((parsed as { error: unknown }).error)
      : String(parsed);
    throw new Error(`bridge ${method} ${path} -> ${res.status}: ${msg}`);
  }
  return parsed as T;
}

function usage(): string {
  return `luckagent teams — Luckagent Agent Teams

Subcommands:
  list
  create <team> [--description <text>]
  delete <team>
  status <team> [--summary|--plain]
  bind <team> <chatId> [--display]
  start <team>
  stop <team>
  dispatch <team> <agent> <subject> [--description <text>] [--message <text>] [--from <name>] [--summary|--plain]
  next <team> <agent> [--read] [--summary|--plain]
  watch <team> [--interval <sec>] [--count <n>] [--summary|--plain]

  agents list <team>
  agents spawn <team> <name> [--role <role>] [--engine claude|codex|kimi] [--prompt <text>]
  agents stop <team> <name>
  agents delete <team> <name>

  send <team> <to> <message> [--from <name>] [--summary <text>]
  inbox <team> <name> [--unread] [--read] [--summary|--plain]

  tasks list <team> [--summary|--plain]
  tasks create <team> <subject> [--description <text>] [--owner <name>]
  tasks get <team> <id>
  tasks update <team> <id> [--status pending|in_progress|completed|deleted] [--owner <name>] [--result <text>]
  tasks claim <team> <id> [owner|--owner <name>]
  tasks done <team> <id> <result>
  tasks block <team> <id> <reason> [--blocked-by <id,id>]
  tasks reopen <team> <id>

  runs list <team> [--summary|--plain]
  runs create <team> [--agent <name>] [--task-id <id>] [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
  runs update <team> <runId> [--status running|completed|failed|stopped] [--output <text>] [--error <text>]
  runs output <team> <runId>
  runs stop <team> <runId>
`;
}

export async function run(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    print(usage());
    return;
  }

  const cfg = loadBridgeConfig();
  const rest = argv.slice(1);
  if (cmd === 'list') {
    print(await bridgeRequest(cfg, 'GET', '/api/agent-teams'));
    return;
  }
  if (cmd === 'create') {
    const { positional, flags } = parseArgs(rest);
    const name = positional[0];
    if (!name) throw new Error('luckagent teams create: <team> required');
    print(await bridgeRequest(cfg, 'POST', '/api/agent-teams', {
      name,
      description: typeof flags.description === 'string' ? flags.description : undefined,
    }));
    return;
  }
  if (cmd === 'delete') {
    const team = rest[0];
    if (!team) throw new Error('luckagent teams delete: <team> required');
    print(await bridgeRequest(cfg, 'DELETE', `/api/agent-teams/${encodeURIComponent(team)}`));
    return;
  }
  if (cmd === 'status') {
    const { positional, flags } = parseArgs(rest);
    const team = positional[0];
    if (!team) throw new Error('luckagent teams status: <team> required');
    const status = await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}`);
    print(wantsSummary(flags) ? formatStatus(status) : status);
    return;
  }
  if (cmd === 'bind') {
    const { positional, flags } = parseArgs(rest);
    const [team, chatId] = positional;
    if (!team || !chatId) throw new Error('luckagent teams bind: <team> <chatId> required');
    const current = await bridgeRequest<{ team?: { chatIds?: string[]; displayChatIds?: string[] } }>(
      cfg,
      'GET',
      `/api/agent-teams/${encodeURIComponent(team)}`,
    );
    const existingChatIds = current.team?.chatIds ?? [];
    const existingDisplayChatIds = current.team?.displayChatIds ?? [];
    const key = flags.display === true || flags.display === 'true' ? 'displayChatIds' : 'chatIds';
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}`, {
      chatIds: key === 'chatIds' ? unique([...existingChatIds, chatId]) : existingChatIds,
      displayChatIds: key === 'displayChatIds' ? unique([...existingDisplayChatIds, chatId]) : existingDisplayChatIds,
    }));
    return;
  }
  if (cmd === 'start' || cmd === 'stop') {
    const team = rest[0];
    if (!team) throw new Error(`luckagent teams ${cmd}: <team> required`);
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/${cmd}`));
    return;
  }
  if (cmd === 'dispatch') {
    await runDispatch(cfg, rest);
    return;
  }
  if (cmd === 'next') {
    await runNext(cfg, rest);
    return;
  }
  if (cmd === 'watch') {
    await runWatch(cfg, rest);
    return;
  }
  if (cmd === 'agents') {
    await runAgents(cfg, rest);
    return;
  }
  if (cmd === 'send') {
    await runSend(cfg, rest);
    return;
  }
  if (cmd === 'inbox') {
    await runInbox(cfg, rest);
    return;
  }
  if (cmd === 'tasks') {
    await runTasks(cfg, rest);
    return;
  }
  if (cmd === 'runs') {
    await runRuns(cfg, rest);
    return;
  }
  throw new Error(`luckagent teams: unknown subcommand '${cmd}'`);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function stringFlag(flags: Record<string, string | true>, name: string): string | undefined {
  return typeof flags[name] === 'string' ? flags[name] : undefined;
}

function boolFlag(flags: Record<string, string | true>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true' || flags[name] === '1';
}

function wantsSummary(flags: Record<string, string | true>): boolean {
  return boolFlag(flags, 'summary') || boolFlag(flags, 'plain');
}

function parseNumberList(value: string | undefined): number[] | undefined {
  if (!value) return undefined;
  const nums = value.split(',')
    .map((part) => Number(part.trim()))
    .filter((num) => Number.isInteger(num) && num > 0);
  return nums.length > 0 ? nums : undefined;
}

function defaultAgentName(): string | undefined {
  return process.env.LUCKAGENT_TEAM_AGENT || process.env.LUCKAGENT_AGENT_NAME || undefined;
}

function compact(value: string | undefined, limit = 120): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3))}...`;
}

function taskLine(task: TeamTask): string {
  const owner = task.owner ? ` @${task.owner}` : '';
  const blocked = task.blockedBy && task.blockedBy.length > 0 ? ` blocked_by=${task.blockedBy.join(',')}` : '';
  const result = task.result ? ` - ${compact(task.result, 80)}` : '';
  return `#${task.id} ${task.status}${owner}${blocked} ${task.subject}${result}`;
}

function runLine(run: TeamRun): string {
  const agent = run.agentName ? ` @${run.agentName}` : '';
  const task = run.taskId != null ? ` task=#${run.taskId}` : '';
  const detail = run.error ? ` error=${compact(run.error, 80)}` : (run.output ? ` output=${compact(run.output, 80)}` : '');
  return `${run.id} ${run.status}${agent}${task}${detail}`;
}

function formatTasks(body: unknown): string {
  const tasks = Array.isArray((body as { tasks?: unknown }).tasks)
    ? ((body as { tasks: TeamTask[] }).tasks)
    : [];
  const open = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  const lines = [
    `Tasks: ${tasks.length} total, ${open.length} open`,
    ...tasks.slice(0, 20).map((task) => `- ${taskLine(task)}`),
  ];
  if (tasks.length > 20) lines.push(`... ${tasks.length - 20} more`);
  return lines.join('\n');
}

function formatRuns(body: unknown): string {
  const runs = Array.isArray((body as { runs?: unknown }).runs)
    ? ((body as { runs: TeamRun[] }).runs)
    : [];
  const running = runs.filter((run) => run.status === 'running').length;
  const lines = [
    `Runs: ${runs.length} total, ${running} running`,
    ...runs.slice(0, 12).map((run) => `- ${runLine(run)}`),
  ];
  if (runs.length > 12) lines.push(`... ${runs.length - 12} more`);
  return lines.join('\n');
}

function formatMessages(messages: TeamMessage[]): string[] {
  if (messages.length === 0) return ['- none'];
  return messages.slice(0, 12).map((message) => {
    const from = message.fromName ? ` from ${message.fromName}` : '';
    const summary = message.summary ? `${message.summary}: ` : '';
    return `- #${message.id}${from} ${summary}${compact(message.body, 140)}`;
  });
}

function formatNext(body: unknown): string {
  const value = body as {
    team?: string;
    agent?: string;
    unreadMessages?: TeamMessage[];
    assignedTasks?: TeamTask[];
    read?: number;
  };
  const unread = value.unreadMessages ?? [];
  const tasks = value.assignedTasks ?? [];
  const lines = [
    `Next: ${value.team || '?'} / ${value.agent || '?'}`,
    `Unread: ${unread.length}${value.read ? ` (${value.read} marked read)` : ''}`,
    ...formatMessages(unread),
    `Assigned open tasks: ${tasks.length}`,
    ...(tasks.length ? tasks.slice(0, 12).map((task) => `- ${taskLine(task)}`) : ['- none']),
  ];
  return lines.join('\n');
}

function formatInbox(body: unknown): string {
  const messages = Array.isArray((body as { messages?: unknown }).messages)
    ? ((body as { messages: TeamMessage[] }).messages)
    : [];
  const read = typeof (body as { read?: unknown }).read === 'number' ? `, read ${(body as { read: number }).read}` : '';
  return [`Inbox: ${messages.length} messages${read}`, ...formatMessages(messages)].join('\n');
}

function formatStatus(body: unknown): string {
  const value = body as {
    team?: { name?: string; status?: string; description?: string };
    agents?: TeamAgent[];
    tasks?: TeamTask[];
    unreadMessages?: number;
    runs?: TeamRun[];
  };
  const agents = value.agents ?? [];
  const tasks = value.tasks ?? [];
  const runs = value.runs ?? [];
  const openTasks = tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress');
  const runningRuns = runs.filter((run) => run.status === 'running');
  const lines = [
    `Team: ${value.team?.name || '?'} [${value.team?.status || '?'}]`,
    value.team?.description ? compact(value.team.description, 160) : undefined,
    `Agents: ${agents.length}${agents.length ? ` (${agents.map((agent) => `${agent.name}:${agent.status || 'unknown'}${agent.engine ? `/${agent.engine}` : ''}`).join(', ')})` : ''}`,
    `Tasks: ${tasks.length} total, ${openTasks.length} open`,
    ...openTasks.slice(0, 8).map((task) => `- ${taskLine(task)}`),
    `Unread messages: ${value.unreadMessages ?? 0}`,
    `Runs: ${runs.length} total, ${runningRuns.length} running`,
    ...runs.slice(0, 5).map((run) => `- ${runLine(run)}`),
  ].filter((line): line is string => Boolean(line));
  return lines.join('\n');
}

async function runAgents(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list') {
    const team = rest[0];
    if (!team) throw new Error('luckagent teams agents list: <team> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/agents`));
    return;
  }
  if (sub === 'spawn') {
    const { positional, flags } = parseArgs(rest);
    const [team, name] = positional;
    if (!team || !name) throw new Error('luckagent teams agents spawn: <team> <name> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/agents`, {
      name,
      role: stringFlag(flags, 'role'),
      engine: stringFlag(flags, 'engine') ?? 'codex',
      prompt: stringFlag(flags, 'prompt'),
    }));
    return;
  }
  if (sub === 'stop') {
    const [team, name] = rest;
    if (!team || !name) throw new Error('luckagent teams agents stop: <team> <name> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/agents/${encodeURIComponent(name)}/stop`));
    return;
  }
  if (sub === 'delete' || sub === 'remove') {
    const [team, name] = rest;
    if (!team || !name) throw new Error(`luckagent teams agents ${sub}: <team> <name> required`);
    print(await bridgeRequest(cfg, 'DELETE', `/api/agent-teams/${encodeURIComponent(team)}/agents/${encodeURIComponent(name)}`));
    return;
  }
  throw new Error('luckagent teams agents: expected list|spawn|stop|delete');
}

async function runSend(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, to, ...messageParts] = positional;
  const message = stringFlag(flags, 'message') ?? messageParts.join(' ');
  if (!team || !to || !message) throw new Error('luckagent teams send: <team> <to> <message> required');
  print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/messages`, {
    toName: to,
    body: message,
    fromName: stringFlag(flags, 'from'),
    summary: stringFlag(flags, 'summary'),
  }));
}

async function runDispatch(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, to, ...subjectParts] = positional;
  const subject = subjectParts.join(' ');
  if (!team || !to || !subject) throw new Error('luckagent teams dispatch: <team> <agent> <subject> required');

  const description = stringFlag(flags, 'description');
  const task = await bridgeRequest<TeamTask>(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/tasks`, {
    subject,
    description,
    owner: to,
    blockedBy: parseNumberList(stringFlag(flags, 'blocked-by')),
  });
  const body = stringFlag(flags, 'message') ?? [
    `Start task #${task.id}: ${subject}`,
    description ? `\n${description}` : '',
    '',
    `Expected: claim with \`luckagent teams tasks claim ${team} ${task.id} ${to}\`, then finish with \`luckagent teams tasks done ${team} ${task.id} "<result>"\`.`,
  ].filter(Boolean).join('\n');
  const message = await bridgeRequest<TeamMessage>(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/messages`, {
    toName: to,
    fromName: stringFlag(flags, 'from') ?? 'lead',
    summary: stringFlag(flags, 'summary') ?? `Task #${task.id}: ${subject}`,
    body,
  });
  const result = { task, message };
  print(wantsSummary(flags) ? formatDispatch(result) : result);
}

async function runNext(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, agent] = positional;
  if (!team || !agent) throw new Error('luckagent teams next: <team> <agent> required');

  const unread = await bridgeRequest<{ messages: TeamMessage[] }>(
    cfg,
    'GET',
    `/api/agent-teams/${encodeURIComponent(team)}/messages?to=${encodeURIComponent(agent)}&unread=1`,
  );
  const tasks = await bridgeRequest<{ tasks: TeamTask[] }>(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/tasks`);
  const assignedTasks = (tasks.tasks || []).filter((task) =>
    task.owner === agent && (task.status === 'pending' || task.status === 'in_progress'),
  );
  let read = 0;
  if (boolFlag(flags, 'read') && unread.messages.length > 0) {
    const result = await bridgeRequest<{ read?: number }>(
      cfg,
      'POST',
      `/api/agent-teams/${encodeURIComponent(team)}/messages/read?to=${encodeURIComponent(agent)}`,
      {},
    );
    read = result.read ?? 0;
  }
  const result = { team, agent, unreadMessages: unread.messages, assignedTasks, ...(read ? { read } : {}) };
  print(wantsSummary(flags) ? formatNext(result) : result);
}

async function runInbox(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team, name] = positional;
  if (!team || !name) throw new Error('luckagent teams inbox: <team> <name> required');
  const unread = flags.unread === true || flags.unread === 'true';
  const inbox = await bridgeRequest<Record<string, unknown>>(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/messages?to=${encodeURIComponent(name)}${unread ? '&unread=1' : ''}`);
  if (flags.read === true || flags.read === 'true') {
    const read = await bridgeRequest<{ read?: number }>(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/messages/read?to=${encodeURIComponent(name)}`, {});
    inbox.read = read.read ?? 0;
  }
  print(wantsSummary(flags) ? formatInbox(inbox) : inbox);
}

async function runTasks(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'list') {
    const { positional, flags } = parseArgs(rest);
    const team = positional[0];
    if (!team) throw new Error('luckagent teams tasks list: <team> required');
    const tasks = await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/tasks`);
    print(wantsSummary(flags) ? formatTasks(tasks) : tasks);
    return;
  }
  if (sub === 'create') {
    const { positional, flags } = parseArgs(rest);
    const [team, ...subjectParts] = positional;
    const subject = subjectParts.join(' ');
    if (!team || !subject) throw new Error('luckagent teams tasks create: <team> <subject> required');
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/tasks`, {
      subject,
      description: stringFlag(flags, 'description'),
      owner: stringFlag(flags, 'owner'),
      blockedBy: parseNumberList(stringFlag(flags, 'blocked-by')),
    }));
    return;
  }
  if (sub === 'get') {
    const [team, id] = rest;
    if (!team || !id) throw new Error('luckagent teams tasks get: <team> <id> required');
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`));
    return;
  }
  if (sub === 'update') {
    const { positional, flags } = parseArgs(rest);
    const [team, id] = positional;
    if (!team || !id) throw new Error('luckagent teams tasks update: <team> <id> required');
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      subject: stringFlag(flags, 'subject'),
      description: stringFlag(flags, 'description'),
      status: stringFlag(flags, 'status'),
      owner: flags.owner === 'none' ? null : stringFlag(flags, 'owner'),
      blockedBy: parseNumberList(stringFlag(flags, 'blocked-by')),
      result: stringFlag(flags, 'result'),
    }));
    return;
  }
  if (sub === 'claim') {
    const { positional, flags } = parseArgs(rest);
    const [team, id, ownerArg] = positional;
    const owner = stringFlag(flags, 'owner') ?? ownerArg ?? defaultAgentName();
    if (!team || !id || !owner) throw new Error('luckagent teams tasks claim: <team> <id> [owner|--owner <name>] required');
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      status: 'in_progress',
      owner,
    }));
    return;
  }
  if (sub === 'done' || sub === 'complete') {
    const { positional, flags } = parseArgs(rest);
    const [team, id, ...resultParts] = positional;
    const result = stringFlag(flags, 'result') ?? resultParts.join(' ');
    if (!team || !id || !result) throw new Error(`luckagent teams tasks ${sub}: <team> <id> <result> required`);
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      status: 'completed',
      result,
    }));
    return;
  }
  if (sub === 'block') {
    const { positional, flags } = parseArgs(rest);
    const [team, id, ...reasonParts] = positional;
    const reason = stringFlag(flags, 'result') ?? reasonParts.join(' ');
    if (!team || !id || !reason) throw new Error('luckagent teams tasks block: <team> <id> <reason> required');
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      status: 'pending',
      blockedBy: parseNumberList(stringFlag(flags, 'blocked-by')),
      result: `Blocked: ${reason}`,
    }));
    return;
  }
  if (sub === 'reopen') {
    const [team, id] = rest;
    if (!team || !id) throw new Error('luckagent teams tasks reopen: <team> <id> required');
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/tasks/${encodeURIComponent(id)}`, {
      status: 'pending',
    }));
    return;
  }
  throw new Error('luckagent teams tasks: expected list|create|get|update|claim|done|block|reopen');
}

async function runRuns(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { positional, flags } = parseArgs(rest);
  const [team, id] = positional;
  if (!team) throw new Error('luckagent teams runs: <team> required');
  if (sub === 'list') {
    const runs = await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/runs`);
    print(wantsSummary(flags) ? formatRuns(runs) : runs);
    return;
  }
  if (sub === 'create') {
    const taskId = typeof flags['task-id'] === 'string' ? Number(flags['task-id']) : undefined;
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/runs`, {
      agentName: stringFlag(flags, 'agent'),
      taskId: Number.isFinite(taskId) ? taskId : undefined,
      status: stringFlag(flags, 'status'),
      output: stringFlag(flags, 'output'),
      error: stringFlag(flags, 'error'),
    }));
    return;
  }
  if (!id) throw new Error(`luckagent teams runs ${sub}: <team> <runId> required`);
  if (sub === 'update') {
    print(await bridgeRequest(cfg, 'PATCH', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}`, {
      status: stringFlag(flags, 'status'),
      output: stringFlag(flags, 'output'),
      error: stringFlag(flags, 'error'),
    }));
    return;
  }
  if (sub === 'output') {
    print(await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}/output`));
    return;
  }
  if (sub === 'stop') {
    print(await bridgeRequest(cfg, 'POST', `/api/agent-teams/${encodeURIComponent(team)}/runs/${encodeURIComponent(id)}/stop`));
    return;
  }
  throw new Error('luckagent teams runs: expected list|create|update|output|stop');
}

async function runWatch(cfg: BridgeConfig, argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const [team] = positional;
  if (!team) throw new Error('luckagent teams watch: <team> required');
  const intervalSec = Math.max(1, Number(stringFlag(flags, 'interval') ?? '5'));
  const count = Math.max(1, Number(stringFlag(flags, 'count') ?? '1'));
  for (let i = 0; i < count; i++) {
    const status = await bridgeRequest(cfg, 'GET', `/api/agent-teams/${encodeURIComponent(team)}`);
    print(wantsSummary(flags) ? formatStatus(status) : status);
    if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
  }
}

function formatDispatch(body: { task: TeamTask; message: TeamMessage }): string {
  return [
    `Dispatched task #${body.task.id} to ${body.task.owner || body.message.toName}: ${body.task.subject}`,
    `Message #${body.message.id} sent to ${body.message.toName}`,
  ].join('\n');
}

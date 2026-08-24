import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.API_PORT = '9100';
  process.env.API_SECRET = 'test-secret';
  delete process.env.LUCKAGENT_URL;
  delete process.env.LUCKAGENT_TEAM_AGENT;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/teams.js')> {
  vi.resetModules();
  return await import('../src/teams.js');
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function calls(fetchMock: typeof fetch): [string, RequestInit][] {
  return (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
}

describe('luckagent teams CLI ergonomics', () => {
  it('agents spawn defaults new teammates to Codex', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ name: 'worker', engine: 'codex' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['agents', 'spawn', 'demo', 'worker', '--role', 'runtime']);

    const [url, init] = calls(fetchMock)[0]!;
    expect(url).toBe('http://localhost:9100/api/agent-teams/demo/agents');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: 'worker',
      role: 'runtime',
      engine: 'codex',
    });
  });

  it('dispatch creates an assigned task and sends a start message', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/tasks')) return jsonResponse({ id: 42, subject: 'Fix bus', owner: 'bridge-runtime', status: 'pending' }, 201);
      if (url.endsWith('/messages')) return jsonResponse({ id: 9, toName: 'bridge-runtime', body: 'Start task #42' }, 201);
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run([
      'dispatch',
      'luckagent-core-chat',
      'bridge-runtime',
      'Fix bus',
      '--description',
      'Use relay.',
    ]);

    expect(calls(fetchMock)).toHaveLength(2);
    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/luckagent-core-chat/tasks');
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      subject: 'Fix bus',
      description: 'Use relay.',
      owner: 'bridge-runtime',
    });
    expect(calls(fetchMock)[1]![0]).toBe('http://localhost:9100/api/agent-teams/luckagent-core-chat/messages');
    const messageBody = JSON.parse(String(calls(fetchMock)[1]![1].body));
    expect(messageBody).toMatchObject({
      toName: 'bridge-runtime',
      fromName: 'lead',
      summary: 'Task #42: Fix bus',
    });
    expect(messageBody.body).toContain('Start task #42');
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('"task"');
  });

  it('dispatch can print a concise plain summary', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/tasks')) return jsonResponse({ id: 42, subject: 'Fix bus', owner: 'bridge-runtime', status: 'pending' }, 201);
      if (url.endsWith('/messages')) return jsonResponse({ id: 9, toName: 'bridge-runtime', body: 'Start task #42' }, 201);
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['dispatch', 'luckagent-core-chat', 'bridge-runtime', 'Fix bus', '--plain']);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('Dispatched task #42 to bridge-runtime: Fix bus');
    expect(printed).toContain('Message #9 sent to bridge-runtime');
    expect(printed).not.toContain('"task"');
  });

  it('next returns unread messages and open assigned tasks, then marks read with --read', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/messages?')) return jsonResponse({ messages: [{ id: 1, toName: 'worker', body: 'ping' }] });
      if (url.endsWith('/tasks')) {
        return jsonResponse({
          tasks: [
            { id: 2, owner: 'worker', status: 'pending', subject: 'owned' },
            { id: 3, owner: 'other', status: 'pending', subject: 'other' },
            { id: 4, owner: 'worker', status: 'completed', subject: 'done' },
          ],
        });
      }
      if (url.includes('/messages/read')) return jsonResponse({ read: 1 });
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['next', 'demo', 'worker', '--read']);

    expect(calls(fetchMock).map(([url]) => url)).toEqual([
      'http://localhost:9100/api/agent-teams/demo/messages?to=worker&unread=1',
      'http://localhost:9100/api/agent-teams/demo/tasks',
      'http://localhost:9100/api/agent-teams/demo/messages/read?to=worker',
    ]);
    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain('"unreadMessages"');
    expect(printed).toContain('"assignedTasks"');
    expect(printed).toContain('"id": 2');
    expect(printed).not.toContain('"id": 3');
  });

  it('status, tasks list, runs list, and inbox support concise summaries', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'http://localhost:9100/api/agent-teams/demo') {
        return jsonResponse({
          team: { name: 'demo', status: 'active', description: 'Demo team' },
          agents: [{ name: 'worker', status: 'idle', engine: 'codex' }],
          tasks: [{ id: 1, owner: 'worker', status: 'pending', subject: 'Ship CLI' }],
          unreadMessages: 2,
          runs: [{ id: 'run-1', agentName: 'worker', status: 'completed', output: 'done' }],
        });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/tasks') {
        return jsonResponse({ tasks: [{ id: 1, owner: 'worker', status: 'pending', subject: 'Ship CLI' }] });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/runs') {
        return jsonResponse({ runs: [{ id: 'run-1', agentName: 'worker', status: 'completed', output: 'done' }] });
      }
      if (url === 'http://localhost:9100/api/agent-teams/demo/messages?to=worker&unread=1') {
        return jsonResponse({ messages: [{ id: 3, fromName: 'lead', toName: 'worker', body: 'please start' }] });
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['status', 'demo', '--summary']);
    await mod.run(['tasks', 'list', 'demo', '--summary']);
    await mod.run(['runs', 'list', 'demo', '--summary']);
    await mod.run(['inbox', 'demo', 'worker', '--unread', '--summary']);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('\n');
    expect(printed).toContain('Team: demo [active]');
    expect(printed).toContain('Tasks: 1 total, 1 open');
    expect(printed).toContain('Runs: 1 total, 0 running');
    expect(printed).toContain('Inbox: 1 messages');
    expect(printed).toContain('#3 from lead please start');
  });

  it('tasks claim uses LUCKAGENT_TEAM_AGENT when owner is omitted', async () => {
    process.env.LUCKAGENT_TEAM_AGENT = 'worker';
    const fetchMock = vi.fn(async () => jsonResponse({ id: 5, owner: 'worker', status: 'in_progress' })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['tasks', 'claim', 'demo', '5']);

    expect(calls(fetchMock)[0]![0]).toBe('http://localhost:9100/api/agent-teams/demo/tasks/5');
    expect(calls(fetchMock)[0]![1].method).toBe('PATCH');
    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      status: 'in_progress',
      owner: 'worker',
    });
  });

  it('tasks done, block, and reopen map to concise task updates', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['tasks', 'done', 'demo', '7', 'implemented']);
    await mod.run(['tasks', 'block', 'demo', '8', 'waiting', 'for', 'token', '--blocked-by', '7,9']);
    await mod.run(['tasks', 'reopen', 'demo', '9']);

    expect(JSON.parse(String(calls(fetchMock)[0]![1].body))).toEqual({
      status: 'completed',
      result: 'implemented',
    });
    expect(JSON.parse(String(calls(fetchMock)[1]![1].body))).toEqual({
      status: 'pending',
      blockedBy: [7, 9],
      result: 'Blocked: waiting for token',
    });
    expect(JSON.parse(String(calls(fetchMock)[2]![1].body))).toEqual({
      status: 'pending',
    });
  });
});

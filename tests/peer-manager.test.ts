import { describe, it, expect, afterEach, vi } from 'vitest';
import { PeerManager, pickPrivateIPv4 } from '../src/api/peer-manager.js';
import type * as os from 'node:os';

type IfaceDict = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function ipv4(address: string): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/24`,
  };
}

function loopback(): os.NetworkInterfaceInfo {
  return {
    address: '127.0.0.1',
    netmask: '255.0.0.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal: true,
    cidr: '127.0.0.1/8',
  };
}

function ipv6(address: string): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6',
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

function createLogger() {
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  logger.child.mockReturnValue(logger);
  return logger;
}

const REGISTRY_ENV_KEYS = [
  'LUCKAGENT_CORE_AGENT_BUS_URL',
  'LUCKAGENT_CORE_URL',
  'LUCKAGENT_CORE_TOKEN',
  'LUCKAGENT_AGENT_SELF_URL',
  'LUCKAGENT_AGENT_RELAY',
  'API_PORT',
] as const;

function clearRegistryEnv() {
  for (const k of REGISTRY_ENV_KEYS) delete process.env[k];
}

describe('PeerManager', () => {
  let manager: PeerManager;

  afterEach(() => {
    if (manager) manager.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clearRegistryEnv();
  });

  it('initializes with empty peer bots', () => {
    manager = new PeerManager([], [], createLogger());
    expect(manager.getPeerBots()).toEqual([]);
    expect(manager.getPeerStatuses()).toEqual([]);
  });

  it('refreshPeer caches bots from a healthy peer', async () => {
    const mockBots = {
      bots: [
        { name: 'bot-a', platform: 'feishu', workingDirectory: '/work/a' },
        { name: 'bot-b', description: 'B bot', platform: 'telegram', workingDirectory: '/work/b' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], [], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(2);
    expect(bots[0].name).toBe('bot-a');
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
    expect(bots[0].peerName).toBe('alice');
    expect(bots[1].name).toBe('bot-b');
    expect(bots[1].description).toBe('B bot');

    const statuses = manager.getPeerStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].healthy).toBe(true);
    expect(statuses[0].botCount).toBe(2);
  });

  it('marks peer as unhealthy when unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    manager = new PeerManager([
      { name: 'bob', url: 'http://unreachable:9999' },
    ], [], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toBe('ECONNREFUSED');
  });

  it('marks peer as unhealthy on non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    }));

    manager = new PeerManager([
      { name: 'locked', url: 'http://locked:9100' },
    ], [], createLogger());

    await manager.refreshAll();

    expect(manager.getPeerBots()).toEqual([]);
    const statuses = manager.getPeerStatuses();
    expect(statuses[0].healthy).toBe(false);
    expect(statuses[0].error).toContain('401');
  });

  it('filters out transitive bots (bots with peerUrl)', async () => {
    const mockBots = {
      bots: [
        { name: 'local-bot', platform: 'feishu', workingDirectory: '/work' },
        { name: 'transitive-bot', platform: 'feishu', workingDirectory: '/other', peerUrl: 'http://third:9300' },
      ],
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockBots),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], [], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots).toHaveLength(1);
    expect(bots[0].name).toBe('local-bot');
  });

  it('findBotPeer returns correct peer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        bots: [{ name: 'backend-bot', platform: 'feishu', workingDirectory: '/work' }],
      }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
    ], [], createLogger());

    await manager.refreshAll();

    const result = manager.findBotPeer('backend-bot');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('alice');
    expect(result!.bot.name).toBe('backend-bot');
  });

  it('findBotPeer returns undefined for unknown bot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    }));

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
    ], [], createLogger());

    await manager.refreshAll();
    expect(manager.findBotPeer('nonexistent')).toBeUndefined();
  });

  it('findBotOnPeer returns bot from specific peer', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('9200/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-a', platform: 'feishu', workingDirectory: '/a' }] }) });
      }
      if (url.includes('9300/api/bots')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ bots: [{ name: 'bot-b', platform: 'telegram', workingDirectory: '/b' }] }) });
      }
      // skills endpoints
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
    });

    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200' },
      { name: 'bob', url: 'http://localhost:9300' },
    ], [], createLogger());

    await manager.refreshAll();

    const result = manager.findBotOnPeer('bob', 'bot-b');
    expect(result).toBeDefined();
    expect(result!.peer.name).toBe('bob');

    // Should not find alice's bot on bob
    expect(manager.findBotOnPeer('bob', 'bot-a')).toBeUndefined();
  });

  it('forwardTask sends POST with X-Luckagent-Origin header', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, responseText: 'done' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
    ], [], createLogger());

    const result = await manager.forwardTask(
      { name: 'alice', url: 'http://localhost:9200', secret: 'sec' },
      { botName: 'bot-a', chatId: 'chat1', prompt: 'hello' },
    );

    expect(result).toEqual({ success: true, responseText: 'done' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/talk',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Luckagent-Origin': 'peer',
          'Authorization': 'Bearer sec',
        }),
      }),
    );
  });

  it('sends auth header when peer has secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'secure-peer', url: 'http://remote:9100', secret: 'my-secret' },
    ], [], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://remote:9100/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Authorization': 'Bearer my-secret', 'X-Luckagent-Origin': 'peer' }),
      }),
    );
  });

  it('does not send auth header when peer has no secret', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    manager = new PeerManager([
      { name: 'local-peer', url: 'http://localhost:9200' },
    ], [], createLogger());

    await manager.refreshAll();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9200/api/bots',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Luckagent-Origin': 'peer' }),
      }),
    );
  });

  it('normalizes trailing slashes in URLs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ bots: [{ name: 'b', platform: 'feishu', workingDirectory: '/' }] }),
    }));

    manager = new PeerManager([
      { name: 'trailing', url: 'http://localhost:9200///' },
    ], [], createLogger());

    await manager.refreshAll();

    const bots = manager.getPeerBots();
    expect(bots[0].peerUrl).toBe('http://localhost:9200');
  });

  // ---------------------------------------------------------------------------
  // Registry mode (LUCKAGENT_CORE_AGENT_BUS_URL set) — discovery via central
  // /api/agents endpoint + visibility-is-the-permission (no talkSecret).
  // ---------------------------------------------------------------------------

  describe('registry mode (LUCKAGENT_CORE_AGENT_BUS_URL)', () => {
    it('bulk-registers all local bots with this bridge self URL', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://self.example:9100';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 2,
          results: [
            { botName: 'visible-bot', status: 201 },
            { botName: 'hidden-bot', status: 201 },
          ],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager(
        [],
        [
          { name: 'visible-bot' },                  // visible undefined → defaults true
          { name: 'hidden-bot', visible: false },
        ],
        createLogger(),
      );

      // Let the unawaited bulkRegisterWithRetry() microtask run.
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall, 'expected POST /api/agents/bulk from bulk-register').toBeDefined();
      const [bulkUrl, bulkInit] = bulkCall!;
      expect(bulkUrl).toBe('https://luckagent.example.com/core/api/agents/bulk');
      expect((bulkInit as RequestInit).headers).toMatchObject({
        'Authorization': 'Bearer core-bearer',
        'Content-Type': 'application/json',
      });
      const body = JSON.parse((bulkInit as RequestInit).body as string);
      expect(body).toEqual({
        bots: [
          { botName: 'visible-bot', url: 'http://self.example:9100', visible: true },
          { botName: 'hidden-bot', url: 'http://self.example:9100', visible: false },
        ],
      });
      // No legacy talkSecret field anywhere in the wire payload.
      expect((bulkInit as RequestInit).body as string).not.toMatch(/talkSecret/);
    });

    it('emits batch POST /api/agents/heartbeat with registered bot names', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://self.example:9100';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'self-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager(
        [],
        [{ name: 'self-bot' }],
        createLogger(),
      );

      // Drain the unawaited bulk-register promise chain so registeredBotNames
      // is populated before we trigger the heartbeat.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      fetchMock.mockClear();

      // Trigger the heartbeat directly (avoids fake-timer interaction with
      // AbortSignal.timeout in the bulk-register fetch).
      await (manager as any).sendHeartbeat();

      const heartbeatCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/heartbeat'),
      );
      expect(heartbeatCall, 'expected POST /api/agents/heartbeat').toBeDefined();
      const [, hbInit] = heartbeatCall!;
      expect((hbInit as RequestInit).method).toBe('POST');
      expect((hbInit as RequestInit).headers).toMatchObject({
        'Authorization': 'Bearer core-bearer',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse((hbInit as RequestInit).body as string)).toEqual({
        botNames: ['self-bot'],
      });
    });

    it('drives peer list from GET /api/agents as core relay peers', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://self.example:9100';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://luckagent.example.com/core/api/agents') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              agents: [
                { botName: 'self-bot', url: 'http://self.example:9100', visible: true, lastSeenAt: 'now' },
                { botName: 'alice', url: 'http://alice:9100', visible: true, lastSeenAt: 'now' },
              ],
            }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [], createLogger());

      // Drive one poll tick manually (the timer interval is 30s; we trigger
      // the same code path directly via the private method).
      await (manager as any).runPollTick();

      const peers = manager.getPeerStatuses();
      expect(peers.map((p) => p.name).sort()).toEqual(['alice']);
      const alicePeer = peers.find((p) => p.name === 'alice');
      expect(alicePeer!.url).toBe('http://alice:9100');
      expect(alicePeer!.healthy).toBe(true);

      const bots = manager.getPeerBots();
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe('alice');
      expect(bots[0].peerName).toBe('alice');
      expect(fetchMock).not.toHaveBeenCalledWith(
        'http://alice:9100/api/bots',
        expect.anything(),
      );
      expect(peers.some((p) => p.name === 'self-bot')).toBe(false);
    });

    it('cross-bridge registry calls enqueue through core inbox instead of direct peer HTTP', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://luckagent.example.com/core/api/agents') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              agents: [{ botName: 'alice', url: 'http://alice:9100', visible: true }],
            }),
          });
        }
        if (url === 'https://luckagent.example.com/core/api/inbox/alice') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ message: { id: 'msg_1' } }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [], createLogger());

      await (manager as any).runPollTick();
      const result = await manager.forwardTask(
        { name: 'alice', url: 'http://alice:9100' },
        { botName: 'alice', chatId: 'chat1', prompt: 'hello' },
      );

      expect(result).toMatchObject({ accepted: true, relay: 'inbox' });
      const relayCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0] === 'https://luckagent.example.com/core/api/inbox/alice',
      );
      expect(relayCall, 'expected cross-bridge core inbox enqueue').toBeDefined();
      const [, relayInit] = relayCall!;
      expect((relayInit as RequestInit).headers).toMatchObject({
        'Authorization': 'Bearer core-bearer',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse((relayInit as RequestInit).body as string)).toEqual({
        chatId: 'chat1',
        content: JSON.stringify({
          type: 'talk',
          botName: 'alice',
          chatId: 'chat1',
          prompt: 'hello',
        }),
      });
      expect(fetchMock).not.toHaveBeenCalledWith('http://alice:9100/api/talk', expect.anything());
    });

    it('keeps same-host registry peers on direct local HTTP instead of core relay', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://10.0.0.5:9100';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://luckagent.example.com/core/api/agents') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              agents: [
                { botName: 'same-host', url: 'http://10.0.0.5:9200', visible: true },
              ],
            }),
          });
        }
        if (url === 'http://10.0.0.5:9200/api/bots') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              bots: [{ name: 'local-worker', platform: 'feishu', workingDirectory: '/work/local' }],
            }),
          });
        }
        if (url === 'http://10.0.0.5:9200/api/skills') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
        }
        if (url === 'http://10.0.0.5:9200/api/talk') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true, responseText: 'local done' }),
          });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [], createLogger());

      await (manager as any).runPollTick();
      expect(manager.getPeerBots().map((b) => b.name)).toEqual(['local-worker']);

      const result = await manager.forwardTask(
        { name: 'same-host', url: 'http://10.0.0.5:9200' },
        { botName: 'local-worker', chatId: 'chat1', prompt: 'hello' },
      );

      expect(result).toEqual({ success: true, responseText: 'local done' });
      expect(fetchMock).toHaveBeenCalledWith(
        'http://10.0.0.5:9200/api/talk',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        'https://luckagent.example.com/core/api/inbox/local-worker',
        expect.anything(),
      );
    });

    it('falls back to static configs when GET /api/agents fails', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';

      const fetchMock = vi.fn().mockImplementation((url: string) => {
        if (url === 'https://luckagent.example.com/core/api/agents') {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        if (url === 'http://static-peer:9100/api/bots') {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              bots: [{ name: 'static-bot', platform: 'feishu', workingDirectory: '/work/static' }],
            }),
          });
        }
        if (url === 'http://static-peer:9100/api/skills') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ skills: [] }) });
        }
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      });
      vi.stubGlobal('fetch', fetchMock);

      const logger = createLogger();
      manager = new PeerManager(
        [{ name: 'static', url: 'http://static-peer:9100' }],
        [],
        logger,
      );

      await (manager as any).runPollTick();

      // Static peer survived the failed registry fetch.
      const peers = manager.getPeerStatuses();
      expect(peers.map((p) => p.name)).toContain('static');
      const staticPeer = peers.find((p) => p.name === 'static');
      expect(staticPeer!.healthy).toBe(true);
      expect(manager.getPeerBots().some((b) => b.name === 'static-bot')).toBe(true);

      // A single warn fired for the agent-bus failure.
      const warnCalls = (logger.warn as any).mock.calls;
      const sawFallbackWarn = warnCalls.some((c: any[]) =>
        typeof c[1] === 'string' && c[1].includes('agent bus unreachable'),
      );
      expect(sawFallbackWarn).toBe(true);
    });

    it('enters registry mode via LUCKAGENT_CORE_URL fallback (when AGENT_BUS_URL unset)', async () => {
      process.env.LUCKAGENT_CORE_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://self.example:9100';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'fallback-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'fallback-bot' }], createLogger());
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall, 'expected POST /api/agents/bulk via LUCKAGENT_CORE_URL fallback').toBeDefined();
      expect(bulkCall![0]).toBe('https://luckagent.example.com/core/api/agents/bulk');
    });

    it('honors API_PORT in the defaulted SELF_URL when LUCKAGENT_AGENT_SELF_URL is unset', async () => {
      process.env.LUCKAGENT_CORE_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_RELAY = 'false';
      process.env.API_PORT = '9123';
      // LUCKAGENT_AGENT_SELF_URL deliberately unset — host (auto-detected private IPv4 or localhost
      // fallback) varies by machine, so we only pin the :<port> suffix.

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'localhost-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'localhost-bot' }], createLogger());
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall, 'expected POST /api/agents/bulk with defaulted SELF_URL').toBeDefined();
      const body = JSON.parse((bulkCall![1] as RequestInit).body as string);
      expect(body.bots[0].url).toMatch(/^http:\/\/[^:]+:9123$/);
    });

    it('defaults SELF_URL to an http URL when env unset (auto-detected private IPv4 with localhost fallback)', async () => {
      process.env.LUCKAGENT_CORE_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_RELAY = 'false';
      // Both LUCKAGENT_AGENT_SELF_URL and API_PORT unset — selfUrl will be auto-detected from this machine's
      // network interfaces, so we only assert the shape, not a specific address. The selection logic itself
      // is exercised directly against pickPrivateIPv4 below.

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'default-port-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'default-port-bot' }], createLogger());
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall).toBeDefined();
      const body = JSON.parse((bulkCall![1] as RequestInit).body as string);
      expect(body.bots[0].url).toMatch(/^http:\/\/[^:]+:9100$/);
    });

    it('LUCKAGENT_CORE_AGENT_BUS_URL wins over LUCKAGENT_CORE_URL (precedence preserved)', async () => {
      process.env.LUCKAGENT_CORE_AGENT_BUS_URL = 'https://bus.example.com/core';
      process.env.LUCKAGENT_CORE_URL = 'https://other.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://self.example:9100';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'precedence-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'precedence-bot' }], createLogger());
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall, 'expected POST /api/agents/bulk against AGENT_BUS_URL').toBeDefined();
      // AGENT_BUS_URL wins — call goes to bus.example.com, not other.example.com.
      expect(bulkCall![0]).toBe('https://bus.example.com/core/api/agents/bulk');
    });

    it('explicit LUCKAGENT_AGENT_SELF_URL wins over the localhost default', async () => {
      process.env.LUCKAGENT_CORE_URL = 'https://luckagent.example.com/core';
      process.env.LUCKAGENT_CORE_TOKEN = 'core-bearer';
      process.env.LUCKAGENT_AGENT_RELAY = 'false';
      process.env.LUCKAGENT_AGENT_SELF_URL = 'http://explicit-self:9100';
      process.env.API_PORT = '9123';

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          registered: 1,
          results: [{ botName: 'self-precedence-bot', status: 201 }],
        }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'self-precedence-bot' }], createLogger());
      await new Promise((r) => setImmediate(r));

      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].endsWith('/api/agents/bulk') && c[1]?.method === 'POST',
      );
      expect(bulkCall, 'expected POST /api/agents/bulk with explicit SELF_URL').toBeDefined();
      const body = JSON.parse((bulkCall![1] as RequestInit).body as string);
      expect(body.bots[0].url).toBe('http://explicit-self:9100');
    });

    it('empty LUCKAGENT_CORE_URL after trim does not enable registry mode', async () => {
      process.env.LUCKAGENT_CORE_URL = '   ';
      // No other registry vars.

      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ bots: [] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      manager = new PeerManager([], [{ name: 'should-not-register' }], createLogger());
      await new Promise((r) => setImmediate(r));

      // No bulk-register call should have been made.
      const bulkCall = fetchMock.mock.calls.find(
        (c) => typeof c[0] === 'string' && c[0].includes('/api/agents/bulk'),
      );
      expect(bulkCall).toBeUndefined();
    });
  });
});

describe('pickPrivateIPv4', () => {
  it('returns undefined when no interfaces have private IPv4', () => {
    const ifaces: IfaceDict = {
      lo: [loopback()],
      eth0: [ipv4('203.0.113.10')], // public
    };
    expect(pickPrivateIPv4(ifaces)).toBeUndefined();
  });

  it('returns undefined for empty interfaces dict', () => {
    expect(pickPrivateIPv4({})).toBeUndefined();
  });

  it('skips loopback (internal=true)', () => {
    const ifaces: IfaceDict = {
      lo: [loopback()],
      eth0: [ipv4('10.0.0.5')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('10.0.0.5');
  });

  it('skips IPv6 addresses', () => {
    const ifaces: IfaceDict = {
      eth0: [ipv6('fe80::1'), ipv4('172.20.0.5')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('172.20.0.5');
  });

  it('prefers 10/8 over 172.16/12 over 192.168/16', () => {
    const ifaces: IfaceDict = {
      eth0: [ipv4('192.168.1.5')],
      eth1: [ipv4('172.20.0.5')],
      eth2: [ipv4('10.0.0.5')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('10.0.0.5');
  });

  it('prefers 172.16/12 over 192.168/16 when 10/8 absent', () => {
    const ifaces: IfaceDict = {
      eth0: [ipv4('192.168.1.5')],
      eth1: [ipv4('172.31.40.182')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('172.31.40.182');
  });

  it('breaks ties on equal rank by interface name (lexicographic)', () => {
    const ifaces: IfaceDict = {
      eth2: [ipv4('10.0.0.10')],
      eth0: [ipv4('10.0.0.20')],
      eth1: [ipv4('10.0.0.30')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('10.0.0.20'); // eth0 wins
  });

  it('skips docker virtual bridge interfaces', () => {
    const ifaces: IfaceDict = {
      docker0: [ipv4('172.17.0.1')], // virtual — must skip
      eth0: [ipv4('172.31.40.182')], // real — must pick this
    };
    expect(pickPrivateIPv4(ifaces)).toBe('172.31.40.182');
  });

  it('skips veth/cni/flannel/kube/br-/cali/virbr/vmnet/tailscale/wg/utun', () => {
    const ifaces: IfaceDict = {
      'veth123abc': [ipv4('10.244.0.1')],
      'cni0': [ipv4('10.244.1.1')],
      'flannel.1': [ipv4('10.244.2.0')],
      'kube-ipvs0': [ipv4('10.96.0.1')],
      'br-abcdef': [ipv4('172.18.0.1')],
      'cali123': [ipv4('192.168.100.1')],
      'virbr0': [ipv4('192.168.122.1')],
      'vmnet1': [ipv4('192.168.110.1')],
      'tailscale0': [ipv4('100.64.0.1')], // CGNAT, but also virtual
      'wg0': [ipv4('10.200.0.1')],
      'utun0': [ipv4('192.168.50.1')],
      'eth0': [ipv4('10.0.0.5')], // the only real one
    };
    expect(pickPrivateIPv4(ifaces)).toBe('10.0.0.5');
  });

  it('returns undefined when every non-virtual iface is public', () => {
    const ifaces: IfaceDict = {
      docker0: [ipv4('172.17.0.1')], // virtual, skipped
      eth0: [ipv4('192.18.73.126')], // public, skipped
    };
    expect(pickPrivateIPv4(ifaces)).toBeUndefined();
  });

  it('handles iface entry being undefined safely', () => {
    const ifaces: IfaceDict = {
      eth0: undefined,
      eth1: [ipv4('10.0.0.5')],
    };
    expect(pickPrivateIPv4(ifaces)).toBe('10.0.0.5');
  });

  describe('intranet CIDR override', () => {
    it('prefers an address inside the CIDR over a higher-ranked one', () => {
      const ifaces: IfaceDict = {
        eth0: [ipv4('10.0.0.5')], // rank 0, would win without CIDR
        eth1: [ipv4('172.31.32.2')], // intranet
      };
      expect(pickPrivateIPv4(ifaces, '172.31.0.0/16')).toBe('172.31.32.2');
    });

    it('picks the intranet address even when it lives on a VPN tunnel iface', () => {
      const ifaces: IfaceDict = {
        eth0: [ipv4('192.168.1.103')], // physical office LAN, not routable
        utun0: [ipv4('172.31.40.7')], // VPN-delivered intranet — must win
      };
      expect(pickPrivateIPv4(ifaces, '172.31.0.0/16')).toBe('172.31.40.7');
      // and without the CIDR the tunnel is skipped → falls back to the LAN addr
      expect(pickPrivateIPv4(ifaces)).toBe('192.168.1.103');
    });

    it('still skips container/bridge ifaces even if they sit inside the CIDR', () => {
      const ifaces: IfaceDict = {
        'br-deadbeef': [ipv4('172.31.0.1')], // docker custom bridge — must NOT squat
        wg0: [ipv4('172.31.55.9')], // real intranet over wireguard
      };
      expect(pickPrivateIPv4(ifaces, '172.31.0.0/16')).toBe('172.31.55.9');
    });

    it('falls back to rank logic when no address matches the CIDR', () => {
      const ifaces: IfaceDict = {
        eth0: [ipv4('192.168.1.5')],
        eth1: [ipv4('10.0.0.5')],
      };
      expect(pickPrivateIPv4(ifaces, '172.31.0.0/16')).toBe('10.0.0.5');
    });

    it('ignores an empty CIDR string (pure fallback behavior)', () => {
      const ifaces: IfaceDict = {
        eth0: [ipv4('192.168.1.5')],
        eth1: [ipv4('172.20.0.5')],
      };
      expect(pickPrivateIPv4(ifaces, '')).toBe('172.20.0.5');
    });
  });
});

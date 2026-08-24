import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  process.env.LUCKAGENT_CORE_TOKEN = 'mt_test_tok';
  process.env.LUCKAGENT_CORE_URL = 'https://example.test/core';
  process.env.HOME = '/tmp/luckagent-cli-test-home-does-not-exist';
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...ORIG_ENV };
});

async function importFresh(): Promise<typeof import('../src/agents.js')> {
  vi.resetModules();
  return await import('../src/agents.js');
}

describe('luckagent agents talk', () => {
  it('routes registry peers through the core inbox relay instead of direct /api/talk', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === 'https://example.test/core/api/agents') {
        return new Response(JSON.stringify({
          agents: [
            { botName: 'alice', url: 'http://alice:9100', visible: true, lastSeenAt: 'now' },
          ],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://example.test/core/api/inbox/worker') {
        return new Response(JSON.stringify({ message: { id: 'msg_1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ error: 'unexpected', url, init }), { status: 500 });
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const mod = await importFresh();
    await mod.run(['talk', 'alice/worker', 'chat1', 'hello']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const relayCall = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[1]!;
    expect(relayCall[0]).toBe('https://example.test/core/api/inbox/worker');
    expect(relayCall[1].method).toBe('POST');
    expect(JSON.parse(String(relayCall[1].body))).toEqual({ chatId: 'chat1', content: 'hello' });
    expect(
      (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.some(
        ([url]) => url === 'http://alice:9100/api/talk',
      ),
    ).toBe(false);
    expect(stdout.mock.calls.map((c) => String(c[0])).join('')).toContain('(relay)');
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('id=msg_1');
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createAuthProbe, inspectLocalClaudeUsage, type ClaudeAuthStatus } from '../src/api/claude-auth-status.js';
import type { BotConfigBase } from '../src/config.js';

const account: ClaudeAuthStatus = {
  source: 'cli', checkedAt: '2026-11-15T00:00:00Z', cliInstalled: true,
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'test@example.test',
};

describe('CLI authentication status', () => {
  it('allowlists results, shares in-flight queries and expires cached results', async () => {
    let now = 1_000;
    const run = vi.fn(async () => JSON.stringify({ ...account, accessToken: 'secret-token', apiKey: 'secret-key', hasAvailableSubscription: false }));
    const probe = createAuthProbe(run, () => now);
    const [a, b] = await Promise.all([probe('/tmp/a', 'sdk'), probe('/tmp/a', 'sdk')]);
    expect(a).toEqual(b);
    expect(run).toHaveBeenCalledTimes(1);
    expect(a.subscriptionType).toBe('max');
    expect(JSON.stringify(a)).not.toContain('secret');
    expect(a).not.toHaveProperty('hasAvailableSubscription');
    await probe('/tmp/b', 'sdk');
    expect(run).toHaveBeenCalledTimes(2);
    now += 60_001;
    await probe('/tmp/a', 'sdk');
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('does not show stale logged-in data or raw errors when refresh fails', async () => {
    let now = 0;
    const run = vi.fn().mockResolvedValueOnce(JSON.stringify(account)).mockRejectedValueOnce(new Error('secret-token'));
    const probe = createAuthProbe(run, () => now);
    expect((await probe()).loggedIn).toBe(true);
    now = 61_000;
    const failed = await probe();
    expect(failed.loggedIn).toBeUndefined();
    expect(failed.subscriptionType).toBeUndefined();
    expect(failed.error).toContain('查询失败');
    expect(JSON.stringify(failed)).not.toContain('secret-token');
  });

  it('distinguishes logged out, missing CLI and malformed output', async () => {
    const loggedOut = await createAuthProbe(async () => '{"loggedIn":false}')();
    expect(loggedOut.loggedIn).toBe(false);
    expect(loggedOut.error).toBeUndefined();
    const missing = await createAuthProbe(async () => { throw Object.assign(new Error('sensitive path'), { code: 'ENOENT' }); })();
    expect(missing.cliInstalled).toBe(false);
    expect(missing.loggedIn).toBeUndefined();
    const invalid = await createAuthProbe(async () => '{"accessToken":"secret"}')();
    expect(invalid.error).toBeDefined();
    expect(JSON.stringify(invalid)).not.toContain('secret');
  });

  it('classifies only matching official accounts and never changes bot configurations', async () => {
    const config = (name: string, patch = {}): BotConfigBase => ({
      name, engine: 'claude', claude: { defaultWorkingDirectory: `/tmp/${name}`, backend: 'sdk', model: 'model', apiKey: undefined,
        maxTurns: undefined, maxBudgetUsd: undefined, outputsBaseDir: '/tmp', downloadsDir: '/tmp', ...patch },
    });
    const configs = [config('local', { connection: 'local' }), config('inherited'), config('api'), config('other-account'), config('unknown'),
      config('explicit-key', { apiKey: 'key' }), config('gateway', { connection: { id: 'c', name: 'Gateway', baseUrl: 'https://example.test', model: 'm', apiKey: 'key' } })];
    const before = structuredClone(configs);
    const probe = vi.fn(async (cwd?: string): Promise<ClaudeAuthStatus> => {
      if (cwd === '/tmp/api') return { ...account, authMethod: 'api_key' };
      if (cwd === '/tmp/other-account') return { ...account, email: 'other@example.test' };
      if (cwd === '/tmp/unknown') return { source: 'cli', checkedAt: '', cliInstalled: true, error: 'failed' };
      return account;
    });
    const result = await inspectLocalClaudeUsage(configs.map(c => ({ name: c.name, config: c })), probe);
    expect(result.runningBots).toEqual(['local', 'inherited']);
    expect(result.inheritedLoginBots).toEqual(['inherited']);
    expect(result.legacyClaudeBots).toEqual(['api', 'other-account', 'unknown']);
    expect(probe).toHaveBeenCalledWith('/tmp/inherited', 'sdk');
    expect(probe).toHaveBeenCalledTimes(5);
    expect(configs).toEqual(before);
  });
});

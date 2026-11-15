import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyModelConnection, botConnectionChoice, connectionUsers, parseModelConnection, validateConnectionSelection } from '../src/model-connections.js';
import { loadAppConfig, type BotConfig, type BotsJsonNewFormat, type FeishuBotJsonEntry } from '../src/config.js';
import { resolveClaudeAuthEnv, nonessentialTrafficSettings } from '../src/engines/claude/auth-env.js';
import { deriveClaudeConfig, deriveCompatConfig, resolveEngineName } from '../src/engines/index.js';
import { legacyModelConnections } from '../src/api/legacy-model-connections.js';
import { handleModelConnectionRoutes } from '../src/api/routes/model-connection-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

vi.mock('../src/api/claude-auth-status.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api/claude-auth-status.js')>();
  return { ...actual, inspectLocalClaudeUsage: (running: Parameters<typeof actual.inspectLocalClaudeUsage>[0]) =>
    actual.inspectLocalClaudeUsage(running, async () => ({ source: 'cli', checkedAt: '2026-11-15T00:00:00Z', cliInstalled: true, error: 'CLI unavailable in test' })) };
});

const connection = { id: 'gateway', name: '灵眸', baseUrl: 'https://api.example.test', model: 'test-model', apiKey: 'secret-test-key' };
const entry: FeishuBotJsonEntry = { name: 'demo', engine: 'claude', defaultWorkingDirectory: '/tmp/demo', feishuAppId: 'app', feishuAppSecret: 'secret' };
function bot(): BotConfig {
  return { name: 'demo', engine: 'claude', feishu: { appId: 'app', appSecret: 'secret' }, claude: { defaultWorkingDirectory: '/tmp/demo', model: 'old-model', apiKey: 'old-key', maxTurns: undefined, maxBudgetUsd: undefined, backend: 'sdk', outputsBaseDir: '/tmp', downloadsDir: '/tmp' } };
}

describe('connection resolution and authentication isolation', () => {
  afterEach(() => vi.unstubAllEnvs());
  const cfg: BotsJsonNewFormat = { modelConnections: [connection], defaultModelConnection: 'gateway' };
  it('preserves existing config when no connection is selected', () => {
    expect(applyModelConnection(bot(), entry, {})).toEqual(bot());
  });
  it('inherits connection defaults but gives a bot model override priority', () => {
    const b = applyModelConnection(bot(), entry, cfg);
    expect(b.claude.model).toBe('test-model');
    expect(b.claude.backend).toBe('sdk');
    const env = resolveClaudeAuthEnv(b)!;
    expect(env.ANTHROPIC_BASE_URL).toBe(connection.baseUrl);
    expect(env.ANTHROPIC_API_KEY).toBe(connection.apiKey);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe(connection.apiKey);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
    expect(env.CLAUDE_CODE_ATTRIBUTION_HEADER).toBe('0');
    expect(applyModelConnection(bot(), { ...entry, model: 'override' }, cfg).claude.model).toBe('override');
    expect(bot().claude.apiKey).toBe('old-key');
  });
  it('pins local login to official endpoint and clears inherited gateway keys', () => {
    const b = applyModelConnection(bot(), { ...entry, modelConnection: 'local' }, cfg);
    expect(b.claude.model).toBeUndefined();
    expect(b.claude.backend).toBe('pty');
    expect(resolveClaudeAuthEnv(b)).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' });
  });
  it('keeps DeepSeek isolated from the Claude connection', () => {
    const b = applyModelConnection(bot(), entry, cfg);
    b.engine = 'deepseek'; b.deepseek = { apiKey: 'deepseek-key' };
    expect(resolveClaudeAuthEnv(b)).toMatchObject({ ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_API_KEY: 'deepseek-key' });
  });
  it('refuses to fall back to host credentials when a saved connection has no key', () => {
    const b = applyModelConnection(bot(), entry, { ...cfg, modelConnections: [{ ...connection, apiKey: undefined }] });
    expect(() => resolveClaudeAuthEnv(b)).toThrow('尚未填写 API Key');
  });
  it.each(['deepseek', 'minimax'] as const)('clears the %s connection model on a Claude session switch', provider => {
    vi.stubEnv('CLAUDE_MODEL', 'host-claude-model');
    const b = applyModelConnection(bot(), entry, { ...cfg, modelConnections: [{ ...connection, provider }] });
    const switched = deriveClaudeConfig(b);
    expect(switched.claude.model).toBe('host-claude-model');
    expect(switched.claude.connection).toBeUndefined();
    expect(resolveClaudeAuthEnv(switched)).toBeUndefined();
    expect(b.claude.model).toBe(connection.model);
    expect(resolveClaudeAuthEnv(b)?.ANTHROPIC_API_KEY).toBe(connection.apiKey);
  });
  it('rejects dangling references and credential-bearing URLs', () => {
    expect(() => validateConnectionSelection('missing', cfg)).toThrow();
    expect(() => parseModelConnection({ ...connection, baseUrl: 'https://user:password@host.test' }, 'id')).toThrow();
    expect(() => parseModelConnection({ ...connection, apiKey: 'bad\nkey' }, 'id')).toThrow();
  });
  it('defaults traffic control off, preserves omitted updates, and rejects truthy strings', () => {
    expect(parseModelConnection(connection, 'gateway').disableNonessentialTraffic).toBe(false);
    const previous = { ...connection, disableNonessentialTraffic: true };
    expect(parseModelConnection(connection, 'gateway', previous).disableNonessentialTraffic).toBe(true);
    expect(parseModelConnection({ ...connection, disableNonessentialTraffic: false }, 'gateway', previous).disableNonessentialTraffic).toBe(false);
    for (const value of ['0', '1', 0, null]) {
      expect(() => parseModelConnection({ ...connection, disableNonessentialTraffic: value }, 'gateway')).toThrow('布尔值');
    }
  });
  it('isolates the switch per connection and pins only the non-secret flag in settings', () => {
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    for (const enabled of [true, false]) {
      const b = applyModelConnection(bot(), entry, { ...cfg, modelConnections: [{ ...connection, disableNonessentialTraffic: enabled }] });
      const env = resolveClaudeAuthEnv(b)!;
      expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe(enabled ? '1' : '');
      expect(nonessentialTrafficSettings(env)).toEqual({ env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: enabled ? '1' : '' } });
      expect(JSON.stringify(nonessentialTrafficSettings(env))).not.toContain(connection.apiKey);
    }
    expect(nonessentialTrafficSettings(resolveClaudeAuthEnv(bot()))).toEqual({});
    expect(nonessentialTrafficSettings(resolveClaudeAuthEnv(applyModelConnection(bot(), { ...entry, modelConnection: 'local' }, cfg)))).toEqual({});
    expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
  });
  it.each(['deepseek', 'minimax'] as const)('keeps old %s bots on old credentials until explicitly opted in', engine => {
    const b = bot(); b.engine = engine; b[engine] = { apiKey: 'old-provider-key', model: 'old-provider-model', baseUrl: 'https://old.test/anthropic' };
    const oldEntry = { ...entry, engine };
    expect(applyModelConnection(structuredClone(b), oldEntry, cfg)).toEqual(b);
    expect(botConnectionChoice(oldEntry)).toBe('legacy');
    expect(connectionUsers({ ...cfg, feishuBots: [oldEntry] }, 'gateway')).toEqual([]);
    const opted = applyModelConnection(structuredClone(b), { ...oldEntry, modelConnection: 'inherit' }, cfg);
    expect(resolveEngineName(opted)).toBe('claude');
    expect(resolveClaudeAuthEnv(opted)?.ANTHROPIC_AUTH_TOKEN).toBe(connection.apiKey);
    const explicit = applyModelConnection(structuredClone(b), { ...oldEntry, modelConnection: 'gateway' }, cfg);
    expect(resolveClaudeAuthEnv(explicit)?.ANTHROPIC_BASE_URL).toBe(connection.baseUrl);
    expect(applyModelConnection(structuredClone(b), { ...oldEntry, modelConnection: 'legacy' }, cfg)).toEqual(b);
  });
  it.each(['deepseek', 'minimax'] as const)('resolves unified %s credentials, model overrides and SDK backend consistently', provider => {
    const c = { ...connection, provider, baseUrl: `https://${provider}.test/anthropic`, model: `${provider}-model`, disableNonessentialTraffic: true };
    const b = applyModelConnection(bot(), { ...entry, model: 'bot-model' }, { ...cfg, modelConnections: [c] });
    expect(b.engine).toBe(provider);
    expect(b[provider]).toMatchObject({ apiKey: c.apiKey, baseUrl: c.baseUrl, model: 'bot-model' });
    const runtime = deriveCompatConfig(b, provider);
    expect(runtime.claude.model).toBe('bot-model');
    expect(runtime.claude.backend).toBe('sdk');
    expect(resolveClaudeAuthEnv(runtime)).toMatchObject({ ANTHROPIC_BASE_URL: c.baseUrl, ANTHROPIC_AUTH_TOKEN: c.apiKey, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
    const withoutKey = applyModelConnection(bot(), entry, { ...cfg, modelConnections: [{ ...c, apiKey: undefined }] });
    vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, 'unrelated-global-key');
    expect(() => resolveClaudeAuthEnv(withoutKey)).toThrow('尚未填写 API Key');
  });
  it('keeps env-only legacy selection and isolates multiple connections to the same provider', () => {
    vi.stubEnv('LUCKAGENT_ENGINE', 'deepseek');
    expect(botConnectionChoice({})).toBe('legacy');
    expect(botConnectionChoice({ modelConnection: 'inherit' })).toBe('inherit');
    const a = { ...connection, provider: 'deepseek' as const, id: 'a', apiKey: 'key-a' };
    const b = { ...a, id: 'b', apiKey: 'key-b', baseUrl: 'https://b.test/anthropic' };
    const config = { modelConnections: [a, b], defaultModelConnection: 'a', feishuBots: [{ ...entry, modelConnection: 'inherit' }, { ...entry, name: 'other', modelConnection: 'b' }] };
    for (const e of config.feishuBots) {
      const resolved = applyModelConnection(bot(), e, config);
      expect(resolveClaudeAuthEnv(resolved)?.ANTHROPIC_API_KEY).toBe(e.name === 'other' ? 'key-b' : 'key-a');
    }
    expect(connectionUsers(config, 'a')).toEqual(['demo']);
    expect(connectionUsers(config, 'b')).toEqual(['other']);
    expect(() => parseModelConnection({ ...connection, provider: 'unknown' }, 'id')).toThrow('服务商');
  });
  it('reads legacy provider sources without mutating the originals', () => {
    const config = { feishuBots: [{ ...entry, engine: 'minimax' as const, minimax: { apiKey: 'bot-key', model: 'bot-model' } }] };
    const before = structuredClone(config);
    const sources = legacyModelConnections(config, { MINIMAX_API_KEY: 'global-key', MINIMAX_BASE_URL: 'https://minimax.test', MINIMAX_MODEL: 'global-model' });
    expect(sources.find(c => c.source === 'env:minimax')).toMatchObject({ apiKey: 'global-key', model: 'global-model' });
    expect(sources.find(c => c.source === 'bot:demo:minimax')).toMatchObject({ apiKey: 'bot-key', model: 'bot-model', baseUrl: 'https://minimax.test' });
    expect(config).toEqual(before);
  });
  it('preserves, rotates and clears keys explicitly', () => {
    expect(parseModelConnection({ ...connection, apiKey: '' }, 'gateway', connection).apiKey).toBe(connection.apiKey);
    expect(parseModelConnection({ ...connection, apiKey: 'new-key' }, 'gateway', connection).apiKey).toBe('new-key');
    expect(parseModelConnection({ ...connection, clearApiKey: true }, 'gateway', connection).apiKey).toBeUndefined();
  });
});

describe('admin model connection lifecycle', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-connections-'));
    file = path.join(dir, 'bots.json');
    fs.writeFileSync(file, JSON.stringify({ feishuBots: [entry], modelConnections: [connection], peers: [{ name: 'peer', url: 'http://localhost:1' }] }));
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  async function request(method: string, suffix = '', body?: unknown, running: Array<{ name: string; config: BotConfig }> = []) {
    const req = new PassThrough();
    let status = 0;
    let result = '';
    const res = { writeHead(code: number) { status = code; }, end(value: string) { result = value; } };
    const work = handleModelConnectionRoutes({ botsConfigPath: file, registry: { listRegistered: () => running } } as RouteContext, req as unknown as IncomingMessage, res as unknown as ServerResponse, method, `/admin/api/model-connections${suffix}`);
    req.end(body === undefined ? '' : JSON.stringify(body));
    await work;
    return { status, data: JSON.parse(result), raw: result };
  }
  it('lists without exposing keys and reports inherited bot impact', async () => {
    expect((await request('PUT', '/default', { connection: 'gateway' })).status).toBe(200);
    const r = await request('GET');
    expect(r.raw).not.toContain(connection.apiKey);
    expect(r.data.connections[0].affectedBots).toEqual(['demo']);
    expect(r.data.connections[0].hasApiKey).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).peers).toHaveLength(1);
  });
  it('distinguishes saved local selections, running local bots and ambiguous legacy auth', async () => {
    vi.stubEnv('LUCKAGENT_ENGINE', 'claude');
    const cfg: BotsJsonNewFormat = { defaultModelConnection: 'local', modelConnections: [connection], feishuBots: [
      { ...entry, name: 'inherited' },
      { ...entry, name: 'stopped-local', modelConnection: 'local' },
      { ...entry, name: 'gateway-bot', modelConnection: 'gateway' },
      { ...entry, name: 'old-deepseek', engine: 'deepseek' },
    ] };
    fs.writeFileSync(file, JSON.stringify(cfg));
    const legacy = bot(); legacy.claude.apiKey = undefined;
    const runtime = [
      { name: 'still-local-until-restart', config: applyModelConnection(bot(), { ...entry, modelConnection: 'local' }, cfg) },
      { name: 'legacy-unknown', config: legacy },
      { name: 'legacy-api', config: bot() },
      { name: 'gateway-bot', config: applyModelConnection(bot(), { ...entry, modelConnection: 'gateway' }, cfg) },
      { name: 'old-deepseek', config: { ...legacy, engine: 'deepseek' as const } },
    ];
    const r = await request('GET', '', undefined, runtime);
    expect(r.data.localLoginUsage).toEqual({ configuredBots: ['inherited', 'stopped-local'], runningBots: ['still-local-until-restart'], inheritedLoginBots: [], legacyClaudeBots: ['legacy-unknown'] });
    expect(r.raw).not.toContain(connection.apiKey);
    expect(r.raw).not.toContain('old-key');
  });
  it('persists across config reload and protects referenced connections from deletion', async () => {
    await request('PUT', '/default', { connection: 'gateway' });
    vi.stubEnv('BOTS_CONFIG', file);
    expect(loadAppConfig().feishuBots[0].claude.model).toBe('test-model');
    expect((await request('DELETE', '/gateway')).status).toBe(400);
    await request('PUT', '/default', { connection: 'legacy' });
    expect((await request('DELETE', '/gateway')).status).toBe(200);
  });
  it('adds, edits without leaking keys, clears keys and rejects invalid references', async () => {
    const created = await request('POST', '', { name: 'New', model: 'model', baseUrl: 'https://new.test' });
    expect(created.status).toBe(200);
    expect((await request('PUT', '/gateway', { ...connection, apiKey: '', name: 'Renamed' })).raw).not.toContain(connection.apiKey);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).modelConnections[0].apiKey).toBe(connection.apiKey);
    await request('PUT', '/gateway', { ...connection, clearApiKey: true });
    expect((await request('POST', '/gateway/test')).status).toBe(400);
    expect((await request('PUT', '/default', { connection: 'missing' })).status).toBe(400);
  });
  it('round-trips the traffic switch through the API and reload without changing the key', async () => {
    expect((await request('GET')).data.connections[0].disableNonessentialTraffic).toBe(false);
    await request('PUT', '/default', { connection: 'gateway' });
    vi.stubEnv('BOTS_CONFIG', file);
    const { apiKey: _key, ...fields } = connection;
    for (const enabled of [true, false]) {
      const r = await request('PUT', '/gateway', { ...fields, disableNonessentialTraffic: enabled });
      expect(r.status).toBe(200);
      expect((await request('GET')).data.connections[0].disableNonessentialTraffic).toBe(enabled);
      expect(resolveClaudeAuthEnv(loadAppConfig().feishuBots[0])).toMatchObject({
        ANTHROPIC_API_KEY: connection.apiKey,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: enabled ? '1' : '',
      });
    }
    expect((await request('PUT', '/gateway', { ...fields, disableNonessentialTraffic: '0' })).status).toBe(400);
  });
  it('copies legacy keys to independent connections without rebinding bots or exposing secrets', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'legacy-private-key');
    vi.stubEnv('DEEPSEEK_MODEL', 'legacy-model');
    const before = JSON.parse(fs.readFileSync(file, 'utf8'));
    const listing = await request('GET');
    expect(listing.raw).not.toContain('legacy-private-key');
    expect(listing.data.presets.map((p: { provider: string }) => p.provider)).toEqual(expect.arrayContaining(['deepseek', 'minimax', 'lmuai']));
    expect((await request('POST', '/import', { source: 'env:deepseek' })).status).toBe(200);
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(after.feishuBots).toEqual(before.feishuBots);
    expect(after.defaultModelConnection).toBe(before.defaultModelConnection);
    const copy = after.modelConnections.find((c: { importedFrom?: string }) => c.importedFrom === 'env:deepseek');
    expect(copy).toMatchObject({ provider: 'deepseek', apiKey: 'legacy-private-key', model: 'legacy-model' });
    expect((await request('GET')).raw).not.toContain('legacy-private-key');
    expect((await request('POST', '/import', { source: 'env:deepseek' })).status).toBe(400);
    expect((await request('POST', '/import', { source: 'missing' })).status).toBe(400);
    await request('PUT', `/${copy.id}`, { ...copy, clearApiKey: true });
    expect(process.env.DEEPSEEK_API_KEY).toBe('legacy-private-key');
  });
  it('tests saved credentials and redacts upstream failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'OK' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await request('POST', '/gateway/test')).data.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.test/v1/messages');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { Authorization: `Bearer ${connection.apiKey}` } });
    fetchMock.mockResolvedValue(new Response(connection.apiKey, { status: 401 }));
    const r = await request('POST', '/gateway/test');
    expect(r.data.ok).toBe(false);
    expect(r.raw).not.toContain(connection.apiKey);
  });
});

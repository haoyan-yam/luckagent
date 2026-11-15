import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { applyModelConnection, parseModelConnection, validateConnectionSelection } from '../src/model-connections.js';
import { loadAppConfig, type BotConfig, type BotsJsonNewFormat, type FeishuBotJsonEntry } from '../src/config.js';
import { resolveClaudeAuthEnv, nonessentialTrafficSettings } from '../src/engines/claude/auth-env.js';
import { handleModelConnectionRoutes } from '../src/api/routes/model-connection-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

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
  async function request(method: string, suffix = '', body?: unknown) {
    const req = new PassThrough();
    let status = 0;
    let result = '';
    const res = { writeHead(code: number) { status = code; }, end(value: string) { result = value; } };
    const work = handleModelConnectionRoutes({ botsConfigPath: file } as RouteContext, req as unknown as IncomingMessage, res as unknown as ServerResponse, method, `/admin/api/model-connections${suffix}`);
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

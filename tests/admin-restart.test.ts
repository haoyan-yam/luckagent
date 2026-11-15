import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAdminRuntimeState } from '../src/api/admin-runtime-state.js';
import { handleRestartRoutes, restartStatus } from '../src/api/routes/restart-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';

let dir: string, envPath: string, botsPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-restart-'));
  envPath = path.join(dir, '.env'); botsPath = path.join(dir, 'bots.json');
  fs.writeFileSync(envPath, 'ARK_API_KEY=secret-old\n');
  fs.writeFileSync(botsPath, '{"feishuBots":[]}');
  vi.stubEnv('SESSION_STORE_DIR', dir);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

function context() {
  const activity = { active: 0, queued: 0 };
  const tasks: Array<{ status: string }> = [];
  const ctx = {
    adminRuntime: createAdminRuntimeState(botsPath, envPath),
    registry: { listRegistered: () => [{ name: 'bot', bridge: { getRestartActivity: () => activity } }] },
    asyncTaskStore: { list: () => tasks }, logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as RouteContext;
  return { ctx, activity, tasks };
}
async function request(ctx: RouteContext, body?: unknown) {
  const req = new PassThrough() as unknown as IncomingMessage;
  const raw = body === undefined ? '' : JSON.stringify(body);
  req.headers = { 'content-length': String(Buffer.byteLength(raw)) };
  let code = 0, result = '';
  const res = { writeHead: (n: number) => { code = n; }, end: (s: string) => { result = s; } } as unknown as ServerResponse;
  const work = handleRestartRoutes(ctx, req, res, 'POST', '/admin/api/restart');
  (req as unknown as PassThrough).end(raw);
  await work;
  return { code, data: JSON.parse(result) };
}

describe('persistent pending configuration state', () => {
  it('survives repeated reads, ignores formatting and clears when changes are reverted', () => {
    const state = createAdminRuntimeState(botsPath, envPath);
    fs.writeFileSync(botsPath, '{\n  "feishuBots": []\n}\n');
    expect(state.configStatus().configDirty).toBe(false);
    fs.writeFileSync(envPath, 'ARK_API_KEY=secret-new\n');
    expect(state.configStatus().pendingChanges).toEqual(['环境默认值与服务凭证']);
    expect(state.configStatus().configDirty).toBe(true);
    expect(JSON.stringify(state.configStatus())).not.toContain('secret');
    fs.writeFileSync(envPath, 'ARK_API_KEY=secret-old\n');
    expect(state.configStatus().configDirty).toBe(false);
    fs.writeFileSync(botsPath, '{"feishuBots":[{"name":"new"}]}');
    expect(state.configStatus().pendingChanges).toEqual(['模型接入与机器人配置']);
    expect(createAdminRuntimeState(botsPath, envPath).configStatus().configDirty).toBe(false);
  });
  it('blocks malformed or removed configuration', () => {
    const { ctx } = context();
    fs.writeFileSync(botsPath, '{bad');
    expect(restartStatus(ctx).configErrors).toHaveLength(1);
    fs.unlinkSync(botsPath);
    expect(restartStatus(ctx).configErrors[0]).toContain('移除');
  });
});

describe('guarded bridge restart', () => {
  beforeEach(() => vi.useFakeTimers());
  it('counts admission, continuation, persistent and queued work without double counting chats', () => {
    const bridge = {
      runningTasks: new Map([['running', {}]]), admitting: new Map([['running', {}], ['downloading', {}]]),
      continuationTasks: new Map([['continuation', {}]]),
      persistentRegistry: { list: () => [{ chatId: 'running', hasActiveTurn: true }, { chatId: 'background', hasActiveTurn: true }, { chatId: 'idle', hasActiveTurn: false }] },
      messageQueues: new Map([['running', [{}, {}]]]), pendingBatches: new Map([['media', {}]]),
    };
    expect(MessageBridge.prototype.getRestartActivity.call(bridge as unknown as MessageBridge)).toEqual({ active: 4, queued: 3 });
  });
  it.each(['active', 'queued'] as const)('blocks %s tasks unless explicitly forced', async field => {
    const { ctx, activity } = context(); activity[field] = 1;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    expect((await request(ctx)).code).toBe(409);
    expect((await request(ctx, { force: 'true' })).code).toBe(400);
    expect((await request(ctx, { force: true })).code).toBe(202);
    vi.advanceTimersByTime(501);
    expect(exit).toHaveBeenCalledOnce();
  });
  it('blocks accepted asynchronous jobs and task inspection failures', async () => {
    const { ctx, tasks } = context(); tasks.push({ status: 'accepted' });
    expect((await request(ctx)).code).toBe(409);
    ctx.registry.listRegistered = () => { throw new Error('unavailable'); };
    expect((await request(ctx, { force: true })).code).toBe(503);
  });
  it('rechecks just before exit and cancels if a new task arrives', async () => {
    const { ctx, activity } = context();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const response = await request(ctx);
    expect(response.code).toBe(202);
    expect(response.data.bootId).toBe(ctx.adminRuntime!.bootId);
    expect((await request(ctx)).code).toBe(429);
    activity.active = 1;
    vi.advanceTimersByTime(501);
    expect(exit).not.toHaveBeenCalled();
    expect(restartStatus(ctx)).toMatchObject({ restarting: false, restartCancelled: true });
  });
  it('restarts an idle bridge, without changing configuration files', async () => {
    const { ctx } = context();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const original = fs.readFileSync(botsPath, 'utf8');
    expect((await request(ctx)).code).toBe(202);
    vi.advanceTimersByTime(501);
    expect(exit).toHaveBeenCalledWith(0);
    expect(fs.readFileSync(botsPath, 'utf8')).toBe(original);
    expect(fs.existsSync(path.join(dir, 'last-restart.json'))).toBe(true);
  });
  it('never forces a restart with broken configuration', async () => {
    const { ctx } = context();
    fs.writeFileSync(botsPath, '{bad');
    expect((await request(ctx, { force: true })).code).toBe(409);
  });
});

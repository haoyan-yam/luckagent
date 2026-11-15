import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RouteHandler, RouteContext } from './types.js';
import { jsonResponse, parseJsonBody } from './helpers.js';

export function restartStatus(ctx: RouteContext) {
  if (!ctx.adminRuntime) throw new Error('重启状态尚未初始化');
  const busyBots = ctx.registry.listRegistered().map(b => {
    const activity = b.bridge.getRestartActivity();
    return { name: b.name, ...activity };
  }).filter(b => b.active > 0 || b.queued > 0);
  const accepted = ctx.asyncTaskStore.list().filter(t => t.status === 'accepted').length;
  return {
    ...ctx.adminRuntime.configStatus(),
    bootId: ctx.adminRuntime.bootId,
    restarting: ctx.adminRuntime.restarting,
    restartCancelled: ctx.adminRuntime.restartCancelled,
    onlineBots: ctx.registry.listRegistered().length,
    activeTasks: busyBots.reduce((n, b) => n + b.active, 0),
    queuedTasks: busyBots.reduce((n, b) => n + b.queued, 0) + accepted,
    busyBots,
  };
}

export const handleRestartRoutes: RouteHandler = async (ctx, req, res, method, url) => {
  if (url !== '/admin/api/restart-status' && url !== '/admin/api/restart') return false;
  if (method === 'GET' && url.endsWith('restart-status')) {
    try { jsonResponse(res, 200, restartStatus(ctx)); }
    catch { jsonResponse(res, 503, { error: '无法确认任务与配置状态，请稍后重试' }); }
    return true;
  }
  if (method !== 'POST' || !url.endsWith('/restart')) {
    jsonResponse(res, 405, { error: '不支持此操作' }); return true;
  }
  // Empty-body callers remain compatible, with safe (non-forced) semantics.
  const hasBody = !!req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0;
  const body = hasBody ? await parseJsonBody(req) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body) || (body.force !== undefined && typeof body.force !== 'boolean')) {
    jsonResponse(res, 400, { error: 'force 须为布尔值' }); return true;
  }
  let status;
  try { status = restartStatus(ctx); }
  catch { jsonResponse(res, 503, { error: '无法确认当前任务状态，未执行重启' }); return true; }
  if (status.restarting) { jsonResponse(res, 429, { error: '重启已在进行中' }); return true; }
  if (status.configErrors.length) {
    jsonResponse(res, 409, { error: '配置文件异常，修复后再重启', ...status }); return true;
  }
  const force = body.force === true;
  if ((status.activeTasks || status.queuedTasks) && !force) {
    jsonResponse(res, 409, { error: '当前有运行或待处理任务，未执行重启', ...status }); return true;
  }
  const state = ctx.adminRuntime!;
  state.restarting = true;
  state.restartCancelled = false;
  jsonResponse(res, 202, { restarting: true, bootId: state.bootId, etaSec: 5 });
  setTimeout(() => {
    try {
      const latest = restartStatus(ctx);
      if (latest.configErrors.length || (!force && (latest.activeTasks || latest.queuedTasks))) {
        state.restarting = false; state.restartCancelled = true;
        ctx.logger.info('Bridge restart cancelled: activity or config changed');
        return;
      }
    } catch {
      state.restarting = false; state.restartCancelled = true; return;
    }
    try {
      const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last-restart.json'), JSON.stringify({ restartedAt: Math.floor(Date.now() / 1000) }) + '\n');
    } catch { ctx.logger.warn('Unable to write restart breadcrumb'); }
    ctx.logger.warn({ force }, 'Admin requested bridge restart');
    // No await between the final activity check and exit.
    process.exit(0);
  }, 500);
  return true;
};

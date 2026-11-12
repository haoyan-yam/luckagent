import { validateConfig } from '../../housekeeping/config.js';
import { archiveTargetStatus, diskUsage } from '../../housekeeping/actions.js';
import { housekeepingService, type EntryStatus } from '../../housekeeping/service.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteHandler } from './types.js';

/**
 * 清理归档 (housekeeping) endpoints, all under /admin/api/housekeeping — Bearer-gated
 * like every /admin/api/* route.
 */
const BASE = '/admin/api/housekeeping';
const ENTRY_PAGE_MAX = 500;

export const handleHousekeepingRoutes: RouteHandler = async (ctx, req, res, method, rawUrl) => {
  if (!rawUrl.startsWith(BASE)) return false;
  const u = new URL(rawUrl, 'http://local');
  const p = u.pathname;
  const svc = housekeepingService();

  // GET — config + status
  if (method === 'GET' && p === BASE) {
    const config = svc.getConfig();
    let disk: { totalBytes: number; freeBytes: number } | null = null;
    try {
      disk = diskUsage();
    } catch {
      /* ignore */
    }
    jsonResponse(res, 200, {
      config,
      nextRunAt: svc.getNextRunAt(),
      current: svc.getCurrent(),
      disk,
      archive: archiveTargetStatus(config.archiveRoot),
      /** Running bots that can send the alert notice. */
      bots: ctx.registry?.listRegistered?.().map((b) => b.name) ?? [],
    });
    return true;
  }

  // PUT /config — replace the whole config
  if (method === 'PUT' && p === `${BASE}/config`) {
    const body = await parseJsonBody(req);
    const v = validateConfig(body);
    if (!v.ok) {
      jsonResponse(res, 400, { error: v.error });
      return true;
    }
    svc.saveConfig(v.config);
    jsonResponse(res, 200, { config: v.config, nextRunAt: svc.getNextRunAt() });
    return true;
  }

  // POST /run {dryRun?: boolean, ruleIds?: string[]}
  if (method === 'POST' && p === `${BASE}/run`) {
    const body = await parseJsonBody(req);
    const ruleIds = Array.isArray(body.ruleIds) ? body.ruleIds.filter((x): x is string => typeof x === 'string') : undefined;
    try {
      const runId = svc.startRun({ trigger: 'manual', dryRun: body.dryRun !== false, ruleIds });
      jsonResponse(res, 202, { runId });
    } catch (e) {
      jsonResponse(res, 409, { error: (e as Error).message });
    }
    return true;
  }

  // POST /restore {runId, paths?: string[]} — put archived/trashed files back
  if (method === 'POST' && p === `${BASE}/restore`) {
    const body = await parseJsonBody(req);
    const runId = typeof body.runId === 'string' ? body.runId : '';
    const paths = Array.isArray(body.paths) ? body.paths.filter((x): x is string => typeof x === 'string') : undefined;
    if (!runId) {
      jsonResponse(res, 400, { error: '缺少 runId' });
      return true;
    }
    try {
      const results = await svc.restore(runId, paths);
      jsonResponse(res, 200, { results, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
    } catch (e) {
      jsonResponse(res, 409, { error: (e as Error).message });
    }
    return true;
  }

  // POST /alert-test — send a test notice with the saved alert settings
  if (method === 'POST' && p === `${BASE}/alert-test`) {
    const ok = await svc.testAlert();
    jsonResponse(res, ok ? 200 : 400, ok ? { ok } : { error: '发送失败：检查是否开启提醒、选了机器人和群，且机器人在群里' });
    return true;
  }

  // POST /cancel
  if (method === 'POST' && p === `${BASE}/cancel`) {
    jsonResponse(res, 200, { cancelled: svc.cancel() });
    return true;
  }

  // GET /runs — summaries
  if (method === 'GET' && p === `${BASE}/runs`) {
    const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit')) || 50));
    jsonResponse(res, 200, { runs: svc.listRuns(limit) });
    return true;
  }

  // GET /runs/:id?status=&rule=&q=&offset=&limit= — one run with a page of entries
  const m = /^\/admin\/api\/housekeeping\/runs\/([\w-]+)$/.exec(p);
  if (method === 'GET' && m) {
    const run = svc.getRun(m[1]);
    if (!run) {
      jsonResponse(res, 404, { error: '没有这条记录' });
      return true;
    }
    const status = u.searchParams.get('status') as EntryStatus | null;
    const rule = u.searchParams.get('rule');
    const q = (u.searchParams.get('q') || '').toLowerCase();
    const offset = Math.max(0, Number(u.searchParams.get('offset')) || 0);
    const limit = Math.min(ENTRY_PAGE_MAX, Math.max(1, Number(u.searchParams.get('limit')) || 100));
    const filtered = run.entries
      .filter((e) => (!status || e.status === status) && (!rule || e.ruleId === rule) && (!q || e.path.toLowerCase().includes(q)))
      .sort((a, b) => b.size - a.size); // biggest first — what people want to eyeball
    const { entries, ...summary } = run;
    jsonResponse(res, 200, {
      run: summary,
      total: filtered.length,
      entries: filtered.slice(offset, offset + limit),
      counts: entries.reduce<Record<string, number>>((acc, e) => ((acc[e.status] = (acc[e.status] || 0) + 1), acc), {}),
    });
    return true;
  }

  return false;
};

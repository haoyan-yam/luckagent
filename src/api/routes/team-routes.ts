import type * as http from 'node:http';
import { jsonResponse, parseJsonBody } from './helpers.js';
import { getTeamStatus } from '../team-status.js';
import type { RouteContext } from './types.js';

export async function handleTeamRoutes(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): Promise<boolean> {
  const { registry, peerManager, intentRouter, circuitBreaker, budgetManager, teamManager } = ctx;

  // GET /api/activity/events — recent activity events
  if (method === 'GET' && url.startsWith('/api/activity/events')) {
    if (!ctx.activityStore) {
      jsonResponse(res, 200, { events: [] });
      return true;
    }
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const botName = parsed.searchParams.get('botName') || undefined;
    const since = parsed.searchParams.get('since') ? Number(parsed.searchParams.get('since')) : undefined;
    const limit = parsed.searchParams.get('limit') ? Number(parsed.searchParams.get('limit')) : 50;
    const events = ctx.activityStore.list({ botName, since, limit });
    jsonResponse(res, 200, { events });
    return true;
  }

  // GET /api/team/status
  if (method === 'GET' && url === '/api/team/status') {
    const status = await getTeamStatus(registry);
    jsonResponse(res, 200, status);
    return true;
  }

  // POST /api/route — route a message to the best bot
  if (method === 'POST' && url === '/api/route') {
    const body = await parseJsonBody(req);
    const message = body.message as string;
    const currentBot = body.currentBot as string | undefined;
    if (!message) {
      jsonResponse(res, 400, { error: 'Missing required field: message' });
      return true;
    }
    const allBots = [...registry.list(), ...(peerManager?.getPeerBots() ?? [])];
    const result = await intentRouter.route(message, allBots, currentBot);
    jsonResponse(res, 200, result);
    return true;
  }

  // GET /api/router/mode
  if (method === 'GET' && url === '/api/router/mode') {
    jsonResponse(res, 200, { mode: intentRouter.getMode() });
    return true;
  }

  // PUT /api/router/mode
  if (method === 'PUT' && url === '/api/router/mode') {
    const body = await parseJsonBody(req);
    const mode = body.mode as string;
    if (!['auto', 'suggest', 'manual'].includes(mode)) {
      jsonResponse(res, 400, { error: 'Invalid mode. Use: auto, suggest, manual' });
      return true;
    }
    intentRouter.setMode(mode as 'auto' | 'suggest' | 'manual');
    jsonResponse(res, 200, { mode });
    return true;
  }

  // GET /api/budgets
  if (method === 'GET' && url === '/api/budgets') {
    jsonResponse(res, 200, { budgets: budgetManager.getAllBudgets() });
    return true;
  }

  // PUT /api/budgets/:botName
  if (method === 'PUT' && url.match(/^\/api\/budgets\/[^/]+$/)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const dailyLimitUsd = body.dailyLimitUsd as number;
    if (typeof dailyLimitUsd !== 'number') {
      jsonResponse(res, 400, { error: 'Missing required field: dailyLimitUsd' });
      return true;
    }
    budgetManager.setLimit(botName, dailyLimitUsd);
    jsonResponse(res, 200, { botName, dailyLimitUsd });
    return true;
  }

  // GET /api/costs/report
  if (method === 'GET' && url.startsWith('/api/costs/report')) {
    const parsed = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const period = (parsed.searchParams.get('period') || 'daily') as 'daily' | 'weekly' | 'monthly';
    jsonResponse(res, 200, { period, report: budgetManager.getReport(period) });
    return true;
  }

  // GET /api/circuits
  if (method === 'GET' && url === '/api/circuits') {
    jsonResponse(res, 200, { circuits: circuitBreaker.getStatus() });
    return true;
  }

  // POST /api/circuits/:botName/reset
  if (method === 'POST' && url.match(/^\/api\/circuits\/[^/]+\/reset$/)) {
    const botName = decodeURIComponent(url.split('/')[3]);
    circuitBreaker.reset(botName);
    jsonResponse(res, 200, { reset: true, botName });
    return true;
  }

  // GET /api/teams
  if (method === 'GET' && url === '/api/teams') {
    jsonResponse(res, 200, { teams: teamManager.list() });
    return true;
  }

  // POST /api/teams
  if (method === 'POST' && url === '/api/teams') {
    const body = await parseJsonBody(req);
    const name = body.name as string;
    const members = body.members as string[] | undefined;
    const budgetDailyUsd = body.budgetDailyUsd as number | undefined;
    if (!name) {
      jsonResponse(res, 400, { error: 'Missing required field: name' });
      return true;
    }
    try {
      const team = teamManager.create(name, members, budgetDailyUsd);
      jsonResponse(res, 201, team);
    } catch (err: any) {
      jsonResponse(res, 409, { error: err.message });
    }
    return true;
  }

  // GET /api/teams/:id
  if (method === 'GET' && url.match(/^\/api\/teams\/[^/]+$/) && !url.endsWith('/teams/')) {
    const id = decodeURIComponent(url.split('/')[3]);
    const team = teamManager.get(id) || teamManager.getByName(id);
    if (!team) {
      jsonResponse(res, 404, { error: 'Team not found' });
      return true;
    }
    jsonResponse(res, 200, team);
    return true;
  }

  // PUT /api/teams/:id
  if (method === 'PUT' && url.match(/^\/api\/teams\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const body = await parseJsonBody(req);
    const updated = teamManager.update(id, body as any);
    if (!updated) {
      jsonResponse(res, 404, { error: 'Team not found' });
      return true;
    }
    jsonResponse(res, 200, updated);
    return true;
  }

  // DELETE /api/teams/:id
  if (method === 'DELETE' && url.match(/^\/api\/teams\/[^/]+$/)) {
    const id = decodeURIComponent(url.split('/')[3]);
    const deleted = teamManager.delete(id);
    jsonResponse(res, deleted ? 200 : 404, { deleted });
    return true;
  }

  return false;
}

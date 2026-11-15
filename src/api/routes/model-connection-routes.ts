import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import { readBotsConfig, writeBotsConfig } from '../bots-config-writer.js';
import { connectionUsers, parseModelConnection, validateConnectionSelection } from '../../model-connections.js';
import { jsonResponse, parseJsonBody } from './helpers.js';
import type { RouteContext } from './types.js';

/** Only reached through the local admin authentication gate. Never return upstream errors or keys. */
export async function handleModelConnectionRoutes(ctx: RouteContext, req: http.IncomingMessage, res: http.ServerResponse, method: string, url: string): Promise<boolean> {
  const prefix = '/admin/api/model-connections';
  if (url !== prefix && !url.startsWith(`${prefix}/`)) return false;
  if (!ctx.botsConfigPath) {
    jsonResponse(res, 400, { error: '需要先配置 BOTS_CONFIG 才能管理模型连接' });
    return true;
  }
  // Finish reading before taking the config snapshot; writes then remain synchronous.
  const body = (method === 'PUT' || (method === 'POST' && url === prefix)) ? await parseJsonBody(req) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    jsonResponse(res, 400, { error: '请求正文须为对象' }); return true;
  }
  const cfg = readBotsConfig(ctx.botsConfigPath);
  const connections = cfg.modelConnections || [];
  const suffix = url.slice(prefix.length);
  try {
    if (method === 'GET' && !suffix) {
      jsonResponse(res, 200, {
        defaultConnection: cfg.defaultModelConnection || 'legacy',
        connections: connections.map(({ apiKey, ...c }) => ({ ...c, disableNonessentialTraffic: c.disableNonessentialTraffic ?? false, hasApiKey: !!apiKey, affectedBots: connectionUsers(cfg, c.id) })),
        inheritedBots: (cfg.feishuBots || []).filter(b => !b.modelConnection && (b.engine || process.env.LUCKAGENT_ENGINE || 'claude') === 'claude').map(b => b.name),
      });
      return true;
    }
    if (method === 'PUT' && suffix === '/default') {
      validateConnectionSelection(body.connection, cfg, true);
      cfg.defaultModelConnection = typeof body.connection === 'string' && body.connection ? body.connection : 'legacy';
    } else if (method === 'POST' && !suffix) {
      cfg.modelConnections = [...connections, parseModelConnection(body, randomUUID())];
    } else {
      const match = /^\/([a-zA-Z0-9-]+)(\/test)?$/.exec(suffix);
      const connection = match && connections.find(c => c.id === match[1]);
      if (!connection) { jsonResponse(res, 404, { error: '模型连接不存在' }); return true; }
      if (method === 'POST' && match?.[2]) {
        if (!connection.apiKey) throw new Error('请先保存 API Key，再测试连接');
        // Test only the saved endpoint. Redirects must not forward credentials.
        try {
          const response = await fetch(`${connection.baseUrl}/v1/messages`, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
            headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01', Authorization: `Bearer ${connection.apiKey}`, 'x-api-key': connection.apiKey },
            body: JSON.stringify({ model: connection.model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply OK.' }] }),
          });
          if (!response.ok) {
            await response.body?.cancel();
            jsonResponse(res, 200, { ok: false, message: `连接失败（HTTP ${response.status}），请检查地址、Key、模型权限及余额` });
          } else {
            const data = await response.json() as { type?: string; content?: unknown[] };
            const ok = data.type === 'message' && Array.isArray(data.content);
            jsonResponse(res, 200, { ok, message: ok ? '认证与模型调用成功' : '响应不是 Anthropic Messages 格式，请检查接口地址' });
          }
        } catch {
          jsonResponse(res, 200, { ok: false, message: '请求超时或网络连接失败，请检查接口地址及网络' });
        }
        return true;
      }
      if (match?.[2]) { jsonResponse(res, 405, { error: '不支持此操作' }); return true; }
      if (method === 'PUT') {
        cfg.modelConnections = connections.map(c => c.id === connection.id ? parseModelConnection(body, c.id, c) : c);
      } else if (method === 'DELETE') {
        if (cfg.defaultModelConnection === connection.id || cfg.feishuBots?.some(b => b.modelConnection === connection.id)) {
          throw new Error('此连接仍被全局默认或机器人引用，请先切换接入方式再删除');
        }
        cfg.modelConnections = connections.filter(c => c.id !== connection.id);
      } else { jsonResponse(res, 405, { error: '不支持此操作' }); return true; }
    }
    writeBotsConfig(ctx.botsConfigPath, cfg);
    jsonResponse(res, 200, { saved: true, requiresRestart: true });
  } catch (err) {
    // Only our validation messages are exposed; filesystem failures may contain sensitive data.
    const message = err instanceof Error && !('code' in err) ? err.message : '配置保存失败';
    jsonResponse(res, 400, { error: message });
  }
  return true;
}

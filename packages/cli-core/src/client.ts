import type { Config } from './config.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

export interface ClientError extends Error {
  status: number;
  body: unknown;
}

function buildUrl(base: string, p: string, query?: RequestOptions['query']): string {
  const url = new URL(base + p);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

export async function request<T = unknown>(
  cfg: Config,
  opts: RequestOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = buildUrl(cfg.url, opts.path, opts.query);
  const method = opts.method || 'GET';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.token}`,
    Accept: 'application/json',
  };
  let body: string | undefined;
  if (opts.body !== undefined && opts.body !== null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  const res = await fetchImpl(url, { method, headers, body });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      // leave as raw text
    }
  }
  if (!res.ok) {
    const errMsg =
      typeof parsed === 'object' && parsed && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : String(parsed);
    const e = new Error(`luckagent-core ${method} ${opts.path} → ${res.status}: ${errMsg}`) as ClientError;
    e.status = res.status;
    e.body = parsed;
    throw e;
  }
  return parsed as T;
}

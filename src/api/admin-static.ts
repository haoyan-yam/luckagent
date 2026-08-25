import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as http from 'node:http';

/**
 * Static file server for the built admin console (packages/admin-ui →
 * dist/admin). Serves GET/HEAD under /admin/*; returns false when the request
 * is not for the admin UI so normal routing continues.
 *
 * Security: the root is fixed; the resolved path must stay inside it
 * (prefix check after path.resolve). Hash-named assets get immutable caching;
 * index.html is no-cache so a redeploy is picked up immediately.
 */

const ADMIN_ROOT = path.resolve(process.cwd(), 'dist', 'admin');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

function send(res: http.ServerResponse, absPath: string, immutable: boolean, method: string): boolean {
  let stat: fs.Stats;
  let real: string;
  try {
    real = fs.realpathSync(absPath);
    stat = fs.statSync(real);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  // Defense-in-depth: after resolving symlinks the file must still live
  // inside the admin build dir — a planted symlink can't read outside it.
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(ADMIN_ROOT);
  } catch {
    return false;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return false;
  const ext = path.extname(absPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(absPath).pipe(res);
  return true;
}

export function serveAdminStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  method: string,
  url: string,
): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;

  // Root redirect for discoverability: / → /admin/
  if (url === '/' ) {
    res.writeHead(302, { Location: '/admin/' });
    res.end();
    return true;
  }

  if (url !== '/admin' && !url.startsWith('/admin/')) return false;
  if (url.startsWith('/admin/api/')) return false;

  if (url === '/admin') {
    res.writeHead(301, { Location: '/admin/' });
    res.end();
    return true;
  }

  const pathname = url.split('?')[0];
  // Reject any '..' path segment outright.
  if (pathname.split('/').some((seg) => seg === '..')) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"bad_path"}');
    return true;
  }

  const rel = pathname === '/admin/' ? 'index.html' : pathname.slice('/admin/'.length);
  const resolved = path.resolve(ADMIN_ROOT, rel);
  if (resolved !== ADMIN_ROOT && !resolved.startsWith(ADMIN_ROOT + path.sep)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"bad_path"}');
    return true;
  }

  const immutable = rel.startsWith('assets/');
  if (send(res, resolved, immutable, method)) return true;

  // Fallback to index.html (HashRouter means this is rarely needed).
  if (send(res, path.join(ADMIN_ROOT, 'index.html'), false, method)) return true;

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"error":"admin_ui_not_built","hint":"run: npm run build"}');
  return true;
}

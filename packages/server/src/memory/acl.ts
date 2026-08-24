import { Credential, canRead as credCanRead, canReadDoc as credCanReadDoc, canWrite as credCanWrite } from '../auth/credentials.js';

export function canReadPath(cred: Credential, path: string): boolean {
  return credCanRead(cred, path);
}

/**
 * Document-level read: path-based access OR an explicit `shared` flag. Used by
 * the document read paths (get/list/search) so a shared doc is visible across
 * namespaces without living under `/shared/`.
 */
export function canReadDoc(cred: Credential, path: string, shared: boolean): boolean {
  return credCanReadDoc(cred, path, shared);
}

export function canWritePath(cred: Credential, path: string): boolean {
  return credCanWrite(cred, path);
}

/**
 * Return the set of namespace roots a credential can read from, used to scope
 * search/list. Admin gets ['/']; members get '/shared' plus each configured
 * readable namespace.
 */
export function readableRoots(cred: Credential): string[] {
  if (cred.role === 'admin') return ['/'];
  const roots = new Set<string>(['/shared']);
  for (const ns of cred.readableNamespaces) roots.add(ns);
  return [...roots];
}

export function normalizePath(p: string): string {
  if (!p) return '/';
  let out = p.trim();
  if (!out.startsWith('/')) out = '/' + out;
  out = out.replace(/\/+/g, '/');
  if (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/** Join folder path + child name. */
export function joinPath(folder: string, name: string): string {
  const base = folder === '/' ? '' : folder.replace(/\/+$/, '');
  return `${base}/${name}`;
}

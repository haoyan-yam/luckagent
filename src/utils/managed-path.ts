import * as path from 'node:path';

/** Resolve a path only when it stays inside the managed root. */
export function resolveWithinRoot(root: string, ...parts: string[]): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...parts);
  const relative = path.relative(resolvedRoot, resolvedPath);

  if (relative === '') return resolvedPath;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return resolvedPath;
}

/**
 * Minimal glob → RegExp for housekeeping rules. Paths are POSIX, relative to a
 * rule's root. Supported: `**` (any depth; a leading double-star segment also matches zero dirs),
 * `*` (within one segment), `?`, `{a,b}` alternation. Case-insensitive, since
 * macOS volumes usually are.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegStart = i === 0 || glob[i - 1] === '/';
        if (atSegStart && glob[i + 2] === '/') {
          re += '(?:[^/]*/)*'; // `**/` → zero or more whole directories
          i += 3;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      braceDepth++;
      re += '(?:';
    } else if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (c === ',' && braceDepth > 0) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i++;
  }
  return new RegExp(`^${re}$`, 'i');
}

export function compileGlobs(globs: string[]): RegExp[] {
  return globs.map((g) => g.trim()).filter(Boolean).map(globToRegExp);
}

export function matchesAny(rel: string, res: RegExp[]): boolean {
  return res.some((r) => r.test(rel));
}

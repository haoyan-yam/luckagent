export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | true>;
}

/**
 * Light argparse. Supports `--name value`, `--name=value`, and `-n value`.
 * `--` ends flag parsing.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        i++;
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[a.slice(2)] = next;
          i += 2;
        } else {
          flags[a.slice(2)] = true;
          i++;
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[a.slice(1)] = next;
        i += 2;
      } else {
        flags[a.slice(1)] = true;
        i++;
      }
    } else {
      positional.push(a);
      i++;
    }
  }
  return { positional, flags };
}

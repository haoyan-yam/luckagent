import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// Personal edition default: a luckagent-core server running locally. Override
// with LUCKAGENT_CORE_URL to point at a remote/self-hosted host.
export const DEFAULT_URL = 'http://localhost:9200';

export interface Config {
  url: string;
  token: string;
}

function readFirstLine(p: string): string | null {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const line = raw.split(/\r?\n/)[0]?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

export function tokenFilePath(): string {
  return path.join(os.homedir(), '.luckagent-core', 'token');
}

/**
 * Resolve URL + token.
 *
 * URL precedence:   LUCKAGENT_CORE_URL → DEFAULT_URL.
 * Token precedence: LUCKAGENT_CORE_TOKEN → ~/.luckagent-core/token (first line).
 *
 * Throws when no token is configured.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = (env.LUCKAGENT_CORE_URL || DEFAULT_URL).replace(/\/+$/, '');
  let token = (env.LUCKAGENT_CORE_TOKEN || '').trim();
  if (!token) {
    const fromFile = readFirstLine(tokenFilePath());
    if (fromFile) token = fromFile;
  }
  if (!token) {
    throw new Error(
      `no token configured — set LUCKAGENT_CORE_TOKEN env var, or write the token to ${tokenFilePath()}`,
    );
  }
  return { url, token };
}

import { execFile } from 'node:child_process';
import * as os from 'node:os';
import type { BotConfigBase } from '../config.js';
import { resolveEngineName } from '../engines/index.js';

export interface ClaudeAuthStatus {
  source: 'cli';
  checkedAt: string;
  cliInstalled: boolean;
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  subscriptionType?: string;
  email?: string;
  error?: string;
}

type ProbeMode = 'local' | 'sdk' | 'pty';
type CliRunner = (cwd: string, mode: ProbeMode) => Promise<string>;
export type AuthProbe = (cwd?: string, mode?: ProbeMode) => Promise<ClaudeAuthStatus>;

const runCli: CliRunner = (cwd, mode) => new Promise((resolve, reject) => {
  const env = { ...process.env };
  // Match the SDK's auth-relevant environment filtering; PTY preserves host
  // auth variables. Never invoke login, a model request, or an API-key helper.
  if (mode === 'sdk') {
    for (const key of Object.keys(env)) if (key.startsWith('CLAUDE')) delete env[key];
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  const args: string[] = mode === 'sdk' ? ['--setting-sources', 'user,project'] : [];
  if (mode === 'local') {
    const isolated = {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '',
      CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '', CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    };
    Object.assign(env, isolated);
    args.push('--settings', JSON.stringify({ apiKeyHelper: '', env: isolated }));
  }
  args.push('auth', 'status', '--json');
  execFile(process.env.CLAUDE_EXECUTABLE_PATH || 'claude', args,
    { cwd, env, timeout: 5000, maxBuffer: 128 * 1024 }, (err, stdout) => {
      // `auth status` may exit 1 while returning a valid logged-out result.
      if (err && (err.code !== 1 || !stdout.trim())) reject(err);
      else resolve(stdout);
    });
});

/** Short-lived, in-flight-deduplicated results; never fall back to ~/.claude.json. */
export function createAuthProbe(run: CliRunner = runCli, now = Date.now): AuthProbe {
  const cache = new Map<string, { expires: number; result: Promise<ClaudeAuthStatus> }>();
  return (cwd = os.homedir(), mode = 'local') => {
    const key = JSON.stringify([cwd, mode]);
    const previous = cache.get(key);
    if (previous && previous.expires > now()) return previous.result;
    const checkedAt = new Date(now()).toISOString();
    const result = run(cwd, mode).then(raw => {
      const data = JSON.parse(raw);
      if (typeof data?.loggedIn !== 'boolean') throw new Error('Invalid CLI status');
      // Strict allowlist: stdout/stderr and credentials never reach the API.
      const status: ClaudeAuthStatus = { source: 'cli', checkedAt, cliInstalled: true, loggedIn: data.loggedIn };
      for (const field of ['authMethod', 'apiProvider', 'subscriptionType', 'email'] as const) {
        if (typeof data[field] === 'string') status[field] = data[field];
      }
      return status;
    }).catch((err: NodeJS.ErrnoException): ClaudeAuthStatus => ({
      source: 'cli', checkedAt, cliInstalled: err.code !== 'ENOENT',
      error: err.code === 'ENOENT' ? '未找到 Claude CLI' : 'CLI 认证状态查询失败，请稍后重试',
    }));
    // Bound retained working directories when bots are removed or moved.
    for (const [k, value] of cache) if (value.expires <= now()) cache.delete(k);
    cache.set(key, { expires: now() + 60000, result });
    return result;
  };
}

export const queryClaudeAuthStatus = createAuthProbe();

export async function inspectLocalClaudeUsage(
  running: Array<{ name: string; config: BotConfigBase }> | undefined,
  probe: AuthProbe = queryClaudeAuthStatus,
) {
  const claudeAuth = await probe();
  if (!running) return { claudeAuth, runningBots: null, inheritedLoginBots: null, legacyClaudeBots: null };
  const runningBots = running.filter(b => resolveEngineName(b.config) === 'claude' && b.config.claude.connection === 'local').map(b => b.name);
  const candidates = running.filter(b => resolveEngineName(b.config) === 'claude' && !b.config.claude.connection && !b.config.claude.apiKey);
  const inheritedLoginBots: string[] = [];
  const legacyClaudeBots: string[] = [];
  for (let i = 0; i < candidates.length; i += 4) {
    const group = await Promise.all(candidates.slice(i, i + 4).map(async b => ({
      name: b.name, auth: await probe(b.config.claude.defaultWorkingDirectory, b.config.claude.backend === 'sdk' ? 'sdk' : 'pty'),
    })));
    for (const { name, auth } of group) {
      const sameLocalAccount = !claudeAuth.error && claudeAuth.loggedIn && claudeAuth.authMethod === 'claude.ai'
        && claudeAuth.apiProvider === 'firstParty' && !!claudeAuth.email
        && !auth.error && auth.loggedIn && auth.authMethod === 'claude.ai'
        && auth.apiProvider === 'firstParty' && auth.email === claudeAuth.email;
      if (sameLocalAccount) { inheritedLoginBots.push(name); runningBots.push(name); }
      else legacyClaudeBots.push(name);
    }
  }
  return { claudeAuth, runningBots, inheritedLoginBots, legacyClaudeBots };
}

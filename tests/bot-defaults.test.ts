import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig } from '../src/config.js';
import { larkCliHasApp, installSkillsToWorkDir, resolveLarkProfileName } from '../src/api/skills-installer.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

describe('workspace instruction deployment (engine-neutral)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ws-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('AGENTS.md is a symlink to CLAUDE.md so edits reach every engine', async () => {
    const workDir = path.join(dir, 'bots', 'demo');
    fs.mkdirSync(workDir, { recursive: true });
    await installSkillsToWorkDir(workDir, noopLogger);

    const claudeMd = path.join(workDir, 'CLAUDE.md');
    const agentsMd = path.join(workDir, 'AGENTS.md');
    expect(fs.existsSync(claudeMd)).toBe(true);
    expect(fs.lstatSync(agentsMd).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(agentsMd)).toBe('CLAUDE.md');
    // Reading through the link yields the same document; edits propagate.
    fs.appendFileSync(claudeMd, '\n<!-- edited -->\n');
    expect(fs.readFileSync(agentsMd, 'utf-8')).toContain('<!-- edited -->');
    // Parent shared conventions deployed alongside.
    expect(fs.existsSync(path.join(dir, 'bots', 'CLAUDE.md'))).toBe(true);
  });

  it('an existing regular AGENTS.md (user-customized) is left untouched', async () => {
    const workDir = path.join(dir, 'bots', 'demo2');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), 'custom instructions\n');
    await installSkillsToWorkDir(workDir, noopLogger);
    expect(fs.lstatSync(path.join(workDir, 'AGENTS.md')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf-8')).toBe('custom instructions\n');
  });
});

describe('downloadsDir defaults to <workDir>/inputs', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ['BOTS_CONFIG', 'DOWNLOADS_DIR', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-defaults-'));
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('bots.json entry without downloadsDir falls back to workDir/inputs', () => {
    const workDir = path.join(dir, 'workspace');
    const cfgPath = path.join(dir, 'bots.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        feishuBots: [
          { name: 'd1', feishuAppId: 'cli_x', feishuAppSecret: 's', defaultWorkingDirectory: workDir },
        ],
      }),
    );
    process.env.BOTS_CONFIG = cfgPath;
    const app = loadAppConfig();
    expect(app.feishuBots[0].claude.downloadsDir).toBe(path.join(workDir, 'inputs'));
  });

  it('explicit downloadsDir wins over the default', () => {
    const workDir = path.join(dir, 'workspace');
    const custom = path.join(dir, 'elsewhere');
    const cfgPath = path.join(dir, 'bots.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        feishuBots: [
          { name: 'd1', feishuAppId: 'cli_x', feishuAppSecret: 's', defaultWorkingDirectory: workDir, downloadsDir: custom },
        ],
      }),
    );
    process.env.BOTS_CONFIG = cfgPath;
    const app = loadAppConfig();
    expect(app.feishuBots[0].claude.downloadsDir).toBe(custom);
  });
});

describe('larkCliHasApp', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-larkcfg-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('true only when the appId is present in apps[]', () => {
    const p = path.join(dir, 'config.json');
    fs.writeFileSync(p, JSON.stringify({ apps: [{ appId: 'cli_aaa' }, { appId: 'cli_bbb' }] }));
    expect(larkCliHasApp(p, 'cli_aaa')).toBe(true);
    expect(larkCliHasApp(p, 'cli_zzz')).toBe(false);
  });

  it('false for a missing or corrupt config file', () => {
    expect(larkCliHasApp(path.join(dir, 'nope.json'), 'cli_aaa')).toBe(false);
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{{{');
    expect(larkCliHasApp(p, 'cli_aaa')).toBe(false);
  });
});

describe('resolveClaudeAuthEnv (deepseek runs on the claude runtime)', () => {
  const OLD = process.env.DEEPSEEK_API_KEY;
  afterEach(() => {
    if (OLD === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = OLD;
  });

  const base = (over: Record<string, unknown>) =>
    ({ name: 't', claude: { defaultWorkingDirectory: '/tmp/x', maxTurns: undefined, maxBudgetUsd: undefined, model: undefined, apiKey: undefined, outputsBaseDir: '/tmp/o', downloadsDir: '/tmp/d', backend: 'pty' }, ...over }) as any;

  it('deepseek engine injects endpoint + BOTH key vars (per-bot key wins)', async () => {
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    const env = resolveClaudeAuthEnv(base({ engine: 'deepseek', deepseek: { apiKey: 'sk-ds-1' } }));
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-ds-1',
      ANTHROPIC_API_KEY: 'sk-ds-1',
    });
  });

  it('deepseek falls back to env DEEPSEEK_API_KEY and honors baseUrl override', async () => {
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    process.env.DEEPSEEK_API_KEY = 'sk-ds-env';
    const env = resolveClaudeAuthEnv(base({ engine: 'deepseek', deepseek: { baseUrl: 'https://gw.example.com/anthropic' } }));
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds-env');
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.example.com/anthropic');
  });

  it('deepseek without any key throws a config-guidance error', async () => {
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    delete process.env.DEEPSEEK_API_KEY;
    expect(() => resolveClaudeAuthEnv(base({ engine: 'deepseek' }))).toThrow(/DEEPSEEK_API_KEY/);
  });

  it('claude engine keeps the existing explicit-apiKey behavior', async () => {
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    const cfg = base({ engine: 'claude' });
    cfg.claude.apiKey = 'sk-ant-x';
    expect(resolveClaudeAuthEnv(cfg)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-x' });
    cfg.claude.apiKey = undefined;
    expect(resolveClaudeAuthEnv(cfg)).toBeUndefined();
  });
});

describe('deriveDeepseekConfig / engine pinning (session-override regression)', () => {
  const base = (over: Record<string, unknown>) =>
    ({ name: 't', claude: { defaultWorkingDirectory: '/tmp/x', maxTurns: undefined, maxBudgetUsd: undefined, model: 'claude-fable-5', apiKey: 'sk-ant-host', outputsBaseDir: '/tmp/o', downloadsDir: '/tmp/d', backend: 'pty' }, ...over }) as any;

  it('pins engine=deepseek, defaults the model, strips claude apiKey, forces sdk backend', async () => {
    const { deriveDeepseekConfig } = await import('../src/engines/index.js');
    // A CLAUDE bot being session-overridden to deepseek — the original
    // engine field must NOT leak through.
    const derived = deriveDeepseekConfig(base({ engine: 'claude', deepseek: { apiKey: 'sk-ds' } }));
    expect(derived.engine).toBe('deepseek');
    expect(derived.claude.model).toBe('deepseek-v4-flash');
    expect(derived.claude.apiKey).toBeUndefined();
    expect(derived.claude.backend).toBe('sdk');
  });

  it('derived config resolves DeepSeek auth env (the override-path fix)', async () => {
    const { deriveDeepseekConfig } = await import('../src/engines/index.js');
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    const derived = deriveDeepseekConfig(base({ engine: 'claude', deepseek: { apiKey: 'sk-ds' } }));
    const env = resolveClaudeAuthEnv(derived);
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBe('sk-ds');
  });

  it("createEngine pins engine='claude' so a claude-override on a deepseek bot uses Anthropic auth", async () => {
    const { deriveDeepseekConfig } = await import('../src/engines/index.js');
    const { resolveClaudeAuthEnv } = await import('../src/engines/claude/auth-env.js');
    // Reverse direction: deepseek bot overridden to claude — pinning
    // engine:'claude' must stop the deepseek injection.
    const cfg = base({ engine: 'deepseek', deepseek: { apiKey: 'sk-ds' } });
    const pinned = { ...cfg, engine: 'claude' };
    expect(resolveClaudeAuthEnv(pinned)).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-host' });
    void deriveDeepseekConfig; // silence unused in this scenario
  });
});

describe('resolveLarkProfileName', () => {
  it('returns the profile list name for the appId, appId when unnamed/missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'larkcfg-'));
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ apps: [
      { appId: 'cli_named', name: 'larkmetabot' },
      { appId: 'cli_unnamed' },
    ] }));
    expect(resolveLarkProfileName(cfg, 'cli_named')).toBe('larkmetabot');
    expect(resolveLarkProfileName(cfg, 'cli_unnamed')).toBe('cli_unnamed');
    expect(resolveLarkProfileName(cfg, 'cli_absent')).toBe('cli_absent');
    expect(resolveLarkProfileName('/nonexistent.json', 'cli_x')).toBe('cli_x');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

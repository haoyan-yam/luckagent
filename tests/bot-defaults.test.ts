import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig } from '../src/config.js';
import { larkCliHasApp, installSkillsToWorkDir, opencliAvailable } from '../src/api/skills-installer.js';

const noopLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

describe('workspace instruction deployment (engine-neutral)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-ws-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('AGENTS.md is a symlink to CLAUDE.md so edits reach every engine', () => {
    const workDir = path.join(dir, 'bots', 'demo');
    fs.mkdirSync(workDir, { recursive: true });
    installSkillsToWorkDir(workDir, noopLogger);

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

  it('opencli skill is installed only when the binary is on PATH', () => {
    const savedPath = process.env.PATH;
    try {
      // Fake bin dir containing an executable `opencli`
      const fakeBin = path.join(dir, 'bin');
      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'opencli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      process.env.PATH = fakeBin;
      expect(opencliAvailable()).toBe(true);
      const withDir = path.join(dir, 'bots', 'with-opencli');
      fs.mkdirSync(withDir, { recursive: true });
      installSkillsToWorkDir(withDir, noopLogger);
      expect(fs.existsSync(path.join(withDir, '.claude', 'skills', 'opencli', 'SKILL.md'))).toBe(true);

      process.env.PATH = path.join(dir, 'empty-bin');
      expect(opencliAvailable()).toBe(false);
      const withoutDir = path.join(dir, 'bots', 'without-opencli');
      fs.mkdirSync(withoutDir, { recursive: true });
      installSkillsToWorkDir(withoutDir, noopLogger);
      expect(fs.existsSync(path.join(withoutDir, '.claude', 'skills', 'opencli'))).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('an existing regular AGENTS.md (user-customized) is left untouched', () => {
    const workDir = path.join(dir, 'bots', 'demo2');
    fs.mkdirSync(workDir, { recursive: true });
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), 'custom instructions\n');
    installSkillsToWorkDir(workDir, noopLogger);
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

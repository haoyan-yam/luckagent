import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadAppConfig } from '../src/config.js';
import { larkCliHasApp } from '../src/api/skills-installer.js';

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

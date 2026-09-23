import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyEnvUpdates, displayDefault, validateDefaultsUpdate, writeEnvUpdates } from '../src/api/env-defaults.js';

describe('validateDefaultsUpdate', () => {
  it('accepts whitelisted keys with valid values and trims them', () => {
    const r = validateDefaultsUpdate({
      LUCKAGENT_ENGINE: 'deepseek',
      CLAUDE_MODEL: ' claude-opus-5 ',
      DEEPSEEK_MODEL: 'deepseek-v4-pro',
      MINIMAX_MODEL: 'MiniMax-M2.5',
      IMAGE_GEN_PROVIDER: 'codex',
    });
    expect(r).toEqual({
      updates: {
        LUCKAGENT_ENGINE: 'deepseek',
        CLAUDE_MODEL: 'claude-opus-5',
        DEEPSEEK_MODEL: 'deepseek-v4-pro',
        MINIMAX_MODEL: 'MiniMax-M2.5',
        IMAGE_GEN_PROVIDER: 'codex',
      },
    });
  });

  it('treats empty strings as "unset"', () => {
    expect(validateDefaultsUpdate({ CLAUDE_MODEL: '', IMAGE_GEN_PROVIDER: '' })).toEqual({
      updates: { CLAUDE_MODEL: '', IMAGE_GEN_PROVIDER: '' },
    });
  });

  it('rejects keys outside the whitelist', () => {
    expect(validateDefaultsUpdate({ API_SECRET: 'x' })).toEqual({ error: 'Not editable from the console: API_SECRET' });
    expect(validateDefaultsUpdate({ ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxx' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ API_PORT: '9101' })).toHaveProperty('error');
  });

  it('accepts the video-generation keys (Ark key + TOS) with narrow charsets', () => {
    expect(
      validateDefaultsUpdate({
        ARK_API_KEY: '1f2e3d4c-aaaa-bbbb-cccc-0123456789ab',
        TOS_ACCESS_KEY: 'AKLTabcdef0123456789',
        TOS_SECRET_KEY: 'TWpBd01qRTRZV0kxTkRnME5HWQ==',
        TOS_BUCKET: 'team-seedance-refs',
        TOS_REGION: 'cn-beijing',
      }),
    ).toHaveProperty('updates');
    expect(validateDefaultsUpdate({ TOS_BUCKET: 'Bad_Bucket' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ TOS_REGION: 'beijing' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ TOS_SECRET_KEY: 'has space inside' })).toHaveProperty('error');
  });

  it('never echoes a rejected secret in the error', () => {
    const r = validateDefaultsUpdate({ ARK_API_KEY: 'bad key\nAPI_SECRET=x' }) as { error: string };
    expect(r.error).toBe('Invalid value for ARK_API_KEY');
  });

  it('rejects invalid values', () => {
    expect(validateDefaultsUpdate({ LUCKAGENT_ENGINE: 'gpt' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ IMAGE_GEN_PROVIDER: 'openai' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ DEEPSEEK_MODEL: 'deepseek-v9' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ CLAUDE_MODEL: 'x\nAPI_SECRET=pwned' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ CLAUDE_MODEL: 'has space' })).toHaveProperty('error');
    expect(validateDefaultsUpdate({ CLAUDE_MODEL: 5 })).toHaveProperty('error');
  });

  it('rejects empty and non-object bodies', () => {
    expect(validateDefaultsUpdate({})).toEqual({ error: 'Nothing to update' });
    expect(validateDefaultsUpdate(null)).toHaveProperty('error');
    expect(validateDefaultsUpdate(['x'])).toHaveProperty('error');
  });
});

describe('applyEnvUpdates', () => {
  const base = [
    'API_SECRET=keep-me',
    '# CLAUDE_MODEL=claude-opus-5        # 留空（推荐）',
    '# IMAGE_GEN_PROVIDER=codex',
    'DEEPSEEK_MODEL=deepseek-v4-flash',
    '',
  ].join('\n');

  it('replaces an active line in place', () => {
    const out = applyEnvUpdates(base, { DEEPSEEK_MODEL: 'deepseek-v4-pro' });
    expect(out).toContain('DEEPSEEK_MODEL=deepseek-v4-pro');
    expect(out).not.toContain('deepseek-v4-flash');
    expect(out.split('\n')[3]).toBe('DEEPSEEK_MODEL=deepseek-v4-pro');
  });

  it('fills the commented template line when there is no active line', () => {
    const out = applyEnvUpdates(base, { IMAGE_GEN_PROVIDER: 'seedream' });
    expect(out.split('\n')[2]).toBe('IMAGE_GEN_PROVIDER=seedream');
  });

  it('appends when neither an active nor a template line exists', () => {
    const out = applyEnvUpdates(base, { LUCKAGENT_ENGINE: 'minimax' });
    expect(out.trimEnd().split('\n').pop()).toBe('LUCKAGENT_ENGINE=minimax');
  });

  it('comments out active lines when unsetting', () => {
    const out = applyEnvUpdates(base, { DEEPSEEK_MODEL: '' });
    expect(out).toContain('# DEEPSEEK_MODEL=');
    expect(out).not.toMatch(/^DEEPSEEK_MODEL=/m);
  });

  it('leaves the file unchanged when unsetting a key that is not active', () => {
    expect(applyEnvUpdates(base, { CLAUDE_MODEL: '' })).toBe(base);
  });

  it('collapses duplicate active lines (dotenv lets the last one win)', () => {
    const dup = 'CLAUDE_MODEL=a\nX=1\nCLAUDE_MODEL=b\n';
    expect(applyEnvUpdates(dup, { CLAUDE_MODEL: 'c' })).toBe('CLAUDE_MODEL=c\nX=1\n');
  });

  it('never touches other keys', () => {
    const out = applyEnvUpdates(base, { CLAUDE_MODEL: 'claude-opus-5', DEEPSEEK_MODEL: '' });
    expect(out.split('\n')[0]).toBe('API_SECRET=keep-me');
  });
});

describe('writeEnvUpdates', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-defaults-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes atomically and keeps the 0600 mode', () => {
    const p = path.join(dir, '.env');
    fs.writeFileSync(p, 'API_SECRET=s\n# IMAGE_GEN_PROVIDER=codex\n', { mode: 0o600 });
    writeEnvUpdates(p, { IMAGE_GEN_PROVIDER: 'codex' });
    expect(fs.readFileSync(p, 'utf-8')).toBe('API_SECRET=s\nIMAGE_GEN_PROVIDER=codex\n');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['.env']);
  });

  it('creates a missing .env with mode 0600', () => {
    const p = path.join(dir, '.env');
    writeEnvUpdates(p, { LUCKAGENT_ENGINE: 'deepseek' });
    expect(fs.readFileSync(p, 'utf-8')).toBe('LUCKAGENT_ENGINE=deepseek\n');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('displayDefault', () => {
  it('masks secrets to a tail hint and leaves plain values alone', () => {
    expect(displayDefault('ARK_API_KEY', '1f2e3d4c-aaaa-bbbb-cccc-0123456789ab')).toBe('••••89ab');
    expect(displayDefault('TOS_SECRET_KEY', 'abcdefgh1234')).toBe('••••1234');
    expect(displayDefault('TOS_BUCKET', 'team-refs')).toBe('team-refs');
    expect(displayDefault('ARK_API_KEY', '')).toBe('');
  });
});

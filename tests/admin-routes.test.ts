import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailLogFile } from '../src/api/routes/admin-routes.js';
import { redactBotEntry, stripMaskedSecrets } from '../src/api/routes/bot-routes.js';

describe('tailLogFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-admin-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty for a missing file', () => {
    const r = tailLogFile(path.join(dir, 'nope.log'), 100);
    expect(r.lines).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it('returns the last N lines', () => {
    const p = path.join(dir, 'a.log');
    fs.writeFileSync(p, Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n') + '\n');
    const r = tailLogFile(p, 10);
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]).toBe('line-40');
    expect(r.lines[9]).toBe('line-49');
    expect(r.truncated).toBe(true);
  });

  it('caps the requested line count at 1000', () => {
    const p = path.join(dir, 'b.log');
    fs.writeFileSync(p, Array.from({ length: 1500 }, (_, i) => `l${i}`).join('\n') + '\n');
    const r = tailLogFile(p, 999999);
    expect(r.lines).toHaveLength(1000);
    expect(r.lines[999]).toBe('l1499');
  });

  it('reads only the tail of a very large file and drops the partial first line', () => {
    const p = path.join(dir, 'c.log');
    // ~600KB of lines; the byte cap is 512KB so the head must be skipped.
    const line = 'x'.repeat(100);
    fs.writeFileSync(p, Array.from({ length: 6000 }, (_, i) => `${i}:${line}`).join('\n') + '\n');
    const r = tailLogFile(p, 1000);
    expect(r.truncated).toBe(true);
    expect(r.lines).toHaveLength(1000);
    // Every returned line must be complete (starts with an index prefix).
    expect(r.lines[0]).toMatch(/^\d+:x+$/);
    expect(r.lines[999]).toBe(`5999:${line}`);
  });
});

describe('bot secret redaction', () => {
  it('masks feishuAppSecret and nested apiKey, keeps other fields', () => {
    const entry = {
      name: 'demo',
      feishuAppId: 'cli_test1234567890ab',
      feishuAppSecret: 'supersecretvalue9876',
      defaultWorkingDirectory: '/tmp/demo',
      codex: { model: 'gpt-5.5', apiKey: 'sk-abcdef123456' },
    };
    const out = redactBotEntry(entry);
    expect(out.feishuAppSecret).toBe('••••9876');
    expect((out.codex as any).apiKey).toBe('••••3456');
    expect(out.feishuAppId).toBe('cli_test1234567890ab');
    expect(out.name).toBe('demo');
    // The original object must be untouched (deep copy).
    expect(entry.feishuAppSecret).toBe('supersecretvalue9876');
  });

  it('stripMaskedSecrets removes echoed masks so they can never be written back', () => {
    const body: Record<string, unknown> = {
      description: 'updated',
      feishuAppSecret: '••••9876',
      codex: { model: 'gpt-5.5', apiKey: '••••3456' },
    };
    stripMaskedSecrets(body);
    expect(body.feishuAppSecret).toBeUndefined();
    expect((body.codex as any).apiKey).toBeUndefined();
    expect((body.codex as any).model).toBe('gpt-5.5');
    expect(body.description).toBe('updated');
  });

  it('stripMaskedSecrets keeps genuinely new secret values', () => {
    const body: Record<string, unknown> = { feishuAppSecret: 'brand-new-secret' };
    stripMaskedSecrets(body);
    expect(body.feishuAppSecret).toBe('brand-new-secret');
  });
});

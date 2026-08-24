import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveProjectChatId } from '../src/project-id.js';

describe('deriveProjectChatId', () => {
  it('produces a proj:<base>:<8-hex> shape', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-project-id-'));
    try {
      const id = deriveProjectChatId(dir);
      expect(id).toMatch(/^proj:[a-z0-9_-]+:[0-9a-f]{8}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is deterministic across calls for the same absolute path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-project-id-'));
    try {
      const a = deriveProjectChatId(dir);
      const b = deriveProjectChatId(dir);
      expect(a).toBe(b);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disambiguates two directories that share a basename', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-project-id-'));
    const dirA = path.join(root, 'workspace-a', 'api');
    const dirB = path.join(root, 'workspace-b', 'api');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    try {
      const a = deriveProjectChatId(dirA);
      const b = deriveProjectChatId(dirB);
      expect(a).not.toBe(b);
      // Same basename slug, different hash.
      expect(a.split(':')[1]).toBe(b.split(':')[1]);
      expect(a.split(':')[2]).not.toBe(b.split(':')[2]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sanitizes basename characters that are not URL-safe', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-project-id-'));
    const dir = path.join(root, 'my project (v2)!');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const id = deriveProjectChatId(dir);
      // No spaces, parens, exclamation marks; only [a-z0-9_-]
      const base = id.split(':')[1];
      expect(base).toMatch(/^[a-z0-9_-]+$/);
      expect(base).not.toMatch(/^-|-$/); // no leading/trailing dash
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to "root" when basename sanitizes to empty', () => {
    // Hard to actually mkdir a name that sanitizes to empty; verify via the
    // pure function with a synthetic path. path.resolve resolves relative
    // paths against cwd, so pass an absolute path.
    const id = deriveProjectChatId('/' + '!!!');
    expect(id.split(':')[1]).toBe('root');
  });

  it('relative cwd resolves to its absolute equivalent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-project-id-'));
    try {
      const abs = deriveProjectChatId(dir);
      const rel = deriveProjectChatId(path.relative(process.cwd(), dir));
      expect(abs).toBe(rel);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

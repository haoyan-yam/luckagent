import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { expandUserPath } from '../src/config.js';

/**
 * Regression: PTY blank-card bug (prod 2026-05-30).
 *
 * The `luckagent` bot had defaultWorkingDirectory: "." in bots.json. expandUserPath
 * returned "." unchanged (it only handled ~ and empty), so the PTY backend's
 * jsonl-path derivation — `cwd.replace(/\//g,'-')` — produced "." and the
 * scanner tailed `~/.claude/projects/./<id>.jsonl`, a path that never exists.
 * claude ran fine and wrote its jsonl to the REAL cwd's escaped dir, but the
 * scanner read nothing → the Feishu card completed with $0.00 and a BLANK body.
 *
 * Only `trunks` (the one bot with an absolute defaultWorkingDirectory) was
 * unaffected — which is why single-bot dogfooding looked healthy.
 *
 * The fix makes expandUserPath always return an ABSOLUTE path for non-empty
 * input. (pty-session also path.resolve()s defensively as a second layer.)
 */
describe('expandUserPath resolves relative paths to absolute', () => {
  it('resolves "." to an absolute path (the prod bug)', () => {
    const out = expandUserPath('.');
    expect(path.isAbsolute(out)).toBe(true);
    expect(out).toBe(path.resolve('.'));
    expect(out).not.toBe('.');
  });

  it('resolves relative "./foo" and "foo/bar" to absolute', () => {
    expect(path.isAbsolute(expandUserPath('./foo'))).toBe(true);
    expect(expandUserPath('foo/bar')).toBe(path.resolve('foo/bar'));
  });

  it('expands ~ and ~/sub to the home directory (absolute)', () => {
    expect(expandUserPath('~')).toBe(os.homedir());
    expect(expandUserPath('~/sub')).toBe(path.join(os.homedir(), 'sub'));
  });

  it('passes absolute paths through unchanged', () => {
    expect(expandUserPath('/vepfs/users/alicew/luckagent')).toBe('/vepfs/users/alicew/luckagent');
  });
});

import { describe, it, expect } from 'vitest';
import { apply1MContextSettings } from '../src/engines/claude/executor.js';

describe('apply1MContextSettings', () => {
  it('sets betas when model has [1m] suffix and leaves env untouched', () => {
    const q: Record<string, unknown> = { model: 'claude-opus-4-7[1m]' };
    apply1MContextSettings(q);
    expect(q.betas).toEqual(['context-1m-2025-08-07']);
    expect(q.env).toBeUndefined();
  });

  it('caps the auto-compact window to 200k when model lacks [1m]', () => {
    const q: Record<string, unknown> = { model: 'claude-opus-4-8' };
    apply1MContextSettings(q);
    expect(q.betas).toBeUndefined();
    const env = q.env as Record<string, string>;
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });

  it('leaves Fable 5 on its native Claude Code context settings', () => {
    const q: Record<string, unknown> = { model: 'claude-fable-5' };
    apply1MContextSettings(q);
    expect(q.betas).toBeUndefined();
    expect(q.env).toBeUndefined();
  });

  it('does NOT cap the auto-compact window when [1m] is requested', () => {
    const q: Record<string, unknown> = { model: 'claude-opus-4-8[1m]' };
    apply1MContextSettings(q);
    expect(q.env).toBeUndefined();
  });

  it('preserves pre-existing env entries when adding the cap flags', () => {
    const q: Record<string, unknown> = {
      model: 'claude-sonnet-4-6',
      env: { FOO: 'bar' },
    };
    apply1MContextSettings(q);
    expect(q.env).toEqual({
      FOO: 'bar',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '200000',
    });
  });

  it('handles undefined model as "lacks [1m]"', () => {
    const q: Record<string, unknown> = {};
    apply1MContextSettings(q);
    const env = q.env as Record<string, string>;
    expect(env.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
  });
});

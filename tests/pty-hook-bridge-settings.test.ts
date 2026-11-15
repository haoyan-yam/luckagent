import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { nonessentialTrafficSettings } from '../src/engines/claude/auth-env.js';
import { createHookBridge } from '../src/engines/claude/pty/hook-bridge.js';

describe('PTY hook bridge — generated --settings', () => {
  it.each(['1', ''])('writes traffic preference %j while preserving hooks', async value => {
    const bridge = createHookBridge();
    try {
      const settings = JSON.parse(readFileSync(await bridge.writeSettings(nonessentialTrafficSettings({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value, ANTHROPIC_AUTH_TOKEN: 'secret-key' })), 'utf8'));
      expect(settings.env).toEqual({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: value });
      expect(settings.hooks?.Stop).toBeDefined();
      expect(JSON.stringify(settings)).not.toContain('secret-key');
    } finally { await bridge.dispose(); }
  });
  it('declares bypass-disclaimer consent alongside the Stop hook', async () => {
    const bridge = createHookBridge();
    try {
      const settings = JSON.parse(readFileSync(await bridge.writeSettings({ apiKeyHelper: '' }), 'utf8'));
      // claude ≥2.1.29x ignores ~/.claude.json's bypassPermissionsModeAccepted;
      // without this the "Bypass Permissions mode" dialog (default "No, exit")
      // blocks every fresh machine. flagSettings scope = luckagent's claude only.
      expect(settings.skipDangerousModePermissionPrompt).toBe(true);
      expect(settings.hooks?.Stop).toBeDefined();
      expect(settings.apiKeyHelper).toBe('');
    } finally {
      await bridge.dispose();
    }
  });
});

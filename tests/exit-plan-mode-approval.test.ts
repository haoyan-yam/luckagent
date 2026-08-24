import { describe, it, expect, vi } from 'vitest';
import { isKeepPlanning } from '../src/engines/claude/persistent-executor.js';
import { driveInteractiveTool, isExitPlanMenu } from '../src/engines/claude/pty/interactive-driver.js';
import type {
  PtyClaudeSession,
  PtyInteractiveResponse,
  PtyInteractiveTool,
} from '../src/engines/claude/pty/contract.js';

/**
 * ExitPlanMode now asks the user (Proceed / Keep planning) instead of silently
 * auto-proceeding. Two pieces under test:
 *   1. isKeepPlanning — maps the user's answer to proceed vs stay-in-plan.
 *   2. the driver — Esc on keep-planning, the menu's bypass digit on approve.
 */

const logger = { debug() {}, info() {}, warn() {}, error() {} } as any;

describe('isKeepPlanning', () => {
  it('proceeds on empty (timeout) — preserves auto-approve', () => {
    expect(isKeepPlanning('')).toBe(false);
    expect(isKeepPlanning('   ')).toBe(false);
  });

  it('proceeds on explicit proceed/yes-style answers (case-insensitive)', () => {
    for (const a of ['Proceed', 'proceed', 'YES', 'y', 'approve', 'OK', 'do it']) {
      expect(isKeepPlanning(a), a).toBe(false);
    }
  });

  it('keeps planning on "Keep planning", "no", or free-text feedback', () => {
    for (const a of ['Keep planning', 'no', 'revise the auth bit', 'use redis instead']) {
      expect(isKeepPlanning(a), a).toBe(true);
    }
  });
});

function fakeSession(snapshot: string): { session: PtyClaudeSession; keys: string[] } {
  const keys: string[] = [];
  const session = {
    sessionId: 's',
    jsonlPath: '/tmp/s.jsonl',
    ready: async () => {},
    typePrompt: async () => {},
    sendKeys: (d: string) => { keys.push(d); },
    snapshot: () => snapshot,
    screen: () => snapshot,
    interrupt: async () => {},
    dispose: async () => {},
  } as PtyClaudeSession;
  return { session, keys };
}

const exitPlanTool: PtyInteractiveTool = { name: 'ExitPlanMode', toolUseId: 't1', input: { plan: 'p' } };

describe('driveInteractiveTool — ExitPlanMode', () => {
  it('sends Esc to keep planning on a cancel response', async () => {
    const { session, keys } = fakeSession('');
    const response: PtyInteractiveResponse = { kind: 'cancel' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['\x1b']);
  });

  it('presses the bypass-permissions digit to proceed on approve (legacy menu)', async () => {
    const menu = [
      'Would you like to proceed?',
      '1. Yes',
      '2. Yes, and bypass permissions',
      '3. No, keep planning',
    ].join('\n');
    const { session, keys } = fakeSession(menu);
    const response: PtyInteractiveResponse = { kind: 'approve' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['2']);
  });

  it('proceeds on the REAL claude 2.1.158 menu (bypass permissions = digit 1)', async () => {
    // Captured verbatim from claude 2.1.158 via node-pty.
    const menu = [
      "Ready to code? Here is Claude's plan:",
      'Claude has written up a plan and is ready to execute. Would you like to proceed?',
      '1. Yes, and bypass permissions',
      '2. Yes, manually approve edits',
      '3. No, refine with Ultraplan on Claude Code on the web',
      '4. Tell Claude what to change',
    ].join('\n');
    const { session, keys } = fakeSession(menu);
    const response: PtyInteractiveResponse = { kind: 'approve' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['1']);
  });

  it('proceeds on the simpler "Exit plan mode? 1.Yes 2.No" menu (digit 1)', async () => {
    // Variant B — the tool-call confirmation shape (no "bypass" option at all).
    const menu = ['Exit plan mode?', 'Claude wants to exit plan mode', '❯ 1. Yes', '  2. No'].join('\n');
    const { session, keys } = fakeSession(menu);
    const response: PtyInteractiveResponse = { kind: 'approve' };
    await driveInteractiveTool({ session, tool: exitPlanTool, response, logger });
    expect(keys).toEqual(['1']);
  });
});

describe('isExitPlanMenu', () => {
  it('detects the REAL claude 2.1.158 menu ("Tell Claude what to change", no "keep planning")', () => {
    const menu = [
      "Ready to code? Here is Claude's plan:",
      'Would you like to proceed?',
      '1. Yes, and bypass permissions',
      '2. Yes, manually approve edits',
      '3. Tell Claude what to change',
    ].join('\n');
    expect(isExitPlanMenu(menu)).toBe(true);
  });
  it('detects the legacy "No, keep planning" menu', () => {
    expect(isExitPlanMenu('Would you like to proceed?\n 2. Yes, and bypass permissions\n 3. No, keep planning')).toBe(true);
  });
  it('detects the simpler "Exit plan mode? 1.Yes 2.No" menu (Variant B)', () => {
    const menu = ['Exit plan mode?', 'Claude wants to exit plan mode', '❯ 1. Yes', '  2. No'].join('\n');
    expect(isExitPlanMenu(menu)).toBe(true);
  });
  it('detects a plan menu purely from the on-screen plan path (wording-free)', () => {
    // No title phrase the detector knows — only the structure + plans path.
    const menu = ['Some brand new wording here', '❯ 1. Go', '  2. Wait', '~/.claude/plans/witty-ocean.md'].join('\n');
    expect(isExitPlanMenu(menu)).toBe(true);
  });
  it('does NOT fire on a numbered menu with no plan context (e.g. AskUserQuestion)', () => {
    const menu = ['Which color?', '❯ 1. Red', '  2. Blue', 'Enter to select'].join('\n');
    expect(isExitPlanMenu(menu)).toBe(false);
  });
  it('does NOT fire on plan body text that merely mentions planning', () => {
    expect(isExitPlanMenu('The plan: keep planning the migration in phases. Proceed carefully.')).toBe(false);
  });
  it('does NOT fire on a title without options (plan still rendering)', () => {
    expect(isExitPlanMenu("Ready to code? Here is Claude's plan: ...still writing...")).toBe(false);
  });
  it('does NOT fire on an unrelated screen', () => {
    expect(isExitPlanMenu('some normal assistant output with no menu')).toBe(false);
  });
});


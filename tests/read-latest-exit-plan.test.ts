import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readLatestExitPlan, readPlanFromScreen } from '../src/engines/claude/pty/pty-query.js';

/**
 * readLatestExitPlan is the crux of the "ExitPlanMode card appears only after
 * /stop" fix: it must recover the ExitPlanMode tool_use from the session jsonl
 * even when the final line has NO trailing newline (claude blocks on the
 * approval menu before flushing it).
 */

let dir: string;
let file: string;

const assistant = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { content: blocks } });
const exitPlan = (id: string, plan: string) =>
  assistant([{ type: 'tool_use', id, name: 'ExitPlanMode', input: { plan } }]);
const textMsg = (t: string) => assistant([{ type: 'text', text: t }]);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-exitplan-'));
  file = path.join(dir, 'session.jsonl');
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('readLatestExitPlan', () => {
  it('returns null when the file is missing or empty', () => {
    expect(readLatestExitPlan(path.join(dir, 'nope.jsonl'))).toBeNull();
    fs.writeFileSync(file, '');
    expect(readLatestExitPlan(file)).toBeNull();
  });

  it('recovers a trailing ExitPlanMode line with NO terminating newline', () => {
    // textMsg line is terminated; the ExitPlanMode line is NOT (the bug case).
    fs.writeFileSync(file, textMsg('thinking…') + '\n' + exitPlan('toolu_1', '# Plan\n- step a'));
    const got = readLatestExitPlan(file);
    expect(got).toEqual({ toolUseId: 'toolu_1', plan: '# Plan\n- step a' });
  });

  it('returns the LATEST ExitPlanMode when several exist', () => {
    fs.writeFileSync(file, [
      exitPlan('toolu_old', 'old plan'),
      textMsg('kept planning'),
      exitPlan('toolu_new', 'new plan'),
    ].join('\n') + '\n');
    expect(readLatestExitPlan(file)?.toolUseId).toBe('toolu_new');
  });

  it('ignores non-ExitPlanMode tool_use and malformed lines', () => {
    fs.writeFileSync(file, [
      '{ not json',
      assistant([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }]),
      textMsg('hello'),
    ].join('\n'));
    expect(readLatestExitPlan(file)).toBeNull();
  });

  it('defaults plan to empty string when input.plan is absent', () => {
    fs.writeFileSync(file, assistant([{ type: 'tool_use', id: 'toolu_2', name: 'ExitPlanMode', input: {} }]));
    expect(readLatestExitPlan(file)).toEqual({ toolUseId: 'toolu_2', plan: '' });
  });

  it('finds the record even when an earlier tail line is partial', () => {
    // Simulate a tail slice that begins mid-record: the first (partial) line is
    // unparseable, but the real record later in the buffer is still found.
    const partial = '","name":"X"}]}}'; // junk fragment, no leading {
    fs.writeFileSync(file, partial + '\n' + exitPlan('toolu_3', 'recovered'));
    expect(readLatestExitPlan(file)?.toolUseId).toBe('toolu_3');
  });
});

describe('readPlanFromScreen', () => {
  it('reads the plan file referenced on the ExitPlanMode screen', () => {
    // Lay out a fake ~/.claude/plans under a temp HOME.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-home-'));
    fs.mkdirSync(path.join(home, '.claude', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(home, '.claude', 'plans', 'goofy-percolating-dahl.md'), '# Real Plan\n- do the thing');
    // Squished/wrapped screen tail as the TUI renders it.
    const screen = 'ctrl-g to edit in Vim · ~/.claude/plans/goofy-percolating-dahl.md';
    expect(readPlanFromScreen(screen, home)).toBe('# Real Plan\n- do the thing');
    fs.rmSync(home, { recursive: true, force: true });
  });
  it('returns empty string when no plan path is on screen', () => {
    expect(readPlanFromScreen('Would you like to proceed? 1. Yes')).toBe('');
  });
});


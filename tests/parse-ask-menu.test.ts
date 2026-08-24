import { describe, it, expect } from 'vitest';
import { parseAskMenuFromScreen } from '../src/engines/claude/pty/interactive-driver.js';

/**
 * parseAskMenuFromScreen turns the CLEAN terminal screen (PtyClaudeSession
 * screen(), via @xterm/headless) into the AskUserQuestion tool_input shape.
 * AskUserQuestion blocks before writing its tool_use to the jsonl (verified via
 * node-pty), so the screen is the only timely source — these fixtures are the
 * real claude 2.1.158 layouts captured from a live PTY.
 */

const single = [
  ' ☐ Color ',
  '',
  'What is your favorite color?',
  '',
  '❯ 1. Red',
  '     The color red.',
  '  2. Green',
  '     The color green.',
  '  3. Blue',
  '     The color blue.',
  '  4. Type something.',
  '────────────────────',
  '  5. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const multiSelect = [
  '←  ☐ Toppings  ✔ Submit  →',
  '',
  'Which toppings would you like?',
  '',
  '❯ 1. [ ] Cheese',
  '  Add cheese.',
  '  2. [ ] Onion',
  '  Add onion.',
  '  3. [ ] Olives',
  '  Add olives.',
  '  5. [ ] Type something',
  '     Submit',
  '  6. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const multiQuestion = [
  '←  ☐ Fruit  ☐ Toppings  ✔ Submit  →',
  '',
  'What is your favorite fruit?',
  '',
  '❯ 1. Apple',
  '     Crisp and sweet.',
  '  2. Banana',
  '     Soft and creamy.',
  '  3. Type something.',
  '  4. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
].join('\n');

describe('parseAskMenuFromScreen', () => {
  it('parses a single-select question (clean labels + descriptions)', () => {
    const r = parseAskMenuFromScreen(single)!;
    expect(r).not.toBeNull();
    expect(r.questions).toHaveLength(1);
    const q = r.questions[0];
    expect(q.header).toBe('Color');
    expect(q.question).toBe('What is your favorite color?');
    expect(q.multiSelect).toBe(false);
    expect(q.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue']);
    expect(q.options[0].description).toBe('The color red.');
  });

  it('parses a multi-select question (strips [ ] checkbox, sets multiSelect)', () => {
    const r = parseAskMenuFromScreen(multiSelect)!;
    expect(r.questions[0].multiSelect).toBe(true);
    expect(r.questions[0].header).toBe('Toppings');
    // "Type something" / "Submit" / "Chat about this" excluded as meta options.
    expect(r.questions[0].options.map((o) => o.label)).toEqual(['Cheese', 'Onion', 'Olives']);
  });

  it('parses the FIRST question of a multi-question (tab-bar) menu', () => {
    const r = parseAskMenuFromScreen(multiQuestion)!;
    expect(r.questions[0].header).toBe('Fruit');
    expect(r.questions[0].question).toBe('What is your favorite fruit?');
    expect(r.questions[0].options.map((o) => o.label)).toEqual(['Apple', 'Banana']);
  });

  it('returns null when the screen is not an AskUserQuestion menu', () => {
    expect(parseAskMenuFromScreen('just some text\n1. a\n2. b')).toBeNull();
    expect(parseAskMenuFromScreen('Would you like to proceed?\n1. Yes\n2. No')).toBeNull();
  });

  it('returns null on an AUQ footer with no real options (still rendering)', () => {
    expect(parseAskMenuFromScreen('A question?\nEnter to select · Esc to cancel')).toBeNull();
  });
});

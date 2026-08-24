import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createJsonlScanner } from '../src/engines/claude/pty/jsonl-scanner.js';

const logger = {
  warn: () => {},
} as any;

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-jsonl-scanner-'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function line(value: unknown): string {
  return JSON.stringify(value) + '\n';
}

async function nextWithTimeout<T>(iterator: AsyncIterator<T>, ms = 500): Promise<IteratorResult<T>> {
  return Promise.race([
    iterator.next(),
    new Promise<IteratorResult<T>>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for scanner record')), ms);
    }),
  ]);
}

describe('createJsonlScanner', () => {
  it('replays existing records by default', async () => {
    fs.writeFileSync(file, line({ type: 'assistant', id: 'old' }));
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5 });
    const iterator = scanner[Symbol.asyncIterator]();

    await expect(nextWithTimeout(iterator)).resolves.toEqual({
      done: false,
      value: { type: 'assistant', id: 'old' },
    });
    scanner.stop();
  });

  it('starts at EOF on resume and only emits newly appended records', async () => {
    fs.writeFileSync(file, [
      line({ type: 'assistant', id: 'old-question', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion' }] } }),
      line({ type: 'assistant', id: 'old-answer' }),
    ].join(''));
    const scanner = createJsonlScanner({ jsonlPath: file, logger, pollMs: 5, startAtEnd: true });
    const iterator = scanner[Symbol.asyncIterator]();

    const next = nextWithTimeout(iterator);
    await new Promise((resolve) => setTimeout(resolve, 25));
    fs.appendFileSync(file, line({ type: 'assistant', id: 'new-turn' }));

    await expect(next).resolves.toEqual({
      done: false,
      value: { type: 'assistant', id: 'new-turn' },
    });
    scanner.stop();
  });
});

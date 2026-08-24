/**
 * PTY backend — JSONL scanner.
 *
 * Tails a Claude session `.jsonl` file, yielding each newly-appended JSON
 * record exactly once in order. Handles:
 *   - file not yet existing (polls until it appears)
 *   - partial trailing line (buffers until newline-terminated)
 *   - clean stop via stop()
 *
 * Uses byte-offset tracking + interval polling (fs.read from last offset).
 */

import { openSync, readSync, statSync, closeSync } from 'node:fs';
import type { CreateJsonlScanner, JsonlScanner, RawJsonlRecord } from './contract.js';

const DEFAULT_POLL_MS = 120;

export const createJsonlScanner: CreateJsonlScanner = ({
  jsonlPath,
  logger,
  pollMs = DEFAULT_POLL_MS,
  startAtEnd = false,
}) => {
  let stopped = false;
  let offset = 0;
  let partialLine = '';

  function stop(): void {
    stopped = true;
  }

  function fileExists(): boolean {
    try {
      statSync(jsonlPath);
      return true;
    } catch {
      return false;
    }
  }

  function fileSize(): number {
    try {
      return statSync(jsonlPath).size;
    } catch {
      return 0;
    }
  }

  /**
   * Read newly appended bytes starting from `offset`, split into lines,
   * parse each complete line as JSON, and yield the records.
   */
  function readNewRecords(): RawJsonlRecord[] {
    const size = fileSize();
    if (size < offset) {
      offset = startAtEnd ? size : 0;
      partialLine = '';
    }
    if (size <= offset) return [];

    const bytesToRead = size - offset;
    const buf = Buffer.alloc(bytesToRead);

    let fd: number | undefined;
    try {
      fd = openSync(jsonlPath, 'r');
      readSync(fd, buf, 0, bytesToRead, offset);
    } catch (err) {
      logger.warn({ err, jsonlPath }, 'jsonl-scanner: read error');
      return [];
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    offset = size;
    const chunk = buf.toString('utf8');
    const raw = partialLine + chunk;
    const lines = raw.split('\n');

    // Last element is either '' (chunk ended with \n) or an incomplete line.
    partialLine = lines.pop() ?? '';

    const records: RawJsonlRecord[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as RawJsonlRecord);
      } catch {
        logger.warn({ line: trimmed.slice(0, 120) }, 'jsonl-scanner: malformed JSON line, skipping');
      }
    }
    return records;
  }

  async function* iterate(): AsyncGenerator<RawJsonlRecord, void, undefined> {
    // Wait for the file to appear.
    while (!stopped && !fileExists()) {
      await sleep(pollMs);
    }
    if (stopped) return;
    if (startAtEnd) {
      offset = fileSize();
      partialLine = '';
    }

    // Main poll loop.
    while (!stopped) {
      const records = readNewRecords();
      for (const rec of records) {
        yield rec;
        if (stopped) return;
      }
      await sleep(pollMs);
    }
  }

  const scanner: JsonlScanner = {
    stop,
    [Symbol.asyncIterator]() {
      return iterate();
    },
  };

  return scanner;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

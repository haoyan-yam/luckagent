import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression: zero-install DeepSeek / MiniMax machines (no `claude` CLI).
 *
 * v0.4.1 fixed resolveClaudePath() in executor.ts to return undefined when no
 * binary is found, so the Agent SDK falls back to its BUNDLED runtime. The
 * persistent executor — the default path for every engine, including the
 * compat-endpoint ones forced onto the SDK backend — kept its own copy with
 * the old `/usr/local/bin/claude` fallback, so it always passed a guessed,
 * nonexistent pathToClaudeCodeExecutable to query().
 *
 * CLAUDE_EXECUTABLE is computed at module load, so each case resets the module
 * graph and re-imports after arranging `which` / env.
 */

const h = vi.hoisted(() => ({
  whichResult: undefined as string | Error | undefined,
  queryCalls: [] as Array<{ options: Record<string, unknown> }>,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(() => {
      if (h.whichResult instanceof Error) throw h.whichResult;
      return h.whichResult ?? '';
    }),
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: Record<string, unknown> }) => {
    h.queryCalls.push({ options: args.options });
    // A stream that stays open (never yields) — enough for start() to finish.
    const idle: AsyncIterableIterator<unknown> = {
      next: () => new Promise<IteratorResult<unknown>>(() => {}),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return Object.assign(idle, { interrupt: async () => {} });
  }),
}));

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

async function loadPersistent() {
  vi.resetModules();
  const mod = await import('../src/engines/claude/persistent-executor.js');
  return mod.PersistentClaudeExecutor;
}

async function startSdkExecutor(): Promise<Record<string, unknown>> {
  const PersistentClaudeExecutor = await loadPersistent();
  const exec = new PersistentClaudeExecutor({
    cwd: '/tmp',
    logger: mockLogger,
    idleTimeoutMs: 0,
    backend: 'sdk',
  });
  await exec.start();
  expect(h.queryCalls).toHaveLength(1);
  return h.queryCalls[0].options;
}

describe('claude executable resolution', () => {
  const savedPath = process.env.CLAUDE_EXECUTABLE_PATH;

  beforeEach(() => {
    delete process.env.CLAUDE_EXECUTABLE_PATH;
    h.whichResult = undefined;
    h.queryCalls = [];
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env.CLAUDE_EXECUTABLE_PATH;
    else process.env.CLAUDE_EXECUTABLE_PATH = savedPath;
  });

  describe('resolveClaudePath', () => {
    async function resolve() {
      vi.resetModules();
      const { resolveClaudePath } = await import('../src/engines/claude/executor.js');
      return resolveClaudePath();
    }

    it('returns undefined when `which claude` fails (no guessed fallback)', async () => {
      h.whichResult = new Error('not found');
      expect(await resolve()).toBeUndefined();
    });

    it('returns undefined when `which claude` prints nothing', async () => {
      h.whichResult = '';
      expect(await resolve()).toBeUndefined();
    });

    it('returns the first line of `which claude`', async () => {
      h.whichResult = '/opt/bin/claude\n/usr/bin/claude\n';
      expect(await resolve()).toBe('/opt/bin/claude');
    });

    it('prefers CLAUDE_EXECUTABLE_PATH over PATH lookup', async () => {
      process.env.CLAUDE_EXECUTABLE_PATH = '/custom/claude';
      h.whichResult = '/opt/bin/claude';
      expect(await resolve()).toBe('/custom/claude');
    });
  });

  describe('PersistentClaudeExecutor (SDK backend)', () => {
    it('omits pathToClaudeCodeExecutable when no claude CLI is installed', async () => {
      h.whichResult = new Error('not found');
      const options = await startSdkExecutor();
      expect(options).not.toHaveProperty('pathToClaudeCodeExecutable');
    });

    it('passes the resolved binary through when claude CLI is installed', async () => {
      h.whichResult = '/opt/bin/claude';
      const options = await startSdkExecutor();
      expect(options.pathToClaudeCodeExecutable).toBe('/opt/bin/claude');
    });

    it('honors CLAUDE_EXECUTABLE_PATH', async () => {
      process.env.CLAUDE_EXECUTABLE_PATH = '/custom/claude';
      h.whichResult = new Error('not found');
      const options = await startSdkExecutor();
      expect(options.pathToClaudeCodeExecutable).toBe('/custom/claude');
    });
  });

  describe('PersistentClaudeExecutor (PTY backend)', () => {
    it('fails with an actionable error when no claude CLI is installed', async () => {
      h.whichResult = new Error('not found');
      const PersistentClaudeExecutor = await loadPersistent();
      const exec = new PersistentClaudeExecutor({
        cwd: '/tmp',
        logger: mockLogger,
        idleTimeoutMs: 0,
        backend: 'pty',
      });
      await expect(exec.start()).rejects.toThrow(/PTY backend requires the claude CLI binary/);
    });
  });
});

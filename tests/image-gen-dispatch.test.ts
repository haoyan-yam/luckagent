import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * image-gen 技能的统一入口 scripts/gen.py：后端判定（--provider > IMAGE_GEN_PROVIDER >
 * Codex 已登录 > ARK_API_KEY）、Codex 不可用时自动兜底到 Seedream、多张命名。
 *
 * 用假的 codex 可执行文件（CODEX_BIN）和本地 HTTP 服务冒充方舟接口（ARK_BASE_URL），
 * 真实跑 python 脚本；HOME / cwd 指向临时目录，不碰本机的 .env 和 ~/.codex。
 */

const GEN = path.resolve(__dirname, '../src/skills/image-gen/scripts/gen.py');
// 1x1 透明 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let tmp: string;
let fakeCodex: string;
let server: http.Server;
let arkUrl: string;
let arkRequests: Array<Record<string, unknown>>;

function writeFakeCodex(dir: string): string {
  const p = path.join(dir, 'codex');
  fs.writeFileSync(
    p,
    [
      '#!/bin/sh',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      '  if [ "$FAKE_CODEX_LOGGED_IN" = "1" ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      '  echo "Not logged in"; exit 1',
      'fi',
      'if [ "$1" = "exec" ]; then',
      '  cat >/dev/null',
      '  echo "${FAKE_CODEX_EXEC_ERROR:-error}" >&2',
      '  exit 1',
      'fi',
      'echo "codex-cli 0.0.0-test"',
    ].join('\n'),
  );
  fs.chmodSync(p, 0o755);
  return p;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGen(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'python3',
      [GEN, ...args],
      {
        cwd: tmp,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tmp,
          LUCKAGENT_HOME: path.join(tmp, 'luckagent'),
          CODEX_HOME: path.join(tmp, '.codex'),
          CODEX_BIN: fakeCodex,
          ARK_BASE_URL: arkUrl,
          ...env,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const payload = JSON.parse(body || '{}') as Record<string, unknown>;
      arkRequests.push(payload);
      const opts = payload.sequential_image_generation_options as { max_images?: number } | undefined;
      const n = opts?.max_images ?? 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  arkUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'image-gen-test-'));
  fs.mkdirSync(path.join(tmp, 'luckagent'));
  fakeCodex = writeFakeCodex(tmp);
  arkRequests = [];
});

describe('gen.py backend resolution', () => {
  it('prefers Codex when it is logged in, with no fallback when there is no ARK key', async () => {
    const r = await runGen(['一只猫', '-o', 'cat.png', '--print-cmd'], { FAKE_CODEX_LOGGED_IN: '1' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('provider=codex');
    expect(r.stdout).toContain('fallback=none');
    expect(r.stdout).toContain('--aspect 1:1');
  });

  it('keeps Codex as default and arms the Seedream fallback when an ARK key exists', async () => {
    const r = await runGen(['一只猫', '--print-cmd'], { FAKE_CODEX_LOGGED_IN: '1', ARK_API_KEY: 'ark-test' });
    expect(r.stdout).toContain('provider=codex');
    expect(r.stdout).toContain('fallback=seedream');
  });

  it('uses Seedream automatically when Codex is not logged in', async () => {
    const r = await runGen(['一只猫', '--print-cmd'], { ARK_API_KEY: 'ark-test' });
    expect(r.stdout).toContain('provider=seedream');
    expect(r.stdout).toContain('auto: 已配 ARK_API_KEY');
  });

  it('honors IMAGE_GEN_PROVIDER from the Luckagent .env over auto-detection', async () => {
    fs.writeFileSync(path.join(tmp, 'luckagent', '.env'), 'IMAGE_GEN_PROVIDER=seedream\nARK_API_KEY=ark-test\n');
    const r = await runGen(['一只猫', '--print-cmd'], { FAKE_CODEX_LOGGED_IN: '1' });
    expect(r.stdout).toContain('provider=seedream  (IMAGE_GEN_PROVIDER)');
  });

  it('fails with setup guidance when no backend is available', async () => {
    const r = await runGen(['一只猫', '--print-cmd']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('本机没有可用的生图后端');
    expect(r.stderr).toContain('codex login');
    expect(r.stderr).toContain('ARK_API_KEY');
  });

  it('converts --aspect into a ~4MP Seedream size', async () => {
    const r = await runGen(['一只猫', '--aspect', '16:9', '--provider', 'seedream', '--print-cmd'], {
      ARK_API_KEY: 'ark-test',
    });
    expect(r.stdout).toContain('--size 2752x1536');
  });

  it('rejects --transparent with a jpg output', async () => {
    const r = await runGen(['icon', '--transparent', '-o', 'x.jpg', '--print-cmd'], { FAKE_CODEX_LOGGED_IN: '1' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('--transparent 需要 .png 或 .webp');
  });
});

describe('gen.py execution', () => {
  it('falls back to Seedream when Codex hits its subscription quota', async () => {
    const r = await runGen(['一只猫', '-o', 'cat.png', '--timeout', '5'], {
      FAKE_CODEX_LOGGED_IN: '1',
      FAKE_CODEX_EXEC_ERROR: 'error: usage limit reached, try again later',
      ARK_API_KEY: 'ark-test',
    });
    expect(r.stderr).toContain('[fallback]');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'cat.png'))).toBe(true);
    expect(arkRequests).toHaveLength(1);
    expect(arkRequests[0].size).toBe('2048x2048');
  }, 30_000);

  it('does not fall back when --provider codex is forced', async () => {
    const r = await runGen(['一只猫', '-o', 'cat.png', '--timeout', '5', '--provider', 'codex'], {
      FAKE_CODEX_LOGGED_IN: '1',
      FAKE_CODEX_EXEC_ERROR: 'error: usage limit reached',
      ARK_API_KEY: 'ark-test',
    });
    expect(r.code).toBe(4);
    expect(r.stderr).not.toContain('[fallback]');
    expect(arkRequests).toHaveLength(0);
  }, 30_000);

  it('names multiple Seedream images <stem>_1..N like the Codex backend', async () => {
    const r = await runGen(['同一角色的两个表情', '-o', 'face.png', '--n', '2', '--provider', 'seedream'], {
      ARK_API_KEY: 'ark-test',
    });
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(tmp, 'face_1.png'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'face_2.png'))).toBe(true);
    expect(arkRequests[0].sequential_image_generation).toBe('auto');
  }, 30_000);
});

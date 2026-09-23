import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/**
 * seedance-video skill (scripts/gen_video.py + tos_upload.py), run for real
 * against a local HTTP server that plays both the Ark video API
 * (ARK_BASE_URL) and the TOS bucket endpoint (TOS_ENDPOINT):
 *  - config comes from env or $LUCKAGENT_HOME/.env;
 *  - a missing Ark key / missing TOS fails BEFORE any billable submit;
 *  - local reference media is uploaded, and deleted once the task is final;
 *  - refs are kept when the task may still be running (poll timeout);
 *  - `--probe` uploads + deletes a tiny object and explains failures.
 */

const SCRIPTS = path.resolve(__dirname, '../src/skills/seedance-video/scripts');
const GEN = path.join(SCRIPTS, 'gen_video.py');
const TOS = path.join(SCRIPTS, 'tos_upload.py');

interface Req {
  method: string;
  url: string;
  body: string;
}

let server: http.Server;
let base: string;
let reqs: Req[];
let taskStatus: string;
let tosPutStatus: number;
let tmp: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      reqs.push({ method: req.method ?? '', url, body: Buffer.concat(chunks).toString('utf8') });
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.method === 'POST' && url.startsWith('/api/v3/contents/generations/tasks')) {
        return json(200, { id: 'task-1' });
      }
      if (req.method === 'GET' && url.startsWith('/api/v3/contents/generations/tasks/task-1')) {
        return json(200, { status: taskStatus, content: { video_url: `${base}/video.mp4` } });
      }
      if (req.method === 'GET' && url === '/video.mp4') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        return res.end(Buffer.from('fake-mp4-bytes'));
      }
      if (url.startsWith('/seedance-refs/')) {
        if (req.method === 'PUT') {
          res.writeHead(tosPutStatus);
          return res.end(tosPutStatus === 200 ? '' : '<Error><Code>AccessDenied</Code></Error>');
        }
        if (req.method === 'DELETE') {
          res.writeHead(204);
          return res.end();
        }
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  reqs = [];
  taskStatus = 'succeeded';
  tosPutStatus = 200;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-test-'));
  fs.mkdirSync(path.join(tmp, 'luckagent'));
});

const TOS_ENV = {
  TOS_ACCESS_KEY: 'AKLTtest0123456789',
  TOS_SECRET_KEY: 'c2VjcmV0c2VjcmV0',
  TOS_BUCKET: 'test-bucket',
};

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(
      'python3',
      [script, ...args],
      {
        cwd: tmp,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tmp,
          LUCKAGENT_HOME: path.join(tmp, 'luckagent'),
          ARK_BASE_URL: `${base}/api/v3`,
          TOS_ENDPOINT: base,
          ...env,
        },
        timeout: 60_000,
      },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

const arkCalls = () => reqs.filter((r) => r.url.startsWith('/api/v3/'));
const tosCalls = (method: string) => reqs.filter((r) => r.method === method && r.url.startsWith('/seedance-refs/'));
const objectPath = (url: string) => url.split('?')[0];

describe('gen_video.py', () => {
  it('refuses to run without an Ark key and points at the admin console', async () => {
    const r = await run(GEN, ['一只猫在跑', '--out', 'x.mp4']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('视频生成未开通');
    expect(r.stderr).toContain('系统配置 → 默认设置 → 视频生成');
    expect(reqs).toHaveLength(0);
  });

  it('reads the Ark key from $LUCKAGENT_HOME/.env and delivers the mp4', async () => {
    fs.writeFileSync(path.join(tmp, 'luckagent', '.env'), 'ARK_API_KEY=ark-from-dotenv-1234\n');
    const r = await run(GEN, ['一只猫在跑', '--out', 'cat.mp4']);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(tmp, 'cat.mp4'), 'utf8')).toBe('fake-mp4-bytes');
    expect(arkCalls()[0].method).toBe('POST');
  });

  it('fails before submitting (no charge) when a local reference video needs TOS but none is configured', async () => {
    fs.writeFileSync(path.join(tmp, 'ref.mp4'), 'ref-video');
    const r = await run(GEN, ['参考这个运镜', '--ref-video', 'ref.mp4', '--out', 'o.mp4'], {
      ARK_API_KEY: 'ark-key-12345678',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('任务未提交、未计费');
    expect(arkCalls()).toHaveLength(0);
  });

  it('uploads local reference media to TOS and deletes it once the task succeeds', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mp4'), 'ref-a');
    fs.writeFileSync(path.join(tmp, 'b.mp4'), 'ref-b');
    const r = await run(GEN, ['参考运镜', '--ref-video', 'a.mp4', '--ref-video', 'b.mp4', '--out', 'o.mp4'], {
      ARK_API_KEY: 'ark-key-12345678',
      ...TOS_ENV,
    });
    expect(r.code).toBe(0);
    const puts = tosCalls('PUT').map((c) => objectPath(c.url));
    expect(puts).toHaveLength(2);
    expect(new Set(puts).size).toBe(2); // two same-type files in one second must not share a key
    const submit = JSON.parse(arkCalls().find((c) => c.method === 'POST')!.body);
    const refUrls = submit.content
      .filter((c: any) => c.type === 'video_url')
      .map((c: any) => objectPath(c.video_url.url.replace(base, '')));
    expect(refUrls.sort()).toEqual([...puts].sort());
    expect(
      tosCalls('DELETE')
        .map((c) => objectPath(c.url))
        .sort(),
    ).toEqual([...puts].sort());
  });

  it('still deletes the uploaded refs when the task fails', async () => {
    taskStatus = 'failed';
    fs.writeFileSync(path.join(tmp, 'a.mp3'), 'ref-audio');
    const r = await run(GEN, ['配这段音乐', '--ref-audio', 'a.mp3', '--out', 'o.mp4'], {
      ARK_API_KEY: 'ark-key-12345678',
      ...TOS_ENV,
    });
    expect(r.code).not.toBe(0);
    expect(tosCalls('DELETE')).toHaveLength(1);
  });

  it('keeps the refs when polling times out (the task may still be fetching them)', async () => {
    taskStatus = 'running';
    fs.writeFileSync(path.join(tmp, 'a.mp4'), 'ref-a');
    const r = await run(GEN, ['参考运镜', '--ref-video', 'a.mp4', '--max-wait', '0', '--out', 'o.mp4'], {
      ARK_API_KEY: 'ark-key-12345678',
      ...TOS_ENV,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('task id = task-1');
    expect(tosCalls('PUT')).toHaveLength(1);
    expect(tosCalls('DELETE')).toHaveLength(0);
  });

  it('--keep-refs leaves the uploaded refs in place', async () => {
    fs.writeFileSync(path.join(tmp, 'a.mp4'), 'ref-a');
    const r = await run(GEN, ['参考运镜', '--ref-video', 'a.mp4', '--keep-refs', '--out', 'o.mp4'], {
      ARK_API_KEY: 'ark-key-12345678',
      ...TOS_ENV,
    });
    expect(r.code).toBe(0);
    expect(tosCalls('DELETE')).toHaveLength(0);
  });
});

describe('tos_upload.py --probe', () => {
  it('passes when it can upload and delete a small object', async () => {
    const r = await run(TOS, ['--probe'], TOS_ENV);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('通过');
    expect(tosCalls('PUT')).toHaveLength(1);
    expect(tosCalls('DELETE')).toHaveLength(1);
  });

  it('explains a denied upload', async () => {
    tosPutStatus = 403;
    const r = await run(TOS, ['--probe'], TOS_ENV);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('HTTP 403');
    expect(r.stdout).toContain('AccessDenied');
  });

  it('reports missing settings without touching the network', async () => {
    const r = await run(TOS, ['--probe'], { TOS_ACCESS_KEY: 'AKLTonly' });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('未配置');
    expect(reqs).toHaveLength(0);
  });
});

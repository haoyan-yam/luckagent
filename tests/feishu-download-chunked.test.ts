import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSender } from '../src/feishu/message-sender.js';

/**
 * [design-note N] 超 100MB 附件的分片下载回退 — MessageSender 层。
 *
 * 背景：SDK 单次 GET 限 100MB，超限返回 400 + {code:234037}，且原实现把失败
 * 静默吞成 false——2026-07-20（225MB）/07-22（152.9MB）两次真实丢文件。
 * 同端点支持 HTTP Range，lark-cli 用「128KB 探测段 + 8MB 分段」下载成功过
 * 同一条 225.3MB 消息。这些测试锁定回退协议的硬规则：
 *
 *   1. 单发 GET 报 234037（错误体是【未消费的流】）→ 自动转分片下载，
 *      探测段必须是 bytes=0-131071，后续按 8MB 顺序分段直到 total-1。
 *   2. 拼接完整性：落盘文件的大小与字节内容必须与源文件逐字节一致。
 *   3. 分段回包尺寸不对 → 判失败、删掉半成品文件（绝不留截断的假文件）。
 *   4. 非 234037 错误 → 不碰分片，携带错误码原因返回 {ok:false,reason}。
 *   5. transient 网络错（ECONNRESET 等）→ 该分段退避重试后成功。
 *   6. downloadImage 与 downloadFile 走同一条回退路径。
 */

const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

/** 构造 SDK messageResource.get 抛出的那种错误：400 + responseType:'stream' 的未消费错误体。 */
function makeStreamedApiError(code: number, msg: string): Error {
  const body = JSON.stringify({ code, msg });
  const err = new Error('Request failed with status code 400') as Error & {
    response?: { status: number; data: unknown };
  };
  err.response = { status: 400, data: Readable.from([Buffer.from(body)]) };
  return err;
}

/** 按 Range 语义切片 fileBuf 的 client.request mock；记录每次请求的区间。 */
function makeRangeServer(fileBuf: Buffer, opts: { corruptChunkAt?: number; failFirstWith?: NodeJS.ErrnoException } = {}) {
  const ranges: Array<{ start: number; end: number }> = [];
  let failedOnce = false;
  const request = vi.fn(async (payload: any) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(String(payload?.headers?.Range ?? ''));
    if (!m) throw new Error(`mock: missing/invalid Range header: ${payload?.headers?.Range}`);
    const start = Number(m[1]);
    const end = Number(m[2]);
    ranges.push({ start, end });
    if (opts.failFirstWith && !failedOnce) {
      failedOnce = true;
      throw opts.failFirstWith;
    }
    let slice = fileBuf.subarray(start, Math.min(end + 1, fileBuf.length));
    if (opts.corruptChunkAt !== undefined && start === opts.corruptChunkAt) {
      slice = slice.subarray(0, Math.max(0, slice.length - 100)); // 少回 100 字节
    }
    return {
      data: Buffer.from(slice),
      headers: { 'content-range': `bytes ${start}-${start + slice.length - 1}/${fileBuf.length}` },
    };
  });
  return { request, ranges };
}

function makeSender(fileBuf: Buffer, opts: Parameters<typeof makeRangeServer>[1] = {}) {
  const get = vi.fn().mockRejectedValue(makeStreamedApiError(234037, 'file size exceeds the limit'));
  const server = makeRangeServer(fileBuf, opts);
  const client = { im: { v1: { messageResource: { get } } }, request: server.request } as any;
  return { sender: new MessageSender(client, mockLogger), get, ...server };
}

const PROBE = 128 * 1024;
const CHUNK = 8 * 1024 * 1024;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chunked-dl-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

describe('MessageSender chunked download fallback (patch N)', () => {
  it('234037 triggers chunked fallback: probe 128KB, then 8MB chunks, assembled file is byte-identical', async () => {
    // 2 个整分段 + 一个零头尾段，覆盖边界取整
    const fileBuf = crypto.randomBytes(PROBE + 2 * CHUNK + 12_345);
    const { sender, get, ranges } = makeSender(fileBuf);
    const savePath = path.join(dir, 'big.bin');

    const res = await sender.downloadFile('om_x', 'file_v3_x', savePath);

    expect(res).toBe(true);
    expect(get).toHaveBeenCalledOnce();
    // 探测段与分段区间严格符合协议
    expect(ranges[0]).toEqual({ start: 0, end: PROBE - 1 });
    expect(ranges[1]).toEqual({ start: PROBE, end: PROBE + CHUNK - 1 });
    expect(ranges[2]).toEqual({ start: PROBE + CHUNK, end: PROBE + 2 * CHUNK - 1 });
    expect(ranges[3]).toEqual({ start: PROBE + 2 * CHUNK, end: fileBuf.length - 1 });
    expect(ranges).toHaveLength(4);
    // 拼接完整性：大小与内容都与直传一致
    const assembled = fs.readFileSync(savePath);
    expect(assembled.length).toBe(fileBuf.length);
    expect(sha(assembled)).toBe(sha(fileBuf));
  });

  it('chunk shorter than requested → fails with reason and removes the partial file', async () => {
    const fileBuf = crypto.randomBytes(PROBE + CHUNK + 999);
    const { sender } = makeSender(fileBuf, { corruptChunkAt: PROBE });
    const savePath = path.join(dir, 'trunc.bin');

    const res = await sender.downloadFile('om_x', 'file_v3_x', savePath);

    expect(res).not.toBe(true);
    expect(res).toMatchObject({ ok: false });
    expect((res as { reason: string }).reason).toMatch(/mismatch/);
    expect(fs.existsSync(savePath)).toBe(false); // 半成品必须删掉
  });

  it('non-234037 API error → no chunk attempt, reason carries the error code', async () => {
    const get = vi.fn().mockRejectedValue(makeStreamedApiError(234002, 'no permission'));
    const request = vi.fn();
    const client = { im: { v1: { messageResource: { get } } }, request } as any;
    const sender = new MessageSender(client, mockLogger);

    const res = await sender.downloadFile('om_x', 'file_v3_x', path.join(dir, 'x.bin'));

    expect(res).toMatchObject({ ok: false });
    expect((res as { reason: string }).reason).toContain('234002');
    expect(request).not.toHaveBeenCalled();
  });

  it('transient chunk error (ECONNRESET) is retried and the download still succeeds', async () => {
    const fileBuf = crypto.randomBytes(PROBE + 4321);
    const netErr = new Error('socket hang up') as NodeJS.ErrnoException;
    netErr.code = 'ECONNRESET';
    const { sender, ranges } = makeSender(fileBuf, { failFirstWith: netErr });
    const savePath = path.join(dir, 'retry.bin');

    const res = await sender.downloadFile('om_x', 'file_v3_x', savePath);

    expect(res).toBe(true);
    // 探测段失败一次 + 重试成功 + 尾段 = 3 次请求
    expect(ranges).toHaveLength(3);
    expect(ranges[0]).toEqual(ranges[1]);
    expect(sha(fs.readFileSync(savePath))).toBe(sha(fileBuf));
  }, 15_000);

  it('downloadImage takes the same fallback path', async () => {
    const fileBuf = crypto.randomBytes(PROBE + 777);
    const { sender, ranges } = makeSender(fileBuf);
    const savePath = path.join(dir, 'huge.png');

    const res = await sender.downloadImage('om_x', 'img_v3_x', savePath);

    expect(res).toBe(true);
    expect(ranges[0]).toEqual({ start: 0, end: PROBE - 1 });
    expect(sha(fs.readFileSync(savePath))).toBe(sha(fileBuf));
  });

  it('small-file success path still returns plain true (regression)', async () => {
    const writeFile = vi.fn().mockResolvedValue('ok');
    const get = vi.fn().mockResolvedValue({ writeFile });
    const client = { im: { v1: { messageResource: { get } } }, request: vi.fn() } as any;
    const sender = new MessageSender(client, mockLogger);

    const res = await sender.downloadFile('om_x', 'file_v3_x', path.join(dir, 's.bin'));

    expect(res).toBe(true);
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

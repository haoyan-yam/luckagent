import * as fs from 'node:fs';
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from '../utils/logger.js';
import type { DownloadOutcome, FetchedMessage } from '../bridge/message-sender.interface.js';

/**
 * [design-note P] 媒体发送结果：成功时带回 message_id 与媒资 key，供出站台账登记
 * （key 是耐久句柄——本地文件被design-note E 清掉后，引用回复仍可按 (messageId, key) 从飞书回捞）。
 * 失败仍为 false；对象为 truthy，旧真值判断全兼容。messageId 可能拿不到（响应缺失），
 * 不能因此谎报失败——否则会误触发design-note L 的「发送失败」群通知。
 */
export interface MediaSendOutcome {
  messageId?: string;
  mediaKey: string;
}

/**
 * [design-note G] 出站脱敏：飞书对话里不透露本机真实路径与密钥。
 *
 * 背景：bot 跑在本机、有完整工具权限，解释自己做了什么时会很自然地把本机绝对
 * 路径说出口——实测曾有 bot 在**客户群**里回过「成品归档到 ~/projects/<client>/
 * outputs/，而桥接只监听系统指定的 outputs 目录」。光靠提示词约束依赖模型自觉、
 * 不可靠，故在**出站收口处**强制过滤：MessageSender 的三个「带文字」出口
 * （sendCard / updateCard / sendText）覆盖全部卡片与文本，模型绕不过去。
 * 对所有会话（群聊 + 私聊）一律生效——私聊同样可能被截图/转发。
 *
 * ⚠️ 刻意**不做**「长 token 通杀」之类的宽泛规则：那会误伤飞书自身的
 * open_id(`ou_…`)、file_key(`file_v3_…`)、image_key(`img_v3_…`)、message_id(`om_…`)，
 * 直接打断 @ 提醒(patch F)与图片/文件发送。只匹配明确的路径与密钥形态。
 * 上传/下载用的 filePath 走 sendImageFile/sendLocalFile/uploadFile，**不经过本函数**
 * （否则真实路径被替换会导致读不到文件）。
 *
 * 替换串只含中文书名号，不含引号/反斜杠 → 不会破坏卡片的 JSON 结构。
 */
// 路径：前面加负向后顾，避免吃掉 URL 里的 /tmp/ 之类（如 https://host/tmp/x）
const LOCAL_PATH_RE =
  /(?<![A-Za-z0-9])(?:\/Users\/|~\/|\/var\/folders\/|\/private\/(?:tmp|var)\/|\/tmp\/)[^\s"'\\,;)\]}]*/g;

// 密钥：仅匹配明确形态；KEY/TOKEN/SECRET 等键名限大写，避免误伤 file_key 等小写字段
const SECRET_RULES: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '〈已隐藏〉'],   // OpenAI 类
  [/\bAKLT[A-Za-z0-9_-]{10,}/g, '〈已隐藏〉'],  // 火山 AK
  [/\bla_[A-Za-z0-9]{16,}/g, '〈已隐藏〉'],     // luckagent-core token
  [/\b([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*['"]?[^\s"'\\,;)\]}]+/g, '$1=〈已隐藏〉'],
];

/** [design-note G] 见上。对出站文字做脱敏；文件名（有扩展名）保留，只抹掉目录结构。 */
export function redactSensitive(text: string): string {
  let out = text;
  for (const [re, to] of SECRET_RULES) out = out.replace(re, to);
  out = out.replace(LOCAL_PATH_RE, (m) => {
    const base = m.slice(m.lastIndexOf('/') + 1);
    // 只在末段像文件名（有扩展名）时保留它；否则整段抹掉，避免 /Users/<用户名> 漏出账号名
    return /\.[A-Za-z0-9]{1,8}$/.test(base) ? `〈本地路径〉/${base}` : '〈本地路径〉';
  });
  return out;
}

// [design-note K] 飞书上传偶发 502 / 请求 hang 会静默丢文件（uploadFile/uploadImage 原本
// 只发一次、一 catch 就返回 undefined、不重试）——2026-07-07 与 2026-07-22 两个客户群
// PPT 各因 502 静默丢失。这里给上传加「单次超时 + 对 transient 错(5xx/超时/网络)指数退避重试」。
// 卡片发送早有重试(sendFinalCardWithRetry)，文件上传一直没有；本增强补齐这个不对称。
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_BASE_DELAY_MS = 1000;          // 退避基数：1s → 2s
const UPLOAD_ATTEMPT_TIMEOUT_MS = 120_000;  // 单次尝试上限 2 分钟，避免像那次 hang 8 分钟

function isTransientUploadError(err: unknown): boolean {
  const e = err as { code?: string; status?: number; message?: string; response?: { status?: number } };
  const status = e?.response?.status ?? e?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN'].includes(String(e?.code || ''))) return true;
  return /\b(50[0-9]|timeout|timed out|socket hang up|network)\b/i.test(String(e?.message || ''));
}

async function withUploadTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${UPLOAD_ATTEMPT_TIMEOUT_MS}ms`)), UPLOAD_ATTEMPT_TIMEOUT_MS);
  });
  try { return await Promise.race([p, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * [design-note N] 超 100MB 附件的分片下载回退。
 *
 * 背景：SDK 的 im.v1.messageResource.get 是单次 GET，飞书对它限 100MB——超限返回
 * HTTP 400 + body {code:234037}。2026-07-20（225MB）与 07-22（152.9MB）两次真实失败，
 * 且失败被静默吞掉，agent 全然不知道用户发过文件。同端点其实支持 HTTP Range 分段：
 * lark-cli 的 +messages-resources-download 就是靠「128KB 探测段（从 Content-Range 拿
 * 总大小）→ 8MB 顺序分段 → 尺寸校验」下载成功了同一条 225.3MB 消息（约 2.5 分钟）。
 * 这里按同一协议自实现，不 spawn lark-cli（免去对 profile 配置的耦合）。
 *
 * 实现要点：
 * - 走 client.request()：每个分段请求都由 SDK 注入新鲜 tenant token——下载耗时可达
 *   数分钟，固定 token 可能中途过期。`$return_headers` 让拦截器把 headers 带回来。
 * - 错误响应因 responseType:'stream' 是【未消费的流】，要先读完才能解析出 code。
 * - 每段 90s 超时 + transient 错误重试 2 次（指数退避）；整体 30 分钟兜底止损。
 * - 任何一步失败都删掉半成品文件，绝不留下截断的假文件。
 */
const LARGE_FILE_ERR_CODE = 234037;           // 飞书：单次 GET 资源超 100MB
const CHUNK_PROBE_BYTES = 128 * 1024;         // 探测段 128KB（与 lark-cli 一致）
const CHUNK_BYTES = 8 * 1024 * 1024;          // 后续分段 8MB（与 lark-cli 一致）
const CHUNK_MAX_ATTEMPTS = 5;                 // 每段 1 次 + 重试 4 次（退避 1+2+4+8≈15s，覆盖十秒级网络抖动）
const CHUNK_RETRY_BASE_DELAY_MS = 1000;       // 退避基数 1s → 2s → 4s → 8s
const CHUNK_ATTEMPT_TIMEOUT_MS = 90_000;      // 单段超时（8MB 实测约 5s，留 ~17x 余量）
const CHUNK_TOTAL_DEADLINE_MS = 30 * 60_000;  // 整体兜底（225MB 实测约 2.5 分钟）
const ERROR_BODY_READ_LIMIT = 64 * 1024;      // 错误体最多读 64KB，防异常大响应
const ERROR_BODY_READ_TIMEOUT_MS = 5000;

export function isTransientDownloadError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; status?: number; message?: string; response?: { status?: number } };
  // Deliberate cancellation is never transient — retrying a cancel would fight
  // an intentional abort (e.g. task stop) for up to the whole backoff budget.
  if (e?.name === 'AbortError' || e?.name === 'CanceledError' || e?.code === 'ERR_CANCELED') return false;
  const status = e?.response?.status ?? e?.status;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  // ERR_BAD_RESPONSE / ERR_STREAM_PREMATURE_CLOSE: axios surfaces a mid-stream
  // TLS/socket death this way ("stream has been aborted") — the textbook
  // transient blip. 真实事故：一次 11.6s 断网把 187MB 下载整体判死不重试。
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ENETUNREACH', 'EAI_AGAIN', 'ERR_BAD_RESPONSE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(String(e?.code || ''))) return true;
  return /\b(50[0-9]|timeout|timed out|socket hang up|network|aborted|premature close)\b/i.test(String(e?.message || ''));
}

/** 把 responseType:'stream' 的错误响应体读成字符串（可能已是 Buffer/string/object）。 */
async function readErrorBody(data: unknown): Promise<string | undefined> {
  if (data == null) return undefined;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (typeof data === 'string') return data;
  const maybeStream = data as NodeJS.ReadableStream & { destroy?: () => void };
  if (typeof maybeStream.on === 'function') {
    return await new Promise<string | undefined>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => { maybeStream.destroy?.(); resolve(undefined); }, ERROR_BODY_READ_TIMEOUT_MS);
      maybeStream.on('data', (c: Buffer | string) => {
        if (size < ERROR_BODY_READ_LIMIT) {
          const buf = Buffer.from(c);
          chunks.push(buf);
          size += buf.length;
        }
      });
      maybeStream.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      maybeStream.on('error', () => { clearTimeout(timer); resolve(undefined); });
    });
  }
  try { return JSON.stringify(data); } catch { return undefined; }
}

/** 从 axios/SDK 抛出的下载错误里解析飞书业务错误码（拿不到则两项皆 undefined）。 */
async function extractFeishuErrorCode(err: unknown): Promise<{ code?: number; msg?: string }> {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  const body = await readErrorBody(data);
  if (!body) return {};
  try {
    const parsed = JSON.parse(body) as { code?: unknown; msg?: unknown };
    return {
      code: typeof parsed?.code === 'number' ? parsed.code : undefined,
      msg: typeof parsed?.msg === 'string' ? parsed.msg : undefined,
    };
  } catch {
    return {};
  }
}

/** Content-Range: "bytes 0-131071/236500000" → 236500000；解析不了返回 undefined。 */
function parseTotalFromContentRange(header: string | undefined): number | undefined {
  const m = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(String(header ?? '').trim());
  if (!m) return undefined;
  const total = Number(m[1]);
  return Number.isSafeInteger(total) && total > 0 ? total : undefined;
}

function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (typeof data === 'string') return Buffer.from(data, 'binary');
  throw new Error(`unexpected chunk payload type: ${Object.prototype.toString.call(data)}`);
}

export class MessageSender {
  constructor(
    private client: lark.Client,
    private logger: Logger,
  ) {}

  async sendCard(chatId: string, cardContent: string): Promise<string | undefined> {
    const safeContent = redactSensitive(cardContent); // [design-note G] 出站脱敏
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: safeContent,
          msg_type: 'interactive',
        },
      });

      const messageId = resp?.data?.message_id;
      if (!messageId) {
        this.logger.error({ resp }, 'Failed to get message_id from send response');
      }
      return messageId;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send card');
      return undefined;
    }
  }

  async updateCard(messageId: string, cardContent: string): Promise<boolean> {
    const safeContent = redactSensitive(cardContent); // [design-note G] 出站脱敏
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: safeContent },
      });
      return true;
    } catch (err) {
      this.logger.error({ err, messageId }, 'Failed to update card');
      return false;
    }
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<DownloadOutcome> {
    return this.downloadResource(messageId, imageKey, 'image', savePath);
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<DownloadOutcome> {
    return this.downloadResource(messageId, fileKey, 'file', savePath);
  }

  /**
   * [design-note N] 单次 GET → 234037 时回退分片下载；失败携带原因返回。
   * 见文件头 patch N 说明。label 仅用于保持原有日志文案（'Image downloaded' 等）可 grep。
   */
  private async downloadResource(
    messageId: string,
    resourceKey: string,
    type: 'image' | 'file',
    savePath: string,
  ): Promise<DownloadOutcome> {
    const label = type === 'image' ? 'image' : 'file';
    const keyField = type === 'image' ? { imageKey: resourceKey } : { fileKey: resourceKey };
    try {
      const resp = await this.client.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: resourceKey },
        params: { type },
      });

      if (resp) {
        await (resp as any).writeFile(savePath);
        this.logger.info({ messageId, ...keyField, savePath }, type === 'image' ? 'Image downloaded' : 'File downloaded');
        return true;
      }
      this.logger.error({ messageId, ...keyField }, `Empty response when downloading ${label}`);
      return false;
    } catch (err) {
      const { code, msg } = await extractFeishuErrorCode(err);
      if (code === LARGE_FILE_ERR_CODE) {
        this.logger.warn(
          { messageId, ...keyField, savePath },
          `${label} exceeds the 100MB single-GET limit (code 234037), falling back to chunked download`,
        );
        const res = await this.downloadResourceChunked(messageId, resourceKey, type, savePath);
        if (res.ok) return true;
        return { ok: false, reason: `文件超过 100MB（飞书错误码 234037），分片下载回退也失败：${res.reason}` };
      }
      this.logger.error({ err, messageId, ...keyField }, `Failed to download ${label}`);
      const reason = code !== undefined
        ? `飞书接口错误码 ${code}${msg ? `（${msg}）` : ''}`
        : (err instanceof Error ? err.message : String(err));
      return { ok: false, reason };
    }
  }

  /**
   * [design-note N] HTTP Range 分片下载（协议与 lark-cli 一致，见文件头说明）。
   * 128KB 探测段拿 Content-Range 总大小 → 8MB 顺序分段 → 落盘后校验总尺寸。
   * 失败时删除半成品文件并返回原因。
   */
  private async downloadResourceChunked(
    messageId: string,
    resourceKey: string,
    type: 'image' | 'file',
    savePath: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const url = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resourceKey)}`;
    const deadline = Date.now() + CHUNK_TOTAL_DEADLINE_MS;
    const startedAt = Date.now();

    // client.request 自动注入 tenant token；多余字段（responseType/timeout/$return_headers）透传 axios
    const fetchRange = async (start: number, endInclusive: number): Promise<{ data: unknown; headers: Record<string, unknown> }> => {
      return await (this.client as unknown as {
        request: (payload: Record<string, unknown>) => Promise<{ data: unknown; headers: Record<string, unknown> }>;
      }).request({
        method: 'GET',
        url,
        params: { type },
        headers: { Range: `bytes=${start}-${endInclusive}` },
        responseType: 'arraybuffer',
        timeout: CHUNK_ATTEMPT_TIMEOUT_MS,
        $return_headers: true,
      });
    };

    const fetchRangeWithRetry = async (start: number, endInclusive: number) => {
      for (let attempt = 1; ; attempt++) {
        if (Date.now() > deadline) {
          throw new Error(`chunked download exceeded overall deadline (${CHUNK_TOTAL_DEADLINE_MS}ms)`);
        }
        try {
          return await fetchRange(start, endInclusive);
        } catch (err) {
          if (attempt < CHUNK_MAX_ATTEMPTS && isTransientDownloadError(err)) {
            const delay = CHUNK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
            this.logger.warn({ messageId, resourceKey, start, endInclusive, attempt, delay }, 'Chunk request failed (transient), retrying');
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          throw err;
        }
      }
    };

    let out: fs.WriteStream | undefined;
    try {
      // 探测段：拿总大小；服务端不回 Content-Range 时说明整包已在响应里
      const probe = await fetchRangeWithRetry(0, CHUNK_PROBE_BYTES - 1);
      const probeBuf = toBuffer(probe.data);
      const rawContentRange = probe.headers?.['content-range'] ?? probe.headers?.['Content-Range'];
      const total = parseTotalFromContentRange(rawContentRange === undefined ? undefined : String(rawContentRange));
      if (total === undefined && rawContentRange !== undefined) {
        throw new Error(`unparseable Content-Range header: ${String(rawContentRange)}`);
      }

      out = fs.createWriteStream(savePath);
      const stream = out;
      const writeChunk = (buf: Buffer) => new Promise<void>((resolve, reject) => {
        stream.write(buf, (e) => (e ? reject(e) : resolve()));
      });
      const closeStream = () => new Promise<void>((resolve, reject) => {
        stream.on('error', reject);
        stream.end(() => resolve());
      });

      await writeChunk(probeBuf);

      if (total === undefined) {
        // 没有 Content-Range：响应即完整文件（服务端忽略了 Range）
        await closeStream();
        out = undefined;
        this.logger.info({ messageId, resourceKey, savePath, size: probeBuf.length }, 'Chunked download degenerated to full response, saved');
        return { ok: true };
      }

      let offset = probeBuf.length;
      while (offset < total) {
        const end = Math.min(offset + CHUNK_BYTES, total) - 1;
        const part = await fetchRangeWithRetry(offset, end);
        const buf = toBuffer(part.data);
        const expected = end - offset + 1;
        if (buf.length !== expected) {
          throw new Error(`chunk size mismatch at offset ${offset}: got ${buf.length} bytes, want ${expected}`);
        }
        await writeChunk(buf);
        offset += buf.length;
      }
      await closeStream();
      out = undefined;

      const actual = fs.statSync(savePath).size;
      if (actual !== total) {
        throw new Error(`assembled file size ${actual} != expected ${total}`);
      }
      this.logger.info(
        { messageId, resourceKey, savePath, size: total, elapsedMs: Date.now() - startedAt },
        type === 'image' ? 'Image downloaded (chunked)' : 'File downloaded (chunked)',
      );
      return { ok: true };
    } catch (err) {
      try { out?.destroy(); } catch { /* noop */ }
      try { if (fs.existsSync(savePath)) fs.unlinkSync(savePath); } catch { /* noop */ }
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error({ err, messageId, resourceKey, savePath }, 'Chunked download failed');
      return { ok: false, reason };
    }
  }

  async uploadImage(filePath: string): Promise<string | undefined> {
    // [design-note K] 同 uploadFile：单次超时 + transient 退避重试。
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await withUploadTimeout(this.client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: fs.createReadStream(filePath),
          },
        }), 'image upload');
        const imageKey = resp?.image_key;
        if (imageKey) {
          this.logger.info({ filePath, imageKey, attempt }, 'Image uploaded to Feishu');
          return imageKey;
        }
        this.logger.error({ filePath, attempt }, 'Image upload returned no image_key');
        return undefined;
      } catch (err) {
        if (isTransientUploadError(err) && attempt < UPLOAD_MAX_ATTEMPTS) {
          const delay = UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn({ err, filePath, attempt, delay }, 'Image upload failed (transient), retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error({ err, filePath, attempts: attempt }, 'Failed to upload image');
        return undefined;
      }
    }
    return undefined;
  }

  async sendImage(chatId: string, imageKey: string): Promise<MediaSendOutcome | false> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ image_key: imageKey }),
          msg_type: 'image',
        },
      });
      return { messageId: resp?.data?.message_id, mediaKey: imageKey }; // [design-note P] 台账登记用
    } catch (err) {
      this.logger.error({ err, chatId, imageKey }, 'Failed to send image');
      return false;
    }
  }

  async sendImageFile(chatId: string, filePath: string): Promise<MediaSendOutcome | false> {
    const imageKey = await this.uploadImage(filePath);
    if (!imageKey) return false;
    return this.sendImage(chatId, imageKey);
  }

  async uploadFile(filePath: string, fileName: string, fileType: string): Promise<string | undefined> {
    // [design-note K] 单次超时 + transient 错(5xx/超时/网络)指数退避重试；每次都新建 read stream。
    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await withUploadTimeout(this.client.im.v1.file.create({
          data: {
            file_type: fileType as any,
            file_name: fileName,
            file: fs.createReadStream(filePath),
          },
        }), 'file upload');
        const fileKey = resp?.file_key;
        if (fileKey) {
          this.logger.info({ filePath, fileKey, fileType, attempt }, 'File uploaded to Feishu');
          return fileKey;
        }
        this.logger.error({ filePath, fileType, attempt }, 'File upload returned no file_key');
        return undefined; // 非异常但没拿到 key：不重试
      } catch (err) {
        if (isTransientUploadError(err) && attempt < UPLOAD_MAX_ATTEMPTS) {
          const delay = UPLOAD_BASE_DELAY_MS * 2 ** (attempt - 1);
          this.logger.warn({ err, filePath, fileType, attempt, delay }, 'File upload failed (transient), retrying');
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        this.logger.error({ err, filePath, fileType, attempts: attempt }, 'Failed to upload file');
        return undefined;
      }
    }
    return undefined;
  }

  async sendFile(chatId: string, fileKey: string): Promise<MediaSendOutcome | false> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'file',
        },
      });
      return { messageId: resp?.data?.message_id, mediaKey: fileKey }; // [design-note P]
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send file');
      return false;
    }
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string, fileType: string): Promise<MediaSendOutcome | false> {
    const fileKey = await this.uploadFile(filePath, fileName, fileType);
    if (!fileKey) return false;
    return this.sendFile(chatId, fileKey);
  }

  async sendAudio(chatId: string, fileKey: string): Promise<MediaSendOutcome | false> {
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ file_key: fileKey }),
          msg_type: 'audio',
        },
      });
      return { messageId: resp?.data?.message_id, mediaKey: fileKey }; // [design-note P]
    } catch (err) {
      this.logger.error({ err, chatId, fileKey }, 'Failed to send audio');
      return false;
    }
  }

  async sendAudioFile(chatId: string, filePath: string, fileName: string): Promise<MediaSendOutcome | false> {
    const fileKey = await this.uploadFile(filePath, fileName, 'opus');
    if (!fileKey) return false;
    return this.sendAudio(chatId, fileKey);
  }

  async getChatMemberCount(chatId: string): Promise<number | undefined> {
    try {
      const resp: any = await this.client.im.v1.chat.get({
        path: { chat_id: chatId },
      });
      const userCount = parseInt(resp?.data?.user_count, 10) || 0;
      const botCount = parseInt(resp?.data?.bot_count, 10) || 0;
      return userCount + botCount;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to get chat member count');
      return undefined;
    }
  }

  // [design-note P] 返回 message_id（原为 void）供出站台账登记；失败仍返回 undefined，行为不变。
  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const safeText = redactSensitive(text); // [design-note G] 出站脱敏
    // [design-note] 传了 replyToMessageId 就用 im.message.reply 引用回复(触发提问人的飞书通知);
    // reply 失败(原消息被撤回/过期/权限等)则回退普通 create,保证通知即使引用失败也照发。
    if (replyToMessageId) {
      try {
        const resp = await this.client.im.v1.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: JSON.stringify({ text: safeText }), msg_type: 'text' },
        });
        return resp?.data?.message_id;
      } catch (err) {
        this.logger.warn({ err, replyToMessageId }, 'Failed to reply-quote text, falling back to plain send');
      }
    }
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: safeText }),
          msg_type: 'text',
        },
      });
      return resp?.data?.message_id;
    } catch (err) {
      this.logger.error({ err, chatId }, 'Failed to send text');
      return undefined;
    }
  }

  /**
   * [design-note P] 拉取指定消息内容（引用回复解析用）。任何失败（无权限、
   * 已删除、网络、SDK 以 {code,msg} 返回业务错）都返回 undefined，绝不抛出。
   */
  /**
   * [design-note S] Page a chat's messages newest-first inside a time window
   * (im.v1.message.list) for round-context fetching. Returns undefined on any
   * failure so the caller can degrade; never throws.
   */
  async listMessages(
    chatId: string, startTimeSec: string, endTimeSec: string, pageToken?: string,
  ): Promise<{ items: any[]; hasMore: boolean; pageToken?: string } | undefined> {
    try {
      const resp: any = await this.client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: startTimeSec,
          end_time: endTimeSec,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      if (resp?.code !== undefined && resp?.code !== null && resp.code !== 0) {
        this.logger.warn({ chatId, code: resp.code, msg: resp.msg }, 'listMessages returned error code');
        return undefined;
      }
      return { items: resp?.data?.items ?? [], hasMore: Boolean(resp?.data?.has_more), pageToken: resp?.data?.page_token };
    } catch (err) {
      this.logger.warn({ err, chatId }, 'listMessages failed');
      return undefined;
    }
  }

  async fetchMessage(messageId: string): Promise<FetchedMessage | undefined> {
    try {
      const resp = await this.client.im.v1.message.get({ path: { message_id: messageId } });
      const item = resp?.data?.items?.[0];
      if (!item) {
        this.logger.warn({ messageId, code: (resp as any)?.code, msg: (resp as any)?.msg }, 'fetchMessage returned no item');
        return undefined;
      }
      return {
        msgType: item.msg_type ?? 'unknown',
        content: item.body?.content ?? '',
        senderId: item.sender?.id,
        senderIdType: item.sender?.id_type,
        senderType: item.sender?.sender_type,
        deleted: item.deleted,
      };
    } catch (err) {
      this.logger.warn({ err, messageId }, 'fetchMessage failed');
      return undefined;
    }
  }
}

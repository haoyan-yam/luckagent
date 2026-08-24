import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { CardState } from '../types.js';
import type { IMessageSender } from './message-sender.interface.js';
import { StreamProcessor, extractImagePaths } from '../engines/index.js';
import { OutputsManager } from './outputs-manager.js';

/**
 * Feishu API limits documented at
 *   https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/image/create
 *   https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/file/create
 *
 * Previous value of 50 MB for FILE_MAX_BYTES was incorrect — uploads in
 * the 30-50 MB range would attempt and silently fail at the Feishu API
 * level with the user never knowing. Aligning to the documented cap
 * lets the OversizedNotice path catch them instead.
 */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const FILE_MAX_BYTES  = 30 * 1024 * 1024; // 30 MB

interface OversizedFile {
  fileName:  string;
  sizeBytes: number;
  isImage:   boolean;
  /** [design-note Q] 若位于发送目录内,通知发出后删除,防每轮重复通知 */
  filePath?: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export class OutputHandler {
  constructor(
    private logger: Logger,
    private sender: IMessageSender,
    private outputsManager: OutputsManager,
  ) {}

  // [design-note Q] per-chat 发送互斥链:轮末扫描 / spontaneous 补扫 / 开轮兜底 /
  // 延迟清理前置补扫可能并发扫同一目录,串行化后配合"发过即删"物理上杜绝双发。
  private sendChains = new Map<string, Promise<void>>();

  private runExclusive<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.sendChains.get(chatId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.sendChains.set(chatId, tail);
    void tail.then(() => {
      if (this.sendChains.get(chatId) === tail) this.sendChains.delete(chatId);
    });
    return run;
  }

  /** [design-note Q] p 是否位于 dir 之内(防误删发送目录外的工作区文件)。 */
  private isInsideDir(dir: string, p: string): boolean {
    const rel = path.relative(dir, p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  private tryUnlink(p: string): void {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }

  /** [design-note Q] 通知发出后删除仍留在发送目录内的超限/失败文件,防每轮重复通知。 */
  private deleteNoticedLeftovers(outputsDir: string, entries: { filePath?: string }[]): void {
    for (const e of entries) {
      if (e.filePath && this.isInsideDir(outputsDir, e.filePath)) this.tryUnlink(e.filePath);
    }
  }

  /**
   * [design-note Q] 发送目录扫描 + 逐个发送。发送成功的文件**立即删除** ——
   * 建立不变量「目录里还有 = 一定没发过」,所有发送入口由此天然免疫重复发送。
   * 供 sendOutputFiles(轮末)与 sweepDir(补扫)共用。调用方须已持有 runExclusive。
   */
  private async sendDirFilesLocked(
    chatId: string,
    outputsDir: string,
    sentPaths: Set<string>,
    oversized: OversizedFile[],
    failedSends: { fileName: string; isImage: boolean; filePath?: string }[],
  ): Promise<void> {
    const outputFiles = this.outputsManager.scanOutputs(outputsDir);
    for (const file of outputFiles) {
      try {
        if (file.isImage && file.sizeBytes <= IMAGE_MAX_BYTES) {
          this.logger.info({ filePath: file.filePath }, 'Sending output image from outputs dir');
          const ok = await this.sender.sendImageFile(chatId, file.filePath);
          if (!ok) failedSends.push({ fileName: file.fileName, isImage: true, filePath: file.filePath }); // [design-note L]
          else this.tryUnlink(file.filePath); // [design-note Q] 发过即删
        } else if (!file.isImage && file.sizeBytes <= FILE_MAX_BYTES) {
          this.logger.info({ filePath: file.filePath }, 'Sending output file from outputs dir');
          const sent = await this.sender.sendLocalFile(chatId, file.filePath, file.fileName);
          if (!sent) {
            if (OutputsManager.isTextFile(file.extension) && file.sizeBytes < 30 * 1024) {
              // 小文本上传失败 → 直接把内容当文本贴出（已投递，不算失败）
              this.logger.info({ filePath: file.filePath }, 'File upload failed, sending as text message');
              const content = fs.readFileSync(file.filePath, 'utf-8');
              await this.sender.sendText(chatId, `📄 ${file.fileName}\n\n${content}`);
              this.tryUnlink(file.filePath); // [design-note Q] 已投递,同删
            } else {
              // [design-note L] 经 K 重试仍失败、又没走文本兜底 → 记下，末尾统一告知，不再静默丢
              failedSends.push({ fileName: file.fileName, isImage: false, filePath: file.filePath });
            }
          } else {
            this.tryUnlink(file.filePath); // [design-note Q] 发过即删
          }
        } else {
          // Track for a single end-of-batch notice so users know files exist
          // but were dropped — silently logging warn was the original bug.
          this.logger.warn({ filePath: file.filePath, sizeBytes: file.sizeBytes }, 'Output file too large to send');
          oversized.push({ fileName: file.fileName, sizeBytes: file.sizeBytes, isImage: file.isImage, filePath: file.filePath });
        }
        sentPaths.add(file.filePath);
      } catch (err) {
        this.logger.warn({ err, filePath: file.filePath }, 'Failed to send output file');
      }
    }
  }

  /**
   * [design-note Q] 纯目录补扫:把发送目录里残留(=未发送)的文件发出并删除。
   * 不做正文/processor fallback(避免把正文提到的归档路径重发)。
   * 入口:spontaneous 卡片后、开轮 prepareDir 前、延迟清理 rm 前。
   */
  async sweepDir(chatId: string, outputsDir: string | null): Promise<void> {
    if (!outputsDir) return;
    return this.runExclusive(chatId, async () => {
      const sentPaths = new Set<string>();
      const oversized: OversizedFile[] = [];
      const failedSends: { fileName: string; isImage: boolean; filePath?: string }[] = [];
      await this.sendDirFilesLocked(chatId, outputsDir, sentPaths, oversized, failedSends);
      if (oversized.length > 0) await this.sendOversizedNotice(chatId, oversized);
      if (failedSends.length > 0) await this.sendFailedNotice(chatId, failedSends);
      this.deleteNoticedLeftovers(outputsDir, [...oversized, ...failedSends]);
    });
  }

  async sendOutputFiles(
    chatId: string,
    outputsDir: string,
    processor: StreamProcessor,
    state: CardState,
  ): Promise<void> {
    return this.runExclusive(chatId, async () => { // [design-note Q] 互斥
    const sentPaths = new Set<string>();
    const oversized: OversizedFile[] = [];
    const failedSends: { fileName: string; isImage: boolean; filePath?: string }[] = []; // [design-note L] 经 K 重试仍失败的

    // 1. Scan the outputs directory for any files the agent placed there
    //    [design-note Q] 逻辑提取到 sendDirFilesLocked(发过即删),与补扫共用
    await this.sendDirFilesLocked(chatId, outputsDir, sentPaths, oversized, failedSends);

    // 2. Fallback: send images detected via old method (Write tool tracking + response text scanning)
    const imagePaths = new Set<string>(processor.getImagePaths());
    if (state.responseText) {
      for (const p of extractImagePaths(state.responseText)) {
        imagePaths.add(p);
      }
    }

    for (const imgPath of imagePaths) {
      if (sentPaths.has(imgPath)) continue;
      try {
        if (fs.existsSync(imgPath) && fs.statSync(imgPath).isFile()) {
          const size = fs.statSync(imgPath).size;
          if (size <= 0) continue;
          if (size <= IMAGE_MAX_BYTES) {
            this.logger.info({ imgPath }, 'Sending output image (fallback)');
            const ok = await this.sender.sendImageFile(chatId, imgPath);
            if (!ok) failedSends.push({ fileName: imgPath.split('/').pop() ?? imgPath, isImage: true, filePath: imgPath }); // [design-note L]
            // [design-note Q] fallback 命中的文件若位于发送目录内(扩展名未被
            // scanOutputs 识别的边角),发过同删 —— 否则会被后续补扫当文件重发。
            else if (this.isInsideDir(outputsDir, imgPath)) this.tryUnlink(imgPath);
          } else {
            // Same notice path as the outputs-dir scan — match user-visible behaviour.
            this.logger.warn({ imgPath, sizeBytes: size }, 'Fallback output image too large to send');
            oversized.push({ fileName: imgPath.split('/').pop() ?? imgPath, sizeBytes: size, isImage: true, filePath: imgPath });
          }
        }
      } catch (err) {
        this.logger.warn({ err, imgPath }, 'Failed to send output image');
      }
    }

    // 3. If anything was dropped for being too large, tell the user. Previously
    //    these failed silently — users assumed the bot just didn't generate
    //    the file. One coalesced notice for the whole batch instead of one
    //    per file so a 10-file batch with all-oversized doesn't spam.
    if (oversized.length > 0) {
      await this.sendOversizedNotice(chatId, oversized);
    }

    // 4. [design-note L] 经 patch K 重试后仍发送失败的文件/图片 → 明确告知，不再静默丢。
    if (failedSends.length > 0) {
      await this.sendFailedNotice(chatId, failedSends);
    }

    // 5. [design-note Q] 通知完删除发送目录内的超限/失败残留,防下轮重复通知/重发。
    this.deleteNoticedLeftovers(outputsDir, [...oversized, ...failedSends]);
    }); // [design-note Q] 互斥结束
  }

  /**
   * [design-note L] 上传经 patch K 重试仍失败时，末尾发一条软措辞通知，不再静默丢文件。
   * 措辞刻意软化：极少数情况下 sent=false 但飞书其实已投递（投递步客户端超时 race），
   * 说「如果没看到」而非硬「失败」，即便误报也只是「文件明明在啊」，不尴尬。
   */
  private async sendFailedNotice(chatId: string, files: { fileName: string; isImage: boolean }[]): Promise<void> {
    const list = files.map((f) => `- \`${f.fileName}\`${f.isImage ? ' (图片)' : ''}`).join('\n');
    const body = `下面${files.length === 1 ? '这个文件' : `这 ${files.length} 个文件`}我已经生成好，但**发送到群里没成功**（飞书上传多次重试仍失败）。如果你在群里没看到，回我一声，我马上重发：\n\n${list}`;
    try {
      await this.sender.sendTextNotice(chatId, '⚠️ 有文件没发出来', body, 'red');
    } catch (err) {
      this.logger.warn({ err, chatId, count: files.length }, 'Failed to send send-failure notice');
    }
  }

  private async sendOversizedNotice(chatId: string, files: OversizedFile[]): Promise<void> {
    const lines = [
      `Cannot send **${files.length}** file${files.length === 1 ? '' : 's'} because ${files.length === 1 ? 'it exceeds' : 'they exceed'} the Feishu upload limit (max ${IMAGE_MAX_BYTES / 1024 / 1024}MB images, ${FILE_MAX_BYTES / 1024 / 1024}MB files):`,
      '',
      ...files.map((f) => `- \`${f.fileName}\` — ${formatBytes(f.sizeBytes)}${f.isImage ? ' (image)' : ''}`),
    ];
    try {
      await this.sender.sendTextNotice(chatId, '⚠️ Files Too Large', lines.join('\n'), 'orange');
    } catch (err) {
      this.logger.warn({ err, chatId, count: files.length }, 'Failed to send oversized-file notice');
    }
  }
}

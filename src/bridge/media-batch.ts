import type { IncomingMessage } from '../types.js';
import { DEFAULT_FILE_TEXT, DEFAULT_IMAGE_TEXT } from './bridge-constants.js';

export interface PendingBatch {
  messages: IncomingMessage[];
  timerId: ReturnType<typeof setTimeout>;
}

export function isDefaultMediaText(msg: IncomingMessage): boolean {
  return (!!msg.imageKey && msg.text === DEFAULT_IMAGE_TEXT)
    || (!!msg.fileKey && msg.text === DEFAULT_FILE_TEXT);
}

export function mergeBatchMessages(messages: IncomingMessage[]): IncomingMessage {
  const first = messages[0];
  if (messages.length === 1) return first;

  const imageCount = messages.filter((m) => m.imageKey).length;
  const fileCount = messages.filter((m) => m.fileKey).length;
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount}张图片`);
  if (fileCount > 0) parts.push(`${fileCount}个文件`);

  return {
    ...first,
    text: `请分析这些${parts.join('和')}`,
    extraMedia: messages.slice(1).map((m) => ({
      messageId: m.messageId,
      imageKey: m.imageKey,
      fileKey: m.fileKey,
      fileName: m.fileName,
    })),
  };
}

export function mergeBatchWithText(batchMsgs: IncomingMessage[], textMsg: IncomingMessage): IncomingMessage {
  return {
    ...textMsg,
    extraMedia: batchMsgs.map((m) => ({
      messageId: m.messageId,
      imageKey: m.imageKey,
      fileKey: m.fileKey,
      fileName: m.fileName,
    })),
  };
}

/**
 * Merge a follow-up message into an earlier queued message from the SAME
 * sender. Used to coalesce a person's rapid-fire messages while a task is
 * running, so they run as a single turn instead of N serial turns. The earlier
 * message stays the base (keeping its primary media slot); the follow-up's text
 * is appended and its media folded into extraMedia. Default media placeholder
 * texts (e.g. "请分析这张图片") are dropped when there is real text to keep.
 */
export function mergeSameSenderMessages(base: IncomingMessage, next: IncomingMessage): IncomingMessage {
  const texts: string[] = [];
  if (base.text && !isDefaultMediaText(base)) texts.push(base.text);
  if (next.text && !isDefaultMediaText(next)) texts.push(next.text);

  const extraMedia = [...(base.extraMedia ?? [])];
  if (next.imageKey || next.fileKey) {
    extraMedia.push({
      messageId: next.messageId,
      imageKey: next.imageKey,
      fileKey: next.fileKey,
      fileName: next.fileName,
    });
  }
  if (next.extraMedia?.length) extraMedia.push(...next.extraMedia);

  return {
    ...base,
    text: texts.length > 0 ? texts.join('\n') : base.text,
    extraMedia: extraMedia.length > 0 ? extraMedia : undefined,
  };
}

import type { IncomingMessage } from '../types.js';
import { DEFAULT_FILE_TEXT, DEFAULT_IMAGE_TEXT } from './bridge-constants.js';

export interface PendingBatch {
  messages: IncomingMessage[];
  timerId: ReturnType<typeof setTimeout>;
}

export function isDefaultMediaText(msg: IncomingMessage): boolean {
  return (!!msg.imageKey && msg.text === DEFAULT_IMAGE_TEXT) || (!!msg.fileKey && msg.text === DEFAULT_FILE_TEXT);
}

type MediaRef = NonNullable<IncomingMessage['extraMedia']>[number];

/**
 * Every attachment a message carries: its primary slot plus whatever is already
 * in its extraMedia (a rich-text post's 2nd+ images, the @-round's earlier
 * uploads). Merges must carry all of these — replacing extraMedia silently
 * dropped them.
 */
function mediaOf(m: IncomingMessage): MediaRef[] {
  const out: MediaRef[] = [];
  if (m.imageKey || m.fileKey) {
    out.push({ messageId: m.messageId, imageKey: m.imageKey, fileKey: m.fileKey, fileName: m.fileName });
  }
  if (m.extraMedia?.length) out.push(...m.extraMedia);
  return out;
}

const mediaKey = (m: MediaRef) => `${m.messageId}|${m.imageKey ?? ''}|${m.fileKey ?? ''}`;

/**
 * Drop repeated attachments (same message + key) and the one already sitting in
 * the merged message's primary slot, so nothing is downloaded twice. Keeps the
 * first occurrence's order; undefined when nothing is left.
 */
function dedupeMedia(list: MediaRef[], primary: IncomingMessage): MediaRef[] | undefined {
  const seen = new Set<string>();
  if (primary.imageKey || primary.fileKey) {
    seen.add(mediaKey({ messageId: primary.messageId, imageKey: primary.imageKey, fileKey: primary.fileKey }));
  }
  const out = list.filter((m) => {
    const k = mediaKey(m);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return out.length > 0 ? out : undefined;
}

export function mergeBatchMessages(messages: IncomingMessage[]): IncomingMessage {
  const first = messages[0];
  if (messages.length === 1) return first;

  const extraMedia = dedupeMedia(messages.flatMap(mediaOf), first);
  const primary = first.imageKey || first.fileKey ? mediaOf(first).slice(0, 1) : [];
  const all = [...primary, ...(extraMedia ?? [])];
  const imageCount = all.filter((m) => m.imageKey).length;
  const fileCount = all.filter((m) => m.fileKey).length;
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount}张图片`);
  if (fileCount > 0) parts.push(`${fileCount}个文件`);

  return {
    ...first,
    text: `请分析这些${parts.join('和')}`,
    extraMedia,
  };
}

/**
 * Fold batched media-only messages into the text message that flushed them.
 * The text message keeps its own primary slot and its own extraMedia; the
 * batch's media (sent earlier) come first.
 */
export function mergeBatchWithText(batchMsgs: IncomingMessage[], textMsg: IncomingMessage): IncomingMessage {
  return {
    ...textMsg,
    extraMedia: dedupeMedia([...batchMsgs.flatMap(mediaOf), ...(textMsg.extraMedia ?? [])], textMsg),
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

  return {
    ...base,
    text: texts.length > 0 ? texts.join('\n') : base.text,
    extraMedia: dedupeMedia([...(base.extraMedia ?? []), ...mediaOf(next)], base),
  };
}

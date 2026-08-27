import * as lark from '@larksuiteoapi/node-sdk';
import type { BotConfig } from '../config.js';
import type { Logger } from '../utils/logger.js';
import { MessageSender } from './message-sender.js';

// Re-export from shared types so existing imports continue to work
export type { IncomingMessage } from '../types.js';
import type { IncomingMessage } from '../types.js';

export type MessageHandler = (msg: IncomingMessage) => void;

/** Payload delivered when a user clicks a button on an interactive card. */
export interface CardActionEvent {
  chatId: string;
  userId: string;
  messageId: string;
  /** Arbitrary value object set by the card builder on the clicked button. */
  value: Record<string, unknown>;
}

export type CardActionHandler = (event: CardActionEvent) => void;

// Cache for group member counts (to avoid calling Feishu API on every message)
const MEMBER_COUNT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const memberCountCache = new Map<string, { count: number; ts: number }>();

// Cache for recent media messages in group chats (file/image sent without @mention).
// When a user later @mentions the bot, cached media is attached automatically.
// [design-note N] TTL 5 分钟太短：2026-07-21 13:29 缓存的两个文件，13:39 @bot 时
// 已过期被【静默】过滤，用户以为 bot 收到了文件。传大文件、写一段说明再 @，超过
// 5 分钟太常见。提到 30 分钟（缓存只存 key 不存内容，内存无压力）；过期丢弃必须打
// WARN（含文件名），事后可从日志还原「用户发过什么、为什么没带上」。
// 导出 cachePendingMedia/getCachedMedia/MEDIA_CACHE_TTL_MS 仅为单测；生产只有本文件用。
export const MEDIA_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
interface CachedMedia {
  messageId: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
  ts: number;
}
const pendingMediaCache = new Map<string, CachedMedia[]>(); // key: chatId:userId

function cacheMediaKey(chatId: string, userId: string): string {
  return `${chatId}:${userId}`;
}

/** [design-note N] 入缓存收口成函数（原是调用点内联三行），单测得以直接构造过期条目。 */
export function cachePendingMedia(chatId: string, userId: string, media: CachedMedia): void {
  const key = cacheMediaKey(chatId, userId);
  const items = pendingMediaCache.get(key) || [];
  items.push(media);
  pendingMediaCache.set(key, items);
}

export function getCachedMedia(chatId: string, userId: string, logger?: Logger): CachedMedia[] {
  const key = cacheMediaKey(chatId, userId);
  const items = pendingMediaCache.get(key);
  if (!items) return [];
  const now = Date.now();
  const valid = items.filter(m => now - m.ts < MEDIA_CACHE_TTL_MS);
  // [design-note N] 过期丢弃绝不静默：WARN 带文件名/图片 key 与滞留时长
  const expired = items.filter(m => now - m.ts >= MEDIA_CACHE_TTL_MS);
  if (expired.length > 0 && logger) {
    logger.warn(
      {
        chatId,
        userId,
        dropped: expired.map(m => m.fileName || m.imageKey || m.fileKey || m.messageId),
        oldestAgeMs: Math.max(...expired.map(m => now - m.ts)),
        ttlMs: MEDIA_CACHE_TTL_MS,
      },
      'Cached media expired before @mention and was dropped (NOT attached to the task)',
    );
  }
  if (valid.length === 0) {
    pendingMediaCache.delete(key);
    return [];
  }
  pendingMediaCache.set(key, valid);
  return valid;
}

function clearCachedMedia(chatId: string, userId: string): void {
  pendingMediaCache.delete(cacheMediaKey(chatId, userId));
}

// Dedup cache for already-processed message ids. Feishu retries webhook delivery
// (at-least-once) when the handler is slow to respond — e.g. a long-running task
// or media download — so without dedup the same message gets processed repeatedly.
const PROCESSED_MSG_TTL_MS = 10 * 60 * 1000; // 10 minutes
const processedMessages = new Map<string, number>(); // messageId -> ts

/** Returns true if this messageId was already seen (and records it otherwise). */
function isDuplicateMessage(messageId: string): boolean {
  const now = Date.now();
  // Opportunistic cleanup of stale entries
  if (processedMessages.size > 500) {
    for (const [id, ts] of processedMessages) {
      if (now - ts > PROCESSED_MSG_TTL_MS) processedMessages.delete(id);
    }
  }
  const seen = processedMessages.get(messageId);
  if (seen !== undefined && now - seen < PROCESSED_MSG_TTL_MS) return true;
  processedMessages.set(messageId, now);
  return false;
}

async function isPrivateLikeGroup(chatId: string, sender: MessageSender): Promise<boolean> {
  const cached = memberCountCache.get(chatId);
  if (cached && Date.now() - cached.ts < MEMBER_COUNT_CACHE_TTL_MS) {
    return cached.count === 2;
  }
  const count = await sender.getChatMemberCount(chatId);
  if (count !== undefined) {
    memberCountCache.set(chatId, { count, ts: Date.now() });
    return count === 2;
  }
  return false;
}


/**
 * The im.message.receive_v1 handler as a standalone factory. Exported so the
 * reconnect BACKFILL can replay REST-fetched messages through the exact same
 * pipeline (dedupe/@-gating/media parsing) that live WebSocket events use —
 * the module-level processedMessages cache makes double-delivery safe.
 */
export function createReceiveHandler(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
): (data: any) => Promise<void> {
  return async (data: any) => {
      try {
        const event = data;
        const message = event.message;
        const sender = event.sender;

        const msgType = message.message_type;

        // Only handle text, post (rich text), image, and file messages
        if (msgType !== 'text' && msgType !== 'post' && msgType !== 'image' && msgType !== 'file') {
          logger.debug({ type: msgType }, 'Ignoring unsupported message type');
          return;
        }

        const userId = sender?.sender_id?.open_id;
        if (!userId) {
          logger.warn('Message missing sender open_id');
          return;
        }

        const chatId = message.chat_id;
        const chatType = message.chat_type;
        const messageId = message.message_id;
        // [design-note P] 引用回复带 parent_id（被引消息 id）；桥接据此把被引内容注入回合上下文。
        // root_id 仅入日志，供「话题内普通消息是否误带 parent_id」这类语义边界的事后诊断。
        const parentId = message.parent_id;
        if (parentId) {
          logger.info({ chatId, userId, messageId, parentId, rootId: message.root_id }, 'Message is a quote-reply');
        }

        // Dedup: Feishu retries delivery if we respond slowly (e.g. during a
        // long task). Mark this messageId as seen up-front so retries are dropped.
        if (messageId && isDuplicateMessage(messageId)) {
          logger.debug({ messageId, msgType }, 'Duplicate message delivery ignored');
          return;
        }

        // groupOnly mode: ignore private (1-on-1) chats entirely. Employees can
        // only interact with the bot inside project groups. Reply once with a
        // short hint so they know where to go, then drop the message.
        const groupOnlyAllowed = config.groupOnlyAllowUsers?.includes(userId);
        if (config.groupOnly && chatType !== 'group' && !groupOnlyAllowed) {
          logger.info({ chatId, userId, chatType }, 'groupOnly mode: ignoring private chat message');
          if (messageSender) {
            try {
              await messageSender.sendText(chatId, '你好,我只在项目群里工作,请到对应的项目群里 @我使用 🙂');
            } catch (err) {
              logger.warn({ err }, 'Failed to send groupOnly hint reply');
            }
          }
          return;
        }

        // In group chats, only respond when the bot is @mentioned
        // Exceptions: 2-member groups are treated like DMs; groupNoMention mode skips @mention check
        const mentions = message.mentions;
        if (chatType === 'group') {
          const botMentioned = botOpenId
            ? mentions?.some((m: any) => m.id?.open_id === botOpenId)
            : mentions && mentions.length > 0;
          if (!botMentioned) {
            // groupNoMention mode: respond to all messages without @mention
            if (config.groupNoMention) {
              logger.debug({ chatId }, 'Group no-mention mode enabled, processing without @mention');
            } else if (messageSender && await isPrivateLikeGroup(chatId, messageSender)) {
              logger.debug({ chatId }, 'Private-like group (2 members), processing without @mention');
            } else if (msgType === 'image' || msgType === 'file') {
              // Cache media messages for later retrieval when user @mentions bot
              const media = parseMediaMessage(message, msgType, logger);
              if (media) {
                cachePendingMedia(chatId, userId, { ...media, messageId, ts: Date.now() });
                logger.info({ chatId, userId, msgType, ...media }, 'Cached group media for later @mention');
              }
              return;
            } else {
              logger.debug('Ignoring group message without @mention');
              return;
            }
          }
        }

        let text = '';
        let imageKey: string | undefined;
        let fileKey: string | undefined;
        let fileName: string | undefined;
        let postExtraImages: string[] = [];

        if (msgType === 'image') {
          // Image message: extract image_key
          try {
            const content = JSON.parse(message.content);
            imageKey = content.image_key;
          } catch {
            logger.warn('Failed to parse image message content');
            return;
          }
          if (!imageKey) {
            logger.warn('Image message missing image_key');
            return;
          }
          text = '请分析这张图片';
          logger.info({ userId, chatId, chatType, imageKey }, 'Received image message');
        } else if (msgType === 'file') {
          // File message: extract file_key and file_name
          try {
            const content = JSON.parse(message.content);
            fileKey = content.file_key;
            fileName = content.file_name;
          } catch {
            logger.warn('Failed to parse file message content');
            return;
          }
          if (!fileKey || !fileName) {
            logger.warn('File message missing file_key or file_name');
            return;
          }
          text = '请分析这个文件';
          logger.info({ userId, chatId, chatType, fileKey, fileName }, 'Received file message');
        } else if (msgType === 'post') {
          // Rich text (post) message: extract plain text and images from nested structure
          try {
            const content = JSON.parse(message.content);
            logger.debug({ postContent: JSON.stringify(content).slice(0, 500) }, 'Raw post content');
            text = extractTextFromPost(content);
            const postImages = extractImagesFromPost(content);
            if (postImages.length > 0) {
              imageKey = postImages[0];
              postExtraImages = postImages.slice(1);
            }
            logger.debug({ extractedText: text.slice(0, 200), imageKey, postImageCount: postImages.length }, 'Extracted post content');
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse post message content');
            return;
          }
        } else {
          // Text message: extract and clean text
          try {
            const content = JSON.parse(message.content);
            text = content.text || '';
          } catch {
            logger.warn({ content: message.content }, 'Failed to parse message content');
            return;
          }
        }

        // Common text cleanup for text and post messages
        if (msgType === 'text' || msgType === 'post') {
          // Strip @mention tags (format: @_user_xxx or similar)
          text = text.replace(/@_\w+\s*/g, '').trim();

          // Strip Feishu auto-generated markdown links: [text](url) → text
          text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

          if (!text && !imageKey) {
            logger.debug('Empty message after stripping mentions');
            return;
          }

          // If text is empty but we have an image (e.g. @bot + image in group chat), set default prompt
          if (!text && imageKey) {
            text = '请分析这张图片';
          }

          logger.info({ userId, chatId, chatType, text: text.slice(0, 100), imageKey }, 'Received message');
        }

        // Collect extra media: post images (2nd+) and cached group media
        let extraMedia: IncomingMessage['extraMedia'];
        if (postExtraImages.length > 0) {
          extraMedia = postExtraImages.map(key => ({
            messageId,
            imageKey: key,
          }));
          logger.info({ chatId, postExtraImageCount: postExtraImages.length }, 'Attached extra images from post');
        }
        if (chatType === 'group') {
          const cached = getCachedMedia(chatId, userId, logger); // [design-note N] 过期丢弃要打 WARN
          if (cached.length > 0) {
            const cachedMedia = cached.map(m => ({
              messageId: m.messageId,
              imageKey: m.imageKey,
              fileKey: m.fileKey,
              fileName: m.fileName,
            }));
            extraMedia = extraMedia ? [...extraMedia, ...cachedMedia] : cachedMedia;
            clearCachedMedia(chatId, userId);
            logger.info({ chatId, userId, mediaCount: cached.length }, 'Attached cached media to @mention message');
          }
        }

        onMessage({ messageId, chatId, chatType, userId, parentId, text, imageKey, fileKey, fileName, extraMedia });
      } catch (err) {
        logger.error({ err }, 'Error handling message event');
      }
    };
}

export function createEventDispatcher(
  config: BotConfig,
  logger: Logger,
  onMessage: MessageHandler,
  botOpenId?: string,
  messageSender?: MessageSender,
  onCardAction?: CardActionHandler,
): lark.EventDispatcher {
  const dispatcher = new lark.EventDispatcher({});

  // Register the card action trigger handler (fired when a user clicks a button
  // on an interactive card). The lark SDK types omit this event so we cast.
  if (onCardAction) {
    (dispatcher as unknown as {
      register: (handlers: Record<string, (data: unknown) => unknown>) => void;
    }).register({
      'card.action.trigger': (data: unknown) => {
        try {
          const d = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_message_id?: string; open_chat_id?: string };
          };
          const userId = d.operator?.open_id;
          const messageId = d.context?.open_message_id;
          const chatId = d.context?.open_chat_id;
          const raw = d.action?.value;
          if (!userId || !messageId || !chatId || !raw || typeof raw !== 'object') {
            logger.warn({ data }, 'Card action missing required fields');
            return { toast: { type: 'error', content: 'Invalid card action' } };
          }
          onCardAction({
            chatId,
            userId,
            messageId,
            value: raw as Record<string, unknown>,
          });
          return { toast: { type: 'success', content: '已收到' } };
        } catch (err) {
          logger.error({ err }, 'Error handling card action');
          return { toast: { type: 'error', content: 'Internal error' } };
        }
      },
    });
  }

  dispatcher.register({
    'im.message.receive_v1': createReceiveHandler(config, logger, onMessage, botOpenId, messageSender),
  });

  return dispatcher;
}

/** Parse image/file message content, returning media fields or undefined on failure. */
function parseMediaMessage(
  message: any, msgType: string, logger: Logger,
): { imageKey?: string; fileKey?: string; fileName?: string } | undefined {
  try {
    const content = JSON.parse(message.content);
    if (msgType === 'image') {
      const imageKey = content.image_key;
      return imageKey ? { imageKey } : undefined;
    }
    if (msgType === 'file') {
      const fileKey = content.file_key;
      const fileName = content.file_name;
      return (fileKey && fileName) ? { fileKey, fileName } : undefined;
    }
  } catch {
    logger.warn({ msgType }, 'Failed to parse media message for caching');
  }
  return undefined;
}

/**
 * Extract all image_keys from a Feishu post (rich text) message.
 * Looks for { tag: "img", image_key: "..." } elements in the post content.
 */
function extractImagesFromPost(content: Record<string, unknown>): string[] {
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    bodies.push(content);
  } else {
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  const keys: string[] = [];
  for (const body of bodies) {
    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if (el.tag === 'img' && typeof el.image_key === 'string') {
          keys.push(el.image_key);
        }
      }
    }
  }

  return keys;
}

/**
 * Extract plain text from Feishu post (rich text) message content.
 * Handles two formats:
 *   With locale wrapper: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
 *   Without locale wrapper: { "title": "...", "content": [[{tag, text}, ...], ...] }
 */
// [design-note P] 导出仅为 quote-context 复用富文本解析；生产逻辑不变。
export function extractTextFromPost(content: Record<string, unknown>): string {
  // Try to find the post body — either the content itself or nested under a locale key
  const bodies: Array<Record<string, unknown>> = [];

  if (Array.isArray(content.content)) {
    // Direct format (no locale wrapper)
    bodies.push(content);
  } else {
    // Locale-wrapped format: values are { title, content }
    for (const locale of Object.values(content)) {
      if (locale && typeof locale === 'object' && !Array.isArray(locale)) {
        const loc = locale as Record<string, unknown>;
        if (Array.isArray(loc.content)) {
          bodies.push(loc);
        }
      }
    }
  }

  for (const body of bodies) {
    const parts: string[] = [];

    if (body.title && typeof body.title === 'string') {
      parts.push(body.title);
    }

    const paragraphs = body.content as unknown[][];
    for (const paragraph of paragraphs) {
      if (!Array.isArray(paragraph)) continue;
      const line: string[] = [];
      for (const element of paragraph) {
        if (!element || typeof element !== 'object') continue;
        const el = element as Record<string, unknown>;
        if ((el.tag === 'text' || el.tag === 'a') && typeof el.text === 'string') {
          line.push(el.text);
        }
      }
      if (line.length > 0) {
        parts.push(line.join(''));
      }
    }

    if (parts.length > 0) {
      return parts.join('\n');
    }
  }

  return '';
}


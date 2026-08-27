import type { Logger } from '../utils/logger.js';

/**
 * WebSocket 断连盲区补扫。
 *
 * 长连接死掉到被发现之间（liveness watchdog 生效前最长约 2.5 分钟）落在盲区的
 * 消息会被飞书静默丢弃（飞书自身的重投不保证覆盖）。重连成功后，按断连时间窗
 * 用 REST 拉取各群消息，合成与 WebSocket 事件同构的载荷回灌进同一个接收处理
 * 器——去重缓存（processedMessages）保证与飞书重投/正常事件不双发。
 *
 * 真实事故：一条 132MB pptx 恰落盲区，5 分钟后才靠飞书重投救回。
 */

const MSG_TYPES = new Set(['text', 'post', 'image', 'file']);
const MAX_CHAT_PAGES = 2; // ≤100 chats
const MAX_REPLAY_TOTAL = 200;
const MAX_WINDOW_MS = 30 * 60 * 1000;
const WINDOW_PAD_MS = 60 * 1000;

interface RestMention { key?: string; id?: string; name?: string; }
interface RestMessageItem {
  message_id?: string;
  msg_type?: string;
  create_time?: string;
  chat_id?: string;
  parent_id?: string;
  root_id?: string;
  deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: RestMention[];
}

/**
 * REST message.list 条目 → im.message.receive_v1 事件同构载荷。
 * 只映射接收处理器实际消费的字段。Exported for tests.
 */
export function restItemToEvent(item: RestMessageItem, chatMode: string): Record<string, unknown> {
  return {
    message: {
      message_id: item.message_id,
      chat_id: item.chat_id,
      chat_type: chatMode === 'p2p' ? 'p2p' : 'group',
      message_type: item.msg_type,
      content: item.body?.content,
      create_time: item.create_time,
      parent_id: item.parent_id,
      root_id: item.root_id,
      mentions: (item.mentions ?? []).map((m) => ({ key: m.key, id: { open_id: m.id }, name: m.name })),
    },
    sender: {
      sender_id: { open_id: item.sender?.id },
      sender_type: item.sender?.sender_type,
    },
  };
}

/** 该条目是否值得回灌（真人 + 支持的类型 + 未删除）。Exported for tests. */
export function shouldReplay(item: RestMessageItem): boolean {
  if (item.deleted) return false;
  if (!item.message_id || !item.msg_type || !MSG_TYPES.has(item.msg_type)) return false;
  if (item.sender?.sender_type !== 'user') return false;
  if (item.sender.id_type && item.sender.id_type !== 'open_id') return false;
  return Boolean(item.sender.id);
}

export async function backfillMissedMessages(opts: {
  client: any;
  receive: (data: unknown) => Promise<void> | void;
  logger: Logger;
  /** 断连开始的 ms 时间戳 */
  sinceMs: number;
}): Promise<void> {
  const { client, receive, logger, sinceMs } = opts;
  const now = Date.now();
  const from = Math.max(sinceMs - WINDOW_PAD_MS, now - MAX_WINDOW_MS);
  const startSec = String(Math.floor(from / 1000));
  const endSec = String(Math.ceil(now / 1000));

  // 1) 列出 bot 所在的会话（群 + 私聊），上限两页
  const chats: Array<{ chatId: string; mode: string }> = [];
  try {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_CHAT_PAGES; page++) {
      const resp = await client.im.chat.list({
        params: { page_size: 50, ...(pageToken ? { page_token: pageToken } : {}) },
      });
      if (resp?.code !== 0 && resp?.code !== undefined && resp?.code !== null) {
        throw new Error(`chat.list code ${resp.code}: ${resp.msg || ''}`);
      }
      for (const it of resp?.data?.items ?? []) {
        const mode = it.chat_mode || 'group';
        if (mode === 'topic') continue;
        if (it.chat_id) chats.push({ chatId: it.chat_id, mode });
      }
      if (!resp?.data?.has_more || !resp?.data?.page_token) break;
      pageToken = resp.data.page_token;
    }
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'backfill: chat.list failed — skipping backfill');
    return;
  }

  // 2) 逐会话拉盲区消息并回灌
  let replayed = 0;
  let scannedChats = 0;
  for (const chat of chats) {
    if (replayed >= MAX_REPLAY_TOTAL) break;
    scannedChats++;
    try {
      const resp = await client.im.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chat.chatId,
          start_time: startSec,
          end_time: endSec,
          page_size: 50,
        },
      });
      const items: RestMessageItem[] = resp?.data?.items ?? [];
      for (const item of items) {
        if (replayed >= MAX_REPLAY_TOTAL) break;
        if (!shouldReplay(item)) continue;
        try {
          await receive(restItemToEvent(item, chat.mode));
          replayed++;
        } catch (err: any) {
          logger.warn({ err: err?.message, messageId: item.message_id }, 'backfill: replay failed for one message');
        }
      }
    } catch (err: any) {
      logger.warn({ err: err?.message, chatId: chat.chatId }, 'backfill: message.list failed for chat');
    }
  }

  logger.info(
    { outageMs: now - sinceMs, windowFrom: startSec, chats: scannedChats, replayed },
    'backfill: reconnect blind-window sweep done（回灌数含被去重丢弃前的候选）',
  );
}

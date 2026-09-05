/**
 * [design-note S] 本轮上下文拉取（私聊群聊同一机制）。
 *
 * 用户习惯「先把文件、链接、要求发齐，最后 @ 一句处理」。以前靠内存缓存 + 30 分钟
 * 寿命兜这件事：只存媒体不存文本、按发送人隔离、重启即丢、超时静默——0904/0905 生产
 * 连续翻车（KK 私聊先发材料、3 小时后 @，bot 只拿到「处理以上问题」）。飞书接口里
 * 什么都有，这里改为 @ 触发时按接口拉「本轮」：
 *
 *   - 只拉 @ 的这个人自己发的消息（群里别人的闲聊/文件不拉，私聊天然只有一人）；
 *   - 本轮边界 = 这个人上一条 @bot 的消息（不用 bot 的回复做边界：bot 中途可能自发
 *     推送后台产物，会把一轮切断）；往前最多 MAX_AGE_MS / MAX_MESSAGES；
 *   - 文本/富文本取正文（剥 @ 标记，富文本链接带 URL），图片/文件作为附件，
 *     引用回复沿用最早那条的被引 id；贴纸/语音/卡片/已撤回跳过；
 *   - 完全无状态，重启无关；任何失败降级为提示，绝不阻塞回合。
 *
 * 纯函数 + 注入的取数接口，单测可以用假客户端全覆盖。
 */

export const ROUND_MAX_AGE_MS = 48 * 60 * 60 * 1000;
export const ROUND_MAX_MESSAGES = 100;
const MAX_PAGES = 4;

/** 与飞书 im.v1.message.list 的 items[] 同构（只列用到的字段）。 */
export interface ListedMessage {
  message_id?: string;
  msg_type?: string;
  create_time?: string; // ms since epoch, as string
  parent_id?: string;
  deleted?: boolean;
  sender?: { id?: string; id_type?: string; sender_type?: string };
  body?: { content?: string };
  mentions?: Array<{ key?: string; id?: string; name?: string }>;
}

export interface ListPage {
  items: ListedMessage[];
  hasMore: boolean;
  pageToken?: string;
}

/** 取数接口：按时间窗倒序分页列消息（start/end 为秒级字符串）。 */
export type ListMessagesFn = (
  chatId: string, startTimeSec: string, endTimeSec: string, pageToken?: string,
) => Promise<ListPage | undefined>;

export interface RoundText {
  messageId: string;
  text: string;
  parentId?: string;
}

export interface RoundMedia {
  messageId: string;
  imageKey?: string;
  fileKey?: string;
  fileName?: string;
}

export interface RoundContext {
  texts: RoundText[];
  media: RoundMedia[];
  /** 触顶（时间/条数/页数）而非遇到上一条 @ 停下。 */
  truncated: boolean;
  /** 取数失败原因；有值时 texts/media 为空。 */
  error?: string;
  scanned: number;
}

export interface RoundDeps {
  extractPostText: (content: Record<string, unknown>) => string;
  extractPostImages: (content: Record<string, unknown>) => string[];
}

export interface RoundQuery {
  chatId: string;
  /** 触发消息（本条 @）的 id，本身不计入本轮。 */
  triggerMessageId: string;
  /** 触发消息的创建时间（ms）。 */
  triggerTimeMs: number;
  /** @ 的这个人。 */
  senderId: string;
  /** bot 自己的 open_id；缺失时任何 mention 都视为 @bot。 */
  botOpenId?: string;
}

const TEXT_TYPES = new Set(['text', 'post']);

function stripMentionTags(text: string): string {
  return text.replace(/@_\w+\s*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim();
}

function mentionsBot(m: ListedMessage, botOpenId?: string): boolean {
  const list = m.mentions ?? [];
  if (list.length === 0) return false;
  return botOpenId ? list.some((x) => x.id === botOpenId) : true;
}

/**
 * 从一页倒序消息里挑出本轮内容。返回 { picked, boundaryHit }：
 * picked 为这个人在边界之后（不含触发消息）的消息，仍是倒序；boundaryHit 表示遇到了
 * 上一条 @bot 消息（或触发消息之前的历史已经翻完）。Exported for tests.
 */
export function pickRound(
  itemsDesc: ListedMessage[],
  q: RoundQuery,
  lowerBoundMs: number,
): { picked: ListedMessage[]; boundaryHit: boolean; tooOld: boolean } {
  const picked: ListedMessage[] = [];
  for (const m of itemsDesc) {
    if (!m.message_id) continue;
    if (m.message_id === q.triggerMessageId) continue;
    const t = Number(m.create_time ?? 0);
    if (t >= q.triggerTimeMs) continue; // 触发之后的消息不属于本轮
    if (t < lowerBoundMs) return { picked, boundaryHit: false, tooOld: true };
    if (m.sender?.sender_type !== 'user' || m.sender?.id !== q.senderId) continue;
    if (mentionsBot(m, q.botOpenId)) return { picked, boundaryHit: true, tooOld: false };
    picked.push(m);
  }
  return { picked, boundaryHit: false, tooOld: false };
}

/** 单条消息 → 文本/媒体。跳过的类型返回空。Exported for tests. */
export function mapMessage(m: ListedMessage, deps: RoundDeps): { text?: RoundText; media: RoundMedia[] } {
  const media: RoundMedia[] = [];
  const messageId = m.message_id as string;
  if (m.deleted) return { media };
  let content: any;
  try {
    content = JSON.parse(m.body?.content ?? '');
  } catch {
    return { media };
  }
  if (m.msg_type === 'image') {
    if (content?.image_key) media.push({ messageId, imageKey: content.image_key });
    return { media };
  }
  if (m.msg_type === 'file') {
    if (content?.file_key && content?.file_name) media.push({ messageId, fileKey: content.file_key, fileName: content.file_name });
    return { media };
  }
  if (!TEXT_TYPES.has(m.msg_type ?? '')) return { media };
  let text: string;
  if (m.msg_type === 'post') {
    text = deps.extractPostText(content ?? {});
    for (const key of deps.extractPostImages(content ?? {})) media.push({ messageId, imageKey: key });
  } else {
    text = typeof content?.text === 'string' ? content.text : '';
  }
  text = stripMentionTags(text);
  return { text: text ? { messageId, text, parentId: m.parent_id } : undefined, media };
}

/** 主入口：拉本轮上下文。任何失败都落到 error 字段，不抛。 */
export async function fetchRoundContext(
  list: ListMessagesFn, q: RoundQuery, deps: RoundDeps,
): Promise<RoundContext> {
  const lowerBoundMs = q.triggerTimeMs - ROUND_MAX_AGE_MS;
  const startSec = String(Math.floor(lowerBoundMs / 1000));
  const endSec = String(Math.ceil(q.triggerTimeMs / 1000) + 1);
  const collectedDesc: ListedMessage[] = [];
  let boundaryHit = false;
  let truncated = false;
  let scanned = 0;
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const resp = await list(q.chatId, startSec, endSec, pageToken);
      if (!resp) return { texts: [], media: [], truncated: false, error: 'message.list returned nothing', scanned };
      scanned += resp.items.length;
      const r = pickRound(resp.items, q, lowerBoundMs);
      collectedDesc.push(...r.picked);
      if (r.boundaryHit) { boundaryHit = true; break; }
      if (r.tooOld) { truncated = true; break; }
      if (collectedDesc.length >= ROUND_MAX_MESSAGES) { truncated = true; break; }
      if (!resp.hasMore || !resp.pageToken) break;
      pageToken = resp.pageToken;
      if (page === MAX_PAGES - 1) truncated = true;
    }
  } catch (err: any) {
    return { texts: [], media: [], truncated: false, error: err?.message || String(err), scanned };
  }
  const roundAsc = collectedDesc.slice(0, ROUND_MAX_MESSAGES).reverse();
  const texts: RoundText[] = [];
  const media: RoundMedia[] = [];
  for (const m of roundAsc) {
    const mapped = mapMessage(m, deps);
    if (mapped.text) texts.push(mapped.text);
    media.push(...mapped.media);
  }
  void boundaryHit;
  return { texts, media, truncated, scanned };
}

/** 提示词拼装：本轮早先文本按序在前，触发消息永远最后。Exported for tests. */
export function buildRoundPrompt(ctx: RoundContext, triggerText: string): string {
  const parts: string[] = [];
  if (ctx.error) {
    parts.push('[本轮历史拉取失败，需要材料请让用户重发]');
  } else if (ctx.texts.length > 0) {
    parts.push(ctx.truncated
      ? '[以下是你本轮早先发来的内容，按时间顺序；更早的部分已超出拉取范围]'
      : '[以下是你本轮早先发来的内容，按时间顺序]');
    parts.push(...ctx.texts.map((t) => t.text));
    parts.push('[本条]');
  }
  parts.push(triggerText);
  return parts.join('\n\n');
}

import * as path from 'node:path';
import type { DownloadOutcome, FetchedMessage, IMessageSender } from '../bridge/message-sender.interface.js';
import type { CardState } from '../types.js';
import { MessageSender } from './message-sender.js';
import { buildCard, buildTextCard } from './card-builder.js';
import { buildCardV2, buildTextCardV2 } from './card-builder-v2.js';
import { OutputsManager } from '../bridge/outputs-manager.js';
import type { OutboundKind, OutboundLedger } from '../bridge/outbound-ledger.js';

// v2 (native table + lark_md headings + grey footer) is the default.
// Set CARD_SCHEMA_V2=false to opt out and fall back to v1.
const USE_V2 = process.env.CARD_SCHEMA_V2 !== 'false';

/**
 * [design-note P] 台账用的卡片文本：responseText 为主（用户引用卡片时想要的
 * 就是答案正文）；纯提问卡（responseText 为空）退而记问题与选项。截 4000 由台账负责。
 */
function cardLedgerText(state: CardState): string {
  const body = state.responseText?.trim();
  if (body) return body;
  const q = state.pendingQuestion?.questions?.[0];
  if (q) {
    const options = (q.options ?? []).map((o, i) => `${i + 1}. ${o.label}`).join(' / ');
    return `[提问卡] ${q.question}${options ? `（选项：${options}）` : ''}`;
  }
  return state.userPrompt ? `[卡片] ${state.userPrompt}` : '';
}

/**
 * Adapts the Feishu-specific MessageSender to the platform-agnostic IMessageSender interface.
 * Handles card building (CardState → Feishu JSON) internally.
 *
 * [design-note P] 出站台账写入统一收口在本层：这里同时拿得到语义内容
 * （CardState.responseText / 文本 / 文件路径）和底层返回的 message_id。
 * 台账记录的是**脱敏前**内容——它只会被 quote-context 回注进本地 agent 的
 * prompt，不会出站；真正出站的内容在 MessageSender 的 patch-G 收口处照常脱敏。
 */
export class FeishuSenderAdapter implements IMessageSender {
  constructor(
    private sender: MessageSender,
    private opts?: { ledger?: OutboundLedger; botName?: string },
  ) {}

  /** [design-note P] 台账登记；无 ledger / 无 messageId 时为无操作，绝不影响发送结果。 */
  private recordOutbound(
    messageId: string | undefined,
    chatId: string,
    kind: OutboundKind,
    fields: { text?: string; filePath?: string; fileName?: string; mediaKey?: string } = {},
  ): void {
    if (!messageId || !this.opts?.ledger) return;
    this.opts.ledger.record({
      messageId,
      botName: this.opts.botName ?? 'unknown',
      chatId,
      kind,
      ...fields,
    });
  }

  async sendCard(chatId: string, state: CardState): Promise<string | undefined> {
    const messageId = await this.sender.sendCard(chatId, USE_V2 ? buildCardV2(state) : buildCard(state));
    this.recordOutbound(messageId, chatId, 'card', { text: cardLedgerText(state) });
    return messageId;
  }

  async updateCard(messageId: string, state: CardState): Promise<boolean> {
    const ok = await this.sender.updateCard(messageId, USE_V2 ? buildCardV2(state) : buildCard(state));
    // [design-note P] 流式卡片终版内容赢——用户引用的是完成后的卡，不是初始「思考中」。
    if (ok) this.opts?.ledger?.updateText(messageId, cardLedgerText(state));
    return ok;
  }

  /**
   * AskUserQuestion card — always Schema 1.0, regardless of CARD_SCHEMA_V2.
   *
   * Why: Feishu mobile App silently drops `tag: action` button blocks under
   * Schema 2.0, so v2 question cards show up with NO buttons on iOS/Android.
   * v1 button rendering is verified working on mobile (PR #199 tested it).
   *
   * Why a SEPARATE card rather than switching the main streaming card's
   * schema mid-life: Feishu rejects `updateCard` with a different schema
   * than the original create ("ErrCode 200830: schemaV2 card can not change
   * schemaV1"). So the main streaming card stays v2 throughout, and the
   * question gets its own dedicated v1 card sent alongside.
   *
   * See memory: bug-feishu-v2-mobile-action-buttons.
   */
  async sendQuestionCard(chatId: string, state: CardState): Promise<string | undefined> {
    const messageId = await this.sender.sendCard(chatId, buildCard(state));
    this.recordOutbound(messageId, chatId, 'card', { text: cardLedgerText(state) });
    return messageId;
  }

  async updateQuestionCard(messageId: string, state: CardState): Promise<boolean> {
    const ok = await this.sender.updateCard(messageId, buildCard(state));
    if (ok) this.opts?.ledger?.updateText(messageId, cardLedgerText(state)); // [design-note P]
    return ok;
  }

  async sendTextNotice(chatId: string, title: string, content: string, color: string = 'blue'): Promise<void> {
    const messageId = await this.sender.sendCard(chatId, USE_V2 ? buildTextCardV2(title, content, color) : buildTextCard(title, content, color));
    this.recordOutbound(messageId, chatId, 'notice', { text: `${title}\n${content}` });
  }

  async sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const messageId = await this.sender.sendText(chatId, text, replyToMessageId);
    this.recordOutbound(messageId, chatId, 'text', { text });
  }

  async sendImageFile(chatId: string, filePath: string): Promise<boolean> {
    const res = await this.sender.sendImageFile(chatId, filePath);
    if (res !== false) {
      this.recordOutbound(res.messageId, chatId, 'image', { filePath, mediaKey: res.mediaKey });
    }
    return res !== false;
  }

  async sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean> {
    const ext = path.extname(fileName).toLowerCase();
    const feishuType = OutputsManager.feishuFileType(ext);
    const res = await this.sender.sendLocalFile(chatId, filePath, fileName, feishuType);
    if (res !== false) {
      this.recordOutbound(res.messageId, chatId, 'file', { filePath, fileName, mediaKey: res.mediaKey });
    }
    return res !== false;
  }

  async sendAudioFile(chatId: string, filePath: string, fileName?: string): Promise<boolean> {
    const name = fileName ?? path.basename(filePath);
    const res = await this.sender.sendAudioFile(chatId, filePath, name);
    if (res !== false) {
      this.recordOutbound(res.messageId, chatId, 'audio', { filePath, fileName: name, mediaKey: res.mediaKey });
    }
    return res !== false;
  }

  async downloadImage(messageId: string, imageKey: string, savePath: string): Promise<DownloadOutcome> {
    return this.sender.downloadImage(messageId, imageKey, savePath);
  }

  async downloadFile(messageId: string, fileKey: string, savePath: string): Promise<DownloadOutcome> {
    return this.sender.downloadFile(messageId, fileKey, savePath);
  }

  async fetchMessage(messageId: string): Promise<FetchedMessage | undefined> {
    return this.sender.fetchMessage(messageId); // [design-note P]
  }
}

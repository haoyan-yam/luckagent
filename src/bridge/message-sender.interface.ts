import type { CardState } from '../types.js';

/**
 * [design-note N] Download outcome for user-sent attachments.
 *
 * `true` = success. `false` = failure with no detail (legacy senders).
 * `{ ok: false, reason }` = failure with a human-readable reason that the
 * bridge MUST surface in the prompt — a silently dropped attachment looks to
 * the agent like the user never sent one (real incidents: 100MB+ files on
 * 2026-07-20/22 vanished without a trace).
 *
 * ⚠️ Check success with `result === true`, never truthiness — the failure
 * object is truthy. Senders that only report boolean stay compatible.
 */
export type DownloadOutcome = boolean | { ok: false; reason: string };

/**
 * [design-note P] Snapshot of a fetched message, for quote-reply resolution.
 * `content` is the raw platform payload (Feishu: the body.content JSON string);
 * interpretation is up to the caller (quote-context).
 */
export interface FetchedMessage {
  msgType: string;
  content: string;
  senderId?: string;
  senderIdType?: string;
  senderType?: string;
  deleted?: boolean;
}

/**
 * Platform-agnostic message sender interface.
 * Implemented by each IM platform (Feishu, Telegram, etc.).
 */
export interface IMessageSender {
  /** Send a new streaming card/message for a CardState. Returns messageId for subsequent updates. */
  sendCard(chatId: string, state: CardState): Promise<string | undefined>;

  /** Update an existing streaming card/message with new CardState. Returns false on failure. */
  updateCard(messageId: string, state: CardState): Promise<boolean>;

  /**
   * Send a dedicated interactive question card for an AskUserQuestion call.
   * The state's `pendingQuestion` field carries the options/buttons.
   *
   * Why a separate method (not just sendCard with pendingQuestion):
   *   - On Feishu, Card Schema 2.0 has a mobile-App render bug — `tag: action`
   *     button blocks are silently dropped on iOS/Android, so AskUserQuestion
   *     options become invisible. The Feishu adapter forces Schema 1.0 for
   *     question cards (v1 buttons are verified working on mobile).
   *   - On Telegram (and future platforms), this is the natural hook for
   *     inline-keyboard rendering — also conceptually distinct from a
   *     streaming "thinking" card.
   *
   * Optional: platforms without a special path may omit; bridge falls back
   * to sendCard / updateCard.
   *
   * See memory: bug-feishu-v2-mobile-action-buttons.
   */
  sendQuestionCard?(chatId: string, state: CardState): Promise<string | undefined>;

  /** Update an existing question card with new CardState (e.g., mark answered). */
  updateQuestionCard?(messageId: string, state: CardState): Promise<boolean>;

  /** Send a simple notice message (for command responses: /help, /reset, /stop, etc.). */
  sendTextNotice(chatId: string, title: string, content: string, color?: string): Promise<void>;

  /**
   * Send a plain text message.
   *
   * `replyToMessageId` (optional, [design-note]): when set, the text is sent as a
   * quote-reply to that message so the person who triggered it gets a reply
   * notification. Used by the task-completion notice so the ping lands when the
   * answer is ready (not when the bot starts thinking). Platforms without a
   * reply concept ignore the arg and send normally.
   */
  sendText(chatId: string, text: string, replyToMessageId?: string): Promise<void>;

  /** Send a local image file to the chat. */
  sendImageFile(chatId: string, filePath: string): Promise<boolean>;

  /** Send a local file to the chat. */
  sendLocalFile(chatId: string, filePath: string, fileName: string): Promise<boolean>;

  /** Send a local audio file as a native voice/audio message, when supported. */
  sendAudioFile?(chatId: string, filePath: string, fileName?: string): Promise<boolean>;

  /** Download a user-sent image to a local path. See DownloadOutcome ([design-note N]). */
  downloadImage(messageId: string, imageKey: string, savePath: string): Promise<DownloadOutcome>;

  /** Download a user-sent file to a local path. See DownloadOutcome ([design-note N]). */
  downloadFile(messageId: string, fileKey: string, savePath: string): Promise<DownloadOutcome>;

  /**
   * [design-note P] Fetch a message's content by id (quote-reply resolution).
   * Optional — platforms without the capability omit it. Never throws; any
   * failure (permission, deleted, network) resolves to undefined.
   */
  fetchMessage?(messageId: string): Promise<FetchedMessage | undefined>;

  /** If true, the bridge will not send a separate "Task completed" text after the card update. */
  skipCompletionNotice?: boolean;
}

import type { BotConfigBase } from '../config.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import { isVoiceReplyEnabled } from './voice-reply.js';

export const COMPLETION_NOTICE_MIN_DURATION_MS = 10_000;

/**
 * Sends the small push-only completion notice for long-running tasks.
 * Rich details stay in the card footer; this path is only for notification surfaces.
 */
export async function sendCompletionNotice(opts: {
  sender: IMessageSender;
  config: BotConfigBase;
  logger: Logger;
  chatId: string;
  state: CardState;
  durationMs: number;
  /**
   * [design-note] When set (group chats), the completion notice is sent as a
   * quote-reply to the triggering message, so the asker's Feishu push lands
   * exactly when the answer is ready (the rich answer is already in the card
   * above). Private chats pass undefined and get a plain notice as before.
   */
  replyToMessageId?: string;
}): Promise<void> {
  const { sender, config, logger, chatId, state, durationMs, replyToMessageId } = opts;

  if (sender.skipCompletionNotice) return;
  if (state.status === 'complete' && isVoiceReplyEnabled(config)) return;
  if (durationMs < COMPLETION_NOTICE_MIN_DURATION_MS) return;

  const statusEmoji = state.status === 'complete' ? '✅' : '❌';
  const statusWord = state.status === 'complete' ? 'Done' : 'Failed';

  try {
    await sender.sendText(chatId, `${statusEmoji} ${statusWord}`, replyToMessageId);
  } catch (err) {
    logger.warn({ err, chatId }, 'Failed to send completion notice');
  }
}

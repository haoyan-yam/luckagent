import type * as lark from '@larksuiteoapi/node-sdk';
import { buildTextCard } from '../feishu/card-builder.js';
import { buildTextCardV2 } from '../feishu/card-builder-v2.js';
import { redactSensitive } from '../feishu/message-sender.js';
import type { AlertRecipient } from './config.js';

const USE_V2 = process.env.CARD_SCHEMA_V2 !== 'false';

/**
 * Send an alert card as the bot. A person gets it as a private message by
 * open_id (works even if they never chatted with the bot, as long as they are
 * in its availability scope); a chat by chat_id. Throws on failure so the
 * caller can tell recipients that missed it.
 */
export async function sendAlertCard(client: lark.Client, to: AlertRecipient, title: string, content: string): Promise<void> {
  const card = redactSensitive(USE_V2 ? buildTextCardV2(title, content, 'orange') : buildTextCard(title, content, 'orange'));
  const resp = await client.im.v1.message.create({
    params: { receive_id_type: to.type === 'user' ? 'open_id' : 'chat_id' },
    data: { receive_id: to.id, msg_type: 'interactive', content: card },
  });
  if (!resp?.data?.message_id) throw new Error(`飞书没有返回 message_id（${(resp as { msg?: string })?.msg ?? '未知原因'}）`);
}

import * as crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Logger } from 'pino';

export interface InboxMessage {
  id: string;
  targetBot: string;
  chatId: string;
  fromBot: string | null;
  fromOwner: string;
  fromCredentialId: string;
  content: string;
  enqueuedAt: string;
}

export interface EnqueueInput {
  targetBot: string;
  chatId?: string;
  fromBot: string | null;
  fromOwner: string;
  fromCredentialId: string;
  content: string;
}

/**
 * Central inbox for the agent bus. CC/Codex CLI users have no resident bridge
 * to receive `/api/talk` POSTs at, so messages are spooled here keyed by
 * `(targetBot, chatId)` and drained via long-poll on `/api/inbox/:botName/poll`.
 *
 * Schema is append-only-then-delete on pop: `popOne` deletes the row it
 * returns, which gives us exactly-once delivery as long as the caller treats
 * the response as the message. Peek does not delete.
 *
 * No TTL / GC at this layer — the surface is `/api/inbox/:botName` DELETE
 * (`luckagent inbox clear`). If queues grow unbounded we revisit.
 */
export class InboxStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(db: Database.Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_inbox (
        id                  TEXT PRIMARY KEY,
        target_bot          TEXT NOT NULL,
        chat_id             TEXT NOT NULL DEFAULT '',
        from_bot            TEXT,
        from_owner          TEXT NOT NULL,
        from_credential_id  TEXT NOT NULL,
        content             TEXT NOT NULL,
        enqueued_at         TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_inbox_target_chat_time
        ON agent_inbox(target_bot, chat_id, enqueued_at);
    `);
  }

  enqueue(input: EnqueueInput): InboxMessage {
    const id = crypto.randomUUID();
    const chatId = input.chatId ?? '';
    const enqueuedAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_inbox
        (id, target_bot, chat_id, from_bot, from_owner, from_credential_id, content, enqueued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.targetBot, chatId, input.fromBot, input.fromOwner, input.fromCredentialId,
      input.content, enqueuedAt,
    );
    this.logger.debug(
      { targetBot: input.targetBot, chatId, fromBot: input.fromBot, id },
      'inbox enqueued',
    );
    return {
      id,
      targetBot: input.targetBot,
      chatId,
      fromBot: input.fromBot,
      fromOwner: input.fromOwner,
      fromCredentialId: input.fromCredentialId,
      content: input.content,
      enqueuedAt,
    };
  }

  /**
   * Pop the oldest message for `targetBot`, optionally filtered by chatId.
   * Atomic via transaction (better-sqlite3 is synchronous so the SELECT+DELETE
   * pair runs without other handlers interleaving). Returns undefined when
   * the queue (or chatId slice) is empty.
   */
  popOne(targetBot: string, chatId?: string): InboxMessage | undefined {
    const tx = this.db.transaction((): InboxMessage | undefined => {
      const row = chatId !== undefined
        ? this.db.prepare(`
            SELECT * FROM agent_inbox
             WHERE target_bot = ? AND chat_id = ?
          ORDER BY enqueued_at ASC, id ASC
             LIMIT 1
          `).get(targetBot, chatId) as RawInboxRow | undefined
        : this.db.prepare(`
            SELECT * FROM agent_inbox
             WHERE target_bot = ?
          ORDER BY enqueued_at ASC, id ASC
             LIMIT 1
          `).get(targetBot) as RawInboxRow | undefined;
      if (!row) return undefined;
      this.db.prepare('DELETE FROM agent_inbox WHERE id = ?').run(row.id);
      return rowToMessage(row);
    });
    return tx();
  }

  peek(targetBot: string, chatId: string | undefined, limit: number): InboxMessage[] {
    const lim = Math.max(1, Math.min(200, Math.floor(limit)));
    const rows = chatId !== undefined
      ? this.db.prepare(`
          SELECT * FROM agent_inbox
           WHERE target_bot = ? AND chat_id = ?
        ORDER BY enqueued_at ASC, id ASC
           LIMIT ?
        `).all(targetBot, chatId, lim) as RawInboxRow[]
      : this.db.prepare(`
          SELECT * FROM agent_inbox
           WHERE target_bot = ?
        ORDER BY enqueued_at ASC, id ASC
           LIMIT ?
        `).all(targetBot, lim) as RawInboxRow[];
    return rows.map(rowToMessage);
  }

  clear(targetBot: string, chatId?: string): number {
    const result = chatId !== undefined
      ? this.db.prepare('DELETE FROM agent_inbox WHERE target_bot = ? AND chat_id = ?')
          .run(targetBot, chatId)
      : this.db.prepare('DELETE FROM agent_inbox WHERE target_bot = ?')
          .run(targetBot);
    return result.changes as number;
  }

  count(targetBot: string, chatId?: string): number {
    const row = chatId !== undefined
      ? this.db.prepare('SELECT COUNT(*) AS n FROM agent_inbox WHERE target_bot = ? AND chat_id = ?')
          .get(targetBot, chatId) as { n: number }
      : this.db.prepare('SELECT COUNT(*) AS n FROM agent_inbox WHERE target_bot = ?')
          .get(targetBot) as { n: number };
    return row.n;
  }
}

interface RawInboxRow {
  id: string;
  target_bot: string;
  chat_id: string;
  from_bot: string | null;
  from_owner: string;
  from_credential_id: string;
  content: string;
  enqueued_at: string;
}

function rowToMessage(row: RawInboxRow): InboxMessage {
  return {
    id: row.id,
    targetBot: row.target_bot,
    chatId: row.chat_id,
    fromBot: row.from_bot,
    fromOwner: row.from_owner,
    fromCredentialId: row.from_credential_id,
    content: row.content,
    enqueuedAt: row.enqueued_at,
  };
}

/**
 * [design-note P] Outbound message ledger — records every message the bot
 * sends to Feishu (messageId → what it was), so a later 引用回复 (quote-reply)
 * can be resolved back to real content:
 *
 *   - card / text / notice  → the text we sent (cards keep the FINAL state via
 *     updateText — users quote finished cards, not the initial "thinking" one)
 *   - image / file / audio  → local file path + the Feishu media key. The path
 *     goes stale fast (patch E empties the per-chat send dir at next turn
 *     start), so the media key is the durable handle: quote-context re-downloads
 *     from Feishu via (this row's messageId, mediaKey) whenever the file is gone.
 *
 * One shared instance serves all bots in the process (om_* ids are globally
 * unique; bot_name disambiguates and lets "quote bot B's card while @-ing
 * bot A" still resolve). SQLite at <SESSION_STORE_DIR|~/.luckagent>/outbound-ledger.db —
 * outside the repo, untouched by `luckagent update`.
 *
 * Contract: record/updateText/get NEVER throw — a broken ledger degrades quote
 * resolution, it must not break message sending or a turn.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import type { Logger } from '../utils/logger.js';

export type OutboundKind = 'card' | 'text' | 'notice' | 'image' | 'file' | 'audio';

export interface OutboundRecord {
  messageId: string;
  botName: string;
  chatId: string;
  kind: OutboundKind;
  text?: string;
  filePath?: string;
  fileName?: string;
  mediaKey?: string;
  ts: number;
}

const MAX_TEXT_LEN = 4000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class OutboundLedger {
  private db: Database.Database | undefined;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private logger: Logger, opts: { dbPath?: string } = {}) {
    try {
      let dbPath = opts.dbPath;
      if (!dbPath) {
        const dataDir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
        fs.mkdirSync(dataDir, { recursive: true });
        dbPath = path.join(dataDir, 'outbound-ledger.db');
      }
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS outbound_messages (
          message_id TEXT PRIMARY KEY,
          bot_name TEXT NOT NULL,
          chat_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          text TEXT,
          file_path TEXT,
          file_name TEXT,
          media_key TEXT,
          ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_outbound_ts ON outbound_messages(ts);
      `);
      this.cleanup();
      // 进程一跑数周，仅启动时清一次不够；unref 保证不阻止进程退出。
      this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
      this.cleanupTimer.unref?.();
      this.logger.info({ dbPath }, 'Outbound ledger initialized');
    } catch (err) {
      this.db = undefined;
      this.logger.warn({ err }, 'Outbound ledger unavailable — quote resolution will degrade');
    }
  }

  /** Record an outbound message. Same messageId overwrites (INSERT OR REPLACE). Never throws. */
  record(rec: Omit<OutboundRecord, 'ts'> & { ts?: number }): void {
    if (!this.db) return;
    try {
      this.db.prepare(`
        INSERT OR REPLACE INTO outbound_messages (message_id, bot_name, chat_id, kind, text, file_path, file_name, media_key, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rec.messageId, rec.botName, rec.chatId, rec.kind,
        rec.text?.slice(0, MAX_TEXT_LEN) ?? null,
        rec.filePath ?? null, rec.fileName ?? null, rec.mediaKey ?? null,
        rec.ts ?? Date.now(),
      );
    } catch (err) {
      this.logger.warn({ err, messageId: rec.messageId }, 'Outbound ledger record failed');
    }
  }

  /** Update the recorded text for a message (streaming card updates — final content wins). Missing row = no-op. Never throws. */
  updateText(messageId: string, text: string): void {
    if (!this.db) return;
    try {
      this.db.prepare('UPDATE outbound_messages SET text = ?, ts = ? WHERE message_id = ?')
        .run(text.slice(0, MAX_TEXT_LEN), Date.now(), messageId);
    } catch (err) {
      this.logger.warn({ err, messageId }, 'Outbound ledger updateText failed');
    }
  }

  /** Look up an outbound message by id. Never throws (failure → undefined). */
  get(messageId: string): OutboundRecord | undefined {
    if (!this.db) return undefined;
    try {
      const row: any = this.db.prepare('SELECT * FROM outbound_messages WHERE message_id = ?').get(messageId);
      if (!row) return undefined;
      return {
        messageId: row.message_id,
        botName: row.bot_name,
        chatId: row.chat_id,
        kind: row.kind,
        text: row.text ?? undefined,
        filePath: row.file_path ?? undefined,
        fileName: row.file_name ?? undefined,
        mediaKey: row.media_key ?? undefined,
        ts: row.ts,
      };
    } catch (err) {
      this.logger.warn({ err, messageId }, 'Outbound ledger get failed');
      return undefined;
    }
  }

  /** Delete rows older than 30 days. */
  cleanup(): void {
    if (!this.db) return;
    try {
      const result = this.db.prepare('DELETE FROM outbound_messages WHERE ts < ?').run(Date.now() - MAX_AGE_MS);
      if (result.changes > 0) {
        this.logger.info({ deleted: result.changes }, 'Outbound ledger cleanup');
      }
    } catch (err) {
      this.logger.warn({ err }, 'Outbound ledger cleanup failed');
    }
  }

  close(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    try {
      this.db?.close();
    } catch { /* ignore */ }
    this.db = undefined;
  }
}

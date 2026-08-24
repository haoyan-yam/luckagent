import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Restart breadcrumb + one-shot reminder.
 *
 * `pm2 restart` kills the whole node process — including every Claude session —
 * and respawns it. The agent that ran `luckagent restart` therefore loses all
 * memory of having done so; when the next message arrives the session resumes
 * with "please restart" still in its history and the agent restarts again, in a
 * loop. To break it, `bin/luckagent` writes a timestamp breadcrumb just before
 * `pm2 restart`; we read (and delete) it at boot, then inject a one-shot
 * `<system-reminder>` into the first turn of each chat telling the agent the
 * restart already happened and not to do it again.
 */

const BREADCRUMB_FILENAME = 'last-restart.json';
// Only treat the breadcrumb as a "fresh restart" within this window. Guards
// against a stale file (e.g. a crash where boot never ran to delete it) firing
// the reminder days later on an unrelated start.
const RESTART_WINDOW_MS = 15 * 60 * 1000;

let restartedAtMs: number | undefined;
const remindedChats = new Set<string>();

function breadcrumbPath(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
  return path.join(dir, BREADCRUMB_FILENAME);
}

/**
 * Read the restart breadcrumb at boot and stash the timestamp in memory, then
 * delete the file so a later cold start doesn't re-trigger. Call once during
 * bridge startup. Safe to call when no breadcrumb exists.
 */
export function loadRestartBreadcrumb(): void {
  const file = breadcrumbPath();
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as { restartedAt?: number };
    if (typeof parsed.restartedAt === 'number') {
      restartedAtMs = parsed.restartedAt * 1000; // breadcrumb stores epoch seconds
    }
  } catch {
    /* missing/unreadable — nothing to do */
  }
  // Delete regardless; the timestamp now lives in memory for this process.
  try {
    fs.unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** True if we should inject the restart reminder for this chat's next turn. */
export function shouldRemindRestart(chatId: string): boolean {
  if (restartedAtMs === undefined) return false;
  if (Date.now() - restartedAtMs > RESTART_WINDOW_MS) return false;
  return !remindedChats.has(chatId);
}

/** Mark a chat as having received the restart reminder (one-shot per chat). */
export function markReminded(chatId: string): void {
  remindedChats.add(chatId);
}

/** Whole seconds since the recorded restart (0 if unknown). */
export function restartSecondsAgo(): number {
  if (restartedAtMs === undefined) return 0;
  return Math.max(0, Math.round((Date.now() - restartedAtMs) / 1000));
}

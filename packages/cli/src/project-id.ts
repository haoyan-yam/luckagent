import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Derive a stable chatId from a project directory. CC/Codex have no Feishu
 * chatId, so each project's cwd becomes its own conversation namespace.
 *
 * Shape: `proj:<basename>:<sha1(abs-path)[:8]>`.
 *
 * The basename gives a humane prefix when scanning peeked messages; the
 * sha1 slice keeps two different projects with the same basename apart
 * (`~/work/api` vs `~/scratch/api`).
 *
 * Intentionally NOT cross-machine stable: an absolute path on machine A
 * differs from the same project on machine B, so they get different chatIds
 * by design. Two devs collaborating on the same repo on different boxes
 * are two independent threads; pass `--chat <id>` explicitly to share one.
 *
 * Non-pchar bytes in the basename are sanitized to `-` so the chatId is
 * URL-safe (we URL-encode it when slotting into query strings, but a clean
 * literal is friendlier in logs and shell history).
 */
export function deriveProjectChatId(cwd: string = process.cwd()): string {
  const abs = path.resolve(cwd);
  const base = path
    .basename(abs)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'root';
  const hash = createHash('sha1').update(abs).digest('hex').slice(0, 8);
  return `proj:${base}:${hash}`;
}

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Feishu indexes (`.feishu-index.tsv`) — so a file that was archived or deleted
 * locally can be fetched again straight from Feishu
 * (GET /im/v1/messages/{message_id}/resources/{key}) without digging through
 * chat history:
 *
 * - inputs/: every attachment the bridge downloads (written at download time)
 * - outputs/: every file the bot sends that also has an archive copy in
 *   outputs/ (same name + size), written at send time — the outbound ledger
 *   only keeps 30 days, about when outputs get archived.
 *
 * work/ has none: nothing there is ever sent to Feishu; the NAS manifest is
 * the only way back.
 */
export const DOWNLOAD_INDEX_NAME = '.feishu-index.tsv';
const INPUT_HEADER = '下载时间\t文件名\tmessage_id\tkey\t类型\n';
const OUTPUT_HEADER = '发送时间\t文件（相对 outputs）\tmessage_id\tkey\t类型\tchat_id\n';

const clean = (s: string) => s.replace(/[\t\r\n]/g, ' ');

function appendLine(index: string, header: string, cols: string[]): void {
  const line = cols.map(clean).join('\t') + '\n';
  if (!fs.existsSync(index)) fs.writeFileSync(index, header + line);
  else fs.appendFileSync(index, line);
}

export function recordFeishuDownload(savePath: string, messageId: string, key: string, type: 'image' | 'file'): void {
  try {
    appendLine(path.join(path.dirname(savePath), DOWNLOAD_INDEX_NAME), INPUT_HEADER, [
      new Date().toISOString(),
      path.basename(savePath),
      messageId,
      key,
      type,
    ]);
  } catch {
    /* best effort — never fail a download over the index */
  }
}

/** Newest file under `dir` with this exact name and size, or null. */
export function findArchiveCopy(dir: string, fileName: string, size: number): string | null {
  let best: { p: string; t: number } | null = null;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.normalize('NFC') === fileName.normalize('NFC')) {
        try {
          const st = fs.statSync(p);
          if (st.size === size && (!best || st.mtimeMs > best.t)) best = { p, t: st.mtimeMs };
        } catch {
          /* vanished */
        }
      }
    }
  }
  return best?.p ?? null;
}

export interface SentFile {
  workDir: string;
  fileName: string;
  fileSize: number;
  messageId: string;
  mediaKey: string;
  kind: string;
  chatId: string;
  ts?: number;
}

/** Index a sent file against its outputs/ archive copy. Returns the indexed copy, or null if there is none. */
export function recordFeishuSend(f: SentFile): string | null {
  try {
    const outputs = path.join(f.workDir, 'outputs');
    const copy = findArchiveCopy(outputs, f.fileName, f.fileSize);
    if (!copy) return null;
    appendLine(path.join(outputs, DOWNLOAD_INDEX_NAME), OUTPUT_HEADER, [
      new Date(f.ts ?? Date.now()).toISOString(),
      path.relative(outputs, copy),
      f.messageId,
      f.mediaKey,
      f.kind,
      f.chatId,
    ]);
    return copy;
  } catch {
    return null;
  }
}

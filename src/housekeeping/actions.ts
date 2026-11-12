import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { expandUserPath } from '../config.js';
import type { Candidate } from './scan.js';

export interface ArchiveTargetStatus {
  ok: boolean;
  root: string;
  reason?: string;
  freeBytes?: number;
}

/**
 * Archive root is usable when configured, and — if it lives under /Volumes —
 * that volume is actually mounted (not a stale empty mountpoint on the boot disk).
 */
export function archiveTargetStatus(archiveRoot: string): ArchiveTargetStatus {
  if (!archiveRoot) return { ok: false, root: '', reason: '未设置归档目录' };
  const root = path.resolve(expandUserPath(archiveRoot));
  const m = /^\/Volumes\/([^/]+)/.exec(root);
  if (m) {
    const vol = `/Volumes/${m[1]}`;
    try {
      if (fs.statSync(vol).dev === fs.statSync('/').dev) return { ok: false, root, reason: `${vol} 没有挂载` };
    } catch {
      return { ok: false, root, reason: `硬盘 ${m[1]} 没有接上` };
    }
  }
  try {
    // Read-only check: the folder itself is created on the first real archive.
    let probe = root;
    while (!fs.existsSync(probe)) probe = path.dirname(probe);
    fs.accessSync(probe, fs.constants.W_OK);
    const s = fs.statfsSync(probe);
    return { ok: true, root, freeBytes: s.bavail * s.bsize };
  } catch (e) {
    return { ok: false, root, reason: `归档目录不可写：${(e as Error).message}` };
  }
}

export function diskUsage(p = os.homedir()): { totalBytes: number; freeBytes: number } {
  const s = fs.statfsSync(p);
  return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
}

async function sha1File(abs: string): Promise<string> {
  const h = createHash('sha1');
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 4 << 20 })) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Source must still look exactly as it did at scan time; otherwise someone is using it. */
async function unchanged(c: Candidate): Promise<boolean> {
  try {
    const st = await fs.promises.lstat(c.abs);
    return st.isFile() && st.size === c.size && st.mtimeMs === c.mtimeMs;
  } catch {
    return false;
  }
}

/** Mirror layout: <archiveRoot>/<path relative to home>, e.g. projects/sephora/work/a.pkl */
export function archiveDest(archiveRoot: string, abs: string): string {
  const rel = path.relative(os.homedir(), abs);
  return path.join(path.resolve(expandUserPath(archiveRoot)), rel);
}

function stampedName(p: string): string {
  const ext = path.extname(p);
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${p.slice(0, p.length - ext.length)}~${ts}${ext}`;
}

export type ActionResult =
  | { status: 'archived' | 'trashed'; dest: string; sha1?: string; note?: string }
  | { status: 'skipped' | 'error'; note: string };

/**
 * Copy → fsync → re-read and compare SHA-1 → confirm source untouched → delete source.
 * If an identical copy already sits at the destination, reuse it.
 */
export async function archiveFile(c: Candidate, archiveRoot: string): Promise<ActionResult> {
  if (!(await unchanged(c))) return { status: 'skipped', note: '扫描后文件有变动' };
  let dest = archiveDest(archiveRoot, c.abs);
  try {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const srcSha = await sha1File(c.abs);
    let reused = false;
    try {
      const st = await fs.promises.stat(dest);
      if (st.size === c.size && (await sha1File(dest)) === srcSha) reused = true;
      else dest = stampedName(dest);
    } catch {
      /* dest absent */
    }
    if (!reused) {
      const tmp = `${dest}.partial`;
      await fs.promises.copyFile(c.abs, tmp);
      const fh = await fs.promises.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      const dstSha = await sha1File(tmp);
      if (dstSha !== srcSha) {
        await fs.promises.rm(tmp, { force: true });
        return { status: 'error', note: '复制后校验不一致，本机文件未删除' };
      }
      await fs.promises.rename(tmp, dest);
      await fs.promises.utimes(dest, new Date(), new Date(c.mtimeMs));
    }
    if (!(await unchanged(c))) return { status: 'skipped', note: '复制期间文件有变动，本机文件未删除' };
    await fs.promises.unlink(c.abs);
    return { status: 'archived', dest, sha1: srcSha, note: reused ? '硬盘上已有相同文件' : undefined };
  } catch (e) {
    return { status: 'error', note: (e as Error).message };
  }
}

export function trashBatchDir(runStartedAt: number): string {
  const d = new Date(runStartedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  return path.join(os.homedir(), '.Trash', `luckagent-清理-${stamp}`);
}

/** Move into a per-run folder in ~/.Trash, keeping the original path readable in the file name. */
export async function trashFile(c: Candidate, batchDir: string): Promise<ActionResult> {
  if (!(await unchanged(c))) return { status: 'skipped', note: '扫描后文件有变动' };
  try {
    await fs.promises.mkdir(batchDir, { recursive: true });
    const flat = path.relative(os.homedir(), c.abs).split(path.sep).join('__');
    let dest = path.join(batchDir, flat);
    if (fs.existsSync(dest)) dest = stampedName(dest);
    await fs.promises.rename(c.abs, dest);
    return { status: 'trashed', dest };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const hint = err.code === 'EPERM' ? '（没有废纸篓权限：系统设置 → 隐私与安全性 → 完全磁盘访问权限 里给 node 授权）' : '';
    return { status: 'error', note: `${err.message}${hint}` };
  }
}

export type RestoreResult = { ok: true; note?: string } | { ok: false; note: string };

/**
 * Put an archived/trashed file back where it was. Archive copies are verified
 * against the SHA-1 recorded at archive time; the original mtime is kept (ctime
 * becomes "now", so the file counts as fresh and isn't swept again right away).
 * Never overwrites: if something is already at the original path, it refuses.
 */
export async function restoreFile(
  e: { path: string; dest?: string; sha1?: string; mtimeMs: number; status: string },
): Promise<RestoreResult> {
  if (!e.dest) return { ok: false, note: '没有记录去向' };
  if (fs.existsSync(e.path)) return { ok: false, note: '原位置已有同名文件，没有覆盖' };
  if (!fs.existsSync(e.dest)) {
    return { ok: false, note: e.status === 'archived' ? '在硬盘上找不到（硬盘没接上？）' : '废纸篓里找不到（可能已清空）' };
  }
  try {
    await fs.promises.mkdir(path.dirname(e.path), { recursive: true });
    if (e.status === 'trashed') {
      await fs.promises.rename(e.dest, e.path);
      return { ok: true, note: '已从废纸篓放回' };
    }
    const tmp = `${e.path}.restoring`;
    await fs.promises.copyFile(e.dest, tmp);
    if (e.sha1 && (await sha1File(tmp)) !== e.sha1) {
      await fs.promises.rm(tmp, { force: true });
      return { ok: false, note: '硬盘上的副本校验不一致，没有恢复' };
    }
    await fs.promises.chmod(tmp, 0o644);
    await fs.promises.rename(tmp, e.path);
    await fs.promises.utimes(e.path, new Date(), new Date(e.mtimeMs));
    return { ok: true, note: '已从硬盘恢复并校验' };
  } catch (err) {
    return { ok: false, note: (err as Error).message };
  }
}

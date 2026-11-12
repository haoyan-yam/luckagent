import * as fs from 'node:fs';

/** One file entry inside a zip, as read from its central directory. */
export interface ZipEntry {
  name: string;
  size: number;
  crc32: number;
}

const EOCD_SIG = 0x06054b50;
const CDH_SIG = 0x02014b50;
const MAX_COMMENT = 0xffff;

/** Junk that archivers add and nobody needs back: never counted as "missing". */
export function isZipJunk(name: string, size: number): boolean {
  const base = name.split('/').pop() ?? name;
  return (
    size === 0 ||
    name.startsWith('__MACOSX/') ||
    name.includes('/__MACOSX/') ||
    base.startsWith('._') ||
    base === '.DS_Store' ||
    base.toLowerCase() === 'thumbs.db' ||
    base.toLowerCase() === 'desktop.ini'
  );
}

function decodeName(buf: Buffer, utf8Flag: boolean): string {
  if (!utf8Flag) {
    // Windows / Chinese-locale archivers write GBK without setting the flag.
    try {
      return new TextDecoder('gbk', { fatal: true }).decode(buf).normalize('NFC');
    } catch {
      /* fall through */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).normalize('NFC');
  } catch {
    return buf.toString('latin1');
  }
}

/**
 * Read the central directory of a zip. Returns null when the file isn't a zip
 * we can verify (corrupt, or Zip64 — sizes would be unreliable).
 */
export function readZipEntries(zipPath: string): ZipEntry[] | null {
  let fd: number;
  try {
    fd = fs.openSync(zipPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, MAX_COMMENT + 22);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) return null;
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // Zip64
    if (cdOffset + cdSize > size) return null;
    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);
    const out: ZipEntry[] = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CDH_SIG) return null;
      const flags = cd.readUInt16LE(p + 8);
      const crc32 = cd.readUInt32LE(p + 16);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (usize === 0xffffffff) return null; // Zip64 entry
      const name = decodeName(cd.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
      if (!name.endsWith('/')) out.push({ name, size: usize, crc32 });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return out;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

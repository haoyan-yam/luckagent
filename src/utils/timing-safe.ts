import * as crypto from 'node:crypto';

/**
 * Constant-time comparison of two secrets. Both inputs are hashed with SHA-256
 * first so the comparison runs over fixed-length (32-byte) buffers — this both
 * equalizes length (crypto.timingSafeEqual throws on length mismatch) and stops
 * the comparison itself from leaking the secret length via timing. Returns false
 * for any nullish input.
 */
export function timingSafeStrEqual(a: string | undefined | null, b: string | undefined | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

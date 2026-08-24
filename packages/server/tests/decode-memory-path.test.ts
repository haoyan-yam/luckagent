import { describe, it, expect } from 'vitest';
import { decodeMemoryIdOrPath } from '../src/server.js';

// Regression tests for the Caddy + oauth2-proxy v7 cookie-chain double-encode
// gap. See server.ts for the full root-cause writeup. CJK is the load-bearing
// case because, unlike sub-delims, it has no literal-alternative encoding so
// MR !17 (pchar-literal fix) does not cover it.
describe('decodeMemoryIdOrPath', () => {
  it('decodes single-encoded CJK once (bearer path, no proxy re-encode)', () => {
    // "技" → %E6%8A%80 (3 UTF-8 bytes). The slice arrives already missing the
    // leading slash because Caddy collapses the route-prefix boundary.
    const slice = '%E6%8A%80';
    expect(decodeMemoryIdOrPath(slice)).toBe('/技');
  });

  it('decodes double-encoded CJK twice (cookie path, proxy chain re-encoded %XX → %25XX)', () => {
    // "技" originally %E6%8A%80, proxy turned each `%` into `%25` → %25E6%258A%2580.
    const slice = '%25E6%258A%2580';
    expect(decodeMemoryIdOrPath(slice)).toBe('/技');
  });

  it('decodes a realistic double-encoded CJK folder segment ("技术文档") to its canonical form', () => {
    // Full "技术文档" single-encoded:
    //   %E6%8A%80%E6%9C%AF%E6%96%87%E6%A1%A3
    // After one oauth2-proxy re-encode every `%` → `%25`:
    //   %25E6%258A%2580%25E6%259C%25AF%25E6%2596%2587%25E6%25A1%25A3
    const slice = '%25E6%258A%2580%25E6%259C%25AF%25E6%2596%2587%25E6%25A1%25A3';
    expect(decodeMemoryIdOrPath(slice)).toBe('/技术文档');
  });

  it('does not throw on malformed percent-encoding; returns last valid value', () => {
    // %ZZ is not a valid escape; decodeURIComponent throws URIError. The
    // function must trap and fall back to the prior stable value instead of
    // 500-ing on a hand-crafted URL.
    expect(() => decodeMemoryIdOrPath('%ZZ')).not.toThrow();
    expect(decodeMemoryIdOrPath('%ZZ')).toBe('/%ZZ');
  });

  it('returns a UUID slice as-is, without a leading slash', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    expect(decodeMemoryIdOrPath(uuid)).toBe(uuid);
  });

  it('passes through an already-slash-prefixed path (e.g. raw API client)', () => {
    expect(decodeMemoryIdOrPath('/users/x')).toBe('/users/x');
  });

  it('prepends a leading slash for path-shaped slices missing it', () => {
    // Top-level folder name with no slashes — distinguishable from a UUID
    // only by shape, hence the UUID_RE branch in the implementation.
    expect(decodeMemoryIdOrPath('users/x')).toBe('/users/x');
    expect(decodeMemoryIdOrPath('shared')).toBe('/shared');
  });

  it('handles mixed ASCII + double-encoded CJK in a full path slice', () => {
    // /users/user@example.com/legacy-mm/技术文档/doc-a after the
    // proxy chain double-encoded only the CJK bytes (ASCII passes through).
    const slice =
      'users/user@example.com/legacy-mm/%25E6%258A%2580%25E6%259C%25AF%25E6%2596%2587%25E6%25A1%25A3/doc-a';
    expect(decodeMemoryIdOrPath(slice)).toBe(
      '/users/user@example.com/legacy-mm/技术文档/doc-a',
    );
  });

  it('is idempotent — running on an already-decoded path leaves it untouched', () => {
    const path = '/users/user@example.com/legacy-mm/技术文档/doc-a';
    expect(decodeMemoryIdOrPath(path)).toBe(path);
  });
});

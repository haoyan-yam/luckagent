/**
 * Paths owned by sibling subsystems (T5T today) that physically live in the
 * memory store but should not appear in the user-facing memory tab/CLI — those
 * subsystems expose their own dedicated routes and UI tabs. The `/api/memory/*`
 * surface pretends these paths don't exist: list/get return as if absent,
 * write/update return 403.
 *
 * Important: T5T's own routes (`/api/t5t/*`) and `t5t-store.ts` go through the
 * `MemoryStore` directly, bypassing this filter. Hidden paths are only filtered
 * at the `/api/memory/*` route layer.
 *
 * `/instances` and `/qa-scratch` are dead, empty namespaces left over from
 * earlier versions (no current code reads or writes them). Hidden here so they
 * stop cluttering the web memory tree; can be physically dropped later with an
 * admin credential.
 */
export const MEMORY_HIDDEN_PREFIXES = ['/t5t', '/instances', '/qa-scratch'] as const;

export function isHiddenFromMemoryView(path: string): boolean {
  return MEMORY_HIDDEN_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

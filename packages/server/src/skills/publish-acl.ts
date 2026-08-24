import type { Credential } from '../auth/credentials.js';
import { canPublishSkill as credCanPublish } from '../auth/credentials.js';

export function canPublishSkill(cred: Credential): boolean {
  return credCanPublish(cred);
}

export function canUnpublishSkill(cred: Credential): boolean {
  return cred.role === 'admin';
}

/**
 * Owner-protected overwrite: when publishing a skill name that already exists,
 * the caller must be the original owner (or admin). This prevents member B
 * from squatting on member A's skill name. Mirrors `isVisibleToCred`'s
 * user-level owner-bypass (match by `ownerName`, not credentialId, so the
 * same human on a different machine can still republish).
 *
 * Legacy rows (`ownerName` empty/undefined) are admin-only to overwrite —
 * matches the legacy-row guard in `isVisibleToCred` and avoids accidentally
 * letting any empty-owner cred claim them.
 */
export function canOverwriteSkill(
  existing: { ownerName?: string },
  cred: Credential,
): boolean {
  if (cred.role === 'admin') return true;
  if (!existing.ownerName || !cred.ownerName) return false;
  return existing.ownerName === cred.ownerName;
}

/**
 * Members see only `published` + `shared`. Admins see everything (return
 * undefined to skip the visibility filter).
 *
 * NOTE: this filter alone is NOT enough — it never lets a member see their
 * own `private` skill. Callers must compose with `isVisibleToCred` below so
 * the owner's other-machine cred sees their own private skills.
 */
export function visibilityFilter(cred: Credential): ('published' | 'shared' | 'private')[] | undefined {
  if (cred.role === 'admin') return undefined;
  return ['published', 'shared'];
}

/**
 * User-level owner-bypass for skill visibility. A member sees a skill iff:
 *   - admin, OR
 *   - skill is `published` / `shared`, OR
 *   - skill's `ownerName` matches the credential's `ownerName` (user-level)
 *
 * Empty `cred.ownerName` or missing `skill.ownerName` skip the bypass —
 * legacy rows can't accidentally grant access.
 */
export function isVisibleToCred(
  skill: { visibility: 'private' | 'published' | 'shared'; ownerName?: string },
  cred: Credential,
): boolean {
  if (cred.role === 'admin') return true;
  if (skill.visibility !== 'private') return true;
  if (!cred.ownerName || !skill.ownerName) return false;
  return skill.ownerName === cred.ownerName;
}

export function filterSkillsForCred<T extends { visibility: 'private' | 'published' | 'shared'; ownerName?: string }>(
  skills: T[],
  cred: Credential,
): T[] {
  if (cred.role === 'admin') return skills;
  return skills.filter((s) => isVisibleToCred(s, cred));
}

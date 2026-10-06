/**
 * "What needs attention" for the admin dashboard: cross-page warnings
 * (unset group summaries, never-used project skills, memory index pressure,
 * today's failures) folded into one list. Pure builders here; the route in
 * admin-routes.ts gathers the inputs. No cost alerts: bots run on a
 * subscription, so cost is only an API-equivalent reference.
 */

export type AttentionLevel = 'error' | 'warning';

export interface AttentionItem {
  key: string;
  level: AttentionLevel;
  title: string;
  detail?: string;
  /** Admin route to fix it, e.g. "/group-summary". */
  link?: string;
}

export const MEMORY_INDEX_WARN = 0.7;

const list = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join('、')} 等 ${names.length} 个` : names.join('、'));

/** Group-summary rows still "未配置" per bot. Exported for tests. */
export function unsetGroupSummaries(
  chatsByBot: Record<string, Array<{ chatId: string; name: string }>>,
  configuredByBot: Record<string, Set<string>>,
  excludedByBot: Record<string, string[]>,
): Array<{ bot: string; chats: string[] }> {
  const out: Array<{ bot: string; chats: string[] }> = [];
  for (const [bot, chats] of Object.entries(chatsByBot)) {
    const configured = configuredByBot[bot] ?? new Set<string>();
    const excluded = new Set(excludedByBot[bot] ?? []);
    const unset = chats.filter((c) => !configured.has(c.chatId) && !excluded.has(c.chatId)).map((c) => c.name);
    if (unset.length) out.push({ bot, chats: unset });
  }
  return out;
}

export interface AttentionInputs {
  unsetSummaries: Array<{ bot: string; chats: string[] }>;
  /** Bots whose group list couldn't be fetched (not running / Feishu error) — unset count may be incomplete. */
  summaryUnknownBots: string[];
  neverUsedSkills: Array<{ bot: string; skill: string }>;
  memoryIndex: Array<{ bot: string; ratio: number }>;
  failuresToday: Array<{ bot: string }>;
}

/** Fold the inputs into display items, errors first. Exported for tests. */
export function buildAttention(i: AttentionInputs): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (i.failuresToday.length) {
    const bots = [...new Set(i.failuresToday.map((f) => f.bot))];
    items.push({
      key: 'failures',
      level: 'error',
      title: `今天有 ${i.failuresToday.length} 个任务失败`,
      detail: `涉及 ${list(bots)}`,
      link: '/logs',
    });
  }

  const overIndex = i.memoryIndex.filter((m) => m.ratio >= 1);
  if (overIndex.length) {
    items.push({
      key: 'memory-over',
      level: 'error',
      title: `${overIndex.length} 个 bot 的记忆索引已超限，超出部分 bot 看不到`,
      detail: list(overIndex.map((m) => m.bot)),
      link: '/memory',
    });
  }

  const unsetTotal = i.unsetSummaries.reduce((n, s) => n + s.chats.length, 0);
  if (unsetTotal) {
    items.push({
      key: 'group-summary',
      level: 'warning',
      title: `${unsetTotal} 个群还没配置日报`,
      detail:
        i.unsetSummaries.map((s) => `${s.bot}：${list(s.chats, 2)}`).join('；') +
        (i.summaryUnknownBots.length ? `（${list(i.summaryUnknownBots)} 的群列表没拉到，未计入）` : ''),
      link: '/group-summary',
    });
  }

  const warnIndex = i.memoryIndex.filter((m) => m.ratio >= MEMORY_INDEX_WARN && m.ratio < 1);
  if (warnIndex.length) {
    items.push({
      key: 'memory-warn',
      level: 'warning',
      title: `${warnIndex.length} 个 bot 的记忆索引占用超过 ${Math.round(MEMORY_INDEX_WARN * 100)}%`,
      detail: warnIndex.map((m) => `${m.bot} ${Math.round(m.ratio * 100)}%`).join('、'),
      link: '/memory',
    });
  }

  if (i.neverUsedSkills.length) {
    items.push({
      key: 'skills-unused',
      level: 'warning',
      title: `${i.neverUsedSkills.length} 个项目技能从没被用过`,
      detail: list(i.neverUsedSkills.map((s) => s.skill)),
      link: '/skills',
    });
  }

  return items;
}

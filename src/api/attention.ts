/**
 * "What needs attention" for the admin dashboard: cross-page warnings
 * (unset group summaries, never-used project skills, memory index pressure,
 * today's failures, cost spikes) folded into one list. Pure builders here;
 * the route in admin-routes.ts gathers the inputs.
 */

import type { BotDaily } from './cost-stats.js';

export type AttentionLevel = 'error' | 'warning';

export interface AttentionItem {
  key: string;
  level: AttentionLevel;
  title: string;
  detail?: string;
  /** Admin route to fix it, e.g. "/group-summary". */
  link?: string;
}

/** Today's spend must beat its 7-day daily average by this factor… */
export const COST_SPIKE_RATIO = 1.5;
/** …and be at least this much, so a $0.30 → $0.60 day isn't an alert. */
export const COST_SPIKE_MIN_USD = 5;
export const MEMORY_INDEX_WARN = 0.7;

const list = (names: string[], max = 4) => (names.length > max ? `${names.slice(0, max).join('、')} 等 ${names.length} 个` : names.join('、'));
const usd = (v: number) => `$${v.toFixed(2)}`;

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

/**
 * Bots whose today spend spiked vs. their own recent days. `daily.cost` holds
 * the previous 7 days followed by today (8 entries). Exported for tests.
 */
export function costSpikes(byBot: Record<string, BotDaily>): Array<{ bot: string; today: number; avg: number }> {
  const out: Array<{ bot: string; today: number; avg: number }> = [];
  for (const [bot, d] of Object.entries(byBot)) {
    const today = d.cost[d.cost.length - 1] ?? 0;
    const prev = d.cost.slice(0, -1);
    const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
    if (today >= COST_SPIKE_MIN_USD && today >= avg * COST_SPIKE_RATIO) out.push({ bot, today, avg });
  }
  return out.sort((a, b) => b.today - a.today);
}

export interface AttentionInputs {
  unsetSummaries: Array<{ bot: string; chats: string[] }>;
  /** Bots whose group list couldn't be fetched (not running / Feishu error) — unset count may be incomplete. */
  summaryUnknownBots: string[];
  neverUsedSkills: Array<{ bot: string; skill: string }>;
  memoryIndex: Array<{ bot: string; ratio: number }>;
  failuresToday: Array<{ bot: string }>;
  spikes: Array<{ bot: string; today: number; avg: number }>;
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

  // One item for all spikes: they usually share a cause (e.g. the morning digest batch ran heavier).
  if (i.spikes.length) {
    const times = (s: { today: number; avg: number }) => (s.avg > 0 ? `${(s.today / s.avg).toFixed(1)} 倍` : '近 7 天几乎没花费');
    const one = i.spikes[0];
    items.push({
      key: 'cost-spike',
      level: 'warning',
      title:
        i.spikes.length === 1
          ? `${one.bot} 今天成本 ${usd(one.today)}，是近 7 天日均的 ${times(one)}`
          : `${i.spikes.length} 个 bot 今天成本超过近 7 天日均的 ${COST_SPIKE_RATIO} 倍`,
      detail:
        i.spikes.length === 1
          ? `近 7 天日均 ${usd(one.avg)}`
          : list(i.spikes.map((s) => `${s.bot} ${usd(s.today)}（${times(s)}）`)),
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

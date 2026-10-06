import { describe, expect, it } from 'vitest';
import { buildAttention, costSpikes, unsetGroupSummaries, type AttentionInputs } from '../src/api/attention.js';

const daily = (cost: number[]) => ({ tasks: cost.map(() => 1), failed: cost.map(() => 0), cost });

describe('unsetGroupSummaries', () => {
  it('lists chats that are neither configured nor excluded, per bot', () => {
    const out = unsetGroupSummaries(
      {
        A: [{ chatId: 'oc_1', name: '一群' }, { chatId: 'oc_2', name: '二群' }, { chatId: 'oc_3', name: '三群' }],
        B: [{ chatId: 'oc_9', name: '九群' }],
      },
      { A: new Set(['oc_1']), B: new Set(['oc_9']) },
      { A: ['oc_3'] },
    );
    expect(out).toEqual([{ bot: 'A', chats: ['二群'] }]);
  });
});

describe('costSpikes', () => {
  it('flags today ≥ 1.5× the previous 7-day average and ≥ $5', () => {
    const out = costSpikes({
      spike: daily([4, 4, 4, 4, 4, 4, 4, 12]), // 3×
      steady: daily([10, 10, 10, 10, 10, 10, 10, 11]),
      tiny: daily([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 3]), // big ratio but < $5
      fresh: daily([0, 0, 0, 0, 0, 0, 0, 8]), // no history, real spend
    });
    expect(out.map((s) => s.bot)).toEqual(['spike', 'fresh']);
    expect(out[0]).toMatchObject({ today: 12, avg: 4 });
  });
});

describe('buildAttention', () => {
  it('folds several cost spikes into one item', () => {
    const [item] = buildAttention({
      unsetSummaries: [],
      summaryUnknownBots: [],
      neverUsedSkills: [],
      memoryIndex: [],
      failuresToday: [],
      spikes: [
        { bot: 'A', today: 16, avg: 8 },
        { bot: 'B', today: 9, avg: 0 },
      ],
    });
    expect(item.title).toBe('2 个 bot 今天成本超过近 7 天日均的 1.5 倍');
    expect(item.detail).toBe('A $16.00（2.0 倍）、B $9.00（近 7 天几乎没花费）');
  });

  const empty: AttentionInputs = {
    unsetSummaries: [],
    summaryUnknownBots: [],
    neverUsedSkills: [],
    memoryIndex: [],
    failuresToday: [],
    spikes: [],
  };

  it('returns nothing when all is well', () => {
    expect(buildAttention({ ...empty, memoryIndex: [{ bot: 'A', ratio: 0.3 }] })).toEqual([]);
  });

  it('orders errors before warnings and links each item to the page that fixes it', () => {
    const items = buildAttention({
      unsetSummaries: [{ bot: 'A', chats: ['一群', '二群', '三群'] }],
      summaryUnknownBots: ['C'],
      neverUsedSkills: [{ bot: 'A', skill: 'a-copy' }],
      memoryIndex: [{ bot: 'A', ratio: 1.2 }, { bot: 'B', ratio: 0.75 }],
      failuresToday: [{ bot: 'A' }, { bot: 'A' }, { bot: 'B' }],
      spikes: [{ bot: 'B', today: 20, avg: 5 }],
    });
    expect(items.map((i) => [i.key, i.level, i.link])).toEqual([
      ['failures', 'error', '/logs'],
      ['memory-over', 'error', '/memory'],
      ['cost-spike', 'warning', undefined],
      ['group-summary', 'warning', '/group-summary'],
      ['memory-warn', 'warning', '/memory'],
      ['skills-unused', 'warning', '/skills'],
    ]);
    expect(items[0].title).toBe('今天有 3 个任务失败');
    expect(items[0].detail).toBe('涉及 A、B');
    expect(items[2].title).toBe('B 今天成本 $20.00，是近 7 天日均的 4.0 倍');
    expect(items[3].title).toBe('3 个群还没配置日报');
    expect(items[3].detail).toBe('A：一群、二群 等 3 个（C 的群列表没拉到，未计入）');
    expect(items[4].detail).toBe('B 75%');
  });
});

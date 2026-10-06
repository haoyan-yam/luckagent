import { describe, expect, it } from 'vitest';
import { buildAttention, unsetGroupSummaries, type AttentionInputs } from '../src/api/attention.js';

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

describe('buildAttention', () => {
  const empty: AttentionInputs = {
    unsetSummaries: [],
    summaryUnknownBots: [],
    neverUsedSkills: [],
    memoryIndex: [],
    failuresToday: [],
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
    });
    expect(items.map((i) => [i.key, i.level, i.link])).toEqual([
      ['failures', 'error', '/logs'],
      ['memory-over', 'error', '/memory'],
      ['group-summary', 'warning', '/group-summary'],
      ['memory-warn', 'warning', '/memory'],
      ['skills-unused', 'warning', '/skills'],
    ]);
    expect(items[0].title).toBe('今天有 3 个任务失败');
    expect(items[0].detail).toBe('涉及 A、B');
    expect(items[2].title).toBe('3 个群还没配置日报');
    expect(items[2].detail).toBe('A：一群、二群 等 3 个（C 的群列表没拉到，未计入）');
    expect(items[3].detail).toBe('B 75%');
  });
});

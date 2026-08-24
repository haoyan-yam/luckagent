import { afterEach, describe, expect, it } from 'vitest';
import { buildHeuristicVoiceBrief, cleanTextForVoice, isVoiceReplyEnabled, resolveVoiceReplyConfig } from '../src/bridge/voice-reply.js';
import type { BotConfigBase } from '../src/config.js';

function makeConfig(): BotConfigBase {
  return {
    name: 'test',
    claude: {
      defaultWorkingDirectory: '/tmp',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/outputs',
      downloadsDir: '/tmp/downloads',
      backend: 'pty',
    },
  };
}

describe('voice reply config', () => {
  afterEach(() => {
    delete process.env.LUCKAGENT_VOICE_REPLY;
    delete process.env.FEISHU_VOICE_REPLY;
    delete process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON;
  });

  it('is disabled by default', () => {
    expect(isVoiceReplyEnabled(makeConfig())).toBe(false);
  });

  it('can be enabled by an internal default env flag', () => {
    process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON = 'true';
    expect(isVoiceReplyEnabled(makeConfig())).toBe(true);
  });

  it('lets explicit bot config override the internal default', () => {
    process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON = 'true';
    expect(isVoiceReplyEnabled({ ...makeConfig(), voiceReply: { enabled: false } })).toBe(false);
  });

  it('honors per-bot enablement and max char config', () => {
    const config = { ...makeConfig(), voiceReply: { enabled: true, maxChars: 123, provider: 'edge', summaryProvider: 'openai', summaryModel: 'gpt-test' } };
    expect(isVoiceReplyEnabled(config)).toBe(true);
    expect(resolveVoiceReplyConfig(config).maxChars).toBe(123);
    expect(resolveVoiceReplyConfig(config).provider).toBe('edge');
    expect(resolveVoiceReplyConfig(config).summaryProvider).toBe('openai');
    expect(resolveVoiceReplyConfig(config).summaryModel).toBe('gpt-test');
  });
});

describe('cleanTextForVoice', () => {
  it('removes markup, code blocks, tables, and urls', () => {
    const text = [
      '# 完成',
      '请查看 [文档](https://example.com/a)。',
      '```bash',
      'npm test',
      '```',
      '| A | B |',
      '| 1 | 2 |',
      '- `src/app.ts` 已更新',
    ].join('\n');

    const cleaned = cleanTextForVoice(text, 200);
    expect(cleaned).toContain('完成');
    expect(cleaned).toContain('请查看 文档');
    expect(cleaned).not.toContain('https://');
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('npm test');
    expect(cleaned).not.toContain('| A | B |');
  });

  it('truncates long text with a card hint', () => {
    const cleaned = cleanTextForVoice('很长'.repeat(300), 40);
    expect(cleaned.length).toBeLessThanOrEqual(60);
    expect(cleaned).toContain('后续内容请查看卡片');
  });

  it('builds a decision-oriented brief instead of reading code-heavy text verbatim', () => {
    const brief = buildHeuristicVoiceBrief([
      '已经完成语音播报优化，核心链路可用。',
      '```ts',
      'const token = process.env.SECRET;',
      'function noisyImplementation() {}',
      '```',
      '验证通过：npm run build:bridge。',
      '下一步建议先灰度给 luckagent，再默认开启给所有飞书 bot。',
    ].join('\n'), 120);

    expect(brief).toContain('已经完成');
    expect(brief).toContain('下一步建议');
    expect(brief).not.toContain('const token');
    expect(brief).not.toContain('function noisyImplementation');
    expect(brief.length).toBeLessThanOrEqual(140);
  });
});

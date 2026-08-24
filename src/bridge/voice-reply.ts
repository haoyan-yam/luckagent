import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BotConfigBase } from '../config.js';
import type { Logger } from '../utils/logger.js';
import {
  doubaoTTS,
  edgeTTS,
  elevenlabsTTS,
  openaiTTS,
  resolveTTSProvider,
  resolveTTSVoice,
} from '../api/voice-handler.js';

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_CHARS = 400;
const DEFAULT_SUMMARY_MODEL = 'gpt-4o-mini';

interface ResolvedVoiceReplyConfig {
  provider: string;
  voice: string;
  maxChars: number;
  summaryProvider: 'none' | 'openai';
  summaryModel: string;
}

export function isVoiceReplyEnabled(config: BotConfigBase): boolean {
  if (config.voiceReply?.enabled !== undefined) return config.voiceReply.enabled;
  const env = process.env.FEISHU_VOICE_REPLY ?? process.env.LUCKAGENT_VOICE_REPLY;
  if (env !== undefined) return env === 'true' || env === '1';
  return process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON === 'true' || process.env.LUCKAGENT_VOICE_REPLY_DEFAULT_ON === '1';
}

export function resolveVoiceReplyConfig(config: BotConfigBase): ResolvedVoiceReplyConfig {
  const explicitProvider = config.voiceReply?.provider || process.env.FEISHU_VOICE_REPLY_PROVIDER || process.env.LUCKAGENT_VOICE_REPLY_PROVIDER || '';
  const provider = resolveTTSProvider(explicitProvider);
  const envMaxChars = parseInt(process.env.FEISHU_VOICE_REPLY_MAX_CHARS || process.env.LUCKAGENT_VOICE_REPLY_MAX_CHARS || '', 10);
  const maxChars = config.voiceReply?.maxChars ?? (Number.isFinite(envMaxChars) ? envMaxChars : DEFAULT_MAX_CHARS);
  const explicitVoice = config.voiceReply?.voice || config.ttsVoice || process.env.FEISHU_VOICE_REPLY_VOICE || process.env.LUCKAGENT_VOICE_REPLY_VOICE || '';
  const summaryProvider = (
    config.voiceReply?.summaryProvider
    || process.env.FEISHU_VOICE_REPLY_SUMMARY_PROVIDER
    || process.env.LUCKAGENT_VOICE_REPLY_SUMMARY_PROVIDER
    || ''
  ).toLowerCase();
  return {
    provider,
    voice: resolveTTSVoice(explicitVoice, provider),
    maxChars,
    summaryProvider: summaryProvider === 'openai' ? 'openai' : 'none',
    summaryModel: config.voiceReply?.summaryModel
      || process.env.FEISHU_VOICE_REPLY_SUMMARY_MODEL
      || process.env.LUCKAGENT_VOICE_REPLY_SUMMARY_MODEL
      || DEFAULT_SUMMARY_MODEL,
  };
}

function normalizeTextForVoice(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '代码块已省略。')
    .replace(/`([^`]{1,80})`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '图片已省略。')
    .replace(/\[([^\]]+)]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '链接已省略')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, '表格内容已省略。')
    .replace(/[_*~>#]/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function truncateVoiceText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 18)).trim()}。后续内容请查看卡片。`;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function buildHeuristicVoiceBrief(text: string, maxChars: number): string {
  const normalized = normalizeTextForVoice(text).replace(/(表格内容已省略。\s*){2,}/g, '表格内容已省略。');
  if (!normalized) return '';

  const sentences = splitSentences(normalized)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 2 && !/^(状态|restarts?|uptime|message_id|chat_id)\s*[:：]/i.test(s));
  const substantive = sentences.filter((s) => !/^(代码块|表格内容|图片)已省略/.test(s));

  const conclusion = substantive.find((s) => /完成|搞定|已|可以|成功|通过|上线|修复|实现|验证|测试|确认|结论/.test(s))
    ?? substantive[0]
    ?? sentences[0]
    ?? '';
  const risk = substantive.find((s) => /失败|错误|阻塞|风险|注意|不能|没有|缺少|需要/.test(s) && s !== conclusion);
  const next = substantive.find((s) => /建议|下一步|推荐|决策|选择|方案|测试|确认|查看|听一下/.test(s) && s !== conclusion && s !== risk);

  const parts: string[] = [];
  if (conclusion) parts.push(`结论：${conclusion}`);
  if (risk) parts.push(`注意：${risk}`);
  if (next) parts.push(`下一步：${next}`);
  const brief = parts.join('。').replace(/。+/g, '。').trim();
  return truncateVoiceText(brief || normalized.replace(/\s+/g, ' '), maxChars);
}

export function cleanTextForVoice(text: string, maxChars: number): string {
  return buildHeuristicVoiceBrief(text, maxChars);
}

async function summarizeWithOpenAI(text: string, maxChars: number, model: string): Promise<string | undefined> {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LUCKAGENT_VOICE_REPLY_SUMMARY_API_KEY;
  if (!apiKey) return undefined;

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey,
    ...(process.env.OPENAI_BASE_URL || process.env.LUCKAGENT_VOICE_REPLY_SUMMARY_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL || process.env.LUCKAGENT_VOICE_REPLY_SUMMARY_BASE_URL }
      : {}),
  });
  const response = await client.chat.completions.create({
    model,
    temperature: 0.2,
    max_tokens: Math.min(260, Math.max(80, Math.ceil(maxChars / 1.5))),
    messages: [
      {
        role: 'system',
        content: [
          '你是 Luckagent 的语音播报编辑。',
          '把完整卡片回复改写成适合手机语音收听的中文口播摘要。',
          '只保留结论、状态、风险、需要用户决策或下一步动作。',
          '不要读代码、命令、表格、URL、文件路径、日志细节。',
          `控制在 ${maxChars} 个中文字符以内。`,
        ].join('\n'),
      },
      { role: 'user', content: text.slice(0, 6000) },
    ],
  });

  const summary = response.choices[0]?.message?.content?.trim();
  return summary ? truncateVoiceText(normalizeTextForVoice(summary), maxChars) : undefined;
}

async function buildVoiceBrief(text: string, config: ResolvedVoiceReplyConfig, logger: Logger): Promise<string> {
  const fallback = buildHeuristicVoiceBrief(text, config.maxChars);
  if (config.summaryProvider !== 'openai') return fallback;

  try {
    const summary = await summarizeWithOpenAI(text, config.maxChars, config.summaryModel);
    return summary || fallback;
  } catch (err) {
    logger.warn({ err, model: config.summaryModel }, 'Voice reply LLM summary failed, falling back to heuristic brief');
    return fallback;
  }
}

async function synthesizeMp3(text: string, provider: string, voice: string): Promise<Buffer> {
  if (provider === 'elevenlabs') return elevenlabsTTS(text, voice);
  if (provider === 'doubao') return doubaoTTS(text, voice);
  if (provider === 'edge') return edgeTTS(text, voice);
  return openaiTTS(text, voice);
}

export async function createVoiceReplyOpus(
  config: BotConfigBase,
  text: string,
  logger: Logger,
): Promise<{ filePath: string; fileName: string; cleanup: () => Promise<void> } | undefined> {
  if (!isVoiceReplyEnabled(config)) return undefined;

  const voiceConfig = resolveVoiceReplyConfig(config);
  const voiceText = await buildVoiceBrief(text, voiceConfig, logger);
  if (!voiceText) return undefined;

  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'luckagent-voice-reply-'));
  const mp3Path = path.join(tmpDir, 'reply.mp3');
  const opusPath = path.join(tmpDir, 'reply.opus');

  try {
    const audio = await synthesizeMp3(voiceText, voiceConfig.provider, resolveTTSVoice(voiceConfig.voice, voiceConfig.provider, voiceText));
    await fsPromises.writeFile(mp3Path, audio);
    await execFileAsync('ffmpeg', ['-y', '-i', mp3Path, '-c:a', 'libopus', '-b:a', '32k', opusPath], { timeout: 60_000 });
    return {
      filePath: opusPath,
      fileName: 'luckagent-reply.opus',
      cleanup: async () => {
        await fsPromises.rm(tmpDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    logger.warn({ err, provider: voiceConfig.provider }, 'Failed to create voice reply audio');
    await fsPromises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return undefined;
  }
}

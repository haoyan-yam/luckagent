/**
 * TTS providers used by POST /api/tts and the Feishu voice-reply path
 * (src/bridge/voice-reply.ts): Doubao (Volcengine), OpenAI, ElevenLabs and
 * Microsoft Edge TTS, plus provider/voice resolution helpers.
 */

import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { proxyFetch } from '../utils/http.js';

// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------

export async function openaiTTS(text: string, voice: string): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('OPENAI_API_KEY not configured'), { statusCode: 500 });

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const response = await client.audio.speech.create({
    model: 'tts-1',
    voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
    input: text,
  });
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

export async function elevenlabsTTS(text: string, voiceId: string): Promise<Buffer> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw Object.assign(new Error('ELEVENLABS_API_KEY not configured'), { statusCode: 500 });

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const response = await proxyFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'xi-api-key': apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${err}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Doubao (Volcengine) TTS — V3 HTTP Chunked API
// ---------------------------------------------------------------------------

export async function doubaoTTS(text: string, speaker: string): Promise<Buffer> {
  const appId = process.env.VOLCENGINE_TTS_APPID;
  const accessKey = process.env.VOLCENGINE_TTS_ACCESS_KEY;
  const resourceId = process.env.VOLCENGINE_TTS_RESOURCE_ID || 'volc.service_type.10029';
  if (!appId || !accessKey) {
    throw Object.assign(new Error('VOLCENGINE_TTS_APPID and VOLCENGINE_TTS_ACCESS_KEY not configured'), { statusCode: 500 });
  }

  const url = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
  const response = await proxyFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-App-Id': appId,
      'X-Api-Access-Key': accessKey,
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': crypto.randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker,
        audio_params: {
          format: 'mp3',
          sample_rate: 24000,
        },
      },
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Doubao TTS failed: ${response.status} ${err}`);
  }

  // V3 HTTP Chunked returns multiple JSON chunks, each with base64 audio in "data" field
  const body = await response.text();
  const audioChunks: Buffer[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const chunk = JSON.parse(trimmed);
      if (chunk.data) {
        audioChunks.push(Buffer.from(chunk.data, 'base64'));
      }
      if (chunk.code && chunk.code !== 0 && chunk.code !== 20000000) {
        throw new Error(`Doubao TTS error: code=${chunk.code} message=${chunk.message}`);
      }
    } catch (e: any) {
      if (e.message?.startsWith('Doubao TTS error')) throw e;
      // Skip non-JSON lines
    }
  }

  if (audioChunks.length === 0) {
    throw new Error('Doubao TTS returned no audio data');
  }
  return Buffer.concat(audioChunks);
}

// ---------------------------------------------------------------------------
// Edge TTS (Microsoft Edge, free, no API key needed)
// ---------------------------------------------------------------------------

export async function edgeTTS(text: string, voice: string): Promise<Buffer> {
  const { EdgeTTS } = await import('node-edge-tts');
  const tmpFile = `/tmp/mb-edge-tts-${Date.now()}.mp3`;
  const tts = new EdgeTTS({ voice: voice || 'zh-CN-XiaoyiNeural', lang: 'zh-CN' });
  await tts.ttsPromise(text, tmpFile);
  const buf = await fsp.readFile(tmpFile);
  await fsp.unlink(tmpFile).catch(() => {});
  return buf;
}

// ---------------------------------------------------------------------------
// Resolve defaults: prefer Doubao when keys are configured, fall back to OpenAI
// ---------------------------------------------------------------------------


export function resolveTTSProvider(explicit: string): string {
  if (explicit) return explicit;
  // Default to doubao if Volcengine keys exist, otherwise edge (free, no key needed)
  if (process.env.VOLCENGINE_TTS_APPID && process.env.VOLCENGINE_TTS_ACCESS_KEY) return 'doubao';
  return 'edge';
}

export function resolveTTSVoice(explicit: string, ttsProvider: string, text?: string): string {
  if (explicit) return explicit;

  // Auto-detect language from response text to pick the right voice
  const isChinese = text ? detectChinese(text) : true;

  if (ttsProvider === 'doubao') {
    return isChinese
      ? 'zh_female_sajiaonvyou_moon_bigtts'   // Chinese female voice
      : 'en_female_amanda_mars_bigtts';         // English female voice
  }
  if (ttsProvider === 'elevenlabs') return 'EXAVITQu4vr4xnSDxMaL'; // Bella (multilingual)
  if (ttsProvider === 'edge') {
    return isChinese ? 'zh-CN-XiaoyiNeural' : 'en-US-JennyNeural';
  }
  return 'alloy'; // OpenAI (multilingual)
}

/**
 * Detect whether text is primarily Chinese.
 * Returns true if >=15% of characters are CJK.
 */
function detectChinese(text: string): boolean {
  if (!text) return true;
  let cjk = 0;
  let total = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (code > 0x2f) { // skip whitespace/punctuation
      total++;
      if (
        (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified
        (code >= 0x3400 && code <= 0x4dbf) ||   // CJK Extension A
        (code >= 0xf900 && code <= 0xfaff)      // CJK Compat
      ) {
        cjk++;
      }
    }
  }
  return total === 0 || cjk / total >= 0.15;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

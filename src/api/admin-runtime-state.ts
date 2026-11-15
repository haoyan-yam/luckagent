import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Startup snapshots stay server-side; never expose hashes or secret values. */
export function createAdminRuntimeState(botsPath?: string, envPath = path.resolve('.env')) {
  const sources = [
    { path: envPath, kind: 'env', label: '环境默认值与服务凭证' },
    ...(botsPath ? [{ path: botsPath, kind: 'json', label: '模型接入与机器人配置' }] : []),
  ];
  const fingerprint = (source: typeof sources[number]) => {
    let raw: string;
    try { raw = fs.readFileSync(source.path, 'utf8'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw err; }
    return createHash('sha256').update(canonical(source.kind === 'json' ? JSON.parse(raw) : parse(raw))).digest('hex');
  };
  const initial = sources.map(s => { try { return fingerprint(s); } catch { return null; } });
  return {
    bootId: randomUUID(),
    restarting: false,
    restartCancelled: false,
    configStatus() {
      const pendingChanges: string[] = [];
      const errors: string[] = [];
      sources.forEach((s, i) => {
        try {
          const current = fingerprint(s);
          if (initial[i] === null) errors.push(`${s.label}的启动快照不可用`);
          else if (current === 'missing' && initial[i] !== 'missing') errors.push(`${s.label}文件已被移除，请恢复后再重启`);
          else if (current !== initial[i]) pendingChanges.push(s.label);
        } catch { errors.push(`${s.label}无法读取，请检查配置文件`); }
      });
      return { configDirty: pendingChanges.length > 0, pendingChanges, configErrors: errors };
    },
  };
}

export type AdminRuntimeState = ReturnType<typeof createAdminRuntimeState>;

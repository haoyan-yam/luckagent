import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandUserPath, projectsRoot } from '../config.js';
import { isValidCron } from '../scheduler/cron-utils.js';

/**
 * - files: plain age/size/glob filter
 * - extracted-zip: zip whose every entry already exists unpacked (same name, size, CRC) in the same project
 * - codex-exec-sessions: Codex rollout files written by `codex exec` (image-gen), never by the TUI
 */
export type RuleKind = 'files' | 'extracted-zip' | 'codex-exec-sessions';
/** archive = copy to archiveRoot, verify SHA-1, then delete local; trash = move to ~/.Trash */
export type RuleAction = 'archive' | 'trash';

export interface HousekeepingRule {
  id: string;
  name: string;
  enabled: boolean;
  kind: RuleKind;
  /** Directory the globs are relative to; must be inside the home directory. */
  root: string;
  include: string[];
  exclude: string[];
  /** Only files whose mtime is older than this many days. */
  minAgeDays: number;
  /** Only files at least this big (MB). 0 = any size. */
  minSizeMB: number;
  action: RuleAction;
  /**
   * Never archive the newest file of a series — same folder, same name once the
   * digits are ignored (`_arc_master_0831_1108.pkl` ~ `_arc_master_0831_1101.pkl`).
   * For rolling baselines that the next weekly job builds on.
   */
  keepLatestPerSeries?: boolean;
}

/** Who gets the notice: a person by private message (open_id), or a chat (group or existing p2p chat_id). */
export interface AlertRecipient {
  type: 'user' | 'chat';
  /** `ou_…` for a user, `oc_…` for a chat. */
  id: string;
  /** Display name, for the admin page only. */
  name?: string;
}

/** Feishu notice when something needs a human: failed run, drive missing, errors, low disk. */
export interface AlertConfig {
  enabled: boolean;
  /** Bot (from bots.json) whose identity sends the notice. */
  bot: string;
  recipients: AlertRecipient[];
  /** Warn when free space on the home volume drops below this many GB. */
  minFreeGB: number;
}

export interface HousekeepingConfig {
  schedule: { enabled: boolean; cron: string };
  /** Where `archive` rules copy to, e.g. /Volumes/NAS/luckagent-archive. Empty = archive rules are skipped. */
  archiveRoot: string;
  rules: HousekeepingRule[];
  alert: AlertConfig;
}

export function defaultAlert(): AlertConfig {
  return { enabled: false, bot: '', recipients: [], minFreeGB: 15 };
}

export const RULE_KINDS: RuleKind[] = ['files', 'extracted-zip', 'codex-exec-sessions'];
export const RULE_ACTIONS: RuleAction[] = ['archive', 'trash'];
const FONT_GLOBS = ['**/*.{ttf,otf,ttc}'];
/** Bulky, regenerable-or-superseded file types in work/: images, documents, audio/video. */
const WORK_MEDIA_EXTS = [
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'heic', 'bmp',
  'pptx', 'ppt', 'docx', 'doc', 'pdf', 'key',
  'mp4', 'mov', 'm4v', 'webm', 'wav', 'mp3', 'm4a', 'aac',
];

export function housekeepingDir(): string {
  const dir = process.env.SESSION_STORE_DIR || path.join(os.homedir(), '.luckagent');
  return path.join(dir, 'housekeeping');
}

function configPath(): string {
  return path.join(housekeepingDir(), 'config.json');
}

/** The four presets agreed for the first version; schedule starts OFF so an upgrade never deletes on its own. */
export function defaultConfig(): HousekeepingConfig {
  const projects = projectsRoot();
  return {
    schedule: { enabled: false, cron: '0 3 * * *' },
    archiveRoot: '',
    alert: defaultAlert(),
    rules: [
      {
        id: 'work-pkl',
        name: 'work 里的数据缓存（pkl / npy）',
        enabled: true,
        kind: 'files',
        root: projects,
        include: ['*/work/**/*.{pkl,npy}'],
        exclude: [],
        minAgeDays: 7,
        minSizeMB: 0,
        action: 'archive',
        keepLatestPerSeries: true,
      },
      {
        id: 'old-io',
        name: 'inputs / outputs 旧素材',
        enabled: true,
        kind: 'files',
        root: projects,
        include: ['*/inputs/**', '*/outputs/**'],
        exclude: FONT_GLOBS,
        minAgeDays: 30,
        minSizeMB: 1,
        action: 'archive',
      },
      {
        // 和 inputs / outputs 同一套条件；只挑大文件类型，脚本、字体、配置、表格等一律不碰
        id: 'work-media',
        name: 'work 里的图片 / 文档 / 音视频',
        enabled: true,
        kind: 'files',
        root: projects,
        include: [`*/work/**/*.{${WORK_MEDIA_EXTS.join(',')}}`],
        exclude: ['**/node_modules/**', '**/.git/**'],
        // 进行中或刚收尾的任务常在一个多月后回头改，比 inputs/outputs 多留一个月
        minAgeDays: 60,
        minSizeMB: 1,
        action: 'archive',
      },
      {
        id: 'extracted-zip',
        name: '已解压的 zip',
        enabled: true,
        kind: 'extracted-zip',
        root: projects,
        include: ['**/*.zip'],
        exclude: ['*/outputs/**'],
        minAgeDays: 3,
        minSizeMB: 0,
        action: 'trash',
      },
      {
        id: 'codex-exec',
        name: 'Codex 生图会话',
        enabled: true,
        kind: 'codex-exec-sessions',
        root: '~/.codex/sessions',
        include: ['**/*.jsonl'],
        exclude: [],
        // image-gen 已用 --ephemeral，这里只是兜底；留一周给手动 `codex exec resume`
        minAgeDays: 7,
        minSizeMB: 0,
        action: 'trash',
      },
    ],
  };
}

export function readConfig(): HousekeepingConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    const v = validateConfig(parsed);
    if (v.ok) return v.config;
  } catch {
    /* missing or unreadable → defaults */
  }
  return defaultConfig();
}

export function writeConfig(cfg: HousekeepingConfig): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];

/**
 * A rule root may not be the home dir itself, a system location, or contain the
 * archive root (that would archive the archive).
 */
export function rootProblem(root: string, archiveRoot: string): string | null {
  const home = os.homedir();
  const abs = path.resolve(expandUserPath(root));
  if (!abs.startsWith(home + path.sep)) return `目录必须在 ${home} 下面`;
  const rel = path.relative(home, abs).split(path.sep)[0];
  if (['Library', 'Applications', '.Trash', '.ssh', '.luckagent'].includes(rel)) return `不允许清理 ~/${rel}`;
  if (archiveRoot) {
    const ar = path.resolve(expandUserPath(archiveRoot));
    if (ar === abs || ar.startsWith(abs + path.sep)) return '归档目录不能在规则目录里面';
  }
  return null;
}

export function validateConfig(
  input: unknown,
): { ok: true; config: HousekeepingConfig } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: '配置必须是对象' };
  const o = input as Record<string, unknown>;
  const sched = (o.schedule ?? {}) as Record<string, unknown>;
  const cron = typeof sched.cron === 'string' ? sched.cron.trim() : '0 3 * * *';
  if (!isValidCron(cron)) return { ok: false, error: `cron 表达式无效：${cron}` };
  const archiveRoot = typeof o.archiveRoot === 'string' ? o.archiveRoot.trim() : '';
  if (archiveRoot && !/^(\/|~\/)/.test(archiveRoot)) {
    return { ok: false, error: '归档目录必须是绝对路径' };
  }
  if (!Array.isArray(o.rules)) return { ok: false, error: 'rules 必须是数组' };
  const ids = new Set<string>();
  const rules: HousekeepingRule[] = [];
  for (const raw of o.rules as unknown[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '规则格式错误' };
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : '';
    if (!name) return { ok: false, error: '规则名称不能为空' };
    const kind = r.kind as RuleKind;
    if (!RULE_KINDS.includes(kind)) return { ok: false, error: `「${name}」类型无效` };
    const action = r.action as RuleAction;
    if (!RULE_ACTIONS.includes(action)) return { ok: false, error: `「${name}」处理方式无效` };
    const root = typeof r.root === 'string' ? r.root.trim() : '';
    if (!root) return { ok: false, error: `「${name}」目录不能为空` };
    if (!/^(\/|~\/)/.test(root)) return { ok: false, error: `「${name}」目录必须是绝对路径或以 ~/ 开头` };
    const problem = rootProblem(root, archiveRoot);
    if (problem) return { ok: false, error: `「${name}」${problem}` };
    const include = strList(r.include);
    if (!include.length) return { ok: false, error: `「${name}」至少要有一个匹配规则` };
    const minAgeDays = Number(r.minAgeDays);
    if (!Number.isFinite(minAgeDays) || minAgeDays < 1) return { ok: false, error: `「${name}」最少要 1 天没改过` };
    const minSizeMB = Number(r.minSizeMB ?? 0);
    if (!Number.isFinite(minSizeMB) || minSizeMB < 0) return { ok: false, error: `「${name}」最小体积无效` };
    let id = typeof r.id === 'string' && /^[\w-]{1,64}$/.test(r.id) ? r.id : randomUUID().slice(0, 8);
    while (ids.has(id)) id = randomUUID().slice(0, 8);
    ids.add(id);
    rules.push({
      id,
      name,
      enabled: r.enabled !== false,
      kind,
      root,
      include,
      exclude: strList(r.exclude),
      minAgeDays,
      minSizeMB,
      action,
      keepLatestPerSeries: r.keepLatestPerSeries === true,
    });
  }
  const a = (o.alert ?? {}) as Record<string, unknown>;
  const rawRecipients: unknown[] = Array.isArray(a.recipients) ? a.recipients : typeof a.chatId === 'string' && a.chatId ? [{ type: 'chat', id: a.chatId }] : [];
  const recipients: AlertRecipient[] = [];
  for (const r of rawRecipients) {
    const x = (r ?? {}) as Record<string, unknown>;
    const id = typeof x.id === 'string' ? x.id.trim() : '';
    const type = x.type === 'user' ? 'user' : 'chat';
    if (!id) continue;
    if (type === 'user' && !/^ou_\w+$/.test(id)) return { ok: false, error: `提醒接收人 ${id} 不是有效的 open_id（以 ou_ 开头）` };
    if (type === 'chat' && !/^oc_\w+$/.test(id)) return { ok: false, error: `提醒的群 ${id} 不是有效的 chat_id（以 oc_ 开头）` };
    if (recipients.some((y) => y.type === type && y.id === id)) continue;
    recipients.push({ type, id, ...(typeof x.name === 'string' && x.name.trim() ? { name: x.name.trim() } : {}) });
  }
  const alert: AlertConfig = {
    enabled: a.enabled === true,
    bot: typeof a.bot === 'string' ? a.bot.trim() : '',
    recipients,
    minFreeGB: Number.isFinite(Number(a.minFreeGB)) && Number(a.minFreeGB) > 0 ? Number(a.minFreeGB) : 15,
  };
  if (alert.enabled && (!alert.bot || !recipients.length)) {
    return { ok: false, error: '开启提醒需要选择发送的机器人，并至少选一个接收人或群' };
  }
  return { ok: true, config: { schedule: { enabled: sched.enabled === true, cron }, archiveRoot, rules, alert } };
}

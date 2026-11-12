import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Logger } from '../utils/logger.js';
import { nextCronOccurrence } from '../scheduler/cron-utils.js';
import { housekeepingDir, readConfig, rootProblem, writeConfig, type AlertConfig, type AlertRecipient, type HousekeepingConfig, type HousekeepingRule } from './config.js';
import { archiveFile, archiveTargetStatus, diskUsage, restoreFile, trashBatchDir, trashFile, type ActionResult } from './actions.js';
import { buildProtection, protectedReason } from './protect.js';
import { checkExtractedZip, isCodexExecSession, listMatches, ProjectFileIndex, ruleRoot, type Candidate } from './scan.js';

export type EntryStatus = 'pending' | 'archived' | 'trashed' | 'skipped' | 'error' | 'protected' | 'restored';

export interface RunEntry {
  ruleId: string;
  path: string;
  size: number;
  mtimeMs: number;
  /** max(mtime, ctime) at scan time — what "age" is measured from. */
  touchedMs?: number;
  status: EntryStatus;
  dest?: string;
  sha1?: string;
  note?: string;
}

export interface RuleSummary {
  id: string;
  name: string;
  action: HousekeepingRule['action'];
  matched: number;
  matchedBytes: number;
  done: number;
  doneBytes: number;
  skipped: number;
  errors: number;
  /** Matched but kept: referenced by memory / skills / active scripts, or newest of a series. */
  protected?: number;
  protectedBytes?: number;
  /** Why the whole rule didn't run (e.g. drive not connected). */
  skippedReason?: string;
}

export interface RunSummary {
  id: string;
  trigger: 'manual' | 'schedule';
  dryRun: boolean;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: number;
  finishedAt?: number;
  phase?: string;
  rules: RuleSummary[];
  totals: { matched: number; matchedBytes: number; done: number; doneBytes: number; skipped: number; errors: number; protected?: number; protectedBytes?: number };
  freeBefore?: number;
  freeAfter?: number;
  archiveRoot?: string;
  trashDir?: string;
  error?: string;
  /** Problems worth a human's attention (also sent as a Feishu notice when alerts are on). */
  warnings?: string[];
}

export interface RunRecord extends RunSummary {
  entries: RunEntry[];
}

/** Sends a Feishu notice as `bot` to one recipient (private message or chat). Injected by the bridge (needs the bot registry). */
export type Notifier = (bot: string, to: AlertRecipient, title: string, content: string) => Promise<void>;

export interface ServiceOptions {
  /** Clock override (tests). */
  now?: () => number;
  notify?: Notifier;
}

const KEEP_RUNS = 200;
const KEEP_PREVIEWS = 30;
const MAX_TIMEOUT = 2 ** 31 - 1;
const DISK_CHECK_MS = 60 * 60 * 1000;
const LOW_DISK_REPEAT_MS = 24 * 60 * 60 * 1000;
/** A handful of failures is noise (a file in use); more than this is worth a ping. */
const ERROR_ALERT_THRESHOLD = 5;
const GB = 1024 ** 3;
/** The archive drive is big; warn while there is still room to plan a second drive. */
const ARCHIVE_MIN_FREE_GB = 50;

function runsDir(): string {
  return path.join(housekeepingDir(), 'runs');
}

/** Every archived file, across all runs and drives — survives run-log pruning and works without the drive. */
export function localArchiveIndexPath(): string {
  return path.join(housekeepingDir(), '归档总清单.tsv');
}

/** Series keys of everything ever archived (from the local cumulative index). */
function archivedSeriesKeys(): Set<string> {
  const out = new Set<string>();
  try {
    for (const line of fs.readFileSync(localArchiveIndexPath(), 'utf-8').split('\n')) {
      const orig = line.split('\t')[4];
      if (orig && orig.startsWith('/')) out.add(seriesKey(orig));
    }
  } catch {
    /* no history yet */
  }
  return out;
}

function summarize(r: RunRecord): RunSummary {
  const { entries: _e, ...rest } = r;
  return rest;
}

function recomputeTotals(r: RunSummary): void {
  const t = { matched: 0, matchedBytes: 0, done: 0, doneBytes: 0, skipped: 0, errors: 0, protected: 0, protectedBytes: 0 };
  for (const s of r.rules) {
    t.matched += s.matched;
    t.matchedBytes += s.matchedBytes;
    t.done += s.done;
    t.doneBytes += s.doneBytes;
    t.skipped += s.skipped;
    t.errors += s.errors;
    t.protected += s.protected ?? 0;
    t.protectedBytes += s.protectedBytes ?? 0;
  }
  r.totals = t;
}

function safeId(id: string): boolean {
  return /^[\w-]{1,64}$/.test(id);
}

/** Folder + name with every digit run folded: `_arc_master_0831_1108.pkl` → `_arc_master_#_#.pkl`. */
export function seriesKey(abs: string): string {
  return path.join(path.dirname(abs), path.basename(abs).toLowerCase().replace(/\d+/g, '#'));
}

const fmtGB = (b?: number) => (b == null ? '—' : `${(b / GB).toFixed(1)}G`);

export class HousekeepingService {
  private timer: NodeJS.Timeout | null = null;
  private diskTimer: NodeJS.Timeout | null = null;
  private nextRunAt: number | null = null;
  private current: RunRecord | null = null;
  private cancelRequested = false;
  private lastLowDiskAlertAt = 0;
  private lastLowArchiveAlertAt = 0;
  private readonly now: () => number;

  constructor(
    private logger?: Logger,
    /** bots.json — used to find each bot's memory so files it references are never touched. */
    private botsConfigPath?: string,
    private opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ---------------- config ----------------

  getConfig(): HousekeepingConfig {
    return readConfig();
  }

  saveConfig(cfg: HousekeepingConfig): void {
    writeConfig(cfg);
    this.reschedule();
  }

  // ---------------- scheduling ----------------

  start(): void {
    this.reschedule();
    this.diskTimer = setInterval(() => void this.checkDisk(), DISK_CHECK_MS);
    this.diskTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.timer = null;
    this.diskTimer = null;
    this.nextRunAt = null;
    this.cancelRequested = true;
  }

  getNextRunAt(): number | null {
    return this.nextRunAt;
  }

  reschedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    const cfg = readConfig();
    if (!cfg.schedule.enabled) return;
    try {
      this.nextRunAt = nextCronOccurrence(cfg.schedule.cron);
    } catch {
      return;
    }
    this.arm();
  }

  private arm(): void {
    if (this.nextRunAt === null) return;
    const delay = Math.max(0, this.nextRunAt - Date.now());
    this.timer = setTimeout(() => {
      if (this.nextRunAt !== null && Date.now() < this.nextRunAt - 1000) {
        this.arm(); // long waits are chained through MAX_TIMEOUT
        return;
      }
      if (this.current) {
        this.logger?.warn('housekeeping: previous run still going, skipping scheduled run');
      } else {
        void this.run({ trigger: 'schedule', dryRun: false }).catch(() => undefined);
      }
      this.reschedule();
    }, Math.min(delay, MAX_TIMEOUT));
    this.timer.unref?.();
  }

  // ---------------- alerts ----------------

  /** Sends to every recipient; true if at least one got it. */
  private async notify(alert: AlertConfig, title: string, content: string): Promise<boolean> {
    if (!alert.enabled || !alert.bot || !alert.recipients.length || !this.opts.notify) return false;
    let any = false;
    for (const to of alert.recipients) {
      try {
        await this.opts.notify(alert.bot, to, title, content);
        any = true;
      } catch (e) {
        this.logger?.warn({ err: (e as Error).message, to: to.id }, 'housekeeping: alert failed');
      }
    }
    return any;
  }

  async testAlert(): Promise<boolean> {
    const { alert } = readConfig();
    let free = '—';
    try {
      free = fmtGB(diskUsage().freeBytes);
    } catch {
      /* ignore */
    }
    return this.notify(alert, '✅ 清理归档提醒测试', `以后出现执行失败、硬盘没接上、出错较多或可用空间低于 ${alert.minFreeGB}G 时，会发到这里。\n当前可用空间 ${free}。`);
  }

  /**
   * Hourly: warn (each at most once a day) when the Mac's disk drops below the
   * alert threshold, or the archive drive below ARCHIVE_MIN_FREE_GB.
   */
  async checkDisk(): Promise<boolean> {
    const cfg = readConfig();
    const { alert } = cfg;
    if (!alert.enabled) return false;
    let sentAny = false;
    let free: number | null = null;
    try {
      free = diskUsage().freeBytes;
    } catch {
      /* ignore */
    }
    if (free != null && free < alert.minFreeGB * GB && this.now() - this.lastLowDiskAlertAt >= LOW_DISK_REPEAT_MS) {
      const sent = await this.notify(
        alert,
        '⚠️ 本机磁盘快满了',
        `可用空间只剩 ${fmtGB(free)}（提醒线 ${alert.minFreeGB}G）。\n可以到管理台「清理归档」先预览、再执行；归档规则需要接上 NAS 硬盘。`,
      );
      if (sent) this.lastLowDiskAlertAt = this.now();
      sentAny ||= sent;
    }
    const archive = cfg.archiveRoot ? archiveTargetStatus(cfg.archiveRoot) : null;
    if (archive?.ok && archive.freeBytes != null && archive.freeBytes < ARCHIVE_MIN_FREE_GB * GB && this.now() - this.lastLowArchiveAlertAt >= LOW_DISK_REPEAT_MS) {
      const sent = await this.notify(
        alert,
        '⚠️ NAS 归档硬盘快满了',
        `归档硬盘（${archive.root}）只剩 ${fmtGB(archive.freeBytes)}。\n满了以后归档会失败、本机空间就腾不出来，需要清理硬盘或换一块更大的。`,
      );
      if (sent) this.lastLowArchiveAlertAt = this.now();
      sentAny ||= sent;
    }
    return sentAny;
  }

  /** Work out what in a finished run needs a human, record it on the run, and notify. */
  private async reportRun(run: RunRecord, cfg: HousekeepingConfig): Promise<void> {
    if (run.dryRun) return;
    const w: string[] = [];
    if (run.status === 'failed') w.push(`执行失败：${run.error ?? '未知原因'}`);
    for (const r of run.rules) if (r.skippedReason) w.push(`「${r.name}」没有执行：${r.skippedReason}`);
    if (run.totals.errors >= ERROR_ALERT_THRESHOLD) w.push(`有 ${run.totals.errors} 个文件处理出错，详见执行记录`);
    const eperm = run.entries.some((e) => e.status === 'error' && /EPERM|权限/.test(e.note ?? ''));
    if (eperm) w.push('没有废纸篓权限：在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里给 node 授权');
    const lowDisk = run.freeAfter != null && run.freeAfter < cfg.alert.minFreeGB * GB;
    if (lowDisk) w.push(`清理后可用空间只有 ${fmtGB(run.freeAfter)}，低于提醒线 ${cfg.alert.minFreeGB}G`);
    if (!w.length) return;
    run.warnings = w;
    this.persist(run);
    const head = `${run.trigger === 'schedule' ? '定时' : '手动'}清理 ${new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}`;
    const body = `${w.map((x) => `• ${x}`).join('\n')}\n\n已处理 ${run.totals.done} 个（${fmtGB(run.totals.doneBytes)}），可用空间 ${fmtGB(run.freeBefore)} → ${fmtGB(run.freeAfter)}`;
    const sent = await this.notify(cfg.alert, `⚠️ 清理归档需要处理：${head}`, body);
    if (sent && lowDisk) this.lastLowDiskAlertAt = this.now();
  }

  // ---------------- runs ----------------

  getCurrent(): RunSummary | null {
    return this.current ? summarize(this.current) : null;
  }

  cancel(): boolean {
    if (!this.current) return false;
    this.cancelRequested = true;
    return true;
  }

  /** Reads only the small `<id>.sum.json` files — full logs can be MBs each and the page polls this. */
  listRuns(limit = 50): RunSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(runsDir());
    } catch {
      return [];
    }
    const out: RunSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.sum.json')) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(runsDir(), f), 'utf-8')) as RunSummary);
      } catch {
        /* skip corrupt */
      }
    }
    if (this.current && !out.some((r) => r.id === this.current!.id)) out.push(summarize(this.current));
    return out.sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  getRun(id: string): RunRecord | null {
    if (this.current?.id === id) return this.current;
    if (!safeId(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(runsDir(), `${id}.json`), 'utf-8')) as RunRecord;
    } catch {
      return null;
    }
  }

  private persist(r: RunRecord): void {
    try {
      fs.mkdirSync(runsDir(), { recursive: true });
      const file = path.join(runsDir(), `${r.id}.json`);
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(r));
      fs.renameSync(`${file}.tmp`, file);
      const sum = path.join(runsDir(), `${r.id}.sum.json`);
      fs.writeFileSync(`${sum}.tmp`, JSON.stringify(summarize(r)));
      fs.renameSync(`${sum}.tmp`, sum);
    } catch (e) {
      this.logger?.warn({ err: (e as Error).message }, 'housekeeping: failed to write run log');
    }
  }

  /** Real runs and previews are kept separately, so a burst of previews never pushes real history out. */
  private prune(): void {
    try {
      const ids = fs
        .readdirSync(runsDir())
        .filter((f) => f.endsWith('.sum.json'))
        .map((f) => f.slice(0, -'.sum.json'.length))
        .map((id) => ({ id, t: fs.statSync(path.join(runsDir(), `${id}.sum.json`)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      const previews = ids.filter((x) => x.id.startsWith('p-'));
      const real = ids.filter((x) => !x.id.startsWith('p-'));
      for (const { id } of [...previews.slice(KEEP_PREVIEWS), ...real.slice(KEEP_RUNS)]) {
        for (const f of [`${id}.json`, `${id}.sum.json`]) fs.rmSync(path.join(runsDir(), f), { force: true });
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Start a run in the background and return its id. Throws if one is already running.
   * dryRun = scan only (预览): records what would be processed, touches nothing.
   */
  startRun(opts: { trigger: 'manual' | 'schedule'; dryRun: boolean; ruleIds?: string[] }): string {
    if (this.current) throw new Error('已有任务在执行');
    const id = this.newRun(opts);
    void this.execute(opts.ruleIds).catch(() => undefined);
    return id;
  }

  /** Run to completion (used by the scheduler and tests). */
  async run(opts: { trigger: 'manual' | 'schedule'; dryRun: boolean; ruleIds?: string[] }): Promise<RunRecord> {
    if (this.current) throw new Error('已有任务在执行');
    this.newRun(opts);
    return this.execute(opts.ruleIds);
  }

  private newRun(opts: { trigger: 'manual' | 'schedule'; dryRun: boolean }): string {
    const now = Date.now();
    const d = new Date(now);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomUUID().slice(0, 4)}`;
    const id = opts.dryRun ? `p-${stamp}` : stamp;
    this.cancelRequested = false;
    this.current = {
      id,
      trigger: opts.trigger,
      dryRun: opts.dryRun,
      status: 'running',
      startedAt: now,
      phase: '准备中',
      rules: [],
      totals: { matched: 0, matchedBytes: 0, done: 0, doneBytes: 0, skipped: 0, errors: 0 },
      entries: [],
    };
    return id;
  }

  private async execute(ruleIds?: string[]): Promise<RunRecord> {
    const run = this.current!;
    const cfg = readConfig();
    const rules = cfg.rules.filter((r) => (ruleIds?.length ? ruleIds.includes(r.id) : r.enabled));
    try {
      run.freeBefore = diskUsage().freeBytes;
    } catch {
      /* ignore */
    }
    const archive = archiveTargetStatus(cfg.archiveRoot);
    if (archive.ok) run.archiveRoot = archive.root;
    const batchDir = trashBatchDir(run.startedAt);
    const zipIndex = new ProjectFileIndex();
    run.phase = '读取各 bot 的记忆、技能和脚本引用的文件';
    const protection = buildProtection(this.botsConfigPath, this.now());
    if (protection.bots === 0 && !run.dryRun) {
      // Without bots.json we can't tell which files memories rely on — don't guess.
      run.status = 'failed';
      run.error = '读不到 bots.json，无法确认哪些文件被记忆引用，本次没有处理任何文件';
      run.phase = undefined;
      run.finishedAt = Date.now();
      this.persist(run);
      this.current = null;
      await this.reportRun(run, cfg);
      return run;
    }
    const stop = () => this.cancelRequested;
    this.logger?.info({ runId: run.id, dryRun: run.dryRun, trigger: run.trigger, rules: rules.map((r) => r.id) }, 'housekeeping: run started');

    try {
      for (const rule of rules) {
        if (stop()) break;
        const sum: RuleSummary = { id: rule.id, name: rule.name, action: rule.action, matched: 0, matchedBytes: 0, done: 0, doneBytes: 0, skipped: 0, errors: 0, protected: 0, protectedBytes: 0 };
        run.rules.push(sum);
        const problem = rootProblem(rule.root, cfg.archiveRoot);
        if (problem) {
          sum.skippedReason = problem;
          continue;
        }
        if (!fs.existsSync(ruleRoot(rule))) {
          sum.skippedReason = `目录不存在：${rule.root}`;
          continue;
        }
        if (rule.action === 'archive' && !archive.ok) {
          // 预览照样列出命中文件，只提示执行时会跳过
          sum.skippedReason = run.dryRun ? `执行时会跳过：${archive.reason}` : `没有归档：${archive.reason}`;
          if (!run.dryRun) continue;
        }

        run.phase = `扫描「${rule.name}」`;
        const found = await this.filterByKind(rule, await listMatches(rule, this.now(), stop), zipIndex, run, stop);
        const latest = rule.keepLatestPerSeries ? this.latestOfSeries(found) : new Set<string>();
        const matches: typeof found = [];
        for (const c of found) {
          const why = protectedReason(protection, c.abs) ?? (latest.has(c.abs) ? '同一系列里最新的一版（下次还要接着用）' : null);
          if (!why) {
            matches.push(c);
            continue;
          }
          sum.protected!++;
          sum.protectedBytes! += c.size;
          run.entries.push({ ruleId: rule.id, path: c.abs, size: c.size, mtimeMs: c.mtimeMs, touchedMs: c.touchedMs, status: 'protected', note: why });
        }
        const ruleEntries: RunEntry[] = matches.map((c) => ({
          ruleId: rule.id,
          path: c.abs,
          size: c.size,
          mtimeMs: c.mtimeMs,
          touchedMs: c.touchedMs,
          status: 'pending',
          note: c.note,
        }));
        run.entries.push(...ruleEntries);
        sum.matched = matches.length;
        sum.matchedBytes = matches.reduce((n, c) => n + c.size, 0);
        recomputeTotals(run);
        if (run.dryRun) continue;

        let i = 0;
        for (const c of matches) {
          if (stop()) break;
          i++;
          run.phase = `${rule.action === 'archive' ? '归档' : '移到废纸篓'}「${rule.name}」 ${i}/${matches.length}`;
          const res: ActionResult = rule.action === 'archive' ? await archiveFile(c, cfg.archiveRoot) : await trashFile(c, batchDir);
          const entry = ruleEntries[i - 1];
          entry.status = res.status;
          entry.note = res.note ?? entry.note;
          if (res.status === 'archived' || res.status === 'trashed') {
            entry.dest = res.dest;
            if (res.status === 'archived') {
              entry.sha1 = res.sha1;
              this.appendArchiveManifest(cfg.archiveRoot, run.id, entry);
            } else {
              run.trashDir = batchDir;
            }
            sum.done++;
            sum.doneBytes += c.size;
          } else if (res.status === 'skipped') {
            sum.skipped++;
          } else {
            sum.errors++;
          }
          recomputeTotals(run);
        }
        this.persist(run);
      }
      run.status = this.cancelRequested ? 'cancelled' : 'done';
    } catch (e) {
      run.status = 'failed';
      run.error = (e as Error).message;
    } finally {
      run.phase = undefined;
      run.finishedAt = Date.now();
      try {
        run.freeAfter = diskUsage().freeBytes;
      } catch {
        /* ignore */
      }
      recomputeTotals(run);
      this.persist(run);
      this.prune();
      this.current = null;
      this.logger?.info(
        { runId: run.id, status: run.status, dryRun: run.dryRun, ...run.totals },
        'housekeeping: run finished',
      );
    }
    await this.reportRun(run, cfg);
    return run;
  }

  /**
   * For each candidate, is it the newest file of a real version series in its
   * folder? A series is real when it has ≥2 files now, or had earlier versions
   * archived (so a baseline that is alone after its predecessors left stays put).
   * A one-off file (a task folder's only `T.pkl`) is not a series and goes
   * normally — otherwise every task folder would pin its caches forever.
   * Newer siblings that didn't match (too young) count too.
   */
  private latestOfSeries(cands: Candidate[]): Set<string> {
    const archivedSeries = archivedSeriesKeys();
    const newestByKey = new Map<string, number>();
    const countByKey = new Map<string, number>();
    const seenDirs = new Set<string>();
    for (const c of cands) {
      const dir = path.dirname(c.abs);
      if (seenDirs.has(dir)) continue;
      seenDirs.add(dir);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const p = path.join(dir, n);
        try {
          const st = fs.lstatSync(p);
          if (!st.isFile()) continue;
          const k = seriesKey(p);
          const t = Math.max(st.mtimeMs, st.ctimeMs);
          countByKey.set(k, (countByKey.get(k) ?? 0) + 1);
          if (t > (newestByKey.get(k) ?? -1)) newestByKey.set(k, t);
        } catch {
          /* vanished */
        }
      }
    }
    return new Set(
      cands
        .filter((c) => {
          const k = seriesKey(c.abs);
          const isSeries = (countByKey.get(k) ?? 0) >= 2 || archivedSeries.has(k);
          return isSeries && c.touchedMs >= (newestByKey.get(k) ?? Infinity);
        })
        .map((c) => c.abs),
    );
  }

  private async filterByKind(
    rule: HousekeepingRule,
    list: Candidate[],
    zipIndex: ProjectFileIndex,
    run: RunRecord,
    stop: () => boolean,
  ): Promise<Array<Candidate & { note?: string }>> {
    if (rule.kind === 'files') return list;
    const out: Array<Candidate & { note?: string }> = [];
    let i = 0;
    for (const c of list) {
      if (stop()) break;
      i++;
      if (rule.kind === 'codex-exec-sessions') {
        if (await isCodexExecSession(c.abs)) out.push(c);
      } else {
        run.phase = `核对 zip 是否已解压「${rule.name}」 ${i}/${list.length}`;
        const chk = await checkExtractedZip(rule, c, zipIndex);
        if (chk.extracted) out.push({ ...c, note: `${chk.matched}/${chk.total} 个文件已解压` });
      }
    }
    return out;
  }

  /** Same line on the drive (findable without this machine) and locally (findable without the drive). */
  private appendArchiveManifest(archiveRoot: string, runId: string, e: RunEntry): void {
    const header = '归档时间\t批次\t大小\tsha1\t原路径\t硬盘位置\n';
    const line = [new Date().toISOString(), runId, e.size, e.sha1 ?? '', e.path, e.dest ?? ''].join('\t') + '\n';
    for (const file of [path.join(path.resolve(archiveRoot.replace(/^~(?=\/)/, os.homedir())), '归档清单.tsv'), localArchiveIndexPath()]) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (!fs.existsSync(file)) fs.writeFileSync(file, header);
        fs.appendFileSync(file, line);
      } catch {
        /* best effort — the run log has the same data */
      }
    }
  }

  // ---------------- restore ----------------

  /** Put archived / trashed files from one run back in place. Paths empty = every restorable entry. */
  async restore(runId: string, paths?: string[]): Promise<Array<{ path: string; ok: boolean; note?: string }>> {
    if (this.current?.id === runId) throw new Error('这次任务还在执行，等它结束再恢复');
    const run = this.getRun(runId);
    if (!run) throw new Error('没有这条记录');
    const want = paths?.length ? new Set(paths) : null;
    const out: Array<{ path: string; ok: boolean; note?: string }> = [];
    for (const e of run.entries) {
      if (want && !want.has(e.path)) continue;
      if (e.status !== 'archived' && e.status !== 'trashed') {
        if (want) out.push({ path: e.path, ok: false, note: '这个文件没有被移走' });
        continue;
      }
      const res = await restoreFile(e);
      out.push({ path: e.path, ok: res.ok, note: res.note });
      if (res.ok) {
        e.status = 'restored';
        e.note = `${res.note ?? '已恢复'}（${new Date().toLocaleString('zh-CN', { hour12: false })}）`;
      }
    }
    this.persist(run);
    this.logger?.info({ runId, restored: out.filter((r) => r.ok).length, failed: out.filter((r) => !r.ok).length }, 'housekeeping: restore');
    return out;
  }
}

let instance: HousekeepingService | null = null;

export function initHousekeeping(logger?: Logger, botsConfigPath?: string, opts: ServiceOptions = {}): HousekeepingService {
  if (!instance) instance = new HousekeepingService(logger, botsConfigPath, opts);
  return instance;
}

export function housekeepingService(): HousekeepingService {
  return instance ?? initHousekeeping();
}

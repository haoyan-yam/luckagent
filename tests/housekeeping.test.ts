import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/housekeeping/glob.js';
import { readZipEntries } from '../src/housekeeping/zip-index.js';
import { defaultConfig, validateConfig, type HousekeepingConfig } from '../src/housekeeping/config.js';
import { archiveTargetStatus } from '../src/housekeeping/actions.js';
import { HousekeepingService, localArchiveIndexPath, seriesKey } from '../src/housekeeping/service.js';
import { emptyProtection, extractPathRefs, protectFromScripts } from '../src/housekeeping/protect.js';
import { claudeProjectsDir } from '../src/engines/claude/session-lister.js';

const DAY = 86_400_000;
/**
 * Age is max(mtime, ctime) and ctime can't be set, so tests run the service's
 * clock 60 days ahead and set mtimes relative to that: a file "10 days old"
 * gets mtime = NOW - 10d (still after its real ctime), a fresh one mtime = NOW.
 */
const NOW = Date.now() + 60 * DAY;
const clock = { now: () => NOW };
function age(file: string, days: number): void {
  const t = new Date(NOW - days * DAY);
  utimesSync(file, t, t);
}

/** Minimal "stored" zip writer; `gbk` writes names without the UTF-8 flag like Windows archivers do. */
function makeZip(file: string, entries: Array<{ name: string; data: Buffer }>, gbk = false): void {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = gbk ? Buffer.from(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2e, 0x74, 0x78, 0x74])) /* 中文.txt */ : Buffer.from(e.name, 'utf-8');
    const crc = crc32(e.data) >>> 0;
    const flags = gbk ? 0 : 0x800;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(e.data.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    locals.push(lh, name, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(e.data.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([...locals, cd, eocd]));
}

function put(file: string, content: string | Buffer, ageDays = 0): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  age(file, ageDays);
}

describe('globToRegExp', () => {
  it('handles **, *, braces and is case-insensitive', () => {
    const r = globToRegExp('*/work/**/*.pkl');
    expect(r.test('sephora/work/a.pkl')).toBe(true);
    expect(r.test('sephora/work/x/y/A.PKL')).toBe(true);
    expect(r.test('sephora/inputs/a.pkl')).toBe(false);
    expect(r.test('a/b/work/a.pkl')).toBe(false);
    expect(globToRegExp('**/*.{ttf,otf}').test('a/b/F.TTF')).toBe(true);
    expect(globToRegExp('**/*.zip').test('x.zip')).toBe(true);
    expect(globToRegExp('*/inputs/**').test('p/inputs/a/b.mp4')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });
});

describe('readZipEntries', () => {
  let d: string;
  beforeEach(() => (d = mkdtempSync(join(tmpdir(), 'hk-zip-'))));
  afterEach(() => rmSync(d, { recursive: true, force: true }));

  it('reads utf-8 and GBK names with size and crc', () => {
    makeZip(join(d, 'a.zip'), [{ name: '素材/一.txt', data: Buffer.from('hello') }]);
    expect(readZipEntries(join(d, 'a.zip'))).toEqual([{ name: '素材/一.txt', size: 5, crc32: crc32(Buffer.from('hello')) >>> 0 }]);
    makeZip(join(d, 'b.zip'), [{ name: '', data: Buffer.from('x') }], true);
    expect(readZipEntries(join(d, 'b.zip'))?.[0].name).toBe('中文.txt');
  });

  it('returns null for non-zips', () => {
    put(join(d, 'c.zip'), 'not a zip');
    expect(readZipEntries(join(d, 'c.zip'))).toBeNull();
  });
});

describe('extractPathRefs', () => {
  it('reads code spans with spaces, bare tokens, and trims punctuation', () => {
    const refs = extractPathRefs(
      '母本存 `inputs/233 Credentials 202603 for SAM.pptx`。脚本 work/trunk/duo2.py，参考 ~/projects/sams/outputs/a.potx）',
    );
    expect(refs).toEqual(expect.arrayContaining(['inputs/233 Credentials 202603 for SAM.pptx', 'work/trunk/duo2.py', '~/projects/sams/outputs/a.potx']));
    expect(refs.some((r) => r.startsWith('inputs/233 Credentials') && r !== 'inputs/233 Credentials 202603 for SAM.pptx')).toBe(false);
  });
});

describe('validateConfig', () => {
  it('accepts the defaults', () => {
    expect(validateConfig(defaultConfig()).ok).toBe(true);
  });

  it('work media rule only takes bulky types and never code, fonts or data files', () => {
    const rule = defaultConfig().rules.find((r) => r.id === 'work-media')!;
    const inc = rule.include.map(globToRegExp);
    const exc = rule.exclude.map(globToRegExp);
    const hit = (p: string) => inc.some((r) => r.test(p)) && !exc.some((r) => r.test(p));
    for (const p of ['sep/work/a.png', 'sep/work/t/x/B.JPG', 'sep/work/d.pptx', 'sep/work/v.mp4', 'sep/work/r.pdf']) expect(hit(p)).toBe(true);
    for (const p of ['sep/work/run.py', 'sep/work/f.ttf', 'sep/work/cfg.json', 'sep/work/d.xlsx', 'sep/work/a.pkl', 'sep/inputs/a.png', 'sep/work/app/node_modules/x/logo.png']) {
      expect(hit(p)).toBe(false);
    }
    const pkl = defaultConfig().rules.find((r) => r.id === 'work-pkl')!.include.map(globToRegExp);
    expect(pkl.some((r) => r.test('sep/work/x/a.npy'))).toBe(true);
  });

  it('validates alert recipients: people by open_id, chats by chat_id; old chatId still read', () => {
    const base = defaultConfig();
    const ok = validateConfig({ ...base, alert: { enabled: true, bot: 'b', recipients: [{ type: 'user', id: 'ou_1', name: 'x' }, { type: 'chat', id: 'oc_2' }, { type: 'user', id: 'ou_1' }], minFreeGB: 10 } });
    expect(ok.ok && ok.config.alert.recipients).toEqual([{ type: 'user', id: 'ou_1', name: 'x' }, { type: 'chat', id: 'oc_2' }]);
    expect(validateConfig({ ...base, alert: { enabled: true, bot: 'b', recipients: [{ type: 'user', id: 'oc_2' }] } }).ok).toBe(false);
    expect(validateConfig({ ...base, alert: { enabled: true, bot: 'b', recipients: [] } }).ok).toBe(false);
    const legacy = validateConfig({ ...base, alert: { enabled: true, bot: 'b', chatId: 'oc_9' } });
    expect(legacy.ok && legacy.config.alert.recipients).toEqual([{ type: 'chat', id: 'oc_9' }]);
  });

  it('rejects dangerous roots, bad cron and zero-day rules', () => {
    const base = defaultConfig();
    const bad = (patch: Partial<HousekeepingConfig['rules'][0]>, extra: Partial<HousekeepingConfig> = {}) =>
      validateConfig({ ...base, ...extra, rules: [{ ...base.rules[0], ...patch }] });
    expect(bad({ root: '~' })).toMatchObject({ ok: false });
    expect(bad({ root: '/etc' })).toMatchObject({ ok: false });
    expect(bad({ root: '~/Library/Caches' })).toMatchObject({ ok: false });
    expect(bad({ root: 'projects' })).toMatchObject({ ok: false });
    expect(bad({ minAgeDays: 0 })).toMatchObject({ ok: false });
    expect(bad({ include: [] })).toMatchObject({ ok: false });
    expect(bad({}, { schedule: { enabled: true, cron: 'nope' } })).toMatchObject({ ok: false });
    expect(bad({ root: '~/projects' }, { archiveRoot: '~/projects/archive' })).toMatchObject({ ok: false });
  });
});

describe('HousekeepingService run', () => {
  let home: string;
  let oldHome: string | undefined;
  let oldStore: string | undefined;
  let oldBots: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hk-home-'));
    oldHome = process.env.HOME;
    oldStore = process.env.SESSION_STORE_DIR;
    process.env.HOME = home;
    process.env.SESSION_STORE_DIR = join(home, '.luckagent');
    oldBots = process.env.BOTS_CONFIG;
    process.env.BOTS_CONFIG = join(home, 'bots.json');
    put(join(home, 'bots.json'), JSON.stringify({ feishuBots: [{ name: 'sepbot', defaultWorkingDirectory: join(home, 'projects/sep') }] }));
  });
  afterEach(() => {
    process.env.HOME = oldHome;
    if (oldBots === undefined) delete process.env.BOTS_CONFIG;
    else process.env.BOTS_CONFIG = oldBots;
    if (oldStore === undefined) delete process.env.SESSION_STORE_DIR;
    else process.env.SESSION_STORE_DIR = oldStore;
    rmSync(home, { recursive: true, force: true });
  });

  const cfg = (archiveRoot: string): HousekeepingConfig => ({
    schedule: { enabled: false, cron: '0 3 * * *' },
    archiveRoot,
    rules: [
      { id: 'pkl', name: 'pkl', enabled: true, kind: 'files', root: '~/projects', include: ['*/work/**/*.pkl'], exclude: [], minAgeDays: 7, minSizeMB: 0, action: 'archive' },
      { id: 'zip', name: 'zip', enabled: true, kind: 'extracted-zip', root: '~/projects', include: ['**/*.zip'], exclude: ['*/outputs/**'], minAgeDays: 1, minSizeMB: 0, action: 'trash' },
      { id: 'codex', name: 'codex', enabled: true, kind: 'codex-exec-sessions', root: '~/.codex/sessions', include: ['**/*.jsonl'], exclude: [], minAgeDays: 1, minSizeMB: 0, action: 'trash' },
    ],
  });

  function seed(): void {
    put(join(home, 'projects/sep/work/old.pkl'), 'OLD', 10);
    put(join(home, 'projects/sep/work/new.pkl'), 'NEW', 1);
    put(join(home, 'projects/sep/inputs/x/a.txt'), 'aaa', 5);
    makeZip(join(home, 'projects/sep/inputs/done.zip'), [
      { name: 'x/a.txt', data: Buffer.from('aaa') },
      { name: '__MACOSX/._a.txt', data: Buffer.from('junk') },
    ]);
    makeZip(join(home, 'projects/sep/inputs/partial.zip'), [{ name: 'b.txt', data: Buffer.from('bbb') }]);
    makeZip(join(home, 'projects/sep/outputs/deliver.zip'), [{ name: 'x/a.txt', data: Buffer.from('aaa') }]);
    for (const f of ['done.zip', 'partial.zip']) {
      age(join(home, 'projects/sep/inputs', f), 5);
    }
    age(join(home, 'projects/sep/outputs/deliver.zip'), 5);
    put(join(home, '.codex/sessions/2026/10/a.jsonl'), '{"payload":{"originator":"codex_exec"}}\n', 3);
    put(join(home, '.codex/sessions/2026/10/b.jsonl'), '{"payload":{"originator":"codex-tui"}}\n', 3);
  }

  it('dry run lists matches and touches nothing', async () => {
    seed();
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(join(home, 'Volumes-NAS')));
    const run = await svc.run({ trigger: 'manual', dryRun: true });
    expect(run.status).toBe('done');
    const byRule = Object.fromEntries(run.rules.map((r) => [r.id, r.matched]));
    expect(byRule).toEqual({ pkl: 1, zip: 1, codex: 1 });
    expect(run.entries.map((e) => e.path.replace(home, ''))).toEqual([
      '/projects/sep/work/old.pkl',
      '/projects/sep/inputs/done.zip',
      '/.codex/sessions/2026/10/a.jsonl',
    ]);
    expect(existsSync(join(home, 'projects/sep/work/old.pkl'))).toBe(true);
    expect(svc.listRuns()[0]).toMatchObject({ id: run.id, dryRun: true });
  });

  it('archives with verification, trashes, and logs everything', async () => {
    seed();
    const archive = join(home, 'archive');
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(archive));
    const run = await svc.run({ trigger: 'manual', dryRun: false });
    expect(run.totals).toMatchObject({ matched: 3, done: 3, errors: 0 });
    // archived: gone locally, identical copy mirrored under the archive root
    expect(existsSync(join(home, 'projects/sep/work/old.pkl'))).toBe(false);
    expect(readFileSync(join(archive, 'projects/sep/work/old.pkl'), 'utf-8')).toBe('OLD');
    expect(readFileSync(join(archive, '归档清单.tsv'), 'utf-8')).toContain('projects/sep/work/old.pkl');
    // trashed: moved into a per-run folder in ~/.Trash
    expect(existsSync(join(home, 'projects/sep/inputs/done.zip'))).toBe(false);
    const trash = readdirSync(join(home, '.Trash'));
    expect(trash).toHaveLength(1);
    expect(readdirSync(join(home, '.Trash', trash[0])).sort()).toEqual([
      '.codex__sessions__2026__10__a.jsonl',
      'projects__sep__inputs__done.zip',
    ]);
    // untouched
    for (const f of ['projects/sep/work/new.pkl', 'projects/sep/inputs/partial.zip', 'projects/sep/outputs/deliver.zip', '.codex/sessions/2026/10/b.jsonl']) {
      expect(existsSync(join(home, f))).toBe(true);
    }
    const stored = svc.getRun(run.id)!;
    expect(stored.entries.every((e) => e.status === 'archived' || e.status === 'trashed')).toBe(true);
    expect(stored.entries[0].sha1).toMatch(/^[0-9a-f]{40}$/);
  });

  it('never touches files or long-lived dirs that bot memory references', async () => {
    seed();
    put(join(home, 'projects/sep/work/brand.pkl'), 'BRAND', 30);
    put(join(home, 'projects/sep/work/ref/sample.pkl'), 'REF', 30);
    put(join(home, 'projects/sep/work/task1/x.pkl'), 'TASK', 30);
    const mem = join(claudeProjectsDir(join(home, 'projects/sep')), 'memory');
    put(join(mem, 'deliverable-brand.md'), '---\nname: b\n---\n品牌规范原件 `work/brand.pkl`，必须遵守。');
    put(join(mem, 'spec-ref.md'), '---\nname: s\n---\n样本目录 `work/ref/`');
    put(join(mem, 'project-old.md'), '---\nname: p\n---\n过程在 work/task1/ 里，缓存 `work/old.pkl`');
    const archive = join(home, 'archive');
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(archive));
    const run = await svc.run({ trigger: 'manual', dryRun: false });
    expect(existsSync(join(home, 'projects/sep/work/brand.pkl'))).toBe(true);
    expect(existsSync(join(home, 'projects/sep/work/ref/sample.pkl'))).toBe(true);
    // a project log mentioning a task dir does not protect the whole dir
    expect(existsSync(join(home, 'projects/sep/work/task1/x.pkl'))).toBe(false);
    const pkl = run.rules.find((r) => r.id === 'pkl')!;
    expect(pkl.protected).toBe(2);
    expect(run.entries.filter((e) => e.status === 'protected').map((e) => e.note)).toEqual(
      expect.arrayContaining([expect.stringContaining('deliverable-brand'), expect.stringContaining('spec-ref')]),
    );
  });

  it('refuses to delete anything when bots.json is unreadable', async () => {
    seed();
    process.env.BOTS_CONFIG = join(home, 'missing.json');
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(join(home, 'archive')));
    const run = await svc.run({ trigger: 'manual', dryRun: false });
    expect(run.status).toBe('failed');
    expect(existsSync(join(home, 'projects/sep/work/old.pkl'))).toBe(true);
  });

  it('judges age by max(mtime, ctime): unzipped / cp -p material that just arrived is not "old"', async () => {
    seed();
    // real clock: every seeded file was created moments ago, whatever its mtime says
    const svc = new HousekeepingService(undefined, undefined);
    svc.saveConfig(cfg(join(home, 'archive')));
    const run = await svc.run({ trigger: 'manual', dryRun: true });
    expect(run.totals.matched).toBe(0);
  });

  it('keeps the newest file of a series so rolling baselines survive', async () => {
    seed();
    put(join(home, 'projects/sep/work/arc/_arc_master_0831_1101.pkl'), 'A', 20);
    put(join(home, 'projects/sep/work/arc/_arc_master_0831_1108.pkl'), 'B', 10);
    put(join(home, 'projects/sep/work/roll/m_1001.pkl'), 'C', 20);
    put(join(home, 'projects/sep/work/roll/m_1008.pkl'), 'D', 10);
    put(join(home, 'projects/sep/work/roll/m_1015.pkl'), 'E', 2); // newest is still fresh
    put(join(home, 'projects/sep/work/task9/T.pkl'), 'F', 20); // a one-off, not a series
    put(join(home, 'projects/sep/work/hist/_m_1108.pkl'), 'G', 20); // alone now, but 1101 was archived before
    put(localArchiveIndexPath(), `归档时间\t批次\t大小\tsha1\t原路径\t硬盘位置\nx\tb\t1\ts\t${join(home, 'projects/sep/work/hist/_m_1101.pkl')}\t/nas/x\n`);
    const c = cfg(join(home, 'archive'));
    c.rules[0].keepLatestPerSeries = true;
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(c);
    const run = await svc.run({ trigger: 'manual', dryRun: true, ruleIds: ['pkl'] });
    const st = Object.fromEntries(run.entries.map((e) => [e.path.replace(home + '/projects/sep/work/', ''), e.status]));
    expect(st['arc/_arc_master_0831_1101.pkl']).toBe('pending');
    expect(st['arc/_arc_master_0831_1108.pkl']).toBe('protected');
    expect(st['roll/m_1001.pkl']).toBe('pending');
    expect(st['roll/m_1008.pkl']).toBe('pending');
    expect(st['task9/T.pkl']).toBe('pending');
    expect(st['hist/_m_1108.pkl']).toBe('protected');
    expect(seriesKey('/a/_arc_master_0831_1108.pkl')).toBe(seriesKey('/a/_arc_master_0831_1101.pkl'));
  });

  it('protects files named by project skills', async () => {
    seed();
    put(join(home, 'projects/sep/work/tpl.pptx'), 'TPL', 40);
    put(join(home, 'projects/sep/.claude/skills/report/SKILL.md'), '模板用 `work/tpl.pptx`');
    const c = cfg(join(home, 'archive'));
    c.rules.push({ id: 'media', name: 'media', enabled: true, kind: 'files', root: '~/projects', include: ['*/work/**/*.pptx'], exclude: [], minAgeDays: 30, minSizeMB: 0, action: 'archive' });
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(c);
    const run = await svc.run({ trigger: 'manual', dryRun: true, ruleIds: ['media'] });
    expect(run.entries[0]).toMatchObject({ status: 'protected', note: expect.stringContaining('技能 report') });
  });

  it('archives into a local cumulative index too, and restores with verification', async () => {
    seed();
    const archive = join(home, 'archive');
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(archive));
    const run = await svc.run({ trigger: 'manual', dryRun: false });
    expect(readFileSync(localArchiveIndexPath(), 'utf-8')).toContain('projects/sep/work/old.pkl');
    const pkl = join(home, 'projects/sep/work/old.pkl');
    const zip = join(home, 'projects/sep/inputs/done.zip');
    const res = await svc.restore(run.id, [pkl, zip]);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(readFileSync(pkl, 'utf-8')).toBe('OLD');
    expect(existsSync(zip)).toBe(true);
    expect(svc.getRun(run.id)!.entries.filter((e) => e.status === 'restored')).toHaveLength(2);
    // a second restore never overwrites
    expect((await svc.restore(run.id, [pkl]))[0]).toMatchObject({ ok: false });
  });

  it('sends a notice only for real problems, and low-disk at most once a day', async () => {
    seed();
    const sent: string[] = [];
    const to: string[] = [];
    const notify = async (_b: string, r: { id: string }, title: string) => {
      to.push(r.id);
      sent.push(title);
    };
    const svc = new HousekeepingService(undefined, undefined, { ...clock, notify });
    const c = cfg('/Volumes/__hk_test_missing__/archive');
    c.alert = { enabled: true, bot: 'sepbot', recipients: [{ type: 'user', id: 'ou_roy' }, { type: 'chat', id: 'oc_ops' }], minFreeGB: 0.000001 };
    svc.saveConfig(c);
    await svc.run({ trigger: 'manual', dryRun: true });
    expect(sent).toHaveLength(0); // previews never alert
    const run = await svc.run({ trigger: 'schedule', dryRun: false });
    expect(to).toEqual(['ou_roy', 'oc_ops']); // every recipient gets it
    sent.length = 0;
    expect(run.warnings?.[0]).toMatch(/没有执行/);
    c.alert.minFreeGB = 1e9; // way above any real disk
    svc.saveConfig(c);
    expect(await svc.checkDisk()).toBe(true);
    expect(await svc.checkDisk()).toBe(false);
    expect(sent).toHaveLength(2); // one low-disk notice, to both recipients
  });

  it('previews get their own id space so they never push real runs out', async () => {
    seed();
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg(join(home, 'archive')));
    const p = await svc.run({ trigger: 'manual', dryRun: true });
    const r = await svc.run({ trigger: 'manual', dryRun: false });
    expect(p.id.startsWith('p-')).toBe(true);
    expect(r.id.startsWith('p-')).toBe(false);
    // the list reads small summary files only, never the entries
    const listed = svc.listRuns();
    expect(listed.map((x) => x.id).sort()).toEqual([p.id, r.id].sort());
    expect((listed[0] as unknown as { entries?: unknown }).entries).toBeUndefined();
    expect(svc.getRun(r.id)!.entries.length).toBeGreaterThan(0);
  });

  it('skips archive rules when the drive is not mounted', async () => {
    seed();
    const svc = new HousekeepingService(undefined, undefined, clock);
    svc.saveConfig(cfg('/Volumes/__hk_test_missing__/archive'));
    const run = await svc.run({ trigger: 'manual', dryRun: false });
    expect(run.rules.find((r) => r.id === 'pkl')?.skippedReason).toMatch(/没有接上|没有挂载/);
    expect(existsSync(join(home, 'projects/sep/work/old.pkl'))).toBe(true);
    expect(archiveTargetStatus('').ok).toBe(false);
  });
});

describe('feishu download index', () => {
  it('appends one line per download with a header, and bookkeeping files are never archived', async () => {
    const { recordFeishuDownload } = await import('../src/feishu/download-index.js');
    const { isBookkeeping } = await import('../src/housekeeping/scan.js');
    const d = mkdtempSync(join(tmpdir(), 'hk-idx-'));
    try {
      recordFeishuDownload(join(d, 'file_v3_a_报价.xlsx'), 'om_1', 'file_v3_a', 'file');
      recordFeishuDownload(join(d, 'img.png'), 'om_2', 'img_v3_b', 'image');
      const lines = readFileSync(join(d, '.feishu-index.tsv'), 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[1].split('\t').slice(1)).toEqual(['file_v3_a_报价.xlsx', 'om_1', 'file_v3_a', 'file']);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
    expect(isBookkeeping('sep/inputs/.feishu-index.tsv')).toBe(true);
    expect(isBookkeeping('_已归档到外置硬盘NAS_20261104.tsv')).toBe(true);
    expect(isBookkeeping('sep/inputs/data.tsv')).toBe(false);
  });
});

describe('feishu send index (outputs)', () => {
  it('indexes a sent file against its outputs archive copy, and skips files with no copy', async () => {
    const { recordFeishuSend } = await import('../src/feishu/download-index.js');
    const wd = mkdtempSync(join(tmpdir(), 'hk-out-'));
    try {
      put(join(wd, 'outputs/20261112-报告.pptx'), 'PPTX');
      put(join(wd, 'outputs/sub/图.png'), 'PNG!!');
      const base = { workDir: wd, messageId: 'om_1', mediaKey: 'file_v3_x', kind: 'file', chatId: 'oc_1' };
      expect(recordFeishuSend({ ...base, fileName: '20261112-报告.pptx', fileSize: 4 })).toBe(join(wd, 'outputs/20261112-报告.pptx'));
      expect(recordFeishuSend({ ...base, messageId: 'om_2', fileName: '图.png', fileSize: 5 })).toBe(join(wd, 'outputs/sub/图.png'));
      expect(recordFeishuSend({ ...base, messageId: 'om_3', fileName: '图.png', fileSize: 999 })).toBeNull(); // size differs
      expect(recordFeishuSend({ ...base, messageId: 'om_4', fileName: '没留档.pdf', fileSize: 1 })).toBeNull();
      const lines = readFileSync(join(wd, 'outputs/.feishu-index.tsv'), 'utf-8').trim().split('\n');
      expect(lines.slice(1).map((l) => l.split('\t').slice(1, 3))).toEqual([
        ['20261112-报告.pptx', 'om_1'],
        ['sub/图.png', 'om_2'],
      ]);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

describe('protectFromScripts', () => {
  it('only active scripts pin the files they open, and never caches', () => {
    const wd = mkdtempSync(join(tmpdir(), 'hk-scr-'));
    try {
      put(join(wd, 'work/t1/base.png'), 'PNG');
      put(join(wd, 'work/t1/cache.pkl'), 'PKL');
      put(join(wd, 'work/t1/run.py'), 'from PIL import Image\nImage.open("base.png")\nload("cache.pkl")\nf"{x}.png"\n');
      const p1 = emptyProtection();
      protectFromScripts(p1, wd, 'bot', NOW);
      expect([...p1.files.keys()]).toEqual([join(wd, 'work/t1/base.png')]);
      const p2 = emptyProtection();
      protectFromScripts(p2, wd, 'bot', NOW + 100 * DAY); // script untouched for 100 days
      expect(p2.files.size).toBe(0);
    } finally {
      rmSync(wd, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseIndexLine, parseMemoryFrontmatter, readBotMemory, searchMemories, stripFrontmatter } from '../src/api/memory-view.js';

let dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'memory-view-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('parseMemoryFrontmatter', () => {
  it('reads name/description and a type nested under metadata', () => {
    const md = '---\nname: echo-prefs\ndescription: "CMO Echo 的审美偏好"\nmetadata:\n  type: feedback\n---\n\n正文';
    expect(parseMemoryFrontmatter(md)).toEqual({ name: 'echo-prefs', description: 'CMO Echo 的审美偏好', type: 'feedback' });
  });

  it('reads a top-level type and ignores nested name/description keys', () => {
    const md = "---\nname: a\ntype: 'project'\nmetadata:\n  name: nested\n---\nbody";
    expect(parseMemoryFrontmatter(md)).toEqual({ name: 'a', description: '', type: 'project' });
  });

  it('returns null without frontmatter', () => {
    expect(parseMemoryFrontmatter('# 标题\n正文')).toBeNull();
  });

  it('strips frontmatter for the body', () => {
    expect(stripFrontmatter('---\nname: a\n---\n\n# 标题\n正文')).toBe('# 标题\n正文');
    expect(stripFrontmatter('# 无头\n')).toBe('# 无头\n');
  });
});

describe('parseIndexLine', () => {
  it('accepts marker prefixes and takes the text after the link as the hook', () => {
    expect(parseIndexLine('- ⭐⭐ [串词反馈](chuanci.md) — 写串词前必读')).toEqual([{ title: '串词反馈', file: 'chuanci.md', hook: '写串词前必读' }]);
    expect(parseIndexLine('- [无钩子](./bare.md)')).toEqual([{ title: '无钩子', file: 'bare.md', hook: '' }]);
    expect(parseIndexLine('# Memory Index')).toEqual([]);
  });

  it('gives every link on a grouped or table line the flattened line as hook', () => {
    const out = parseIndexLine('- 8月日报：[0831](d-0831.md)口径定版 ｜ [0828](d-0828.md)适配表缺失');
    expect(out.map((e) => e.file)).toEqual(['d-0831.md', 'd-0828.md']);
    expect(out[0].hook).toBe('8月日报：0831口径定版 ｜ 0828适配表缺失');
    const row = parseIndexLine('| **写串词** | `ufs-share` | [小优风格](voice.md)、[口吻](tone.md) |');
    expect(row.map((e) => e.title)).toEqual(['小优风格', '口吻']);
    expect(row[0].hook).toBe('写串词 | ufs-share | 小优风格、口吻 |');
  });
});

describe('readBotMemory', () => {
  it('reports a missing directory', () => {
    expect(readBotMemory(join(tmpdir(), 'definitely-missing-dir-xyz'))).toMatchObject({ exists: false, files: [] });
    expect(readBotMemory(null).exists).toBe(false);
  });

  it('lists indexed entries in order, then unindexed files; measures the index and each line', () => {
    const dir = tmp();
    const longHook = '很长的钩子'.repeat(40);
    writeFileSync(
      join(dir, 'MEMORY.md'),
      [
        '- [项目总览](overview.md) — 定位与负责人',
        `- [偏好](prefs.md) — ${longHook}`,
        '- [已删除](gone.md) — 文件不在了',
        '- [重复](overview.md) — 同一文件第二次出现',
        '- 日报：[a](day-a.md) ｜ [b](day-b.md)',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'overview.md'), '---\nname: overview\nmetadata:\n  type: project\n---\n内容');
    writeFileSync(join(dir, 'prefs.md'), '---\nname: prefs\ntype: feedback\n---\n内容');
    writeFileSync(join(dir, 'stray.md'), '没有 frontmatter');
    writeFileSync(join(dir, 'day-a.md'), 'a');
    writeFileSync(join(dir, 'day-b.md'), 'b');

    const v = readBotMemory(dir);
    expect(v.exists).toBe(true);
    expect(v.index).toEqual({ exists: true, lines: 5, chars: expect.any(Number) });
    expect(v.files.map((f) => [f.file, f.indexed, f.exists])).toEqual([
      ['overview.md', true, true],
      ['prefs.md', true, true],
      ['gone.md', true, false],
      ['day-a.md', true, true],
      ['day-b.md', true, true],
      ['stray.md', false, true],
    ]);
    // the grouped line's length is split between its two memories
    expect(v.files[3].lineChars).toBe(Math.round('- 日报：[a](day-a.md) ｜ [b](day-b.md)'.length / 2));
    expect(v.files[0]).toMatchObject({ title: '项目总览', hook: '定位与负责人', frontmatter: { type: 'project' } });
    expect(v.files[1].lineChars).toBeGreaterThan(200);
    expect(v.files[1].frontmatter?.type).toBe('feedback');
    expect(v.files[2]).toMatchObject({ sizeBytes: null, frontmatter: null });
    expect(v.files[5]).toMatchObject({ title: 'stray', lineChars: 0, frontmatter: null });
  });

  it('handles a directory without an index', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'a.md'), 'x');
    const v = readBotMemory(dir);
    expect(v.index).toEqual({ exists: false, lines: 0, chars: 0 });
    expect(v.files).toHaveLength(1);
  });
});

describe('searchMemories', () => {
  it('finds case-insensitive matches across bots with a snippet and count, skipping MEMORY.md', () => {
    const a = tmp();
    const b = tmp();
    writeFileSync(join(a, 'MEMORY.md'), '- [x](x.md) — Echo 在索引里');
    writeFileSync(join(a, 'x.md'), `${'前文'.repeat(40)}CMO echo 偏好：留白、绿植。ECHO 再次出现`);
    writeFileSync(join(b, 'y.md'), '无关内容');
    writeFileSync(join(b, 'z.md'), 'Echo');
    const { hits, truncated } = searchMemories([{ bot: 'A', memDir: a }, { bot: 'B', memDir: b }], ' Echo ');
    expect(truncated).toBe(false);
    expect(hits.map((h) => [h.bot, h.file, h.matches])).toEqual([
      ['A', 'x.md', 2],
      ['B', 'z.md', 1],
    ]);
    expect(hits[0].snippet.startsWith('…')).toBe(true);
    expect(hits[0].snippet).toContain('CMO echo 偏好');
  });

  it('returns nothing for a blank query and stops at the limit', () => {
    const a = tmp();
    for (const n of ['1', '2', '3']) writeFileSync(join(a, `${n}.md`), 'hit');
    expect(searchMemories([{ bot: 'A', memDir: a }], '   ').hits).toEqual([]);
    const r = searchMemories([{ bot: 'A', memDir: a }], 'hit', 2);
    expect(r.hits).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  it('picks up edits (mtime-keyed cache)', () => {
    const a = tmp();
    const f = join(a, 'm.md');
    writeFileSync(f, 'old text');
    expect(searchMemories([{ bot: 'A', memDir: a }], 'new').hits).toHaveLength(0);
    writeFileSync(f, 'new text, longer');
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(searchMemories([{ bot: 'A', memDir: a }], 'new').hits).toHaveLength(1);
  });
});

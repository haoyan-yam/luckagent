import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pm2StartupConfigured,
  scanSkillsDir,
  readSkillDescription,
  parseMemoryIndex,
  memoryDirCandidates,
  envCredentialState,
} from '../src/api/routes/admin-routes.js';

let dirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('scanSkillsDir', () => {
  it('lists dirs with kind/description; symlinks and git checkouts tagged', () => {
    const root = tmp('skills-');
    // plain skill with frontmatter description
    mkdirSync(join(root, 'alpha'));
    writeFileSync(join(root, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: 做 A 的技能\n---\n\n# Alpha\n');
    // git-checkout skill
    mkdirSync(join(root, 'beta', '.git'), { recursive: true });
    writeFileSync(join(root, 'beta', 'SKILL.md'), '# Beta\n\n正文第一段作为描述。\n');
    // symlinked skill (like npx skills add)
    const store = tmp('store-');
    mkdirSync(join(store, 'gamma'));
    writeFileSync(join(store, 'gamma', 'SKILL.md'), '---\ndescription: "linked skill"\n---\n');
    symlinkSync(join(store, 'gamma'), join(root, 'gamma'));
    // noise: plain file + dotdir are ignored
    writeFileSync(join(root, 'README.md'), 'x');
    mkdirSync(join(root, '.hidden'));

    const out = scanSkillsDir(root);
    expect(out.map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma']);
    const by = Object.fromEntries(out.map((s) => [s.name, s]));
    expect(by.alpha.kind).toBe('dir');
    expect(by.alpha.description).toBe('做 A 的技能');
    expect(by.beta.kind).toBe('git');
    expect(by.beta.description).toBe('正文第一段作为描述。');
    expect(by.gamma.kind).toBe('symlink');
    expect(by.gamma.description).toBe('linked skill');
  });

  it('returns [] for a missing root', () => {
    expect(scanSkillsDir('/nonexistent/skills')).toEqual([]);
  });
});

describe('readSkillDescription', () => {
  it('empty when no SKILL.md', () => {
    const d = tmp('nodesc-');
    expect(readSkillDescription(d)).toBe('');
  });
});

describe('parseMemoryIndex', () => {
  it('parses em-dash, hyphen and hookless entries; ignores non-entry lines', () => {
    const raw = [
      '# Memory Index',
      '',
      '- [提取项目](luckagent-extraction.md) — 0825 全新脱敏仓库',
      '- [代理坑](shell-proxy.md) - env -u 清代理',
      '- [无钩子](bare.md)',
      '普通一行不是条目',
      '  - [缩进也认](indent.md) — 钩子',
    ].join('\n');
    const out = parseMemoryIndex(raw);
    expect(out).toEqual([
      { title: '提取项目', file: 'luckagent-extraction.md', hook: '0825 全新脱敏仓库' },
      { title: '代理坑', file: 'shell-proxy.md', hook: 'env -u 清代理' },
      { title: '无钩子', file: 'bare.md', hook: '' },
      { title: '缩进也认', file: 'indent.md', hook: '钩子' },
    ]);
  });
});

describe('memoryDirCandidates', () => {
  it('munges the workdir path into ~/.claude/projects candidates', () => {
    const cands = memoryDirCandidates('/Users/metabot/projects/larkmetabot');
    expect(cands[0]).toContain('/.claude/projects/-Users-metabot-projects-larkmetabot/memory');
  });
  it('a dotted path yields a second dot-munged candidate', () => {
    const cands = memoryDirCandidates('/srv/app.v2');
    expect(cands.some((c) => c.includes('-srv-app-v2'))).toBe(true);
  });
});

describe('envCredentialState (密钥三态)', () => {
  it('live: process env set and disk agrees (or absent from disk)', () => {
    expect(envCredentialState('sk-live-abcd', 'sk-live-abcd')).toEqual({ set: true, tail: 'abcd' });
    expect(envCredentialState('sk-live-abcd', undefined)).toEqual({ set: true, tail: 'abcd' });
  });
  it('pending: key added to .env but bridge not restarted', () => {
    expect(envCredentialState(undefined, 'sk-cp-new-wxyz')).toEqual({ set: true, tail: 'wxyz', pending: true });
  });
  it('pending: key rotated on disk — tail shows the incoming value', () => {
    expect(envCredentialState('sk-old-aaaa', 'sk-new-bbbb')).toEqual({ set: true, tail: 'bbbb', pending: true });
  });
  it('unset: neither source has a value (blank strings count as unset)', () => {
    expect(envCredentialState(undefined, undefined)).toEqual({ set: false });
    expect(envCredentialState('  ', '')).toEqual({ set: false });
  });
});

describe('pm2StartupConfigured', () => {
  it('true only when a pm2 plist exists in a launchd dir', () => {
    const a = tmp('la-'); const b = tmp('ld-');
    expect(pm2StartupConfigured([a, b])).toBe(false);
    writeFileSync(join(a, 'pm2.metabot.plist'), 'x');
    expect(pm2StartupConfigured([a, b])).toBe(true);
    expect(pm2StartupConfigured(['/nonexistent'])).toBe(false);
  });
});

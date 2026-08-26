import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installSkillsToWorkDir } from '../src/api/skills-installer.js';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
} as any;

let cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

describe('skills installer', () => {
  it('mirrors bundled skills into the Claude project directory and deploys AGENTS.md', async () => {
    const priorHome = process.env.HOME;
    const home = tempDir('luckagent-home-');
    const workDir = tempDir('luckagent-work-');
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.claude/skills'), { recursive: true });

      await installSkillsToWorkDir(workDir, logger);

      // `luckagent` is in the default COMMON_SKILLS list, so its bundled SKILL.md
      // must land in the Claude project directory.
      expect(readFileSync(join(workDir, '.claude/skills/luckagent/SKILL.md'), 'utf-8')).toContain('luckagent');
      // .codex mirroring is gone with the codex engine.
      expect(existsSync(join(workDir, '.codex'))).toBe(false);
      // [design-note M] 工作区模板换成了本地初始模板，断言改为对模板标题不敏感的关键词
      expect(readFileSync(join(workDir, 'AGENTS.md'), 'utf-8')).toContain('Luckagent');

      // Only the bundled common skills are deployed — nothing extra slips in.

      // `metamemory` and `skill-hub` now live in luckagent-core and are NOT
      // bundled here. Confirm the install does not produce them.
      expect(() => readFileSync(join(workDir, '.claude/skills/metamemory/SKILL.md'), 'utf-8')).toThrow();
      expect(() => readFileSync(join(workDir, '.claude/skills/skill-hub/SKILL.md'), 'utf-8')).toThrow();
      // frontend-slides is in COMMON_SKILLS but absent from this fake HOME —
      // it must be skipped silently, not fail the install.
      expect(() => readFileSync(join(workDir, '.claude/skills/frontend-slides/SKILL.md'), 'utf-8')).toThrow();
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});

describe('third-party frontend-slides skill', () => {
  it('mirrors the global copy into bot workdirs without its .git history', async () => {
    const priorHome = process.env.HOME;
    const home = tempDir('luckagent-home-');
    const workDir = tempDir('luckagent-work-');
    try {
      process.env.HOME = home;
      const fsSkill = join(home, '.claude/skills/frontend-slides');
      mkdirSync(join(fsSkill, '.git'), { recursive: true });
      writeFileSync(join(fsSkill, 'SKILL.md'), '# frontend-slides\nHTML presentations');
      writeFileSync(join(fsSkill, '.git', 'HEAD'), 'ref: refs/heads/main');

      await installSkillsToWorkDir(workDir, logger);

      for (const root of ['.claude/skills']) {
        expect(readFileSync(join(workDir, root, 'frontend-slides/SKILL.md'), 'utf-8')).toContain('frontend-slides');
        expect(existsSync(join(workDir, root, 'frontend-slides/.git'))).toBe(false);
      }
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
    }
  });
});

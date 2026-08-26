import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  it('scaffolds the workspace (empty skills dir + AGENTS.md) without copying shared skills', async () => {
    const priorHome = process.env.HOME;
    const home = tempDir('luckagent-home-');
    const workDir = tempDir('luckagent-work-');
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.claude/skills'), { recursive: true });

      await installSkillsToWorkDir(workDir, logger);

      // Shared skills are NOT copied per bot any more — sessions load them
      // from the user-level ~/.claude/skills. The project-level dir exists,
      // empty, reserved for bot-specific custom skills.
      expect(existsSync(join(workDir, '.claude/skills'))).toBe(true);
      expect(existsSync(join(workDir, '.claude/skills/luckagent'))).toBe(false);
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

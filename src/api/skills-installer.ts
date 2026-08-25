import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { execFileSync } from 'node:child_process';
import type { Logger } from '../utils/logger.js';

/** Skills installed for all bots.
 *
 *  Not in this list (opt-in only, sources under src/skills/):
 *   - `metaskill`     — agent-team generator.
 *   - `metaschedule`  — persistent server-side scheduler skill (ad-hoc
 *                       scheduling is covered by Claude Code's native
 *                       `CronCreate` / `/loop`).
 */
const COMMON_SKILLS = ['luckagent'];

/** Lark CLI AI Agent skills — installed via `npx skills add larksuite/cli` and
 *  symlinked into ~/.claude/skills/ automatically. We copy them to the bot
 *  working directory so they are available in the Claude Code session. */
const LARK_CLI_SKILLS = [
  'lark-base', 'lark-calendar', 'lark-contact', 'lark-doc', 'lark-drive',
  'lark-event', 'lark-im', 'lark-mail', 'lark-minutes', 'lark-openapi-explorer',
  'lark-shared', 'lark-sheets', 'lark-skill-maker', 'lark-task', 'lark-vc',
  'lark-whiteboard', 'lark-wiki', 'lark-workflow-meeting-summary',
  'lark-workflow-standup-report',
];

export interface InstallSkillsOptions {
  /** Bot platform — feishu-only skills are skipped for other platforms. */
  platform?: 'feishu';
  /** Feishu app credentials for lark-cli auto-config (feishu only). */
  feishuAppId?: string;
  feishuAppSecret?: string;
  /** Bot name — used as the lark-cli profile name (`--profile <botName>`). */
  botName?: string;
}

export function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): void {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillDirs = [
    path.join(workDir, '.claude', 'skills'),
    path.join(workDir, '.codex', 'skills'),
  ];

  const skillNames = options?.platform === 'feishu'
    ? [...COMMON_SKILLS, ...LARK_CLI_SKILLS]
    : COMMON_SKILLS;

  for (const skill of skillNames) {
    const src = fs.existsSync(path.join(userSkillsDir, skill))
      ? path.join(userSkillsDir, skill)
      : bundledSkillSource(skill);

    if (!src || !fs.existsSync(src)) {
      logger.debug({ skill }, 'Skill source not found, skipping');
      continue;
    }

    for (const destSkillsDir of destSkillDirs) {
      const dest = path.join(destSkillsDir, skill);
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      logger.info({ skill, src, dest }, 'Skill installed to working directory');
    }
  }

  // For Feishu bots, ensure lark-cli has a profile for this app
  if (options?.platform === 'feishu' && options.feishuAppId && options.feishuAppSecret) {
    ensureLarkCliConfig(options.feishuAppId, options.feishuAppSecret, options.botName, logger);
  }

  deployWorkspaceInstructions(workDir, logger);
}

/**
 * True when ~/.lark-cli/config.json (or the given file) already carries an
 * app entry for this appId. Exported for tests.
 */
export function larkCliHasApp(configPath: string, appId: string): boolean {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as { apps?: Array<{ appId?: string }> };
    return (parsed.apps ?? []).some((a) => a.appId === appId);
  } catch {
    return false;
  }
}

/**
 * Ensure lark-cli has a profile for this Feishu app. Uses
 * `lark-cli config init --name <botName>` — the documented append-a-named-
 * profile mode — so a second/third bot gets its own profile instead of the
 * whole config being skipped. Idempotent: skipped when the appId is already
 * present in ~/.lark-cli/config.json. Best-effort: failures only warn.
 */
function ensureLarkCliConfig(appId: string, appSecret: string, botName: string | undefined, logger: Logger): void {
  const configPath = path.join(os.homedir(), '.lark-cli', 'config.json');
  if (larkCliHasApp(configPath, appId)) {
    logger.debug({ appId }, 'lark-cli already has this app, skipping');
    return;
  }

  // Find lark-cli binary
  const larkCliBin = findLarkCli();
  if (!larkCliBin) {
    logger.warn('lark-cli not found in PATH or ~/.npm-global/bin — skipping config. Run: npm install -g @larksuite/cli');
    return;
  }

  const args = ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', 'feishu'];
  if (botName) args.push('--name', botName);
  try {
    execFileSync(larkCliBin, args, {
      input: appSecret,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    logger.info({ appId, profile: botName }, 'lark-cli profile configured');
  } catch (err: any) {
    logger.warn(
      { err: err.message, appId },
      `Failed to configure lark-cli — run manually: lark-cli config init --app-id ${appId} --app-secret-stdin --brand feishu${botName ? ` --name ${botName}` : ''}`,
    );
  }
}

function deployWorkspaceInstructions(workDir: string, logger: Logger): void {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const existingClaudeMd = path.join(workDir, 'CLAUDE.md');
  for (const candidate of [
    path.join(thisDir, '..', 'workspace', 'CLAUDE.md'),
    path.join(thisDir, '..', '..', 'src', 'workspace', 'CLAUDE.md'),
  ]) {
    if (!fs.existsSync(candidate)) continue;

    copyInstructionFile(candidate, existingClaudeMd, 'CLAUDE.md', logger);
    copyInstructionFile(fs.existsSync(existingClaudeMd) ? existingClaudeMd : candidate, path.join(workDir, 'AGENTS.md'), 'AGENTS.md', logger);
    break;
  }

  // Shared conventions for ALL bot workspaces live one level up (the bots'
  // parent dir, e.g. ~/projects/CLAUDE.md). Deploy the template only when the
  // parent has no CLAUDE.md yet — never overwrite a customized one.
  const parentDir = path.dirname(workDir);
  const parentClaudeMd = path.join(parentDir, 'CLAUDE.md');
  if (!fs.existsSync(parentClaudeMd)) {
    for (const candidate of [
      path.join(thisDir, '..', 'workspace', 'PROJECTS-CLAUDE.md'),
      path.join(thisDir, '..', '..', 'src', 'workspace', 'PROJECTS-CLAUDE.md'),
    ]) {
      if (!fs.existsSync(candidate)) continue;
      try {
        fs.copyFileSync(candidate, parentClaudeMd);
        logger.info({ parentClaudeMd }, 'Deployed shared workspace conventions (PROJECTS-CLAUDE.md)');
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'Failed to deploy shared workspace conventions');
      }
      break;
    }
  }
}

function bundledSkillSource(skill: string): string | undefined {
  const thisFile = url.fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  const candidatesBySkill: Record<string, string[]> = {
    // metaskill / metaschedule are opt-in: not in COMMON_SKILLS, but bundled
    // here so users who copy them into `~/.claude/skills/` get the source
    // resolved correctly if they later install a bot with installSkills:true.
    metaskill: [
      path.join(thisDir, '..', 'skills', 'metaskill'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'metaskill'),
    ],
    metaschedule: [
      path.join(thisDir, '..', 'skills', 'metaschedule'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'metaschedule'),
    ],
    luckagent: [
      path.join(thisDir, '..', 'skills', 'luckagent'),
      path.join(thisDir, '..', '..', 'packages', 'skills', 'luckagent'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'luckagent'),
    ],
    voice: [
      path.join(thisDir, '..', 'skills', 'voice'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'voice'),
    ],
  };
  return candidatesBySkill[skill]?.find((candidate) => fs.existsSync(candidate));
}

function copyInstructionFile(src: string, dest: string, fileName: string, logger: Logger): void {
  if (fs.existsSync(dest)) return;
  try {
    fs.copyFileSync(src, dest);
    logger.info({ dest }, `${fileName} deployed to working directory`);
  } catch (err: any) {
    logger.warn({ err: err.message, src, dest }, `Failed to deploy ${fileName}`);
  }
}

/** Locate the lark-cli executable. */
function findLarkCli(): string | null {
  const candidates = [
    path.join(os.homedir(), '.npm-global', 'bin', 'lark-cli'),
    '/usr/local/bin/lark-cli',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Try PATH via which
  try {
    const result = execFileSync('which', ['lark-cli'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5_000 });
    const p = result.toString().trim();
    if (p) return p;
  } catch { /* not in PATH */ }
  return null;
}

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as url from 'node:url';
import { spawn } from 'node:child_process';
import type { Logger } from '../utils/logger.js';

/** Skills installed for all bots. frontend-slides is a third-party MIT skill
 *  (zarazhangrui/frontend-slides) fetched into ~/.claude/skills by install.sh —
 *  absent copies are skipped silently. */
const COMMON_SKILLS = ['luckagent', 'frontend-slides'];

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

/** opencli is an optional third-party binary; its skill is only installed
 *  when the binary is actually present (a skill for a missing tool would
 *  just mislead the agent). PATH-based so tests can control it. */
export function opencliAvailable(): boolean {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, 'opencli'), fs.constants.X_OK);
      return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

export async function installSkillsToWorkDir(workDir: string, logger: Logger, options?: InstallSkillsOptions): Promise<void> {
  const userSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const destSkillDirs = [path.join(workDir, '.claude', 'skills')];

  const skillNames = options?.platform === 'feishu'
    ? [...COMMON_SKILLS, ...LARK_CLI_SKILLS]
    : [...COMMON_SKILLS];
  if (opencliAvailable()) skillNames.push('opencli');

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
      await fs.promises.mkdir(dest, { recursive: true });
      // Skip VCS metadata — git-cloned skills (e.g. frontend-slides) must not
      // drag their .git history into every bot workdir.
      await fs.promises.cp(src, dest, {
        recursive: true,
        filter: (entry) => path.basename(entry) !== '.git',
      });
      logger.info({ skill, src, dest }, 'Skill installed to working directory');
    }
  }

  // For Feishu bots, ensure lark-cli has a profile for this app
  if (options?.platform === 'feishu' && options.feishuAppId && options.feishuAppSecret) {
    await ensureLarkCliConfig(options.feishuAppId, options.feishuAppSecret, options.botName, logger);
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
/** Run a command with data piped to stdin, async (never blocks the loop). */
function runWithStdin(bin: string, args: string[], input: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin?.write(input);
    child.stdin?.end();
  });
}

async function ensureLarkCliConfig(appId: string, appSecret: string, botName: string | undefined, logger: Logger): Promise<void> {
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
    await runWithStdin(larkCliBin, args, appSecret, 15_000);
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
    // AGENTS.md is a SYMLINK to CLAUDE.md — one document, two names, kept for
    // compatibility with any agent tools run manually in this workdir. An
    // existing regular AGENTS.md (user-customized) is left alone.
    const agentsMd = path.join(workDir, 'AGENTS.md');
    if (!fs.existsSync(agentsMd)) {
      try {
        fs.symlinkSync('CLAUDE.md', agentsMd);
        logger.info({ agentsMd }, 'AGENTS.md symlinked to CLAUDE.md');
      } catch (err: any) {
        logger.warn({ err: err?.message }, 'AGENTS.md symlink failed — falling back to copy');
        copyInstructionFile(fs.existsSync(existingClaudeMd) ? existingClaudeMd : candidate, agentsMd, 'AGENTS.md', logger);
      }
    }
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
    opencli: [
      path.join(thisDir, '..', 'skills', 'opencli'),
      path.join(thisDir, '..', '..', 'src', 'skills', 'opencli'),
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
  // Try PATH via a scan (no subprocess)
  try {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      const cand = path.join(dir, 'lark-cli');
      try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { /* next */ }
    }
  } catch { /* not in PATH */ }
  return null;
}

import * as fs from 'node:fs';
import * as path from 'node:path';
import { request } from './client.js';
import type { Config } from './config.js';
import { print } from '@luckagent/cli-core/print';
import type { ParsedArgs } from '@luckagent/cli-core/args';

export { parseArgs } from '@luckagent/cli-core/args';
export type { ParsedArgs } from '@luckagent/cli-core/args';

// ---- Commands ----

export async function cmdList(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/api/skills' });
  print(body);
}

export async function cmdSearch(cfg: Config, args: ParsedArgs): Promise<void> {
  const q = args.positional[0];
  if (!q) throw new Error('search: <query> required');
  const body = await request(cfg, {
    path: '/api/skills/search',
    query: { q },
  });
  print(body);
}

export async function cmdGet(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('get: <skill name> required');
  const body = await request(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

interface SkillRecordSnippet {
  name?: string;
  version?: number;
  skillMd?: string;
}

export async function cmdPublish(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('publish: <skill name> required');

  const from = typeof args.flags.from === 'string' ? args.flags.from : undefined;
  const mdFlag = typeof args.flags.md === 'string' ? args.flags.md : undefined;

  let skillMd: string;
  if (mdFlag) {
    skillMd = fs.readFileSync(mdFlag, 'utf8');
  } else if (from) {
    const p = path.join(from, 'SKILL.md');
    if (!fs.existsSync(p)) throw new Error(`publish: ${p} not found (--from <dir> must contain SKILL.md)`);
    skillMd = fs.readFileSync(p, 'utf8');
  } else if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    skillMd = await new Promise<string>((resolve, reject) => {
      process.stdin.on('data', (c) => chunks.push(c));
      process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()));
      process.stdin.on('error', reject);
    });
  } else {
    throw new Error('publish: provide --from <dir> with SKILL.md, --md <file>, or pipe to stdin');
  }

  const visibility =
    typeof args.flags.visibility === 'string' ? args.flags.visibility : undefined;

  const body = await request<SkillRecordSnippet>(cfg, {
    method: 'POST',
    path: `/api/skills/${encodeURIComponent(name)}/publish`,
    body: { skillMd, visibility },
  });
  print(body);
}

export async function cmdInstall(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('install: <skill name> required');
  const to = typeof args.flags.to === 'string' ? args.flags.to : path.join('.claude', 'skills', name);

  const record = await request<SkillRecordSnippet>(cfg, {
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  if (!record.skillMd) {
    throw new Error(`install: ${name} returned no skillMd content`);
  }
  fs.mkdirSync(to, { recursive: true });
  const dst = path.join(to, 'SKILL.md');
  fs.writeFileSync(dst, record.skillMd);
  print({ name, installedTo: dst, version: record.version });
}

export async function cmdRemove(cfg: Config, args: ParsedArgs): Promise<void> {
  const name = args.positional[0];
  if (!name) throw new Error('remove: <skill name> required');
  const body = await request(cfg, {
    method: 'DELETE',
    path: `/api/skills/${encodeURIComponent(name)}`,
  });
  print(body);
}

export async function cmdHealth(cfg: Config): Promise<void> {
  const body = await request(cfg, { path: '/health' });
  print(body);
}

export function printHelp(): void {
  process.stdout.write(
    `luckagent skills — luckagent-core skill-hub CLI

Usage: luckagent skills <command> [args]

Commands:
  list                              List all visible skills
  search <query>                    FTS search over published skills
  get <name>                        Get one skill (includes SKILL.md)
  publish <name>                    Publish a skill. Source order:
                                      --from <dir>   reads <dir>/SKILL.md
                                      --md <file>    reads file
                                      else           reads stdin
                                    Optional: --visibility published|private|shared
  install <name>                    Download SKILL.md to a local skill dir
                                      [--to <dir>]   default: .claude/skills/<name>
  remove <name>                     Unpublish a skill
  health
  help

Env:
  LUCKAGENT_CORE_URL    default http://localhost:9200
  LUCKAGENT_CORE_TOKEN  bearer token (or write to ~/.luckagent-core/token)
`,
  );
}

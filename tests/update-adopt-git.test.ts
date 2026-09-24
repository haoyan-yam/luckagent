import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * `luckagent update` on a tarball install (no .git): converts it in place into
 * a shallow git checkout tracking origin/main, keeping .env / bots.json /
 * node_modules, then re-execs the (new) repo copy of the CLI. The "origin" is a
 * local repo served over file:// (LUCKAGENT_REPO), and its bin/luckagent is a
 * stub — so the test stops right after the conversion, before npm / pm2.
 */

const CLI = path.resolve(__dirname, '../bin/luckagent');

let tmp: string;
let origin: string;
let home: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

function write(file: string, content: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adopt-git-'));
  origin = path.join(tmp, 'origin');
  home = path.join(tmp, 'luckagent');

  // upstream: the latest release
  const stub = '#!/usr/bin/env bash\necho "new-cli $*"\n';
  write(path.join(origin, 'bin/luckagent'), stub, 0o755);
  write(path.join(origin, 'package.json'), '{"version":"2.0.0"}\n');
  write(path.join(origin, 'README.md'), 'new readme\n');
  write(path.join(origin, '.gitignore'), '.env\nbots.json\nnode_modules/\n');
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'add', '-A');
  git(origin, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'v2');

  // tarball install of an older release, plus machine-local files
  write(path.join(home, 'bin/luckagent'), '#!/usr/bin/env bash\necho "old-cli $*"\n', 0o755);
  write(path.join(home, 'package.json'), '{"version":"1.0.0"}\n');
  write(path.join(home, 'README.md'), 'old readme\n');
  write(path.join(home, '.env'), 'API_SECRET=keep-me\n');
  write(path.join(home, 'bots.json'), '[{"name":"mybot"}]\n');
  write(path.join(home, 'node_modules/x/index.js'), 'module.exports = 1;\n');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function update(repo: string) {
  const r = spawnSync('bash', [CLI, 'update'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmp,
      LUCKAGENT_HOME: home,
      LUCKAGENT_REPO: repo,
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  // eslint-disable-next-line no-control-regex -- strip ANSI colours
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') };
}

const gitUsable =
  spawnSync('git', ['--version']).status === 0 &&
  (process.platform !== 'darwin' || spawnSync('xcode-select', ['-p']).status === 0);

describe.skipIf(!gitUsable)('luckagent update: tarball install → git checkout', () => {
  it('converts in place, keeps machine-local files, and hands off to the new CLI', () => {
    const r = update(`file://${origin}`);
    expect(r.out).toContain('转成 git 检出');
    expect(r.code).toBe(0);
    // re-exec'd the freshly checked-out repo copy of the CLI
    expect(r.out).toContain('new-cli update');

    expect(fs.readFileSync(path.join(home, 'README.md'), 'utf8')).toBe('new readme\n');
    expect(fs.readFileSync(path.join(home, 'package.json'), 'utf8')).toContain('2.0.0');
    expect(fs.readFileSync(path.join(home, '.env'), 'utf8')).toBe('API_SECRET=keep-me\n');
    expect(fs.readFileSync(path.join(home, 'bots.json'), 'utf8')).toBe('[{"name":"mybot"}]\n');
    expect(fs.existsSync(path.join(home, 'node_modules/x/index.js'))).toBe(true);

    expect(git(home, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(git(home, 'rev-parse', '--abbrev-ref', '@{upstream}')).toBe('origin/main');
    expect(git(home, 'status', '--porcelain')).toBe('');
    expect(git(home, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', 'HEAD'));
  });

  it('when the fetch fails: removes the half-made .git, leaves files alone, prints the fallback', () => {
    const r = update(`file://${path.join(tmp, 'missing')}`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('转换失败');
    expect(r.out).toContain('TUN');
    expect(r.out).toContain('codeload.github.com');
    expect(fs.existsSync(path.join(home, '.git'))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'README.md'), 'utf8')).toBe('old readme\n');
  });
});

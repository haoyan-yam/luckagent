#!/usr/bin/env node
/**
 * Luckagent npm 入口（安装引导器 + CLI 透传）。
 *
 * 两种角色：
 *   1. 机器上还没装 Luckagent → `luckagent init` 把仓库取到 ~/luckagent
 *      并运行交互式 install.sh（依赖、.env、PM2 启动一条龙）。
 *   2. 已经装好（检测到 $LUCKAGENT_HOME/bin/luckagent）→ 所有参数原样
 *      透传给真实 CLI，`npm i -g luckagent` 与 ~/.local/bin 两条 PATH
 *      殊途同归。
 *
 * 环境变量：
 *   LUCKAGENT_HOME  安装目录（默认 ~/luckagent）
 *   LUCKAGENT_REPO  克隆源（默认 GitHub 官方仓库；fork/离线镜像可覆盖）
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_REPO = 'https://github.com/haoyan-yam/luckagent.git';
const TARBALL_URL = (ref) =>
  `https://codeload.github.com/haoyan-yam/luckagent/tar.gz/refs/heads/${ref}`;

const pkg = require(path.join(__dirname, '..', 'package.json'));

function resolveHome(explicitDir) {
  return path.resolve(
    explicitDir || process.env.LUCKAGENT_HOME || path.join(os.homedir(), 'luckagent'),
  );
}

function isInstalledAt(dir) {
  return (
    fs.existsSync(path.join(dir, 'bin', 'luckagent')) &&
    fs.existsSync(path.join(dir, 'package.json'))
  );
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function has(cmd) {
  const r = spawnSync('command', ['-v', cmd], { shell: '/bin/sh', stdio: 'ignore' });
  return r.status === 0;
}

function printHelp() {
  console.log(`Luckagent v${pkg.version} — 飞书 AI agent 机器人平台（安装引导器）

用法:
  luckagent init [选项]     把 Luckagent 安装到本机（克隆仓库 + 运行 install.sh）
    --dir <path>            安装目录（默认 ~/luckagent，或 $LUCKAGENT_HOME）
    --ref <branch|tag>      克隆的分支/标签（默认 main）
    --yes                   install.sh 全部采用默认值、不提问
    --no-install            只取代码，不运行 install.sh

安装完成后，本命令自动变成真实 CLI 的透传入口：
  luckagent status | bots | talk | schedule | doctor | update ...

文档: https://github.com/haoyan-yam/luckagent#readme`);
}

function init(argv) {
  const opts = { dir: undefined, ref: 'main', yes: false, install: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--yes' || a === '-y') opts.yes = true;
    else if (a === '--no-install') opts.install = false;
    else if (a === '--help' || a === '-h') return void printHelp();
    else {
      console.error(`未知参数: ${a}（luckagent init --help 查看用法）`);
      process.exit(2);
    }
  }

  if (process.platform !== 'darwin') {
    console.error('Luckagent 目前只支持 macOS（目标机型是 Mac mini / MacBook）。');
    process.exit(1);
  }

  const target = resolveHome(opts.dir);
  if (isInstalledAt(target)) {
    console.log(`✔ ${target} 已经是一份 Luckagent 安装。`);
    console.log('  升级: cd ' + target + ' && luckagent update   # git 检出');
    console.log('  重跑安装(幂等): cd ' + target + ' && bash install.sh');
    return;
  }
  if (fs.existsSync(target) && fs.readdirSync(target).length > 0) {
    console.error(`✖ 目录 ${target} 已存在且非空，但不是 Luckagent 安装。`);
    console.error('  换个目录: luckagent init --dir <path>（或设 LUCKAGENT_HOME）');
    process.exit(1);
  }

  const repo = process.env.LUCKAGENT_REPO || DEFAULT_REPO;
  console.log(`→ 获取 Luckagent（${opts.ref}）到 ${target} ...`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  let fetched = false;
  if (has('git')) {
    const code = run('git', ['clone', '--depth', '1', '--branch', opts.ref, repo, target]);
    fetched = code === 0;
    if (!fetched) console.error('  git clone 失败，改用 tarball 下载 ...');
  }
  if (!fetched) {
    // 全新 Mac 可能还没有 git（随 Xcode CLT 安装）；curl + tar 系统自带。
    fs.mkdirSync(target, { recursive: true });
    const sh = `curl -fsSL "${TARBALL_URL(opts.ref)}" | tar -xz --strip-components=1 -C "${target}"`;
    const code = run('/bin/sh', ['-c', sh]);
    if (code !== 0) {
      console.error('✖ 下载失败。请检查网络后重试，或手动克隆:');
      console.error(`  git clone ${repo} ${target}`);
      process.exit(1);
    }
  }
  console.log('✔ 代码就绪');

  if (!opts.install) {
    console.log(`跳过安装（--no-install）。之后执行: cd ${target} && bash install.sh`);
    return;
  }

  console.log('→ 运行交互式安装 install.sh（依赖、.env、PM2 启动）...\n');
  const args = ['install.sh'];
  if (opts.yes) args.push('--yes');
  const code = run('bash', args, { cwd: target });
  if (code !== 0) {
    console.error(`\n✖ install.sh 退出码 ${code}。可修复问题后重跑: cd ${target} && bash install.sh`);
    process.exit(code);
  }
  console.log(`\n✔ 安装完成。管理台: http://localhost:9100/admin （密钥在 ${target}/.env 的 API_SECRET）`);
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === 'init') return init(argv.slice(1));
  if (cmd === '--version' || cmd === '-V') return void console.log(pkg.version);

  const home = resolveHome();
  if (isInstalledAt(home)) {
    // 已安装 → 透传给真实 CLI（bash 脚本，自带可执行位与 shebang）。
    const real = path.join(home, 'bin', 'luckagent');
    const r = spawnSync(real, argv, { stdio: 'inherit' });
    process.exit(r.status ?? 1);
  }

  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') return void printHelp();
  console.error(`本机还没有安装 Luckagent（未找到 ${home}）。先执行: luckagent init`);
  process.exit(1);
}

main();

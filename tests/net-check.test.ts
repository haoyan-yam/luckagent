import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * scripts/net-check.sh, run for real with every request forced through a
 * dead proxy (127.0.0.1:1) — deterministic and offline: all probes fail fast.
 */

const SCRIPT = path.resolve(__dirname, '../scripts/net-check.sh');

function run(args: string[], input = '', extraEnv: Record<string, string> = {}) {
  const dead = 'http://127.0.0.1:1';
  const r = spawnSync('/bin/bash', [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      https_proxy: dead,
      http_proxy: dead,
      HTTPS_PROXY: dead,
      HTTP_PROXY: dead,
      all_proxy: '',
      ALL_PROXY: '',
      ...extraEnv,
    },
  });
  // eslint-disable-next-line no-control-regex -- strip ANSI colours
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') };
}

describe('net-check.sh', () => {
  it('--report: marks unreachable sources, recommends TUN + Clash Verge, exits 1', () => {
    const r = run(['--report']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ GitHub 代码仓库  连不上');
    expect(r.out).toContain('✗ npm 包仓库  连不上');
    expect(r.out).toContain('有 6 项安装必需的海外源');
    expect(r.out).toContain('虚拟网卡模式（TUN）');
    expect(r.out).toContain('Clash Verge');
    // Claude probes are optional: reported separately, not counted as required
    expect(r.out).toContain('Claude API（Claude 引擎用）');
    expect(r.out).toContain('只用 DeepSeek / MiniMax 引擎可忽略');
    // a proxy set in the terminal is called out (it is the likely culprit)
    expect(r.out).toContain('终端里设置了代理 http://127.0.0.1:1');
  });

  it('never prints proxy credentials', () => {
    const r = run(['--report'], '', { https_proxy: 'http://alice:s3cret@127.0.0.1:1' });
    expect(r.out).toContain('终端代理: http://127.0.0.1:1');
    expect(r.out).not.toContain('s3cret');
    expect(r.out).not.toContain('alice');
  });

  it('interactive: "s" continues the install (exit 0), "q" and EOF abort (exit 1)', () => {
    const cont = run([], 's\n');
    expect(cont.code).toBe(0);
    expect(cont.out).toContain('忽略网络问题继续安装');
    expect(run([], 'q\n').code).toBe(1);
    expect(run([], '').code).toBe(1);
  });

  it('interactive: Enter re-runs the checks', () => {
    const r = run([], '\nq\n');
    expect(r.code).toBe(1);
    expect(r.out).toContain('重新检测');
    expect(r.out.match(/✗ GitHub 代码仓库/g)).toHaveLength(2);
  });
});

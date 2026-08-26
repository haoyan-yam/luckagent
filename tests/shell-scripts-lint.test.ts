import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SHELL_SCRIPTS = ['install.sh', 'bin/luckagent', 'scripts/get.sh', 'scripts/make-installer.sh', 'scripts/uninstall.sh'];

/**
 * macOS bash（3.2 与 Homebrew 5.x 均中招）在 en_US.UTF-8 —— 系统默认 locale ——
 * 下会把紧跟在裸 $VAR 后面的全角标点吞进变量名："（$FOO）" 被解析成变量
 * `FOO）` → set -u 下 unbound variable 直接炸安装（2026-08 新机实测）。
 * 规则：非 ASCII 字符紧邻的变量展开必须写成 ${FOO}。
 */
describe('shell scripts: no bare $VAR adjacent to non-ASCII text', () => {
  const bare = /\$[A-Za-z_][A-Za-z0-9_]*(?=[^\x00-\x7F])/;

  for (const rel of SHELL_SCRIPTS) {
    it(`${rel} braces every expansion that touches CJK text`, () => {
      const lines = readFileSync(join(ROOT, rel), 'utf-8').split('\n');
      const offenders = lines
        .map((line, i) => ({ line, no: i + 1 }))
        .filter(({ line }) => bare.test(line))
        .map(({ line, no }) => `${rel}:${no}: ${line.trim()}`);
      expect(offenders, `写成 \${VAR} 形式（裸 $VAR 紧邻全角字符在 en_US.UTF-8 的 macOS bash 下会炸）:\n${offenders.join('\n')}`).toEqual([]);
    });
  }
});

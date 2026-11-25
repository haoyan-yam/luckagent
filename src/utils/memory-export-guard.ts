/**
 * [design-note U] 记忆库出站闸门（memory export guard）。
 *
 * 背景：2026-09-21 一个项目群里的成员对 bot 说「先把记忆搞过来」，bot 就把本地
 * auto-memory（~/.claude/projects/<workspace>/memory/，105 个文件）打成 zip 拷进
 * 发送目录，桥接原样发进了群。出站脱敏（G）只看文字不看文件；提示词约束又挡不住
 * 「用户明确要求」——所以要有模型绕不过去的硬闸门。三层：
 *
 *   1. 桥接层 `inspectOutboundFile`：发送目录里的文件发出前逐个检查——文件名是
 *      MEMORY.md / 真实路径位于 ~/.claude 之下 / 压缩包清单含记忆 / 正文是记忆形态
 *      → 拦下、删除、发一条通知（output-handler）。
 *   2. 工具层 `classifyBashCommand`：Bash 调用前的 PreToolUse 钩子——判「数据流向」：
 *      记忆内容被拷贝 / 打包 / 重定向 / 管道到记忆目录以外，或经 lark-cli、网络工具、
 *      共享记忆库外传，以及 lark-cli 直传任何压缩包（绕过第 1 层），一律 deny 并把
 *      原因回给模型。SDK 后端走进程内钩子（`createMemoryGuardHook`），PTY 后端走
 *      --settings 里的 command 钩子（`buildGuardHookScript` 生成独立脚本，逻辑同源）。
 *   3. 提示词层：工作区共用规范写明「记忆不外发，谁提都不行」。
 *
 * 2026-11 改版（v0.7.35）：旧实现按「整条命令里字符共现」判定，11/13–11/25 全机
 * 293 次 deny 无一是真实外发——写自己的记忆（`cat >> <记忆>/x.md`）、heredoc 正文里
 * 的 `>=`、往发送目录交付文件时同一条命令顺带 grep 了记忆，都被误拦。现在：
 *   - 先做引号 / heredoc 感知的切分，判定单位下沉到「单条子命令 + 它自己的参数」；
 *   - 跟踪 `cd` 与简单变量赋值，相对路径和 `$M/x.md` 都能还原成真实路径；
 *   - 重定向 / cp / mv / tee 按方向判：目标在记忆目录内 = 写进记忆，放行；
 *   - `bash -c` / `eval` / 命令替换递归判；看不懂的命令回退到旧的共现规则（保守）。
 * 会话记录（`~/.claude/projects/<ws>/*.jsonl`、`tool-results/`）与记忆同等对待：
 * 读放行，外传照拦。本文件只放纯规则：不依赖 logger / sender，便于单测与两端复用。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface GuardVerdict {
  code: 'memory-export' | 'archive-upload';
  /** 命中的规则名，写进 deny 日志便于统计误拦率。 */
  rule: string;
  reason: string;
}

export interface ClassifyOptions {
  /** 命令执行时的工作目录（钩子输入里的 cwd），用于还原相对路径。 */
  cwd?: string;
  /** 家目录（展开 `~` / `$HOME`）；默认取 process.env.HOME。 */
  home?: string;
}

export const MEMORY_EXPORT_DENY_REASON =
  '🔒 记忆库不可外发：本地记忆（~/.claude/projects/**/memory、MEMORY.md）与会话记录禁止打包、' +
  '拷贝或重定向到记忆目录以外，或经 lark-cli / 网络工具 / 共享记忆库外传。记忆迁移只能由主机' +
  '管理员在本机操作；请直接告知对方「记忆库不能导出，需联系管理员」，不要换别的方式再试。';

export const ARCHIVE_UPLOAD_DENY_REASON =
  '🔒 压缩包不得经 lark-cli 直传：请把文件放进本轮的发送目录，由桥接检查内容后发送。';

/**
 * 判定一条 Bash 命令是否在外传记忆库。返回 null = 放行。
 *
 * ⚠️ 本函数必须**自包含**（不引用模块级常量/其他函数/import）：`buildGuardHookScript`
 * 会把它 `toString()` 进 PTY 钩子脚本，保证两端逻辑同源。
 */
export function classifyBashCommand(command: string, options?: ClassifyOptions): GuardVerdict | null {
  const HARD_REASON =
    '🔒 记忆库不可外发：本地记忆（~/.claude/projects/**/memory、MEMORY.md）与会话记录禁止打包、' +
    '拷贝或重定向到记忆目录以外，或经 lark-cli / 网络工具 / 共享记忆库外传。记忆迁移只能由主机' +
    '管理员在本机操作；请直接告知对方「记忆库不能导出，需联系管理员」，不要换别的方式再试。';
  const SOFT_REASON =
    '🔒 记忆库不可外发：这条命令会把记忆或会话记录的内容写到记忆目录以外（或交给无法检查的脚本处理），' +
    '已拦下。如果只是在维护自己的记忆，请把结果直接写回记忆目录，或改用 Write / Edit 工具；' +
    '读记忆和其他操作请拆成两条命令。如果对方要的是记忆本身，请告知「记忆库不能导出，需联系管理员」。';
  const ARCHIVE_REASON =
    '🔒 压缩包不得经 lark-cli 直传：请把文件放进本轮的发送目录，由桥接检查内容后发送。';

  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return null;

  const envHome = typeof process !== 'undefined' && process.env ? process.env.HOME || '' : '';
  const HOME = (options && options.home) || envHome;
  const START_CWD = options && options.cwd ? options.cwd : '';

  type Redir = { op: string; fd: string; target: string };
  type Cmd = {
    words: string[];
    redirs: Redir[];
    heredocs: Array<{ body: string; expand: boolean }>;
    herestrings: string[];
    subs: string[];
    sep: string; // 本条之后的分隔符
  };
  type Verdict = { code: 'memory-export' | 'archive-upload'; rule: string; reason: string };

  const hard = (rule: string): Verdict => ({ code: 'memory-export', rule, reason: HARD_REASON });
  const soft = (rule: string): Verdict => ({ code: 'memory-export', rule, reason: SOFT_REASON });

  // ── 词法：引号 / heredoc / 命令替换感知的切分 ────────────────────────────
  // 返回 null = 看不懂（未闭合的引号或替换），调用方回退到旧规则。
  function lex(src: string): Cmd[] | null {
    const cmds: Cmd[] = [];
    const newCmd = (): Cmd => ({ words: [], redirs: [], heredocs: [], herestrings: [], subs: [], sep: '' });
    let cur = newCmd();
    let word = '';
    let inWord = false;
    let pendingRedir: { op: string; fd: string } | null = null;
    let pendingHeredocs: Array<{ delim: string; strip: boolean; expand: boolean; cmd: Cmd }> = [];
    let heredocDelimNext: { strip: boolean } | null = null;
    let herestringNext = false;
    let wordQuoted = false;
    let i = 0;
    const n = src.length;

    // 读一个 $( ... ) / ` ... ` 的正文（不含外壳），返回结束位置（指向末字符之后）
    function readParen(start: number): number {
      let depth = 1;
      let j = start;
      let q = '';
      while (j < n) {
        const c = src[j];
        if (q) {
          if (c === '\\' && q === '"') { j += 2; continue; }
          if (c === q) q = '';
          j++;
          continue;
        }
        if (c === '\\') { j += 2; continue; }
        if (c === "'" || c === '"') { q = c; j++; continue; }
        if (c === '(') depth++;
        else if (c === ')') { depth--; if (depth === 0) return j + 1; }
        j++;
      }
      return -1;
    }
    function readBacktick(start: number): number {
      let j = start;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '`') return j + 1;
        j++;
      }
      return -1;
    }

    function endWord(): void {
      if (!inWord) return;
      const w = word;
      word = '';
      inWord = false;
      const quoted = wordQuoted;
      wordQuoted = false;
      if (heredocDelimNext) {
        pendingHeredocs.push({ delim: w, strip: heredocDelimNext.strip, expand: !quoted, cmd: cur });
        heredocDelimNext = null;
        return;
      }
      if (herestringNext) { cur.herestrings.push(w); herestringNext = false; return; }
      if (pendingRedir) { cur.redirs.push({ op: pendingRedir.op, fd: pendingRedir.fd, target: w }); pendingRedir = null; return; }
      cur.words.push(w);
    }
    function endCmd(sep: string): void {
      endWord();
      if (cur.words.length || cur.redirs.length || cur.heredocs.length || cur.herestrings.length || pendingHeredocs.some((h) => h.cmd === cur)) {
        cur.sep = sep;
        cmds.push(cur);
      } else if (cmds.length && sep && sep !== '\n') {
        cmds[cmds.length - 1].sep = sep;
      }
      cur = newCmd();
    }
    // 换行处收取挂起的 heredoc 正文
    function consumeHeredocs(): void {
      if (!pendingHeredocs.length) return;
      for (const h of pendingHeredocs) {
        const lines: string[] = [];
        while (i < n) {
          let e = src.indexOf('\n', i);
          if (e < 0) e = n;
          let line = src.slice(i, e);
          i = e + 1;
          if (h.strip) line = line.replace(/^\t+/, '');
          if (line === h.delim) break;
          lines.push(line);
        }
        h.cmd.heredocs.push({ body: lines.join('\n'), expand: h.expand });
      }
      pendingHeredocs = [];
    }

    while (i < n) {
      const c = src[i];
      // 注释
      if (c === '#' && !inWord) {
        const e = src.indexOf('\n', i);
        i = e < 0 ? n : e;
        continue;
      }
      if (c === '\\') {
        if (src[i + 1] === '\n') { i += 2; continue; }
        word += src[i + 1] ?? '';
        inWord = true;
        i += 2;
        continue;
      }
      if (c === "'") {
        const e = src.indexOf("'", i + 1);
        if (e < 0) return null;
        word += src.slice(i + 1, e);
        inWord = true;
        wordQuoted = true;
        i = e + 1;
        continue;
      }
      if (c === '"') {
        let j = i + 1;
        let buf = '';
        let closed = false;
        while (j < n) {
          const d = src[j];
          if (d === '\\') { buf += src[j + 1] ?? ''; j += 2; continue; }
          if (d === '"') { closed = true; j++; break; }
          if (d === '$' && src[j + 1] === '(') {
            const e = readParen(j + 2);
            if (e < 0) return null;
            cur.subs.push(src.slice(j + 2, e - 1));
            buf += src.slice(j, e);
            j = e;
            continue;
          }
          if (d === '`') {
            const e = readBacktick(j + 1);
            if (e < 0) return null;
            cur.subs.push(src.slice(j + 1, e - 1));
            buf += src.slice(j, e);
            j = e;
            continue;
          }
          buf += d;
          j++;
        }
        if (!closed) return null;
        word += buf;
        inWord = true;
        wordQuoted = true;
        i = j;
        continue;
      }
      if (c === '$' && src[i + 1] === '(') {
        const e = readParen(i + 2);
        if (e < 0) return null;
        cur.subs.push(src.slice(i + 2, e - 1));
        word += src.slice(i, e);
        inWord = true;
        i = e;
        continue;
      }
      if ((c === '<' || c === '>') && src[i + 1] === '(') {
        // 进程替换 <(...) / >(...)：正文按命令替换处理，整体当作一个词
        const e = readParen(i + 2);
        if (e < 0) return null;
        cur.subs.push(src.slice(i + 2, e - 1));
        word += src.slice(i, e);
        inWord = true;
        i = e;
        continue;
      }
      if (c === '`') {
        const e = readBacktick(i + 1);
        if (e < 0) return null;
        cur.subs.push(src.slice(i + 1, e - 1));
        word += src.slice(i, e);
        inWord = true;
        i = e;
        continue;
      }
      if (c === '\n') {
        endCmd('\n');
        i++;
        consumeHeredocs();
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
      if (c === ';' || c === '(' || c === ')' || c === '{' && !inWord && /[\s]/.test(src[i + 1] ?? ' ') || c === '}' && !inWord) {
        if (c === ';' && src[i + 1] === ';') { endCmd(';'); i += 2; continue; }
        endCmd(';');
        i++;
        continue;
      }
      if (c === '&') {
        if (src[i + 1] === '&') { endCmd('&&'); i += 2; continue; }
        if (src[i + 1] === '>') {
          endWord();
          const app = src[i + 2] === '>';
          pendingRedir = { op: app ? '>>' : '>', fd: '&' };
          i += app ? 3 : 2;
          continue;
        }
        endCmd('&');
        i++;
        continue;
      }
      if (c === '|') {
        if (src[i + 1] === '|') { endCmd('||'); i += 2; continue; }
        endCmd('|');
        i += src[i + 1] === '&' ? 2 : 1;
        continue;
      }
      if (c === '>' || c === '<') {
        // 前面紧贴的纯数字词是 fd
        let fd = '';
        if (inWord && /^\d+$/.test(word) && !wordQuoted) { fd = word; word = ''; inWord = false; }
        else endWord();
        if (c === '<') {
          if (src.startsWith('<<<', i)) { herestringNext = true; i += 3; continue; }
          if (src.startsWith('<<', i)) {
            const strip = src[i + 2] === '-';
            heredocDelimNext = { strip };
            i += strip ? 3 : 2;
            continue;
          }
          if (src[i + 1] === '&') { i += 2; pendingRedir = { op: '<&', fd }; continue; }
          pendingRedir = { op: '<', fd };
          i += src[i + 1] === '>' ? 2 : 1;
          continue;
        }
        // '>'
        if (src[i + 1] === '&') { pendingRedir = { op: '>&', fd }; i += 2; continue; }
        if (src[i + 1] === '>') { pendingRedir = { op: '>>', fd }; i += 2; continue; }
        pendingRedir = { op: '>', fd };
        i += src[i + 1] === '|' ? 2 : 1;
        continue;
      }
      word += c;
      inWord = true;
      i++;
    }
    endCmd('');
    if (pendingHeredocs.length) consumeHeredocs();
    return cmds;
  }

  // ── 路径工具 ─────────────────────────────────────────────────────────────
  function normalize(p: string): string {
    const abs = p.startsWith('/');
    const out: string[] = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/');
  }
  function resolvePath(p: string, cwd: string): string {
    let v = p;
    if (v === '~' || v.startsWith('~/')) v = HOME ? HOME + v.slice(1) : v;
    if (v.startsWith('/')) return normalize(v);
    if (cwd) return normalize(cwd + '/' + v);
    return v;
  }
  function pathLike(v: string): boolean {
    if (!v || /\s/.test(v) || v.startsWith('-')) return false;
    return v === '.' || v === '..' || v.includes('/') || v.includes('*') || /\.[A-Za-z0-9]{1,8}$/.test(v);
  }
  const CLAUDE_RE = /(^|[\\/])\.claude[\\/]projects([\\/]|$)/;
  const MEM_DIR_RE = /(^|\/)\.claude\/projects\/[^/]+\/memory(\/|$)/;
  /** 文本里是否提到记忆 / 会话记录路径（用于脚本正文、命令替换、外传工具的参数）。 */
  function mentionsMemory(s: string): boolean {
    return CLAUDE_RE.test(s) || /(^|[^\w.-])MEMORY\.md\b/i.test(s) || /(^|[\s'"=@(:\\/])memory[\\/]/.test(s);
  }
  /** 工作目录是否在记忆 / 会话记录目录里。 */
  function cwdIsMemory(cwd: string): boolean {
    return !!cwd && CLAUDE_RE.test(cwd);
  }
  /**
   * 一个参数是否指向记忆 / 会话记录。bare = 光秃秃一个 `memory`（只对拷贝/打包类算数）。
   */
  function argInfo(w: string, cwd: string): { mem: boolean; bare: boolean; inside: boolean } {
    let v = w;
    if (v.startsWith('-') && v.includes('=')) v = v.slice(v.indexOf('=') + 1);
    if (v.includes('=@')) v = v.slice(v.indexOf('=@') + 2);
    else if (v.startsWith('@')) v = v.slice(1);
    if (v === 'memory') return { mem: false, bare: true, inside: false };
    const resolved = pathLike(v) || v.startsWith('~') ? resolvePath(v, cwd) : v;
    const inside = MEM_DIR_RE.test(resolved);
    let mem = mentionsMemory(w) || CLAUDE_RE.test(resolved) || /(^|\/)MEMORY\.md$/i.test(resolved);
    if (!mem && /(^|\/)memory(\/|$)/.test(v) && !v.startsWith('-')) mem = true;
    return { mem, bare: false, inside };
  }
  function base(w: string): string { return w.replace(/^.*[\\/]/, ''); }

  // ── 工具分组 ─────────────────────────────────────────────────────────────
  const COPY = /^(cp|mv|rsync|ditto|install|gcp|gmv)$/;
  const REMOTE_COPY = /^(scp|sftp|rclone|ftp|lftp)$/;
  const ARCHIVERS = /^(zip|tar|bsdtar|gtar|7z|7za|7zr|gzip|bzip2|xz|zstd|cpio|pax|shar|rar|pigz|lz4|brotli)$/;
  const NET = /^(curl|wget|nc|ncat|netcat|socat|ssh|http|https|xh|aria2c|mail|sendmail|mutt)$/;
  const INTERP = /^(python|python3|python3\.\d+|node|nodejs|ruby|perl|php|deno|bun|osascript|Rscript|lua)$/;
  const SHELLS = /^(bash|sh|zsh|dash|ksh|fish)$/;
  const WRAPPERS = /^(sudo|env|command|builtin|nice|nohup|time|timeout|caffeinate|exec|stdbuf|ionice)$/;
  const LITERAL = /^(echo|printf|mkdir|touch|rm|rmdir|test|\[|true|false|sleep|date|ls|stat|du|wc|file|which|type|cd|pwd|export|unset|set|read|chmod|chown|ln|basename|dirname|realpath|readlink|exit|return|local|luckagent|metabot)$/;
  const SCRIPT_API = /\b(shutil|zipfile|tarfile|make_archive|copytree|copyfile|copy2|adm-zip|archiver|JSZip|fs\.cp|copyFileSync?|cpSync|createWriteStream|requests\.(post|put)|urlopen|urllib\.request|http\.client|httpx|fetch\(|axios|smtplib|ftplib|paramiko|boto3|subprocess|os\.system|os\.popen|child_process|execSync|spawnSync|execFileSync)/;

  // ── 分析主体（可递归：bash -c / eval / 命令替换）─────────────────────────
  function analyze(src: string, startCwd: string, vars: Record<string, string>, depth: number): Verdict | null {
    if (depth > 4) return legacy(src);
    const cmds = lex(src);
    if (!cmds) return legacy(src);
    let cwd = startCwd;
    let pipeMem: boolean = false; // 当前管道上游是否在输出记忆内容

    const expand = (w: string): string =>
      w.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
        const k = a || b;
        if (k in vars) return vars[k];
        if (k === 'HOME' && HOME) return HOME;
        return m;
      }).replace(/^~(?=\/|$)/, HOME || '~');

    for (let ci = 0; ci < cmds.length; ci++) {
      const c = cmds[ci];
      const prevSep = ci > 0 ? cmds[ci - 1].sep : '';
      if (prevSep !== '|') pipeMem = false;
      const upstreamMem: boolean = pipeMem;

      // 命令替换 / 进程替换：先递归判一遍
      for (const s of c.subs) {
        const v = analyze(s, cwd, vars, depth + 1);
        if (v) return v;
      }
      // 命令替换是否在读记忆：正文提到记忆路径，或在记忆目录里用相对路径读文件
      const subsMem = c.subs.some((s) => {
        if (mentionsMemory(s)) return true;
        if (!cwdIsMemory(cwd)) return false;
        const inner = lex(s);
        if (!inner) return true;
        return inner.some((ic) => ic.words.slice(1).some((w) => argInfo(expand(w), cwd).mem)
          || ic.redirs.some((r) => r.op === '<' && argInfo(expand(r.target), cwd).mem));
      });

      let words = c.words.map(expand);
      // 前置赋值：X=1 Y=2 cmd ...
      while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) {
        const eq = words[0].indexOf('=');
        vars[words[0].slice(0, eq)] = words[0].slice(eq + 1);
        words = words.slice(1);
      }
      if (words[0] === 'export' || words[0] === 'declare' || words[0] === 'local' || words[0] === 'readonly') {
        for (const w of words.slice(1)) {
          const eq = w.indexOf('=');
          if (eq > 0) vars[w.slice(0, eq)] = w.slice(eq + 1);
        }
      }
      // 去掉包装命令（sudo / env X=1 / timeout 10 …）
      while (words.length && WRAPPERS.test(base(words[0]))) {
        words = words.slice(1);
        while (words.length && (words[0].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[0]) || /^\d+[smh]?$/.test(words[0]))) words = words.slice(1);
      }
      const name = words.length ? base(words[0]) : '';
      const args = words.slice(1);
      const redirs = c.redirs.map((r) => ({ ...r, target: expand(r.target) }));

      if (name === 'cd') {
        const t = args.find((a) => !a.startsWith('-'));
        if (!t) cwd = HOME;
        else if (t === '-') cwd = '';
        else cwd = resolvePath(t, cwd);
        if (!cwd.startsWith('/')) cwd = '';
        pipeMem = false;
        continue;
      }
      if (name === 'pushd') {
        const t = args.find((a) => !a.startsWith('-'));
        if (t) { cwd = resolvePath(t, cwd); if (!cwd.startsWith('/')) cwd = ''; }
        continue;
      }

      const infos = args.map((a) => argInfo(a, cwd));
      const argsMem = infos.some((x) => x.mem);
      const inputMem = redirs.some((r) => (r.op === '<') && argInfo(r.target, cwd).mem)
        || c.herestrings.some((h) => mentionsMemory(h) && /\$\(|`/.test(h))
        || c.heredocs.some((h) => h.expand && /\$\(|`/.test(h.body) && mentionsMemory(h.body));

      // ── 解释器 / 子 shell：脚本正文 ──
      let scriptBody = '';
      if (INTERP.test(name) || SHELLS.test(name)) {
        const ci2 = args.findIndex((a) => a === '-c' || a === '-e' || a === '--eval' || a === '-lc' || a === '-ic');
        if (ci2 >= 0 && args[ci2 + 1] !== undefined) scriptBody = args[ci2 + 1];
        else if (c.heredocs.length) scriptBody = c.heredocs.map((h) => h.body).join('\n');
        else if (c.herestrings.length) scriptBody = c.herestrings.join('\n');
      }
      if (SHELLS.test(name) && scriptBody) {
        const v = analyze(scriptBody, cwd, { ...vars }, depth + 1);
        if (v) return v;
      }
      if (name === 'eval' || name === 'source' || name === '.') {
        if (name === 'eval') {
          const v = analyze(args.join(' '), cwd, { ...vars }, depth + 1);
          if (v) return v;
        }
      }
      const scriptMem = !!scriptBody && (mentionsMemory(scriptBody) || cwdIsMemory(cwd));
      // 用 heredoc 现写一个脚本文件（cat > x.py <<EOF），正文里既有记忆路径又有打包/外传 API：
      // 下一步多半就是执行它，提前拦（与旧规则一致）
      if (!scriptBody && c.heredocs.some((h) => mentionsMemory(h.body) && SCRIPT_API.test(h.body))
        && redirs.some((r) => r.op === '>' || r.op === '>>')) return soft('script-api');
      if (INTERP.test(name) && scriptMem && SCRIPT_API.test(scriptBody)) return soft('script-api');
      // 解释器 + 记忆路径作为参数（python3 x.py <记忆>/a.md）：脚本看不到，视为读取记忆
      const interpArgMem = INTERP.test(name) && argsMem;

      // 本条命令是否在输出记忆内容（供重定向 / 管道下游判断）
      const isLiteral = LITERAL.test(name);
      const readsMem: boolean = upstreamMem || inputMem || subsMem
        || (!isLiteral && name !== 'lark-cli' && (argsMem || scriptMem || interpArgMem));

      // ── lark-cli ──
      if (name === 'lark-cli') {
        if (args.some((a) => mentionsMemory(a)) || infos.some((x) => x.mem)) return hard('lark-arg');
        if (upstreamMem || inputMem || subsMem) return hard('lark-pipe');
        // 直传压缩包（绕过桥接的文件检查）；`+xxx-download` 类下载放行
        const ARCHIVE = /\.(zip|tar|tgz|tbz2|txz|7z|rar)$|\.tar\.(gz|bz2|xz|zst)$/i;
        const toks = args.map((t) => t.replace(/^--?[\w-]+=/, ''));
        if (!toks.some((t) => /^\+[\w-]*download$/i.test(t)) && toks.some((t) => ARCHIVE.test(t))) {
          return { code: 'archive-upload', rule: 'archive-upload', reason: ARCHIVE_REASON };
        }
      }

      // ── 共享记忆库写入 ──
      if ((name === 'luckagent' || name === 'metabot') && args[0] === 'memory' && /^(create|import|update|put)$/.test(args[1] || '')) {
        if (args.slice(2).some((a) => mentionsMemory(a)) || upstreamMem || inputMem || subsMem) return hard('central-write');
      }

      // ── 网络外传 ──
      if (NET.test(name)) {
        if (argsMem || args.some((a) => mentionsMemory(a))) return hard('net-arg');
        if (upstreamMem || inputMem) return hard('net-pipe');
      }

      // ── 远程拷贝：参数里出现记忆即拦 ──
      if (REMOTE_COPY.test(name) && (argsMem || infos.some((x) => x.bare))) return hard('copy-out');

      // ── 本地拷贝 / 移动：记忆是源、目标在记忆外才拦 ──
      if (COPY.test(name)) {
        let dest = '';
        const pos: string[] = [];
        for (let k = 0; k < args.length; k++) {
          const a = args[k];
          if (a === '-t' || a === '--target-directory') { dest = args[k + 1] || ''; k++; continue; }
          if (a.startsWith('--target-directory=')) { dest = a.slice(19); continue; }
          if (a === '-e' || a === '--rsh' || a === '-S' || a === '--suffix' || a === '--exclude' || a === '--include' || a === '-m' || a === '-o' || a === '-g') { k++; continue; }
          if (a.startsWith('-') && a !== '-') continue;
          pos.push(a);
        }
        if (!dest && pos.length >= 2) dest = pos.pop() as string;
        const srcs = pos;
        const srcMem = srcs.some((s) => { const x = argInfo(s, cwd); return x.mem || x.bare; });
        if (srcMem) {
          if (!dest) {
            // 只有一个参数（如花括号展开 a.md{,.bak}）：都在记忆内才放行
            if (!srcs.every((s) => argInfo(s, cwd).inside)) return hard('copy-out');
          } else if (!argInfo(dest, cwd).inside) {
            return hard('copy-out');
          }
        }
      }
      if (name === 'dd') {
        const inf = args.find((a) => a.startsWith('if='));
        const of = args.find((a) => a.startsWith('of='));
        const inMem = (inf && argInfo(inf.slice(3), cwd).mem) || (!inf && upstreamMem);
        if (inMem && !(of && argInfo(of.slice(3), cwd).inside)) return hard('copy-out');
      }

      // ── 打包 / 压缩：参数里出现记忆（含 cd 进记忆后的 `.` / `*`）即拦 ──
      if (ARCHIVERS.test(name)) {
        if (argsMem || infos.some((x) => x.bare)) return hard('archive');
        if (cwdIsMemory(cwd)) return hard('archive');
        if (upstreamMem) return hard('archive');
      }

      // ── find -exec / xargs 把记忆交给外传工具 ──
      if (name === 'find' || name === 'fd') {
        const ex = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir' || a === '-x' || a === '-X');
        if (ex >= 0) {
          const tool = base(args[ex + 1] || '');
          const findMem = args.slice(0, ex).some((a) => argInfo(a, cwd).mem || a === 'memory') || cwdIsMemory(cwd);
          if (findMem && (COPY.test(tool) || REMOTE_COPY.test(tool) || ARCHIVERS.test(tool) || NET.test(tool) || tool === 'lark-cli' || tool === 'tee' || tool === 'dd')) return hard('find-exec');
        }
      }
      if (name === 'xargs') {
        let k = 0;
        while (k < args.length && args[k].startsWith('-')) { k += /^-[IdLnPsE]$/.test(args[k]) ? 2 : 1; }
        const tool = base(args[k] || '');
        if ((upstreamMem || args.some((a) => argInfo(a, cwd).mem) || cwdIsMemory(cwd))
          && (COPY.test(tool) || REMOTE_COPY.test(tool) || ARCHIVERS.test(tool) || NET.test(tool) || tool === 'lark-cli' || tool === 'tee' || tool === 'dd')) return hard('xargs');
      }

      // ── tee：上游是记忆、目标在记忆外 ──
      if (name === 'tee' && upstreamMem) {
        const targets = args.filter((a) => !a.startsWith('-'));
        if (targets.some((t) => !argInfo(t, cwd).inside && !/^\/dev\/(null|stderr|stdout|tty)$/.test(t))) return hard('tee-out');
      }

      // ── 重定向：写进记忆放行；记忆内容写到别处拦 ──
      for (const r of redirs) {
        if (r.op !== '>' && r.op !== '>>') continue;
        if (r.fd && r.fd !== '1' && r.fd !== '&') continue; // 2> 等只写诊断信息
        const t = r.target;
        if (/^\/dev\/(null|stderr|stdout|tty|fd\/\d+)$/.test(t)) continue;
        if (argInfo(t, cwd).inside) continue;
        if (readsMem || (name === 'tee' && upstreamMem)) return soft('redirect-out');
      }

      // 本条的输出是否带记忆内容（流向管道下游）
      pipeMem = c.sep === '|' ? (readsMem || (name === 'tee' && upstreamMem)) : false;
    }
    return null;
  }

  // ── 旧规则（字符共现）：仅在词法看不懂时兜底，宁可误拦 ───────────────────
  function legacy(src: string): Verdict | null {
    const tokens = src.split(/\s+/).filter(Boolean)
      .map((t) => t.replace(/^[\s"'`(){}[\]$]+/, '').replace(/[\s"'`(){}[\];,]+$/, ''))
      .filter(Boolean);
    let strong = false;
    let bare = false;
    for (let k = 0; k < tokens.length; k++) {
      const tok = tokens[k];
      if (CLAUDE_RE.test(tok) || /(^|[\\/])MEMORY\.md$/i.test(tok) || /(^|[\\/])memory([\\/]|$)/.test(tok) && tok !== 'memory') { strong = true; break; }
      if (tok === 'memory' && !/^(metabot|luckagent)$/.test(tokens[k - 1] || '')) bare = true;
    }
    if (!strong && !bare) return null;
    for (const t of tokens) {
      const b = base(t);
      if (COPY.test(b) || REMOTE_COPY.test(b) || ARCHIVERS.test(b)) return soft('legacy-fallback');
      if (strong && (NET.test(b) || b === 'tee' || b === 'dd')) return soft('legacy-fallback');
    }
    if (strong && (/(^|[^0-9&<])>{1,2}(?!&)/.test(src) || tokens.some((t) => /(^|[\\/])lark-cli$/.test(t)) || SCRIPT_API.test(src))) {
      return soft('legacy-fallback');
    }
    return null;
  }

  return analyze(cmd, START_CWD, {}, 0);
}

/** PreToolUse 钩子返回值（SDK 与 CLI 同一 schema）。 */
export function denyHookOutput(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/** deny 明细日志（完整命令，一行一条 JSON）的默认位置：bridge 工作目录下 logs/。 */
export function defaultDenialLogPath(): string {
  return path.resolve(process.cwd(), 'logs', 'memory-guard-denials.jsonl');
}

export interface MemoryGuardHookOptions {
  /** 完整 deny 明细写到这里；不传则只打常规日志。 */
  denialLogPath?: string;
  bot?: string;
  chatId?: string;
}

function appendDenial(file: string, entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf8');
  } catch { /* 记日志失败不影响判定 */ }
}

/**
 * SDK 后端：进程内 PreToolUse(Bash) 钩子。命中即 deny，原因回给模型。
 */
export function createMemoryGuardHook(
  log?: { warn: (obj: unknown, msg: string) => void },
  opts: MemoryGuardHookOptions = {},
) {
  return async (input: { tool_name?: string; tool_input?: unknown; cwd?: unknown }): Promise<Record<string, unknown>> => {
    if (input?.tool_name !== 'Bash') return {};
    const ti = (input.tool_input ?? {}) as { command?: unknown };
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
    let hit: GuardVerdict | null;
    try {
      hit = classifyBashCommand(cmd, { cwd });
    } catch (err) {
      // 规则自身出错时放行（桥接层出站检查仍兜底），但留痕便于修
      log?.warn({ err: String(err), command: cmd.slice(0, 300) }, 'memory export guard: classifier error, allowed');
      return {};
    }
    if (!hit) return {};
    log?.warn({ code: hit.code, rule: hit.rule, chatId: opts.chatId, command: cmd.slice(0, 300) }, 'memory export guard: denied Bash command');
    if (opts.denialLogPath) {
      appendDenial(opts.denialLogPath, {
        ts: new Date().toISOString(), backend: 'sdk', bot: opts.bot, chatId: opts.chatId,
        code: hit.code, rule: hit.rule, cwd, command: cmd,
      });
    }
    return denyHookOutput(hit.reason);
  };
}

/**
 * PTY 后端：生成一份独立的 CommonJS 钩子脚本（`node <script>`），从 stdin 读
 * 钩子 JSON，命中时向 stdout 打 deny JSON。分类逻辑直接内嵌
 * `classifyBashCommand` 的源码，与进程内钩子零分叉。
 */
export function buildGuardHookScript(opts: MemoryGuardHookOptions = {}): string {
  const fnSource = classifyBashCommand.toString();
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    '// [design-note U] 记忆库出站闸门 —— PTY 后端 PreToolUse(Bash) 钩子（自动生成，勿手改）',
    `const classifyBashCommand = ${fnSource};`,
    `const DENIAL_LOG = ${JSON.stringify(opts.denialLogPath ?? '')};`,
    `const META = ${JSON.stringify({ bot: opts.bot, chatId: opts.chatId })};`,
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { raw += c; });',
    'process.stdin.on("end", () => {',
    '  let input = {};',
    '  try { input = JSON.parse(raw || "{}"); } catch { input = {}; }',
    '  if (input.tool_name !== "Bash") return;',
    '  const ti = input.tool_input || {};',
    '  const cmd = typeof ti.command === "string" ? ti.command : "";',
    '  const cwd = typeof input.cwd === "string" ? input.cwd : undefined;',
    '  let hit = null;',
    '  try { hit = classifyBashCommand(cmd, { cwd }); } catch { hit = null; }',
    '  if (!hit) return;',
    '  if (DENIAL_LOG) {',
    '    try {',
    '      const fs = require("fs"); const path = require("path");',
    '      fs.mkdirSync(path.dirname(DENIAL_LOG), { recursive: true });',
    '      fs.appendFileSync(DENIAL_LOG, JSON.stringify({ ts: new Date().toISOString(), backend: "pty", bot: META.bot, chatId: META.chatId, code: hit.code, rule: hit.rule, cwd, command: cmd }) + "\\n");',
    '    } catch {}',
    '  }',
    '  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: hit.reason } }));',
    '});',
    '',
  ].join('\n');
}

// ── 桥接层：出站文件检查 ─────────────────────────────────────────────────────

export interface OutboundInspection {
  blocked: boolean;
  reason?: string;
}

const ARCHIVE_EXT_RE = /\.(zip|tar|tgz|tbz2|txz|7z|rar)$|\.tar\.(gz|bz2|xz|zst)$/i;
const TEXT_EXT_RE = /\.(md|markdown|txt)$/i;
const TEXT_INSPECT_MAX_BYTES = 2 * 1024 * 1024;
/** 压缩包里 .md 条目数达到这个数就当作「整库导出」。 */
const ARCHIVE_MD_THRESHOLD = 20;
/** 文本文件里「- [标题](xxx.md) — 摘要」索引行达到这个数就当作记忆索引。 */
const INDEX_LINE_THRESHOLD = 10;

function listArchiveEntries(filePath: string): string[] | null {
  const lower = filePath.toLowerCase();
  let file: string;
  let args: string[];
  if (lower.endsWith('.zip')) {
    file = 'unzip';
    args = ['-Z1', filePath];
  } else if (/\.(tar|tgz|tbz2|txz)$|\.tar\.(gz|bz2|xz|zst)$/.test(lower)) {
    file = 'tar';
    args = ['-tf', filePath];
  } else {
    return null; // .7z / .rar：本机没有稳定的清单工具，交给调用方按「无法检查」处理
  }
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** 压缩包条目清单是否像记忆库（导出的纯规则，便于单测）。 */
export function archiveEntriesLookLikeMemory(entries: string[]): string | null {
  let mdCount = 0;
  for (const e of entries) {
    const norm = e.replace(/\\/g, '/');
    if (/(^|\/)MEMORY\.md$/i.test(norm)) return '压缩包内含记忆索引 MEMORY.md';
    if (/(^|\/)memory\//.test(norm)) return '压缩包内含 memory/ 目录';
    if (/(^|\/)\.claude\//.test(norm)) return '压缩包内含 .claude/ 目录';
    if (/\.md$/i.test(norm)) mdCount++;
  }
  if (mdCount >= ARCHIVE_MD_THRESHOLD) return `压缩包内含 ${mdCount} 个 .md 文件，疑似整库导出`;
  return null;
}

/** 文本正文是否像一条 auto-memory 或记忆索引（导出的纯规则，便于单测）。 */
export function textLooksLikeMemory(text: string): string | null {
  const head = text.split('\n', 25);
  if (head[0]?.trim() === '---') {
    const fm = head.slice(1, 25).join('\n');
    if (/^description:\s*\S/m.test(fm) && /^metadata:\s*$/m.test(fm) && /^\s+type:\s*(user|feedback|project|reference)\b/m.test(fm)) {
      return '正文是 auto-memory 记忆文件（frontmatter 形态）';
    }
  }
  let indexLines = 0;
  for (const line of text.split('\n')) {
    if (/^\s*- \[[^\]]+\]\([^)\s]+\.md\)\s*[—-]/.test(line)) indexLines++;
    if (indexLines >= INDEX_LINE_THRESHOLD) return '正文是记忆索引（MEMORY.md 形态）';
  }
  return null;
}

/**
 * 发送目录里的一个文件发出前的检查。blocked=true 时调用方应删除该文件并通知。
 * 任何检查步骤抛错都按「放行」处理（闸门只针对记忆库，不应误伤普通交付）。
 */
export function inspectOutboundFile(filePath: string, opts: { homeDir?: string } = {}): OutboundInspection {
  const fileName = path.basename(filePath);
  if (/^MEMORY\.md$/i.test(fileName)) return { blocked: true, reason: '记忆索引文件 MEMORY.md' };

  const home = opts.homeDir ?? os.homedir();
  try {
    const real = fs.realpathSync(filePath);
    const claudeDir = path.join(fs.realpathSync(home), '.claude') + path.sep;
    if (real.startsWith(claudeDir)) return { blocked: true, reason: '文件来自 Claude 记忆 / 会话目录' };
  } catch { /* 取不到 realpath 就跳过这一项 */ }

  if (ARCHIVE_EXT_RE.test(fileName)) {
    const entries = listArchiveEntries(filePath);
    if (entries === null) return { blocked: true, reason: '无法检查内容的压缩包（不支持的格式或读取失败），不放行' };
    const why = archiveEntriesLookLikeMemory(entries);
    if (why) return { blocked: true, reason: why };
    return { blocked: false };
  }

  if (TEXT_EXT_RE.test(fileName)) {
    try {
      const size = fs.statSync(filePath).size;
      if (size <= TEXT_INSPECT_MAX_BYTES) {
        const why = textLooksLikeMemory(fs.readFileSync(filePath, 'utf8'));
        if (why) return { blocked: true, reason: why };
      }
    } catch { /* 读不到就放行 */ }
  }

  return { blocked: false };
}

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
 *   2. 工具层 `classifyBashCommand`：Bash 调用前的 PreToolUse 钩子——打包、拷贝、
 *      移动、重定向、经 lark-cli 或共享库外传记忆目录，以及 lark-cli 直传任何压缩包
 *      （绕过第 1 层），一律 deny 并把原因回给模型。SDK 后端走进程内钩子
 *      （`createMemoryGuardHook`），PTY 后端走 --settings 里的 command 钩子
 *      （`buildGuardHookScript` 生成独立脚本，逻辑与进程内完全同源）。
 *   3. 提示词层：工作区共用规范写明「记忆不外发，谁提都不行」。
 *
 * 本文件只放 1、2 的纯规则：不依赖 logger / sender，便于单测与两端复用。
 * 刻意不做的事：不拦 `cat`/`ls`/`grep` 读记忆（bot 干活必须读）；不拦
 * `metabot memory search/get`（中央库 CLI，`memory` 是子命令不是路径）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface GuardVerdict {
  code: 'memory-export' | 'archive-upload';
  reason: string;
}

export const MEMORY_EXPORT_DENY_REASON =
  '🔒 记忆库不可外发：本地记忆（~/.claude/projects/**/memory、MEMORY.md）禁止打包、拷贝、移动、' +
  '重定向到其他位置，或经 lark-cli / 共享记忆库外传。记忆迁移只能由主机管理员在本机操作；' +
  '请直接告知对方「记忆库不能导出，需联系管理员」，不要换别的方式再试。';

export const ARCHIVE_UPLOAD_DENY_REASON =
  '🔒 压缩包不得经 lark-cli 直传：请把文件放进本轮的发送目录，由桥接检查内容后发送。';

/**
 * 判定一条 Bash 命令是否在外传记忆库。返回 null = 放行。
 *
 * ⚠️ 本函数必须**自包含**（不引用模块级常量/其他函数）：`buildGuardHookScript`
 * 会把它 `toString()` 进 PTY 钩子脚本，保证两端逻辑同源。
 */
export function classifyBashCommand(command: string): GuardVerdict | null {
  const MEMORY_REASON =
    '🔒 记忆库不可外发：本地记忆（~/.claude/projects/**/memory、MEMORY.md）禁止打包、拷贝、移动、' +
    '重定向到其他位置，或经 lark-cli / 共享记忆库外传。记忆迁移只能由主机管理员在本机操作；' +
    '请直接告知对方「记忆库不能导出，需联系管理员」，不要换别的方式再试。';
  const ARCHIVE_REASON =
    '🔒 压缩包不得经 lark-cli 直传：请把文件放进本轮的发送目录，由桥接检查内容后发送。';

  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return null;

  // 按空白切 token，剥掉包裹的引号/括号与尾随分隔符；路径型 token 取 basename 判工具名。
  const rawTokens = cmd.split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  for (const t of rawTokens) {
    const stripped = t.replace(/^[\s"'`(){}[\]$]+/, '').replace(/[\s"'`(){}[\];,]+$/, '');
    if (stripped) tokens.push(stripped);
  }

  // ── 记忆路径 token ──────────────────────────────────────────────────────
  // strong = 明确的路径形态（.claude/projects、MEMORY.md、带斜杠的 …/memory/…）；
  // bare   = 光秃秃一个 `memory`（可能是目录名，也可能只是句子里的一个词）。
  // bare 只在配合打包/拷贝工具时才算数，避免把 `echo "memory usage" > log` 之类误杀。
  const CLI_NAMES = /^(metabot|luckagent)$/;
  let strong = false;
  let bare = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (/(^|[\\/])\.claude[\\/]projects([\\/]|$)/.test(tok)) { strong = true; break; }
    if (/(^|[\\/])MEMORY\.md$/i.test(tok)) { strong = true; break; }
    if (/^memory$/.test(tok)) {
      // `metabot memory ...` / `luckagent memory ...` 的 memory 是子命令，不是路径
      const prev = i > 0 ? tokens[i - 1] : '';
      if (!CLI_NAMES.test(prev)) bare = true;
      continue;
    }
    // 带斜杠、末段或中段是 memory 的路径（./memory、memory/、memory/*.md、~/x/memory、a/memory/b.md）
    if (/(^|[\\/])memory([\\/]|$)/.test(tok)) { strong = true; break; }
  }

  const usesLarkCli = tokens.some((t) => /(^|[\\/])lark-cli$/.test(t));

  if (strong || bare) {
    // 打包 / 拷贝 / 移动 / 同步类工具：strong 与 bare 都拦
    const PACKERS =
      /^(zip|unzip|tar|bsdtar|gtar|ditto|rsync|cp|scp|sftp|mv|7z|7za|7zr|gzip|bzip2|xz|zstd|cpio|pax|shar|rclone)$/;
    // 只对明确路径生效的外传工具（tee/curl 等常见于普通命令，bare 词不足以定罪）
    const SENDERS = /^(tee|curl|wget|install|dd)$/;
    for (const t of tokens) {
      const base = t.replace(/^.*[\\/]/, '');
      if (PACKERS.test(base)) return { code: 'memory-export', reason: MEMORY_REASON };
      if (strong && SENDERS.test(base)) return { code: 'memory-export', reason: MEMORY_REASON };
    }
    // 脚本语言里的打包/拷贝 API
    if (/\b(shutil|zipfile|tarfile|make_archive|copytree|copyfile|adm-zip|archiver|JSZip|fs\.cp|copyFileSync?|cpSync)\b/.test(cmd)) {
      return { code: 'memory-export', reason: MEMORY_REASON };
    }
  }

  if (strong) {
    // 重定向到文件（排除 2>/dev/null、>&2、&> 这类 fd 操作）
    if (/(^|[^0-9&<])>{1,2}(?!&)/.test(cmd)) return { code: 'memory-export', reason: MEMORY_REASON };
    // lark-cli 任何子命令（上传 / 建文档 / 发消息）+ 记忆路径 = 外传
    if (usesLarkCli) return { code: 'memory-export', reason: MEMORY_REASON };
    // 写进跨 bot 共享库
    if (/\b(metabot|luckagent)\s+memory\s+(create|import|update|put)\b/.test(cmd)) {
      return { code: 'memory-export', reason: MEMORY_REASON };
    }
  }

  // ── lark-cli 直传压缩包（绕过桥接的文件检查）────────────────────────────
  if (usesLarkCli) {
    const ARCHIVE = /\.(zip|tar|tgz|tbz2|txz|7z|rar)$|\.tar\.(gz|bz2|xz|zst)$/i;
    if (tokens.some((t) => ARCHIVE.test(t))) return { code: 'archive-upload', reason: ARCHIVE_REASON };
  }

  return null;
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

/**
 * SDK 后端：进程内 PreToolUse(Bash) 钩子。命中即 deny，原因回给模型。
 */
export function createMemoryGuardHook(log?: { warn: (obj: unknown, msg: string) => void }) {
  return async (input: { tool_name?: string; tool_input?: unknown }): Promise<Record<string, unknown>> => {
    if (input?.tool_name !== 'Bash') return {};
    const ti = (input.tool_input ?? {}) as { command?: unknown };
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    const hit = classifyBashCommand(cmd);
    if (!hit) return {};
    log?.warn({ code: hit.code, command: cmd.slice(0, 300) }, 'memory export guard: denied Bash command');
    return denyHookOutput(hit.reason);
  };
}

/**
 * PTY 后端：生成一份独立的 CommonJS 钩子脚本（`node <script>`），从 stdin 读
 * 钩子 JSON，命中时向 stdout 打 deny JSON。分类逻辑直接内嵌
 * `classifyBashCommand` 的源码，与进程内钩子零分叉。
 */
export function buildGuardHookScript(): string {
  const fnSource = classifyBashCommand.toString();
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    '// [design-note U] 记忆库出站闸门 —— PTY 后端 PreToolUse(Bash) 钩子（自动生成，勿手改）',
    `const classifyBashCommand = ${fnSource};`,
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (c) => { raw += c; });',
    'process.stdin.on("end", () => {',
    '  let input = {};',
    '  try { input = JSON.parse(raw || "{}"); } catch { input = {}; }',
    '  if (input.tool_name !== "Bash") return;',
    '  const ti = input.tool_input || {};',
    '  const cmd = typeof ti.command === "string" ? ti.command : "";',
    '  const hit = classifyBashCommand(cmd);',
    '  if (!hit) return;',
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

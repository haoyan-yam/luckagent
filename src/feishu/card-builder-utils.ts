/**
 * Shared utilities for Feishu card builders (v1 and v2).
 *
 * Both card-builder.ts (schema v1) and card-builder-v2.ts (schema v2) use
 * the same status config, background-task icons, content length limit, and
 * truncation helpers.  This file is the single source of truth; import from
 * here — do NOT copy these into individual builder files.
 */
import type { BackgroundEvent, CardStatus } from '../types.js';

// ---------------------------------------------------------------------------
// Status display config
// ---------------------------------------------------------------------------

export const STATUS_CONFIG: Record<CardStatus, { color: string; title: string; icon: string }> = {
  thinking:          { color: 'blue',   title: 'Thinking...',       icon: '🔵' },
  running:           { color: 'blue',   title: 'Running...',        icon: '🔵' },
  complete:          { color: 'green',  title: 'Complete',          icon: '🟢' },
  error:             { color: 'red',    title: 'Error',             icon: '🔴' },
  waiting_for_input: { color: 'yellow', title: 'Waiting for Input', icon: '🟡' },
  // Blue with a distinct title so users can tell a between-turn burst card
  // apart from both a live "running" turn and a finished "complete" reply
  // without reading body text.  See message-bridge.flushSpontaneous.
  agent_activity:    { color: 'blue',   title: 'Agent activity',    icon: '🔵' },
};

// ---------------------------------------------------------------------------
// Background-task status icons
// ---------------------------------------------------------------------------

export const BG_ICON: Record<'running' | 'completed' | 'failed' | 'stopped', string> = {
  running:   '⏳',
  completed: '✅',
  failed:    '❌',
  stopped:   '⏹️',
};

// ---------------------------------------------------------------------------
// Background section rendering  [design-note R]
// ---------------------------------------------------------------------------

/** 逐条列出的（非 completed）后台任务行数上限，超出折叠成计数。 */
const MAX_BG_LINES = 6;

/**
 * [design-note R] 后台任务区块统一渲染（v1/v2 builder 共用，勿各自复制）。
 * 收敛规则——与工具行「用户只关心最终答案」同一哲学：
 *   - 终卡（complete/error）整块隐藏，后台结果由最终回复正文交代；
 *   - 只逐条列 failed/stopped/running（失败优先，保证可见），completed 折叠为计数；
 *   - 逐条上限 MAX_BG_LINES，溢出折叠成「另有 N 个运行中」。
 * 描述/lastEvent 的去代码化（人话关联、命令回显判重、去 URL）在数据层
 * stream-processor 完成，这里只管排版。
 */
export function formatBackgroundSection(
  events: BackgroundEvent[] | undefined,
  status: CardStatus,
): string | null {
  if (!events || events.length === 0) return null;
  if (status === 'complete' || status === 'error') return null;

  const failed  = events.filter((ev) => ev.status === 'failed' || ev.status === 'stopped');
  const running = events.filter((ev) => ev.status === 'running');
  const done    = events.length - failed.length - running.length;

  const listed = [...failed, ...running].slice(0, MAX_BG_LINES);
  const lines = listed.map((ev) => {
    const icon    = BG_ICON[ev.status];
    const shortId = ev.taskId.slice(0, 6);
    const desc    = truncate(ev.description, 60);
    const last    = ev.lastEvent ? ` — _${truncate(ev.lastEvent, 100)}_` : '';
    return `${icon} **${desc}** \`${shortId}\`${last}`;
  });
  const hidden = failed.length + running.length - listed.length;
  if (hidden > 0) lines.push(`… 另有 ${hidden} 个运行中`);
  if (done > 0) lines.push(`✅ ${done} 个已完成`);
  return '📡 **Background**\n' + lines.join('\n');
}

// ---------------------------------------------------------------------------
// Content truncation
// ---------------------------------------------------------------------------

/** Hard character limit for response text sent to Feishu. */
export const MAX_CONTENT_LENGTH = 28000;

/**
 * Truncate `text` to `max` characters, appending an ellipsis if shortened.
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

/**
 * Truncate response body to `MAX_CONTENT_LENGTH`, keeping the head and tail
 * so that both the opening and closing context are visible to the user.
 */
export function truncateContent(text: string): string {
  if (text.length <= MAX_CONTENT_LENGTH) return text;
  const half = Math.floor(MAX_CONTENT_LENGTH / 2) - 50;
  return text.slice(0, half) + '\n\n... (content truncated) ...\n\n' + text.slice(-half);
}

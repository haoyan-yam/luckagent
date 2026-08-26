import type { SDKMessage } from './executor.js';
import type {
  BackgroundEvent,
  BackgroundTaskStatus,
  CardState,
  ToolCall,
  PendingQuestion,
} from '../../feishu/card-builder.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.tiff']);

/**
 * Tools handled by the SDK in bypassPermissions mode.
 * The SDK auto-responds to these; we only detect them for side effects
 * (e.g. sending plan content to the user) — we must NOT call sendAnswer
 * or we'll create duplicate tool_results that cause API 400 errors.
 */
const SDK_HANDLED_TOOLS = new Set(['ExitPlanMode', 'EnterPlanMode']);

export interface DetectedTool {
  toolUseId: string;
  name: string;
}

export class StreamProcessor {
  private responseText = '';
  private toolCalls: ToolCall[] = [];
  private currentToolName: string | null = null;
  private sessionId: string | undefined;
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private _imagePaths: Set<string> = new Set();
  private _pendingQuestions: PendingQuestion[] = [];
  private _sdkHandledTools: DetectedTool[] = [];
  private _planFilePath: string | null = null;
  /** Plan markdown captured directly from the ExitPlanMode tool_use input. */
  private _planContent: string | null = null;
  private _model: string | undefined;
  private _totalTokens: number | undefined;
  private _contextWindow: number | undefined;
  // Track per-API-call usage from stream events for accurate context window display
  private _lastInputTokens: number | undefined;
  private _lastOutputTokens: number | undefined;
  // Live background tasks (Monitor, etc.) — task_id → latest rollup.
  private _backgroundEvents: Map<string, BackgroundEvent> = new Map();
  // [design-note R] 后台任务卡片降噪。Bash run_in_background 任务的 SDK
  // task_started.description 就是命令原文，直接上卡就是一墙 shell + 蓝链 URL
  //（2026-08 生产截图实锤）。这里在 tool_use 块出现时记下模型写的
  // 人话 description 参数，task 事件到达后经 tool_use_id（或命令原文匹配）
  // 关联回来，卡片展示人话而非命令。
  private _bgBashByToolUse: Map<string, { human: string; command: string }> = new Map();
  private _bgHumanDescByTask: Map<string, string> = new Map();
  private _bgRawDescByTask: Map<string, string> = new Map();

  constructor(private userPrompt: string) {}

  processMessage(message: SDKMessage): CardState {
    // Capture session_id from any message
    if (message.session_id) {
      this.sessionId = message.session_id;
    }

    switch (message.type) {
      case 'system':
        // SDK emits task_started / task_progress / task_notification / task_updated
        // as type='system' with a specific subtype. Surface them so Feishu can
        // show background task (e.g. Monitor) progress mid-turn.
        this.processSystemMessage(message);
        break;

      case 'assistant':
        this.processAssistantMessage(message);
        break;

      case 'result':
        return this.processResultMessage(message);

      case 'stream_event':
        this.processStreamEvent(message);
        break;

      case 'tool_use_summary':
        break;
    }

    // Determine running status
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestions.length > 0
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';

    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      model: this._model,
      totalTokens: this._totalTokens,
      contextWindow: this._contextWindow,
      pendingQuestion: this._pendingQuestions[0] || undefined,
      backgroundEvents: this._backgroundEvents.size > 0
        ? [...this._backgroundEvents.values()]
        : undefined,
    };
  }

  private processSystemMessage(message: SDKMessage): void {
    const subtype = (message as { subtype?: string }).subtype;
    if (!subtype) return;
    switch (subtype) {
      case 'task_started':
      case 'task_progress':
      case 'task_notification':
      case 'task_updated':
        this.recordTaskEvent(message, subtype);
        break;
      default:
        break;
    }
  }

  private recordTaskEvent(message: SDKMessage, subtype: string): void {
    const m = message as Record<string, unknown>;
    const taskId = typeof m.task_id === 'string' ? m.task_id : undefined;
    if (!taskId) return;

    // Ambient/housekeeping tasks (skip_transcript=true) stay hidden from the card.
    if (m.skip_transcript === true) return;

    const prior = this._backgroundEvents.get(taskId);
    const patch = (m.patch as Record<string, unknown> | undefined) ?? undefined;
    // [design-note R] rawDesc 保留 SDK 原文（shell 任务 = 命令原文），只用于
    // 命令回显判重和人话关联，不再直接上卡。
    const rawDesc = typeof m.description === 'string'
      ? m.description
      : (typeof patch?.description === 'string' ? patch.description as string : this._bgRawDescByTask.get(taskId));
    if (rawDesc) this._bgRawDescByTask.set(taskId, rawDesc);

    // [design-note R] 人话标签：优先 tool_use_id 精确关联；SDK 未带
    // tool_use_id 时退回「任务描述 == Bash 命令原文」匹配。一旦定下就按
    // task_id 记住，后续事件不再依赖 tool_use_id。
    // 模型没写 description 时（生产实测很常见）退而求其次：从命令里取主程序名
    // 当标签（`opencli` / `curl` / `lark-cli`），不泄命令原文又能区分多个任务。
    const toolUseId = typeof m.tool_use_id === 'string' ? m.tool_use_id : undefined;
    if (!this._bgHumanDescByTask.has(taskId)) {
      const linked = toolUseId ? this._bgBashByToolUse.get(toolUseId) : undefined;
      const matched = linked ?? (rawDesc ? this.findBashByCommand(rawDesc) : undefined);
      const label = matched
        ? (matched.human || commandLabel(matched.command))
        : (rawDesc && looksLikeShellCommand(rawDesc) ? commandLabel(rawDesc) : undefined);
      if (label) this._bgHumanDescByTask.set(taskId, label);
    }
    const humanDesc = this._bgHumanDescByTask.get(taskId);

    let status: BackgroundTaskStatus = prior?.status ?? 'running';
    if (subtype === 'task_notification') {
      const s = typeof m.status === 'string' ? m.status : undefined;
      if (s === 'completed' || s === 'failed' || s === 'stopped') status = s;
    } else if (subtype === 'task_updated') {
      const s = typeof patch?.status === 'string' ? patch.status as string : undefined;
      if (s === 'completed') status = 'completed';
      else if (s === 'failed' || s === 'killed') status = 'failed';
      else if (s === 'running') status = 'running';
    }

    // SDKTaskNotificationMessage.summary carries the last-line event text for Monitor
    // and the final message for one-shot background tasks. SDKTaskProgressMessage
    // also exposes an optional summary for in-flight updates.
    // [design-note R] shell 任务的 summary 常常只是命令回显——与 rawDesc
    // 重复时丢弃；保留下来的展示文本一律去 URL（飞书会渲染成蓝链，极其扎眼）。
    const summary = typeof m.summary === 'string' ? m.summary : undefined;
    const isShellTask = rawDesc !== undefined && looksLikeShellCommand(rawDesc);
    const cleanSummary = summary && !(isShellTask && isCommandEcho(summary, rawDesc))
      ? stripUrls(summary)
      : undefined;
    const lastEvent = cleanSummary ?? prior?.lastEvent;

    // [design-note R] 展示名：人话/程序名标签 > 非 shell 的原描述（去 URL）> 通用。
    const displayDesc = humanDesc
      ?? (rawDesc !== undefined
        ? (isShellTask ? commandLabel(rawDesc) : stripUrls(rawDesc))
        : prior?.description ?? '后台任务');

    this._backgroundEvents.set(taskId, {
      taskId,
      description: displayDesc,
      status,
      lastEvent,
    });
  }

  /** [design-note R] 按命令原文反查 Bash 调用（SDK 事件缺 tool_use_id 时的兜底）。 */
  private findBashByCommand(rawDesc: string): { human: string; command: string } | undefined {
    const norm = normalizeWhitespace(rawDesc);
    if (norm.length < 8) return undefined;
    for (const entry of this._bgBashByToolUse.values()) {
      const cmd = normalizeWhitespace(entry.command);
      const n = Math.min(norm.length, cmd.length);
      if (n >= 8 && norm.slice(0, n) === cmd.slice(0, n)) return entry;
    }
    return undefined;
  }

  private processAssistantMessage(message: SDKMessage): void {
    if (!message.message?.content) return;

    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) {
        // Only accumulate text from top-level assistant messages (not subagent)
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          // Full message text replaces accumulated stream text
          this.responseText = block.text;
        }
      } else if (block.type === 'tool_use' && block.name) {
        this.addToolCall(block.name, block.input);
        // [design-note R] Bash：记下模型写的人话 description，供 task 事件
        // 关联（SDK 的任务描述是命令原文，不适合直接给用户看）。
        // ⚠️ 不能只登记 run_in_background===true 的调用：0818 生产
        // 会话实锤，落进 📡 Background 区块的 8 条命令 run_in_background 全是
        // false（长命令被运行时转为任务跟踪），只认后台标志会一条都关联不上。
        if (block.name === 'Bash' && block.id && block.input && typeof block.input === 'object') {
          const binp = block.input as Record<string, unknown>;
          if (typeof binp.command === 'string') {
            const human = typeof binp.description === 'string' ? binp.description.trim() : '';
            this._bgBashByToolUse.set(block.id, {
              human,
              command: binp.command,
            });
          }
        }
        // Detect interactive tools at top level
        if (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined) {
          if (block.name === 'AskUserQuestion' && block.id && block.input) {
            this.extractPendingQuestion(block.id, block.input);
          } else if (SDK_HANDLED_TOOLS.has(block.name) && block.id) {
            this._sdkHandledTools.push({ toolUseId: block.id, name: block.name });
            // Capture the plan markdown straight from the tool input so the
            // bridge can show it even when the agent didn't Write a plan file.
            if (block.name === 'ExitPlanMode') {
              const plan = (block.input as { plan?: unknown } | undefined)?.plan;
              if (typeof plan === 'string' && plan.trim()) this._planContent = plan;
            }
          }
        }
      } else if (block.type === 'tool_result') {
        this.completeCurrentTool();
      }
    }
  }

  private processStreamEvent(message: SDKMessage): void {
    const event = message.event;
    if (!event) return;

    // Track message_start/message_delta from ALL levels (not just top-level)
    // because these carry per-API-call token usage needed for context display
    if (event.type === 'message_start') {
      const usage = (event as any).message?.usage;
      if (usage) {
        this._lastInputTokens = (usage.input_tokens ?? 0)
          + (usage.cache_read_input_tokens ?? 0)
          + (usage.cache_creation_input_tokens ?? 0);
      }
    } else if (event.type === 'message_delta') {
      const usage = (event as any).usage;
      if (usage?.output_tokens != null) {
        this._lastOutputTokens = usage.output_tokens;
      }
    }

    // Only process top-level stream events for content
    if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) {
      return;
    }

    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block?.type === 'tool_use' && block.name) {
        this.addToolCall(block.name, undefined);
      }
      if (block?.type === 'text') {
        // Reset for new text block
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        this.responseText += delta.text;
      }
    } else if (event.type === 'content_block_stop') {
      // Tool may be complete
      // Actual completion is tracked via assistant messages
    }
  }

  private processResultMessage(message: SDKMessage): CardState {
    this.costUsd = message.total_cost_usd;
    this.durationMs = message.duration_ms;

    // Extract model usage info (per-model breakdown from SDK)
    if (message.modelUsage) {
      const models = Object.keys(message.modelUsage);
      if (models.length > 0) {
        // Primary model is the one with highest cost
        const primaryModel = models.reduce((a, b) =>
          (message.modelUsage![a].costUSD ?? 0) >= (message.modelUsage![b].costUSD ?? 0) ? a : b
        );
        const mu = message.modelUsage[primaryModel];
        this._model = primaryModel;
        this._contextWindow = mu.contextWindow;
        // Use last API call's tokens from stream events (accurate context window occupation)
        // Falls back to cumulative modelUsage input+output if stream events weren't captured
        if (this._lastInputTokens != null) {
          this._totalTokens = this._lastInputTokens + (this._lastOutputTokens ?? 0);
        } else {
          let totalTokens = 0;
          for (const m of models) {
            totalTokens += (message.modelUsage![m].inputTokens ?? 0);
            totalTokens += (message.modelUsage![m].outputTokens ?? 0);
          }
          this._totalTokens = totalTokens;
        }
      }
    }

    // Mark all tools as done
    for (const tool of this.toolCalls) {
      tool.status = 'done';
    }

    const resultText = message.result || this.responseText;
    const isError = message.subtype !== 'success';
    // SDK sometimes wraps API errors as "success" with the error text as result
    const isApiError = !isError && isApiErrorResult(resultText);

    return {
      status: (isError || isApiError) ? 'error' : 'complete',
      userPrompt: this.userPrompt,
      responseText: isApiError ? '' : resultText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      errorMessage: isError
        ? (message.errors?.join('; ') || `Ended with: ${message.subtype}`)
        : isApiError ? resultText : undefined,
      model: this._model,
      totalTokens: this._totalTokens,
      contextWindow: this._contextWindow,
      backgroundEvents: this._backgroundEvents.size > 0
        ? [...this._backgroundEvents.values()]
        : undefined,
    };
  }

  private addToolCall(name: string, input: unknown): void {
    // Complete previous tool
    this.completeCurrentTool();

    this.currentToolName = name;
    const detail = formatToolDetail(name, input);
    this.toolCalls.push({ name, detail, status: 'running' });

    // Track image file paths and plan file paths from Write tool
    if (name === 'Write' && input && typeof input === 'object') {
      const filePath = (input as Record<string, unknown>).file_path as string;
      if (filePath && isImagePath(filePath)) {
        this._imagePaths.add(filePath);
      }
      if (filePath && filePath.includes('.claude/plans/') && filePath.endsWith('.md')) {
        this._planFilePath = filePath;
      }
    }
  }

  private completeCurrentTool(): void {
    if (this.currentToolName) {
      const tool = this.toolCalls.find(
        (t) => t.name === this.currentToolName && t.status === 'running',
      );
      if (tool) {
        tool.status = 'done';
      }
      this.currentToolName = null;
    }
  }

  private extractPendingQuestion(toolUseId: string, input: unknown): void {
    if (!input || typeof input !== 'object') return;
    const inp = input as Record<string, unknown>;
    const questions = inp.questions;
    if (!Array.isArray(questions)) return;

    const parsed = questions.map((q: any) => ({
      question: String(q.question || ''),
      header: String(q.header || ''),
      options: Array.isArray(q.options)
        ? q.options.map((o: any) => ({
            label: String(o.label || ''),
            description: String(o.description || ''),
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }));

    // Queue instead of overwrite — supports multiple AskUserQuestion calls
    this._pendingQuestions.push({ toolUseId, questions: parsed });
  }

  /** Remove the first pending question (after it's been fully answered). */
  clearPendingQuestion(): void {
    this._pendingQuestions.shift();
  }

  /** Peek at the first pending question without removing it. */
  getPendingQuestion(): PendingQuestion | null {
    return this._pendingQuestions[0] ?? null;
  }

  /**
   * Get and clear any SDK-handled tools detected in the stream.
   * These tools are auto-responded to by the SDK in bypassPermissions mode;
   * the bridge should NOT call sendAnswer for them, only perform side effects
   * like sending plan content to the user.
   */
  drainSdkHandledTools(): DetectedTool[] {
    if (this._sdkHandledTools.length === 0) return [];
    const tools = [...this._sdkHandledTools];
    this._sdkHandledTools = [];
    return tools;
  }

  /** Return the current card state without processing a new message. */
  getCurrentState(): CardState {
    const hasActiveTools = this.toolCalls.some((t) => t.status === 'running');
    const status = this._pendingQuestions.length > 0
      ? 'waiting_for_input'
      : hasActiveTools ? 'running' : this.responseText ? 'running' : 'thinking';
    return {
      status,
      userPrompt: this.userPrompt,
      responseText: this.responseText,
      toolCalls: [...this.toolCalls],
      costUsd: this.costUsd,
      durationMs: this.durationMs,
      model: this._model,
      totalTokens: this._totalTokens,
      contextWindow: this._contextWindow,
      pendingQuestion: this._pendingQuestions[0] || undefined,
      backgroundEvents: this._backgroundEvents.size > 0
        ? [...this._backgroundEvents.values()]
        : undefined,
    };
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getImagePaths(): string[] {
    return [...this._imagePaths];
  }

  getPlanFilePath(): string | null {
    return this._planFilePath;
  }

  /** Plan markdown from the ExitPlanMode tool input, if present. */
  getPlanContent(): string | null {
    return this._planContent;
  }
}

function isImagePath(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

/** Scan text for absolute image file paths */
export function extractImagePaths(text: string): string[] {
  const pathRegex = /\/[\w./_-]+\.(?:png|jpe?g|gif|webp|bmp|svg|tiff)/gi;
  const matches = text.match(pathRegex) || [];
  return [...new Set(matches)];
}

function formatToolDetail(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';

  const inp = input as Record<string, unknown>;

  switch (name) {
    case 'Read':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Write':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Edit':
      return inp.file_path ? `\`${shortenPath(inp.file_path as string)}\`` : '';
    case 'Bash':
      return inp.command ? `\`${truncate(inp.command as string, 60)}\`` : '';
    case 'Glob':
      return inp.pattern ? `\`${inp.pattern}\`` : '';
    case 'Grep':
      return inp.pattern ? `\`${inp.pattern}\`` : '';
    case 'WebSearch':
      return inp.query ? `"${truncate(inp.query as string, 50)}"` : '';
    case 'WebFetch':
      return inp.url ? `\`${truncate(inp.url as string, 60)}\`` : '';
    case 'Task':
      return inp.description ? `${inp.description}` : '';
    case 'AskUserQuestion': {
      const qs = inp.questions;
      if (Array.isArray(qs) && qs.length > 0) {
        const first = qs[0] as Record<string, unknown>;
        return first.question ? truncate(String(first.question), 50) : '';
      }
      return '';
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// [design-note R] 后台任务展示文本清洗
// ---------------------------------------------------------------------------

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * [design-note R] 判断一段任务描述是否像 shell 命令原文。
 * 只用于「关联不到人话 description 时该不该把原文上卡」——误判为 shell 的
 * 代价只是显示通用标签「后台命令」，两个结果都干净，无需完美。
 */
export function looksLikeShellCommand(text: string): boolean {
  return (
    /(\$\(|&&|\|\||\s\|\s|<<|>>|2>&1|`)/.test(text) ||
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(text) ||
    /^\s*(for|while|if|cd|cat|curl|wget|env|bash|sh|node|python3?|npx|git|osascript|opencli)\s/.test(text)
  );
}

/**
 * [design-note R] 从命令里取主程序名当展示标签。
 * 模型没写 description 时的兜底——0818 生产会话里 8 条进 Background 的
 * 命令全都没有 description，若统一显示「后台命令」则彼此不可区分（失败的那条
 * 看不出是什么活）。这里跳过 `cd` / 环境变量赋值 / `for`·`until` 等控制结构，
 * 取第一个真正的可执行名（`opencli`、`curl`、`lark-cli`…）。程序名不是命令原文，
 * 不含参数/URL/路径，可安全上卡。取不到时回落通用标签。
 */
export function commandLabel(command: string): string {
  const GENERIC = '后台命令';
  const SKIP_WORDS = new Set([
    'cd', 'for', 'in', 'do', 'done', 'while', 'until', 'if', 'then', 'else', 'fi',
    'sudo', 'env', 'time', 'nohup', 'exec', 'command', 'builtin',
    'echo', 'true', 'false', 'set', 'source', 'eval',
  ]);
  // 先掐掉子命令替换与引号里的内容，避免把 $(...) / "..." 里的词当主程序
  const flat = command
    .replace(/\$\([^)]*\)/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/'[^']*'/g, ' ')
    .replace(/"[^"]*"/g, ' ');
  let skipNext = false;   // `for u in …` 的循环变量：跟在 for 后面的那个词不是程序名
  for (const token of flat.split(/[\s;|&(){}]+/)) {
    const t = token.trim();
    if (!t) continue;
    if (/^[-<>]/.test(t)) continue;                 // 选项 / 重定向
    if (/[=$]/.test(t)) continue;                   // 变量赋值 / 变量引用
    if (skipNext) { skipNext = false; continue; }
    if (SKIP_WORDS.has(t)) {
      if (t === 'for') skipNext = true;
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(t)) continue;
    const name = t.includes('/') ? t.slice(t.lastIndexOf('/') + 1) : t;
    if (name.length > 24) continue;
    return `${GENERIC} · ${name}`;
  }
  return GENERIC;
}

/** [design-note R] summary 是否只是命令原文的回显（前缀重合即视为回显）。 */
function isCommandEcho(summary: string, rawDesc: string): boolean {
  const a = normalizeWhitespace(summary);
  const b = normalizeWhitespace(rawDesc);
  if (!a || !b) return false;
  const n = Math.min(a.length, b.length, 60);
  if (n < 16) return a === b;
  return a.slice(0, n) === b.slice(0, n);
}

/** [design-note R] URL 替换为占位符——飞书会把 URL 渲染成蓝链，在状态行里极其扎眼。 */
export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, '[链接]');
}

function shortenPath(filePath: string): string {
  const parts = filePath.split('/');
  if (parts.length <= 3) return filePath;
  return '.../' + parts.slice(-2).join('/');
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}

/** Detect API error responses that the SDK wraps as successful results */
function isApiErrorResult(text: string): boolean {
  if (!text) return false;
  return /^API Error:\s*\d{3}\s/i.test(text);
}

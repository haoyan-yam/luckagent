import { describe, it, expect } from 'vitest';
import { StreamProcessor, extractImagePaths } from '../src/engines/claude/stream-processor.js';
import type { SDKMessage } from '../src/engines/claude/executor.js';

function msg(overrides: Partial<SDKMessage>): SDKMessage {
  return { type: 'system', session_id: 'sess-1', ...overrides } as SDKMessage;
}

describe('StreamProcessor', () => {
  it('starts in thinking status', () => {
    const p = new StreamProcessor('hello');
    const state = p.processMessage(msg({ type: 'system', session_id: 'sess-1' }));
    expect(state.status).toBe('thinking');
    expect(state.userPrompt).toBe('hello');
    expect(state.responseText).toBe('');
    expect(state.toolCalls).toEqual([]);
  });

  it('captures session_id from first message', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({ type: 'system', session_id: 'abc-123' }));
    expect(p.getSessionId()).toBe('abc-123');
  });

  it('accumulates text from stream_event deltas', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'text' } },
    }));
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } },
    }));
    expect(state.responseText).toBe('Hello world');
    expect(state.status).toBe('running');
  });

  it('tracks tool calls from stream events', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Read' } },
    }));
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].name).toBe('Read');
    expect(state.toolCalls[0].status).toBe('running');
    expect(state.status).toBe('running');
  });

  it('ignores subagent stream events', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: 'tool-123',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'subagent text' } },
    }));
    expect(state.responseText).toBe('');
  });

  it('processes result message as complete', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'success',
      result: 'Done!',
      total_cost_usd: 0.05,
      duration_ms: 1200,
    }));
    expect(state.status).toBe('complete');
    expect(state.responseText).toBe('Done!');
    expect(state.costUsd).toBe(0.05);
    expect(state.durationMs).toBe(1200);
  });

  it('processes error result message', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'error',
      result: '',
      errors: ['Something failed', 'Another error'],
      total_cost_usd: 0.01,
      duration_ms: 500,
    }));
    expect(state.status).toBe('error');
    expect(state.errorMessage).toBe('Something failed; Another error');
  });

  it('detects AskUserQuestion and sets waiting_for_input', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-q1',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              question: 'Which option?',
              header: 'Choice',
              options: [
                { label: 'A', description: 'Option A' },
                { label: 'B', description: 'Option B' },
              ],
              multiSelect: false,
            }],
          },
        }],
      },
    }));
    expect(state.status).toBe('waiting_for_input');
    expect(state.pendingQuestion).toBeDefined();
    expect(state.pendingQuestion!.toolUseId).toBe('tool-q1');
    expect(state.pendingQuestion!.questions[0].question).toBe('Which option?');
  });

  it('tracks Write tool image paths', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/tmp/output.png' },
        }],
      },
    }));
    expect(p.getImagePaths()).toEqual(['/tmp/output.png']);
  });

  it('does not track non-image Write paths', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          name: 'Write',
          input: { file_path: '/tmp/output.txt' },
        }],
      },
    }));
    expect(p.getImagePaths()).toEqual([]);
  });

  it('detects ExitPlanMode as SDK-handled tool', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-plan1',
          name: 'ExitPlanMode',
          input: {},
        }],
      },
    }));
    const tools = p.drainSdkHandledTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].toolUseId).toBe('tool-plan1');
    expect(tools[0].name).toBe('ExitPlanMode');
    // Second drain should be empty
    expect(p.drainSdkHandledTools()).toHaveLength(0);
  });

  it('does not detect ExitPlanMode from subagent', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: 'parent-123',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool-plan2',
          name: 'ExitPlanMode',
          input: {},
        }],
      },
    }));
    expect(p.drainSdkHandledTools()).toHaveLength(0);
  });

  it('marks all tools as done on result', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } },
    }));
    const state = p.processMessage(msg({
      type: 'result',
      subtype: 'success',
      result: 'ok',
    }));
    expect(state.toolCalls.every(t => t.status === 'done')).toBe(true);
  });
});

describe('StreamProcessor background task events', () => {
  it('surfaces task_started as a running background event', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'system',
      subtype: 'task_started',
      task_id: 't-1',
      description: 'Watching CI for PR #215',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents).toEqual([
      { taskId: 't-1', description: 'Watching CI for PR #215', status: 'running', lastEvent: undefined },
    ]);
  });

  it('updates description + lastEvent on task_progress', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 't-1', description: 'Watching CI',
    } as unknown as SDKMessage));
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_progress', task_id: 't-1',
      description: 'Watching CI', summary: 'check (20) running',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0]).toEqual({
      taskId: 't-1', description: 'Watching CI', status: 'running', lastEvent: 'check (20) running',
    });
  });

  it('marks a task completed with its final summary on task_notification', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 't-1', description: 'Watch build',
    } as unknown as SDKMessage));
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 't-1',
      status: 'completed', summary: 'CI done: success',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0]).toMatchObject({
      taskId: 't-1', status: 'completed', lastEvent: 'CI done: success',
    });
  });

  it('picks up failed / stopped statuses from task_notification', () => {
    const p = new StreamProcessor('hi');
    const failed = p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 't-fail',
      status: 'failed', summary: 'crashed',
    } as unknown as SDKMessage));
    expect(failed.backgroundEvents?.[0].status).toBe('failed');

    const stopped = p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 't-stop',
      status: 'stopped',
    } as unknown as SDKMessage));
    expect(stopped.backgroundEvents?.find(e => e.taskId === 't-stop')?.status).toBe('stopped');
  });

  it('applies status patches from task_updated', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 't-1', description: 'Watch build',
    } as unknown as SDKMessage));
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_updated', task_id: 't-1',
      patch: { status: 'killed' },
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0].status).toBe('failed');
  });

  it('hides ambient / skip_transcript tasks from the card', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'housekeeping',
      description: 'Ambient thing', skip_transcript: true,
    } as unknown as SDKMessage));
    expect(state.backgroundEvents).toBeUndefined();
  });

  it('ignores task events without a task_id', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', description: 'no id',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents).toBeUndefined();
  });

  it('renders Codex translator task_notification events too', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'task_notification', session_id: 'codex-sess', result: 'rate limited',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0]).toMatchObject({
      taskId: 'codex-sess', lastEvent: 'rate limited',
    });
  });

  it('propagates backgroundEvents through the result message', () => {
    const p = new StreamProcessor('hi');
    p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 't-1',
      status: 'completed', summary: 'done',
    } as unknown as SDKMessage));
    const result = p.processMessage(msg({
      type: 'result', subtype: 'success', result: 'all set', total_cost_usd: 0, duration_ms: 10,
    }));
    expect(result.status).toBe('complete');
    expect(result.backgroundEvents?.[0]).toMatchObject({ taskId: 't-1', status: 'completed' });
  });
});

// [design-note R] 后台任务卡片降噪：命令原文不上卡。
describe('StreamProcessor background task de-noising (patch R)', () => {
  const COMMAND = 'for u in "http://xhslink.cn/o/AAAA1111" "http://xhslink.cn/o/BBBB2222"; do opencli browser xhs open "$u"; done';

  function bashToolUse(
    p: StreamProcessor,
    id: string,
    human: string | undefined,
    command = COMMAND,
    background = true,
  ): void {
    p.processMessage(msg({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [{
          type: 'tool_use', id, name: 'Bash',
          input: {
            command,
            ...(human ? { description: human } : {}),
            run_in_background: background,
          },
        }],
      },
    } as unknown as SDKMessage));
  }

  it('shows the Bash description param instead of the raw command (tool_use_id link)', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', '后台打开小红书链接');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      tool_use_id: 'tu-1', description: COMMAND,
    } as unknown as SDKMessage));
    const ev = state.backgroundEvents?.find((e) => e.taskId === 'b1');
    expect(ev?.description).toBe('后台打开小红书链接');
    expect(ev?.description).not.toContain('xhslink');
  });

  it('falls back to matching the command text when the task event lacks tool_use_id', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', '后台打开小红书链接');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1', description: COMMAND,
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0].description).toBe('后台打开小红书链接');
  });

  it('labels shell tasks by their main binary when no tool call is linked', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      description: 'U=$(sed -n 1p x.txt) && opencli xiaohongshu note "$U" 2>&1 | tee out.json',
    } as unknown as SDKMessage));
    // 主程序名可区分多个任务，且不含参数/URL/路径
    expect(state.backgroundEvents?.[0].description).toBe('后台命令 · opencli');
  });

  // 0818 生产实锤：进 Background 区块的命令 run_in_background=false
  // 且没有 description —— 只认后台标志会一条都关联不上。
  it('links foreground Bash calls too (run_in_background=false)', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', '打开小红书笔记页', COMMAND, false);
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      tool_use_id: 'tu-1', description: COMMAND,
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0].description).toBe('打开小红书笔记页');
  });

  it('falls back to the binary label when the linked Bash call has no description', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', undefined, 'cd /Users/me/projects/demo/work && for u in "http://xhslink.cn/o/x"; do opencli browser xhs open "$u"; done', false);
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      tool_use_id: 'tu-1',
      description: 'cd /Users/me/projects/demo/work && for u in "http://xhslink.cn/o/x"; do opencli browser xhs open "$u"; done',
    } as unknown as SDKMessage));
    const desc = state.backgroundEvents?.[0].description ?? '';
    expect(desc).toBe('后台命令 · opencli');   // 跳过 cd/for，取真正的可执行名
    expect(desc).not.toContain('xhslink');     // 不泄 URL
    expect(desc).not.toContain('/Users/');     // 不泄本机路径
  });

  it('keeps human descriptions (Monitor etc.) verbatim', () => {
    const p = new StreamProcessor('hi');
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'm1',
      description: 'Watching CI for PR #215',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0].description).toBe('Watching CI for PR #215');
  });

  it('drops a summary that merely echoes the shell command', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', '后台打开小红书链接');
    p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      tool_use_id: 'tu-1', description: COMMAND,
    } as unknown as SDKMessage));
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 'b1',
      status: 'completed', summary: COMMAND.slice(0, 80),
    } as unknown as SDKMessage));
    const ev = state.backgroundEvents?.find((e) => e.taskId === 'b1');
    expect(ev?.status).toBe('completed');
    expect(ev?.lastEvent).toBeUndefined();
  });

  it('keeps a real summary for shell tasks but strips URLs', () => {
    const p = new StreamProcessor('hi');
    bashToolUse(p, 'tu-1', '后台打开小红书链接');
    p.processMessage(msg({
      type: 'system', subtype: 'task_started', task_id: 'b1',
      tool_use_id: 'tu-1', description: COMMAND,
    } as unknown as SDKMessage));
    const state = p.processMessage(msg({
      type: 'system', subtype: 'task_notification', task_id: 'b1',
      status: 'completed', summary: 'saved 6 notes from http://xhslink.cn/o/abc to notes/',
    } as unknown as SDKMessage));
    expect(state.backgroundEvents?.[0].lastEvent).toBe('saved 6 notes from [链接] to notes/');
  });
});

describe('extractImagePaths', () => {
  it('extracts image paths from text', () => {
    const text = 'Created file at /tmp/img/chart.png and /home/user/photo.jpg';
    const paths = extractImagePaths(text);
    expect(paths).toContain('/tmp/img/chart.png');
    expect(paths).toContain('/home/user/photo.jpg');
  });

  it('returns empty for no matches', () => {
    expect(extractImagePaths('no images here')).toEqual([]);
  });

  it('deduplicates paths', () => {
    const text = '/tmp/a.png and /tmp/a.png again';
    expect(extractImagePaths(text)).toHaveLength(1);
  });
});

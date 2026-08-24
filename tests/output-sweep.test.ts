// [design-note Q] 发送目录生命周期守护测试:
//   ① 发过即删(目录里还有 = 一定没发过)
//   ② sweepDir 纯目录补扫(漏发文件发出并删除,失败保留待通知后删)
//   ⑤ cleanup() 延迟 rm 前先调 sweeper(迟到产物不再被静默销毁)
// 升级后跑本文件即可验证 design-note Q 的行为仍然成立。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OutputsManager } from '../src/bridge/outputs-manager.js';
import { OutputHandler } from '../src/bridge/output-handler.js';

const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

function makeSender(overrides: Partial<Record<string, any>> = {}) {
  return {
    sendImageFile: vi.fn().mockResolvedValue(true),
    sendLocalFile: vi.fn().mockResolvedValue(true),
    sendText: vi.fn().mockResolvedValue(undefined),
    sendTextNotice: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('design-note Q:发送目录生命周期', () => {
  let testRoot: string;
  let baseDir: string;
  let manager: OutputsManager;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'luckagent-sweep-test-'));
    baseDir = path.join(testRoot, 'outputs');
    fs.mkdirSync(baseDir);
    manager = new OutputsManager(baseDir, mockLogger);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('① 图片/文件发送成功后立即从发送目录删除', async () => {
    const sender = makeSender();
    const handler = new OutputHandler(mockLogger, sender, manager);
    const dir = manager.prepareDir('chat-q1');
    fs.writeFileSync(path.join(dir, 'a.png'), 'img');
    fs.writeFileSync(path.join(dir, 'b.xlsx'), 'file');

    await handler.sweepDir('chat-q1', dir);

    expect(sender.sendImageFile).toHaveBeenCalledTimes(1);
    expect(sender.sendLocalFile).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual([]); // 发过即删
  });

  it('① 发送失败的文件在告知通知后也删除(防每轮重复通知)', async () => {
    const sender = makeSender({ sendImageFile: vi.fn().mockResolvedValue(false) });
    const handler = new OutputHandler(mockLogger, sender, manager);
    const dir = manager.prepareDir('chat-q2');
    fs.writeFileSync(path.join(dir, 'fail.png'), 'img');

    await handler.sweepDir('chat-q2', dir);

    expect(sender.sendTextNotice).toHaveBeenCalledTimes(1); // patch L 通知
    expect(fs.readdirSync(dir)).toEqual([]); // 通知后删
  });

  it('② sweepDir 空目录 / null 目录安静跳过', async () => {
    const sender = makeSender();
    const handler = new OutputHandler(mockLogger, sender, manager);
    const dir = manager.prepareDir('chat-q3');

    await handler.sweepDir('chat-q3', dir);
    await handler.sweepDir('chat-q3', null);

    expect(sender.sendImageFile).not.toHaveBeenCalled();
    expect(sender.sendTextNotice).not.toHaveBeenCalled();
  });

  it('② 同一 chat 并发补扫被互斥串行,同一文件只发一次', async () => {
    const sender = makeSender();
    const handler = new OutputHandler(mockLogger, sender, manager);
    const dir = manager.prepareDir('chat-q4');
    fs.writeFileSync(path.join(dir, 'once.png'), 'img');

    await Promise.all([
      handler.sweepDir('chat-q4', dir),
      handler.sweepDir('chat-q4', dir),
      handler.sweepDir('chat-q4', dir),
    ]);

    expect(sender.sendImageFile).toHaveBeenCalledTimes(1); // 串行 + 发过即删 → 无重复
  });

  it('⑤ cleanup() 延迟 rm 前先调 sweeper,迟到产物先被发送', async () => {
    vi.useFakeTimers();
    const swept: string[] = [];
    manager.setSweeper(async (dir) => {
      swept.push(...fs.readdirSync(dir));
    });
    const dir = manager.prepareDir('chat-q5');
    // 模拟:轮已结束、cleanup 已排定,产物 5 分钟窗口内迟到落盘
    manager.cleanup(dir);
    fs.writeFileSync(path.join(dir, 'late.png'), 'img');

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 50);

    expect(swept).toContain('late.png');   // rm 前 sweeper 看到了迟到文件
    expect(fs.existsSync(dir)).toBe(false); // 补扫后目录仍被清掉
  });

  it('⑤ dirFor 只解析路径,无副作用', () => {
    const dir = manager.dirFor('chat-q6');
    expect(dir).toBe(path.join(baseDir, 'chat-q6'));
    expect(fs.existsSync(dir!)).toBe(false); // 不建目录
    expect(manager.dirFor('../escape')).toBeNull(); // 越界拒绝
  });
});

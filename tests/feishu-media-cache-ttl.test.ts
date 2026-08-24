import { describe, expect, it, vi } from 'vitest';
import { cachePendingMedia, getCachedMedia, MEDIA_CACHE_TTL_MS } from '../src/feishu/event-handler.js';

/**
 * [design-note N] 群聊媒体缓存 TTL 与过期告警 — event-handler 层。
 *
 * 背景：群里先发文件、后 @bot 是常见用法，缓存靠 TTL 关联两步。原 TTL 5 分钟
 * 太短：2026-07-21 13:29 缓存的两个文件在 13:39 @ 时已过期，被【静默】过滤，
 * 用户以为 bot 拿到了文件。这些测试锁定：
 *
 *   1. TTL = 30 分钟（缓存只存 key 不存内容，放宽无内存压力）。
 *   2. 过期条目被丢弃时必须打 WARN，且带上 fileName（无 fileName 用
 *      imageKey/fileKey 兜底）——事后能从日志还原「用户发过什么」。
 *   3. 未过期条目正常返回、不告警；过期条目只告警一次（丢弃后不复报）。
 */

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
}

// 模块级 Map 是共享的，每个用例用独立 chatId/userId 隔离
let seq = 0;
const ids = () => ({ chatId: `oc_ttl_${++seq}`, userId: `ou_ttl_${seq}` });

describe('group media cache TTL (patch N)', () => {
  it('TTL is 30 minutes', () => {
    expect(MEDIA_CACHE_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('entries older than 5 minutes but within TTL are still attached (the 2026-07-21 incident shape)', () => {
    const { chatId, userId } = ids();
    const logger = makeLogger();
    // 事故场景：13:29 发文件、13:39 @bot —— 间隔 10 分钟，旧 TTL(5min) 会静默丢
    cachePendingMedia(chatId, userId, { messageId: 'om_1', fileKey: 'file_v3_a', fileName: 'report.pdf', ts: Date.now() - 10 * 60 * 1000 });

    const got = getCachedMedia(chatId, userId, logger);

    expect(got).toHaveLength(1);
    expect(got[0].fileName).toBe('report.pdf');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('expired entries are dropped WITH a WARN carrying the file names', () => {
    const { chatId, userId } = ids();
    const logger = makeLogger();
    const expiredTs = Date.now() - MEDIA_CACHE_TTL_MS - 1000;
    cachePendingMedia(chatId, userId, { messageId: 'om_1', fileKey: 'file_v3_a', fileName: 'big-video.mp4', ts: expiredTs });
    cachePendingMedia(chatId, userId, { messageId: 'om_2', imageKey: 'img_v3_b', ts: expiredTs });
    cachePendingMedia(chatId, userId, { messageId: 'om_3', fileKey: 'file_v3_c', fileName: 'fresh.docx', ts: Date.now() });

    const got = getCachedMedia(chatId, userId, logger);

    // 只有未过期的留下
    expect(got).toHaveLength(1);
    expect(got[0].fileName).toBe('fresh.docx');
    // WARN 必须带 fileName（无 fileName 的图片用 imageKey 兜底）
    expect(logger.warn).toHaveBeenCalledOnce();
    const [ctx, msg] = logger.warn.mock.calls[0];
    expect(ctx.dropped).toEqual(['big-video.mp4', 'img_v3_b']);
    expect(ctx.chatId).toBe(chatId);
    expect(String(msg)).toMatch(/expired/i);
    // 过期条目已被清出缓存：再取不再重复告警
    const again = getCachedMedia(chatId, userId, logger);
    expect(again).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('all-expired cache returns empty and clears the key', () => {
    const { chatId, userId } = ids();
    const logger = makeLogger();
    cachePendingMedia(chatId, userId, { messageId: 'om_1', fileKey: 'file_v3_a', fileName: 'old.zip', ts: Date.now() - MEDIA_CACHE_TTL_MS - 5000 });

    expect(getCachedMedia(chatId, userId, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
    // key 已删除：二次读取不再告警
    expect(getCachedMedia(chatId, userId, logger)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('getCachedMedia without a logger still drops expired entries silently (no crash)', () => {
    const { chatId, userId } = ids();
    cachePendingMedia(chatId, userId, { messageId: 'om_1', fileKey: 'file_v3_a', fileName: 'x.bin', ts: Date.now() - MEDIA_CACHE_TTL_MS - 5000 });
    expect(getCachedMedia(chatId, userId)).toEqual([]);
  });
});

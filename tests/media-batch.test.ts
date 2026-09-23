import { describe, expect, it } from 'vitest';
import { mergeBatchMessages, mergeBatchWithText, mergeSameSenderMessages } from '../src/bridge/media-batch.js';
import { DEFAULT_IMAGE_TEXT } from '../src/bridge/bridge-constants.js';
import type { IncomingMessage } from '../src/types.js';

function msg(over: Partial<IncomingMessage>): IncomingMessage {
  return {
    messageId: 'm',
    chatId: 'oc_x',
    chatType: 'group',
    userId: 'u1',
    text: '',
    ...over,
  };
}

describe('mergeSameSenderMessages', () => {
  it('joins two text messages with a newline', () => {
    const merged = mergeSameSenderMessages(
      msg({ messageId: 'a', text: 'first' }),
      msg({ messageId: 'b', text: 'second' }),
    );
    expect(merged.text).toBe('first\nsecond');
    expect(merged.extraMedia).toBeUndefined();
    // base identity preserved
    expect(merged.messageId).toBe('a');
  });

  it("folds the follow-up's own media into extraMedia", () => {
    const merged = mergeSameSenderMessages(
      msg({ messageId: 'a', text: 'look at this' }),
      msg({ messageId: 'b', text: 'and the chart', imageKey: 'img-1' }),
    );
    expect(merged.text).toBe('look at this\nand the chart');
    expect(merged.extraMedia).toEqual([{ messageId: 'b', imageKey: 'img-1', fileKey: undefined, fileName: undefined }]);
  });

  it('keeps the base primary media slot and appends both extraMedia lists', () => {
    const base = msg({
      messageId: 'a',
      text: 'analyze',
      imageKey: 'base-img',
      extraMedia: [{ messageId: 'a2', imageKey: 'base-extra' }],
    });
    const next = msg({
      messageId: 'b',
      text: 'these too',
      fileKey: 'next-file',
      fileName: 'r.pdf',
      extraMedia: [{ messageId: 'b2', imageKey: 'next-extra' }],
    });
    const merged = mergeSameSenderMessages(base, next);
    expect(merged.imageKey).toBe('base-img'); // primary slot untouched
    expect(merged.extraMedia).toEqual([
      { messageId: 'a2', imageKey: 'base-extra' },
      { messageId: 'b', imageKey: undefined, fileKey: 'next-file', fileName: 'r.pdf' },
      { messageId: 'b2', imageKey: 'next-extra' },
    ]);
  });

  it('drops the default media placeholder text when real text exists', () => {
    const merged = mergeSameSenderMessages(
      msg({ messageId: 'a', text: DEFAULT_IMAGE_TEXT, imageKey: 'img-1' }),
      msg({ messageId: 'b', text: 'what is the trend here?' }),
    );
    expect(merged.text).toBe('what is the trend here?');
    expect(merged.imageKey).toBe('img-1');
  });

  it('falls back to base text when both are media-only placeholders', () => {
    const merged = mergeSameSenderMessages(
      msg({ messageId: 'a', text: DEFAULT_IMAGE_TEXT, imageKey: 'img-1' }),
      msg({ messageId: 'b', text: DEFAULT_IMAGE_TEXT, imageKey: 'img-2' }),
    );
    expect(merged.text).toBe(DEFAULT_IMAGE_TEXT);
    expect(merged.imageKey).toBe('img-1');
    expect(merged.extraMedia).toEqual([{ messageId: 'b', imageKey: 'img-2', fileKey: undefined, fileName: undefined }]);
  });
});

// Merges used to REPLACE extraMedia with only the batched messages' primary
// media, silently dropping a rich-text post's 2nd+ images and the @-round's
// earlier uploads (code review 2026-09-23).
describe('mergeBatchWithText', () => {
  it("keeps the text message's own extraMedia (rich-text post with several images)", () => {
    const batched = [msg({ messageId: 'img-msg', text: DEFAULT_IMAGE_TEXT, imageKey: 'earlier' })];
    const post = msg({
      messageId: 'post',
      text: '把这几张拼成一张',
      imageKey: 'p1',
      extraMedia: [
        { messageId: 'post', imageKey: 'p2' },
        { messageId: 'post', imageKey: 'p3' },
      ],
    });
    const merged = mergeBatchWithText(batched, post);
    expect(merged.imageKey).toBe('p1');
    expect(merged.text).toBe('把这几张拼成一张');
    expect(merged.extraMedia?.map((m) => m.imageKey)).toEqual(['earlier', 'p2', 'p3']);
  });

  it("keeps each batched message's own extraMedia too", () => {
    const batched = [
      msg({
        messageId: 'at-img',
        text: DEFAULT_IMAGE_TEXT,
        imageKey: 'now',
        extraMedia: [{ messageId: 'round-1', fileKey: 'f1', fileName: 'brief.pdf' }],
      }),
    ];
    const merged = mergeBatchWithText(batched, msg({ messageId: 't', text: '处理一下' }));
    expect(merged.extraMedia).toEqual([
      { messageId: 'at-img', imageKey: 'now', fileKey: undefined, fileName: undefined },
      { messageId: 'round-1', fileKey: 'f1', fileName: 'brief.pdf' },
    ]);
  });

  it('never lists the same attachment twice, nor the one in the primary slot', () => {
    const batched = [msg({ messageId: 'a', text: DEFAULT_IMAGE_TEXT, imageKey: 'k1' })];
    const text = msg({
      messageId: 't',
      text: 'go',
      imageKey: 'tk',
      extraMedia: [
        { messageId: 'a', imageKey: 'k1' },
        { messageId: 't', imageKey: 'tk' },
      ],
    });
    expect(mergeBatchWithText(batched, text).extraMedia).toEqual([
      { messageId: 'a', imageKey: 'k1', fileKey: undefined, fileName: undefined },
    ]);
  });
});

describe('mergeBatchMessages', () => {
  it('returns a single message untouched', () => {
    const only = msg({ messageId: 'a', text: DEFAULT_IMAGE_TEXT, imageKey: 'k1' });
    expect(mergeBatchMessages([only])).toBe(only);
  });

  it("keeps the first message's round media when another image lands in the batch window", () => {
    const first = msg({
      messageId: 'at-img',
      text: DEFAULT_IMAGE_TEXT,
      imageKey: 'now',
      extraMedia: [
        { messageId: 'round-1', imageKey: 'r1' },
        { messageId: 'round-2', fileKey: 'f2', fileName: 'spec.docx' },
      ],
    });
    const second = msg({ messageId: 'img-2', text: DEFAULT_IMAGE_TEXT, imageKey: 'later' });
    const merged = mergeBatchMessages([first, second]);
    expect(merged.imageKey).toBe('now');
    expect(merged.extraMedia?.map((m) => m.imageKey ?? m.fileKey)).toEqual(['r1', 'f2', 'later']);
    // the prompt counts every attachment, not just each message's primary
    expect(merged.text).toBe('请分析这些3张图片和1个文件');
  });
});

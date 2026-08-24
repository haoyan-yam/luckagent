import { describe, expect, it } from 'vitest';
import { mergeSameSenderMessages } from '../src/bridge/media-batch.js';
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
    expect(merged.extraMedia).toEqual([
      { messageId: 'b', imageKey: 'img-1', fileKey: undefined, fileName: undefined },
    ]);
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
    expect(merged.extraMedia).toEqual([
      { messageId: 'b', imageKey: 'img-2', fileKey: undefined, fileName: undefined },
    ]);
  });
});

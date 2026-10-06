/**
 * The Changes panel's content equality and image cache budget
 * (src/renderer/components/dialogs/task-detail/changes/diff-content.ts). The
 * equality decides whether a background refresh repaints the pane, so it must
 * see a change in image bytes even when the text on both sides is empty.
 */
import { describe, it, expect } from 'vitest';
import {
  EMPTY_DIFF_TEXT,
  diffContentEqual,
  diffContentImageBytes,
  statusHasModified,
  statusHasOriginal,
  trimImageCache,
  type DiffContent,
  type DiffImageSide,
} from '../../src/renderer/components/dialogs/task-detail/changes/diff-content';

function imageSide(dataUrl: string, size = dataUrl.length, width = 10, height = 20): DiffImageSide {
  return { kind: 'image', size, dataUrl, width, height };
}

function imageContent(original: DiffImageSide | null, modified: DiffImageSide | null): DiffContent {
  return { text: EMPTY_DIFF_TEXT, image: { original, modified } };
}

describe('diffContentEqual', () => {
  it('treats identical text and images as equal', () => {
    const first = imageContent(imageSide('data:image/png;base64,AAAA'), imageSide('data:image/png;base64,BBBB'));
    const second = imageContent(imageSide('data:image/png;base64,AAAA'), imageSide('data:image/png;base64,BBBB'));
    expect(diffContentEqual(first, second)).toBe(true);
  });

  it('sees a regenerated image of the same byte size as a change', () => {
    const first = imageContent(imageSide('data:image/png;base64,AAAA'), imageSide('data:image/png;base64,BBBB'));
    const second = imageContent(imageSide('data:image/png;base64,AAAA'), imageSide('data:image/png;base64,CCCC'));
    expect(diffContentEqual(first, second)).toBe(false);
  });

  it('sees a side changing kind (decoded to too large, present to missing) as a change', () => {
    const decoded = imageContent(imageSide('data:a'), imageSide('data:b'));
    expect(diffContentEqual(decoded, imageContent(imageSide('data:a'), { kind: 'too-large', size: 99 }))).toBe(false);
    expect(diffContentEqual(decoded, imageContent(null, imageSide('data:b')))).toBe(false);
    expect(diffContentEqual(
      imageContent({ kind: 'too-large', size: 1 }, null),
      imageContent({ kind: 'too-large', size: 2 }, null),
    )).toBe(false);
    expect(diffContentEqual(
      imageContent({ kind: 'unreadable' }, null),
      imageContent({ kind: 'unreadable' }, null),
    )).toBe(true);
  });

  it('still compares text for files with no image', () => {
    const first: DiffContent = { text: { original: 'a', modified: 'b', language: 'typescript' }, image: null };
    expect(diffContentEqual(first, { ...first })).toBe(true);
    expect(diffContentEqual(first, { text: { ...first.text, modified: 'c' }, image: null })).toBe(false);
    expect(diffContentEqual(first, { ...first, image: { original: null, modified: null } })).toBe(false);
  });
});

describe('status sides', () => {
  it('matches the main-process reader: Added/Untracked have no original, Deleted no modified', () => {
    expect(statusHasOriginal('A')).toBe(false);
    expect(statusHasOriginal('U')).toBe(false);
    expect(statusHasOriginal('M')).toBe(true);
    expect(statusHasModified('D')).toBe(false);
    expect(statusHasModified('R')).toBe(true);
  });
});

describe('trimImageCache', () => {
  const weigh = (length: number) => imageContent(null, imageSide('x'.repeat(length)));

  it('drops the least recently inserted image entries until the budget fits', () => {
    const cache = new Map<string, { result: DiffContent }>([
      ['oldest', { result: weigh(40) }],
      ['middle', { result: weigh(40) }],
      ['newest', { result: weigh(40) }],
    ]);
    trimImageCache(cache, 90);
    expect([...cache.keys()]).toEqual(['middle', 'newest']);
  });

  it('never evicts text-only entries or the newest entry, even when the newest alone is over budget', () => {
    const textOnly: DiffContent = { text: { original: 'a', modified: 'b', language: 'plaintext' }, image: null };
    const cache = new Map<string, { result: DiffContent }>([
      ['text', { result: textOnly }],
      ['image', { result: weigh(50) }],
      ['newest', { result: weigh(500) }],
    ]);
    trimImageCache(cache, 100);
    expect([...cache.keys()]).toEqual(['text', 'newest']);
  });

  it('weighs only decoded images', () => {
    expect(diffContentImageBytes(imageContent({ kind: 'too-large', size: 99999 }, imageSide('abc')))).toBe(3);
    expect(diffContentImageBytes({ text: EMPTY_DIFF_TEXT, image: null })).toBe(0);
  });
});

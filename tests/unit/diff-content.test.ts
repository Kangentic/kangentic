/**
 * The Changes panel's content equality, image cache budget, and fetch routing
 * (src/renderer/components/dialogs/task-detail/changes/diff-content.ts). The
 * equality decides whether a background refresh repaints the pane, so it must
 * see a change in image bytes even when the text on both sides is empty. The
 * fetch routing decides which reads a file needs, so a binary file is never read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMPTY_DIFF_CONTENT,
  EMPTY_DIFF_TEXT,
  diffContentEqual,
  diffContentImageBytes,
  fetchDiffContent,
  statusHasModified,
  statusHasOriginal,
  trimImageCache,
  type DiffContent,
  type DiffImageSide,
} from '../../src/renderer/components/dialogs/task-detail/changes/diff-content';
import { IMAGE_PREVIEW_MAX_BYTES } from '../../src/shared/image-preview';
import type {
  GitDiffStatus,
  GitFileContentInput,
  GitFileContentResult,
  GitImageContentResult,
} from '../../src/shared/types';

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

/**
 * Which reads fetchDiffContent makes, and what it returns, for the paths that
 * never decode an image. Decoding goes through `new Image()` and `FileReader`,
 * which this unit tier does not have, so every case here is built so that no
 * side reaches a decode: an SVG side is empty text (read as unreadable) or
 * over the byte cap, and a raster side is a kind that carries no bytes. The
 * decode path needs a browser, so it belongs to the UI tier.
 */
describe('fetchDiffContent (paths that never decode)', () => {
  const fileContent = vi.fn<(input: GitFileContentInput) => Promise<GitFileContentResult>>();
  const fileImage = vi.fn<(input: GitFileContentInput) => Promise<GitImageContentResult>>();

  beforeEach(() => {
    fileContent.mockReset();
    fileImage.mockReset();
    vi.stubGlobal('window', { electronAPI: { git: { fileContent, fileImage } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function inputFor(filePath: string, status: GitDiffStatus = 'M'): GitFileContentInput {
    return { projectPath: '/project', baseBranch: 'main', filePath, status };
  }

  function textResult(original: string, modified: string): GitFileContentResult {
    return { original, modified, language: 'xml' };
  }

  it('a binary file that is not an image reads nothing and returns the empty content', async () => {
    const result = await fetchDiffContent(inputFor('assets/font.woff2'), true);

    expect(result).toBe(EMPTY_DIFF_CONTENT);
    expect(fileContent).not.toHaveBeenCalled();
    expect(fileImage).not.toHaveBeenCalled();
  });

  it('a text file that is not an image reads its text and carries no image', async () => {
    // The control for the case above: the same two mocks, reached by a file that
    // is not binary, so "never called" there cannot be a mock that was never wired up.
    const text = textResult('before', 'after');
    fileContent.mockResolvedValue(text);
    const input = inputFor('src/index.ts');

    const result = await fetchDiffContent(input, false);

    expect(result).toEqual({ text, image: null });
    expect(fileContent).toHaveBeenCalledWith(input);
    expect(fileImage).not.toHaveBeenCalled();
  });

  it('an SVG marked binary by .gitattributes still reads its text, since the markup is valid', async () => {
    fileContent.mockResolvedValue(textResult('', ''));
    const input = inputFor('icons/logo.svg');

    const result = await fetchDiffContent(input, true);

    expect(fileContent).toHaveBeenCalledWith(input);
    expect(fileImage).not.toHaveBeenCalled();
    expect(result.image).toEqual({ original: { kind: 'unreadable' }, modified: { kind: 'unreadable' } });
  });

  it('an SVG side whose text is empty is unreadable, because empty is what a failed read returns', async () => {
    fileContent.mockResolvedValue(textResult('', ''));

    const result = await fetchDiffContent(inputFor('icons/logo.svg', 'M'), false);

    expect(result.image?.original).toEqual({ kind: 'unreadable' });
    expect(fileImage).not.toHaveBeenCalled();
  });

  it('an SVG side over the byte cap reports its size in bytes and is not decoded', async () => {
    // Two bytes per character: the text is under the cap in characters but over
    // it in bytes, so only a byte count (not `text.length`) reports too-large.
    const twoByteCharacter = String.fromCharCode(0xe9);
    const oversized = twoByteCharacter.repeat(IMAGE_PREVIEW_MAX_BYTES / 2 + 1);
    expect(oversized.length).toBeLessThan(IMAGE_PREVIEW_MAX_BYTES);
    fileContent.mockResolvedValue(textResult('', oversized));

    const result = await fetchDiffContent(inputFor('icons/logo.svg', 'M'), false);

    expect(result.image?.modified).toEqual({ kind: 'too-large', size: IMAGE_PREVIEW_MAX_BYTES + 2 });
    expect(result.image?.original).toEqual({ kind: 'unreadable' });
    expect(result.text.modified).toBe(oversized);
  });

  it.each<GitDiffStatus>(['A', 'U'])('a %s SVG has no original side, even though the text reader returned an empty one', async (status) => {
    fileContent.mockResolvedValue(textResult('', ''));

    const result = await fetchDiffContent(inputFor('icons/new.svg', status), false);

    expect(result.image?.original).toBeNull();
    expect(result.image?.modified).toEqual({ kind: 'unreadable' });
  });

  it('a Deleted SVG has no modified side', async () => {
    fileContent.mockResolvedValue(textResult('', ''));

    const result = await fetchDiffContent(inputFor('icons/old.svg', 'D'), false);

    expect(result.image?.modified).toBeNull();
    expect(result.image?.original).toEqual({ kind: 'unreadable' });
  });

  it('a raster image reads bytes only and passes sides that carry no bytes straight through', async () => {
    fileImage.mockResolvedValue({
      original: { kind: 'too-large', size: 99 },
      modified: { kind: 'lfs-pointer', size: 130 },
    });
    const input = inputFor('shots/home.png');

    const result = await fetchDiffContent(input, true);

    expect(fileImage).toHaveBeenCalledWith(input);
    expect(fileContent).not.toHaveBeenCalled();
    expect(result.text).toEqual(EMPTY_DIFF_TEXT);
    expect(result.image).toEqual({
      original: { kind: 'too-large', size: 99 },
      modified: { kind: 'lfs-pointer', size: 130 },
    });
  });

  it('a raster image keeps a missing side null and an unreadable side unreadable', async () => {
    fileImage.mockResolvedValue({ original: null, modified: { kind: 'unreadable' } });

    const result = await fetchDiffContent(inputFor('shots/new.png', 'A'), true);

    expect(result.image).toEqual({ original: null, modified: { kind: 'unreadable' } });
  });
});

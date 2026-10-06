/**
 * The Changes panel's content equality, image cache, fetch routing and
 * compare-mode rules (src/renderer/components/dialogs/task-detail/changes/diff-content.ts).
 * The equality decides whether a background refresh repaints the pane, so it
 * must see a change in image bytes even when the text on both sides is empty.
 * The fetch routing decides which reads a file needs, so a binary file is
 * never read, and an image side main reports unchanged, or resends byte for
 * byte, is the side already held, not a copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DiffContentCache,
  EMPTY_DIFF_CONTENT,
  EMPTY_DIFF_TEXT,
  diffContentEqual,
  diffContentImageBytes,
  fetchDiffContent,
  imageCompareState,
  trimImageCache,
  type DiffContent,
  type DiffImageContent,
  type DiffImageSide,
} from '../../src/renderer/components/dialogs/task-detail/changes/diff-content';
import type {
  GitDiffStatus,
  GitFileContentInput,
  GitFileContentResult,
  GitFileImageInput,
  GitImageContentResult,
} from '../../src/shared/types';

function imageSide(dataUrl: string, size = dataUrl.length, width = 10, height = 20): DiffImageSide {
  return { kind: 'image', size, dataUrl, width, height };
}

function tooLargeSide(size: number): DiffImageSide {
  return { kind: 'too-large', size };
}

function imageContent(original: DiffImageSide | null, modified: DiffImageSide | null, fingerprints: DiffImageContent['fingerprints'] = {}): DiffContent {
  return { text: EMPTY_DIFF_TEXT, image: { original, modified, fingerprints } };
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
    expect(diffContentEqual(decoded, imageContent(imageSide('data:a'), tooLargeSide(99)))).toBe(false);
    expect(diffContentEqual(decoded, imageContent(null, imageSide('data:b')))).toBe(false);
    expect(diffContentEqual(imageContent(tooLargeSide(1), null), imageContent(tooLargeSide(2), null))).toBe(false);
    expect(diffContentEqual(
      imageContent({ kind: 'unreadable' }, null),
      imageContent({ kind: 'unreadable' }, null),
    )).toBe(true);
  });

  it('still compares text for files with no image', () => {
    const first: DiffContent = { text: { original: 'a', modified: 'b', language: 'typescript' }, image: null };
    expect(diffContentEqual(first, { ...first })).toBe(true);
    expect(diffContentEqual(first, { text: { ...first.text, modified: 'c' }, image: null })).toBe(false);
    expect(diffContentEqual(first, { ...first, image: { original: null, modified: null, fingerprints: {} } })).toBe(false);
  });

  it('ignores fingerprints: they name the bytes, they are not drawn', () => {
    const side = imageSide('data:image/png;base64,AAAA');
    expect(diffContentEqual(
      imageContent(side, null, { original: 'file:4:1:racy' }),
      imageContent(side, null, { original: 'file:4:1' }),
    )).toBe(true);
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
    expect(diffContentImageBytes(imageContent(tooLargeSide(99999), imageSide('abc')))).toBe(3);
    expect(diffContentImageBytes({ text: EMPTY_DIFF_TEXT, image: null })).toBe(0);
  });
});

describe('DiffContentCache', () => {
  const weigh = (length: number) => imageContent(null, imageSide('x'.repeat(length)));

  it('a read counts as a use: the entry read last survives the trim, the one left unread is evicted', () => {
    const cache = new DiffContentCache<{ result: DiffContent }>(90);
    cache.set('first', { result: weigh(40) });
    cache.set('second', { result: weigh(40) });

    expect(cache.get('first')).toBeDefined();
    cache.set('third', { result: weigh(40) });

    expect(cache.keys()).toEqual(['first', 'third']);
  });

  it('a write to a key already held moves it to the newest place', () => {
    const cache = new DiffContentCache<{ result: DiffContent }>(90);
    cache.set('first', { result: weigh(40) });
    cache.set('second', { result: weigh(40) });

    cache.set('first', { result: weigh(40) });
    cache.set('third', { result: weigh(40) });

    expect(cache.keys()).toEqual(['first', 'third']);
  });

  it('a miss changes nothing, and listing the keys is not a use', () => {
    const cache = new DiffContentCache<{ result: DiffContent }>(90);
    cache.set('first', { result: weigh(40) });
    cache.set('second', { result: weigh(40) });

    expect(cache.get('absent')).toBeUndefined();
    expect(cache.keys()).toEqual(['first', 'second']);
    cache.set('third', { result: weigh(40) });

    expect(cache.keys()).toEqual(['second', 'third']);
  });
});

describe('imageCompareState', () => {
  const both = (original: DiffImageSide | null, modified: DiffImageSide | null): DiffImageContent => ({ original, modified, fingerprints: {} });

  it('two decoded sides compare in the chosen mode, and only Side by side offers the layout toggle', () => {
    const image = both(imageSide('data:a'), imageSide('data:b'));
    expect(imageCompareState(image, 'slider')).toEqual({
      comparable: true, effectiveMode: 'slider', showsModeRow: true, showsLayoutToggle: false,
    });
    expect(imageCompareState(image, 'side-by-side').showsLayoutToggle).toBe(true);
  });

  it('one decoded side falls back to Side by side, keeps the mode row, and offers the layout toggle', () => {
    expect(imageCompareState(both(imageSide('data:a'), tooLargeSide(99)), 'diff')).toEqual({
      comparable: false, effectiveMode: 'side-by-side', showsModeRow: true, showsLayoutToggle: true,
    });
  });

  it('no decoded side, or only one side at all, shows neither the mode row nor the layout toggle', () => {
    for (const image of [
      both(tooLargeSide(1), { kind: 'unreadable' }),
      both(null, imageSide('data:added')),
      both(imageSide('data:deleted'), null),
    ]) {
      const state = imageCompareState(image, 'side-by-side');
      expect(state.showsModeRow).toBe(false);
      expect(state.showsLayoutToggle).toBe(false);
    }
  });
});

/**
 * Which reads fetchDiffContent makes, and what it returns, for the paths that
 * never decode an image. Decoding goes through `new Image()` and `FileReader`,
 * which this unit tier does not have, so every image side here is a kind that
 * carries no bytes, or one main answers `unchanged`, which reuses a side
 * already held. The decode path needs a browser, so it belongs to the UI tier.
 */
describe('fetchDiffContent (paths that never decode)', () => {
  const fileContent = vi.fn<(input: GitFileContentInput) => Promise<GitFileContentResult>>();
  const fileImage = vi.fn<(input: GitFileImageInput) => Promise<GitImageContentResult>>();

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

  const NO_KNOWN_FINGERPRINTS = { original: undefined, modified: undefined };

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

  it('an SVG reads its text for the diff and its bytes for the image view', async () => {
    const text = textResult('<svg/>', '<svg></svg>');
    fileContent.mockResolvedValue(text);
    fileImage.mockResolvedValue({ original: { kind: 'unreadable' }, modified: { kind: 'too-large', size: 99, fingerprint: 'blob:m' } });
    const input = inputFor('icons/logo.svg');

    const result = await fetchDiffContent(input, false);

    expect(fileContent).toHaveBeenCalledWith(input);
    expect(fileImage).toHaveBeenCalledWith({ ...input, knownFingerprints: NO_KNOWN_FINGERPRINTS });
    expect(result.text).toBe(text);
    // The sides are main's byte reads, not derived from the text: the short
    // markup above could never be too large, and a failed read stays unreadable.
    expect(result.image).toEqual({
      original: { kind: 'unreadable' },
      modified: { kind: 'too-large', size: 99 },
      fingerprints: { original: undefined, modified: 'blob:m' },
    });
  });

  it('an SVG marked binary by .gitattributes still reads both, since the markup is valid', async () => {
    fileContent.mockResolvedValue(textResult('', ''));
    fileImage.mockResolvedValue({ original: { kind: 'unreadable' }, modified: { kind: 'unreadable' } });
    const input = inputFor('icons/logo.svg');

    const result = await fetchDiffContent(input, true);

    expect(fileContent).toHaveBeenCalledWith(input);
    expect(fileImage).toHaveBeenCalledTimes(1);
    expect(result.image).toEqual({ original: { kind: 'unreadable' }, modified: { kind: 'unreadable' }, fingerprints: {} });
  });

  it('an SVG whose image read fails keeps its text diff, with no image', async () => {
    const text = textResult('<svg/>', '<svg></svg>');
    fileContent.mockResolvedValue(text);
    fileImage.mockRejectedValue(new Error('worktree removed'));

    const result = await fetchDiffContent(inputFor('icons/logo.svg'), false);

    expect(result).toEqual({ text, image: null });
  });

  it('a raster image whose read fails rejects, so the host can fall back', async () => {
    // The control for the case above: a raster has no text to keep.
    fileImage.mockRejectedValue(new Error('worktree removed'));

    await expect(fetchDiffContent(inputFor('shots/home.png'), true)).rejects.toThrow('worktree removed');
  });

  it('an SVG side main reports missing for the status stays null', async () => {
    fileContent.mockResolvedValue(textResult('', '<svg/>'));
    fileImage.mockResolvedValue({ original: null, modified: { kind: 'too-large', size: 5, fingerprint: 'file:5:1' } });

    const result = await fetchDiffContent(inputFor('icons/new.svg', 'A'), false);

    expect(result.image?.original).toBeNull();
  });

  it('a raster image reads bytes only and passes sides that carry no bytes straight through', async () => {
    fileImage.mockResolvedValue({
      original: { kind: 'too-large', size: 99, fingerprint: 'blob:o' },
      modified: { kind: 'lfs-pointer', size: 130, fingerprint: 'file:130:1' },
    });
    const input = inputFor('shots/home.png');

    const result = await fetchDiffContent(input, true);

    expect(fileImage).toHaveBeenCalledWith({ ...input, knownFingerprints: NO_KNOWN_FINGERPRINTS });
    expect(fileContent).not.toHaveBeenCalled();
    expect(result.text).toEqual(EMPTY_DIFF_TEXT);
    expect(result.image).toEqual({
      original: { kind: 'too-large', size: 99 },
      modified: { kind: 'lfs-pointer', size: 130 },
      fingerprints: { original: 'blob:o', modified: 'file:130:1' },
    });
  });

  it('a raster image keeps a missing side null and an unreadable side unreadable', async () => {
    fileImage.mockResolvedValue({ original: null, modified: { kind: 'unreadable' } });

    const result = await fetchDiffContent(inputFor('shots/new.png', 'A'), true);

    expect(result.image).toEqual({ original: null, modified: { kind: 'unreadable' }, fingerprints: {} });
  });

  it('sends the previous sides\' fingerprints, and a side main reports unchanged is the previous side itself', async () => {
    const previousOriginal = imageSide('data:image/png;base64,OLD', 3, 10, 20);
    const previousModified = imageSide('data:image/png;base64,NEW', 3, 10, 20);
    const previous = imageContent(previousOriginal, previousModified, { original: 'blob:original', modified: 'file:3:42' });
    fileImage.mockResolvedValue({
      original: { kind: 'unchanged', fingerprint: 'blob:original' },
      modified: { kind: 'unchanged', fingerprint: 'file:3:42' },
    });
    const input = inputFor('shots/home.png');

    const result = await fetchDiffContent(input, true, previous);

    expect(fileImage).toHaveBeenCalledWith({
      ...input, knownFingerprints: { original: 'blob:original', modified: 'file:3:42' },
    });
    // Identity, not equality: the pixel diff's cache is keyed on these objects.
    expect(result.image?.original).toBe(previousOriginal);
    expect(result.image?.modified).toBe(previousModified);
    expect(result.image?.fingerprints).toEqual({ original: 'blob:original', modified: 'file:3:42' });
    expect(diffContentEqual(result, previous)).toBe(true);
  });

  it('an unreadable previous side sends no fingerprint, and an unchanged answer it cannot match shows nothing', async () => {
    const previous = imageContent({ kind: 'unreadable' }, tooLargeSide(99), { modified: 'blob:held' });
    fileImage.mockResolvedValue({
      original: { kind: 'unreadable' },
      modified: { kind: 'unchanged', fingerprint: 'blob:some-other-blob' },
    });
    const input = inputFor('shots/home.png');

    const result = await fetchDiffContent(input, true, previous);

    expect(fileImage).toHaveBeenCalledWith({ ...input, knownFingerprints: { original: undefined, modified: 'blob:held' } });
    expect(result.image?.modified).toEqual({ kind: 'unreadable' });
  });
});

/**
 * The decode path, with stand-ins for the two browser objects it needs:
 * FileReader turns the bytes into a data URL, and Image "decodes" every data
 * URL to 4 x 3, recording each one it is handed.
 */
describe('fetchDiffContent (bytes main resends unchanged)', () => {
  const fileContent = vi.fn<(input: GitFileContentInput) => Promise<GitFileContentResult>>();
  const fileImage = vi.fn<(input: GitFileImageInput) => Promise<GitImageContentResult>>();
  const decodedDataUrls: string[] = [];

  class StandInFileReader {
    result: string | null = null;
    error: Error | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer().then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      });
    }
  }

  class StandInImage {
    naturalWidth = 0;
    naturalHeight = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(dataUrl: string) {
      decodedDataUrls.push(dataUrl);
      this.naturalWidth = 4;
      this.naturalHeight = 3;
      queueMicrotask(() => this.onload?.());
    }
  }

  beforeEach(() => {
    fileContent.mockReset();
    fileImage.mockReset();
    decodedDataUrls.length = 0;
    vi.stubGlobal('window', { electronAPI: { git: { fileContent, fileImage } } });
    vi.stubGlobal('FileReader', StandInFileReader);
    vi.stubGlobal('Image', StandInImage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const input: GitFileContentInput = { projectPath: '/project', baseBranch: 'main', filePath: 'shots/home.png', status: 'A' };

  function bytesAnswer(bytes: number[], fingerprint: string): GitImageContentResult {
    return { original: null, modified: { kind: 'bytes', size: bytes.length, bytes: new Uint8Array(bytes), fingerprint } };
  }

  it('the same bytes again keep the side already held, decoded once, under the new fingerprint', async () => {
    // A working-tree read inside main's racy window is resent in full even
    // when nothing changed. Keeping the side keeps the pixel diff's cache,
    // which is keyed on side identity.
    fileImage.mockResolvedValueOnce(bytesAnswer([1, 2, 3], 'file:3:10:racy'));
    const first = await fetchDiffContent(input, true);
    fileImage.mockResolvedValueOnce(bytesAnswer([1, 2, 3], 'file:3:10'));

    const second = await fetchDiffContent(input, true, first);

    expect(fileImage).toHaveBeenLastCalledWith({ ...input, knownFingerprints: { original: undefined, modified: 'file:3:10:racy' } });
    expect(first.image?.modified?.kind).toBe('image');
    expect(second.image?.modified).toBe(first.image?.modified);
    expect(second.image?.fingerprints.modified).toBe('file:3:10');
    expect(decodedDataUrls).toHaveLength(1);
  });

  it('different bytes decode into a new side', async () => {
    // The control for the case above: same stand-ins, bytes that differ.
    fileImage.mockResolvedValueOnce(bytesAnswer([1, 2, 3], 'file:3:10'));
    const first = await fetchDiffContent(input, true);
    fileImage.mockResolvedValueOnce(bytesAnswer([4, 5, 6], 'file:3:20'));

    const second = await fetchDiffContent(input, true, first);

    expect(second.image?.modified).not.toBe(first.image?.modified);
    expect(second.image?.fingerprints.modified).toBe('file:3:20');
    expect(decodedDataUrls).toHaveLength(2);
  });
});

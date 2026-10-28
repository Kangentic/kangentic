/**
 * How the Changes panel's markdown preview reads an image a document names.
 *
 * `fetchDocumentImage` asks main for ONE side of an image the markdown file
 * references, at the same revision the preview shows. The image need not be in
 * the panel's file list, so it picks a status that reads only the side it wants
 * (`D` reads the original alone, `A` the modified alone). These pin which side
 * each request reads, that the whole scope reaches main unchanged, which answers
 * count as "no image", and that a path that cannot be an image never asks.
 *
 * The sides carry different bytes on purpose: a swapped read returns the other
 * side's data URL, which a test with identical sides would not notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchDocumentImage, type DiffContentScope } from '../../src/renderer/components/dialogs/task-detail/changes/diff-content';
import type { GitFileImageInput, GitImageContentResult, GitImageSide } from '../../src/shared/types';

/** Node has Blob but no FileReader; this one turns a Blob into the data URL the real one makes. */
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

const ORIGINAL_BYTES = [1, 2, 3];
const MODIFIED_BYTES = [4, 5, 6];
// The base64 of the two byte runs above.
const ORIGINAL_BASE64 = 'AQID';
const MODIFIED_BASE64 = 'BAUG';

function bytesSide(bytes: number[], fingerprint: string): GitImageSide {
  return { kind: 'bytes', size: bytes.length, bytes: new Uint8Array(bytes), fingerprint };
}

const bothSidesAnswer: GitImageContentResult = {
  original: bytesSide(ORIGINAL_BYTES, 'blob:original'),
  modified: bytesSide(MODIFIED_BYTES, 'blob:modified'),
};

/** Every field of the scope set, so a field dropped on the way to main shows. */
const fullScope: DiffContentScope = {
  worktreePath: '/mock/worktree',
  projectPath: '/mock/project',
  baseBranch: 'release/1.0',
  scope: 'staged',
  commitOid: '0123456789abcdef0123456789abcdef01234567',
  range: { base: 'aaaa1111', head: 'bbbb2222' },
};

const minimalScope: DiffContentScope = { projectPath: '/mock/project', baseBranch: 'main' };

describe('fetchDocumentImage', () => {
  const fileImage = vi.fn<(input: GitFileImageInput) => Promise<GitImageContentResult>>();

  beforeEach(() => {
    fileImage.mockReset();
    vi.stubGlobal('window', { electronAPI: { git: { fileImage } } });
    vi.stubGlobal('FileReader', StandInFileReader);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('which side it reads', () => {
    it('reads the original side with status D and returns the original bytes', async () => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      const dataUrl = await fetchDocumentImage(fullScope, 'docs/board.png', 'original');

      expect(dataUrl).toBe(`data:image/png;base64,${ORIGINAL_BASE64}`);
      expect(fileImage).toHaveBeenCalledTimes(1);
      expect(fileImage.mock.calls[0][0].status).toBe('D');
    });

    it('reads the modified side with status A and returns the modified bytes', async () => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      const dataUrl = await fetchDocumentImage(fullScope, 'docs/board.png', 'modified');

      expect(dataUrl).toBe(`data:image/png;base64,${MODIFIED_BASE64}`);
      expect(fileImage).toHaveBeenCalledTimes(1);
      expect(fileImage.mock.calls[0][0].status).toBe('A');
    });

    it('does not fall back to the other side when the wanted side is missing', async () => {
      fileImage.mockResolvedValue({ original: null, modified: bytesSide(MODIFIED_BYTES, 'blob:modified') });
      expect(await fetchDocumentImage(fullScope, 'docs/board.png', 'original')).toBeNull();

      fileImage.mockResolvedValue({ original: bytesSide(ORIGINAL_BYTES, 'blob:original'), modified: null });
      expect(await fetchDocumentImage(fullScope, 'docs/board.png', 'modified')).toBeNull();
    });
  });

  describe('what it sends to main', () => {
    it('passes the whole scope through unchanged, with the file path and the side\'s status', async () => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      await fetchDocumentImage(fullScope, 'docs/images/board.png', 'modified');

      expect(fileImage).toHaveBeenCalledTimes(1);
      expect(fileImage.mock.calls[0][0]).toStrictEqual({
        worktreePath: '/mock/worktree',
        projectPath: '/mock/project',
        baseBranch: 'release/1.0',
        scope: 'staged',
        commitOid: '0123456789abcdef0123456789abcdef01234567',
        range: { base: 'aaaa1111', head: 'bbbb2222' },
        filePath: 'docs/images/board.png',
        status: 'A',
      });
    });

    it('sends the same scope for the original side, changing only the status', async () => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      await fetchDocumentImage(fullScope, 'docs/images/board.png', 'original');

      expect(fileImage.mock.calls[0][0]).toStrictEqual({
        worktreePath: '/mock/worktree',
        projectPath: '/mock/project',
        baseBranch: 'release/1.0',
        scope: 'staged',
        commitOid: '0123456789abcdef0123456789abcdef01234567',
        range: { base: 'aaaa1111', head: 'bbbb2222' },
        filePath: 'docs/images/board.png',
        status: 'D',
      });
    });

    it('adds no scope keys the caller did not give', async () => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      await fetchDocumentImage(minimalScope, 'board.png', 'modified');

      expect(fileImage.mock.calls[0][0]).toStrictEqual({
        projectPath: '/mock/project',
        baseBranch: 'main',
        filePath: 'board.png',
        status: 'A',
      });
    });
  });

  describe('when there is no image to show', () => {
    const unusableSides: Array<[string, GitImageSide | null]> = [
      ['the side is null', null],
      ['the side is too large', { kind: 'too-large', size: 99_000_000, fingerprint: 'blob:large' }],
      ['the side is a Git LFS pointer', { kind: 'lfs-pointer', size: 130, fingerprint: 'blob:pointer' }],
      ['main answers unchanged', { kind: 'unchanged', fingerprint: 'blob:same' }],
      ['the side is unreadable', { kind: 'unreadable' }],
    ];

    it.each(unusableSides)('returns null for the modified side when %s', async (_reason, side) => {
      fileImage.mockResolvedValue({ original: bytesSide(ORIGINAL_BYTES, 'blob:original'), modified: side });
      expect(await fetchDocumentImage(fullScope, 'docs/board.png', 'modified')).toBeNull();
    });

    it.each(unusableSides)('returns null for the original side when %s', async (_reason, side) => {
      fileImage.mockResolvedValue({ original: side, modified: bytesSide(MODIFIED_BYTES, 'blob:modified') });
      expect(await fetchDocumentImage(fullScope, 'docs/board.png', 'original')).toBeNull();
    });

    it.each(['docs/spec.pdf', 'docs/notes.txt', 'docs/LICENSE', 'docs/archive.png.zip'])(
      'returns null for %s without asking main',
      async (filePath) => {
        fileImage.mockResolvedValue(bothSidesAnswer);

        expect(await fetchDocumentImage(fullScope, filePath, 'modified')).toBeNull();
        expect(await fetchDocumentImage(fullScope, filePath, 'original')).toBeNull();

        expect(fileImage).not.toHaveBeenCalled();
      },
    );
  });

  describe('the data URL it returns', () => {
    it.each([
      ['docs/board.png', 'image/png'],
      ['docs/photo.JPG', 'image/jpeg'],
      ['docs/anim.gif', 'image/gif'],
      ['docs/logo.svg', 'image/svg+xml'],
    ])('carries the mime type of %s', async (filePath, mimeType) => {
      fileImage.mockResolvedValue(bothSidesAnswer);

      const dataUrl = await fetchDocumentImage(fullScope, filePath, 'modified');

      expect(dataUrl).toBe(`data:${mimeType};base64,${MODIFIED_BASE64}`);
    });
  });
});

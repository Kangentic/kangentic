/**
 * The shared image classification main and the renderer both read, so the
 * byte reader and the image view can never disagree about what is an image.
 */
import { describe, it, expect } from 'vitest';
import { imageKindForPath, imageMimeTypeForPath, isGitLfsPointer, IMAGE_PREVIEW_MAX_BYTES } from '../../src/shared/image-preview';

describe('imageKindForPath', () => {
  it('classifies every raster format Chromium decodes, case-insensitively', () => {
    for (const filePath of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.bmp', 'g.ico', 'h.avif', 'shots/HOME.PNG', 'x/y/Photo.JpEg']) {
      expect(imageKindForPath(filePath)).toBe('raster');
    }
  });

  it('classifies SVG separately: it is text, so it keeps a text diff', () => {
    expect(imageKindForPath('assets/icon.svg')).toBe('svg');
    expect(imageKindForPath('ICON.SVG')).toBe('svg');
  });

  it('returns null for anything else, including names that only look like an image', () => {
    for (const filePath of ['src/index.ts', 'feed.xml', 'Makefile', 'png', '.png', 'notes.png.md', 'archive.tar.gz', 'dir.png/file']) {
      expect(imageKindForPath(filePath)).toBeNull();
    }
  });

  it('reads the extension of the file name, never of a directory', () => {
    expect(imageKindForPath('screens.v2/home')).toBeNull();
    expect(imageKindForPath('C:\\repo\\img.dir\\logo.png')).toBe('raster');
  });
});

describe('imageMimeTypeForPath', () => {
  it('maps each extension to the MIME type a data URL needs', () => {
    expect(imageMimeTypeForPath('a.png')).toBe('image/png');
    expect(imageMimeTypeForPath('a.JPG')).toBe('image/jpeg');
    expect(imageMimeTypeForPath('a.jpeg')).toBe('image/jpeg');
    expect(imageMimeTypeForPath('a.ico')).toBe('image/x-icon');
    expect(imageMimeTypeForPath('a.svg')).toBe('image/svg+xml');
    expect(imageMimeTypeForPath('a.txt')).toBeNull();
  });
});

describe('isGitLfsPointer', () => {
  const encode = (text: string) => new TextEncoder().encode(text);

  it('recognizes the pointer file Git LFS stores in place of the image', () => {
    expect(isGitLfsPointer(encode('version https://git-lfs.github.com/spec/v1\noid sha256:4d7a\nsize 12345\n'))).toBe(true);
  });

  it('rejects image bytes, truncated headers, and anything too large to be a pointer', () => {
    expect(isGitLfsPointer(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isGitLfsPointer(encode('version https://git-lfs'))).toBe(false);
    expect(isGitLfsPointer(encode(`version https://git-lfs.github.com/spec/v1\n${'x'.repeat(2048)}`))).toBe(false);
  });

  it('accepts a pointer of exactly 1024 bytes and rejects one byte more: the size limit is strict', () => {
    // The limit is private to the module, so the boundary is stated here as 1024.
    const header = 'version https://git-lfs.github.com/spec/v1\n';
    const atLimit = encode(header + 'x'.repeat(1024 - header.length));
    const overLimit = encode(header + 'x'.repeat(1025 - header.length));
    // Preconditions: a miscount would test the wrong boundary and still pass.
    expect(atLimit.length).toBe(1024);
    expect(overLimit.length).toBe(1025);
    expect(isGitLfsPointer(atLimit)).toBe(true);
    expect(isGitLfsPointer(overLimit)).toBe(false);
  });
});

describe('IMAGE_PREVIEW_MAX_BYTES', () => {
  it('is 10 MB per side', () => {
    expect(IMAGE_PREVIEW_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

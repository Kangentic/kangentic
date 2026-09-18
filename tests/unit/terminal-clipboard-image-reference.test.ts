import { describe, it, expect, vi } from 'vitest';
import {
  formatImageReference,
  needsImageNormalization,
  pasteDroppedItems,
  resolveImagePasteText,
} from '../../src/renderer/utils/terminal-clipboard';

/**
 * Unit coverage for the adapter-declared image-paste decision used by the Ctrl+V
 * paste and drag-drop image paths (see agent-adapters-boundary.md: the renderer
 * never branches on agent name, only on the generic `PastedImageCapability`
 * surfaced via `agents.list`).
 *
 * `resolveImagePasteText` decides WHAT is pasted: the bare quoted path for an
 * extension the CLI attaches natively from a bracketed paste, the adapter's
 * fallback template for everything else. `formatImageReference` is the fallback
 * formatter it delegates to.
 */
describe('formatImageReference', () => {
  it('returns the bare quoted path when no template is given', () => {
    expect(formatImageReference('"C:\\temp\\pasted-image-1.png"')).toBe('"C:\\temp\\pasted-image-1.png"');
    expect(formatImageReference('"C:\\temp\\pasted-image-1.png"', undefined)).toBe('"C:\\temp\\pasted-image-1.png"');
  });

  it('substitutes {path} in the template with the quoted path', () => {
    expect(formatImageReference('"/tmp/x.png"', 'Read this image: {path} ')).toBe('Read this image: "/tmp/x.png" ');
  });

  it('substitutes every occurrence of {path}, not just the first', () => {
    expect(formatImageReference('"/tmp/x.png"', '{path} is at {path}')).toBe('"/tmp/x.png" is at "/tmp/x.png"');
  });

  it('appends the quoted path after a space when the template has no {path} placeholder', () => {
    expect(formatImageReference('"/tmp/x.png"', 'Look at this image')).toBe('Look at this image "/tmp/x.png"');
  });

  it('treats an empty-string template the same as no template (falsy)', () => {
    expect(formatImageReference('"/tmp/x.png"', '')).toBe('"/tmp/x.png"');
  });
});

describe('resolveImagePasteText', () => {
  // Mirrors ClaudeAdapter: png/jpg/jpeg/gif/webp attach natively, the rest fall
  // back to the explicit Read instruction.
  const claudeLike = {
    pastedImageNativeExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    pastedImageReferenceTemplate: 'Read this image: {path} ',
  };

  it('pastes the bare quoted path for an extension the CLI attaches natively', () => {
    expect(resolveImagePasteText('"C:\\temp\\shot.png"', 'C:\\temp\\shot.png', claudeLike))
      .toBe('"C:\\temp\\shot.png"');
    expect(resolveImagePasteText('/tmp/photo.jpeg', '/tmp/photo.jpeg', claudeLike)).toBe('/tmp/photo.jpeg');
    expect(resolveImagePasteText('/tmp/anim.gif', '/tmp/anim.gif', claudeLike)).toBe('/tmp/anim.gif');
    expect(resolveImagePasteText('/tmp/pic.webp', '/tmp/pic.webp', claudeLike)).toBe('/tmp/pic.webp');
  });

  it('matches the extension case-insensitively (Explorer keeps whatever case the file has)', () => {
    expect(resolveImagePasteText('"C:\\temp\\SHOT.PNG"', 'C:\\temp\\SHOT.PNG', claudeLike))
      .toBe('"C:\\temp\\SHOT.PNG"');
    expect(resolveImagePasteText('/tmp/photo.Jpg', '/tmp/photo.Jpg', claudeLike)).toBe('/tmp/photo.Jpg');
  });

  it('falls back to the template for an image outside the native set (bmp, svg)', () => {
    expect(resolveImagePasteText('/tmp/x.bmp', '/tmp/x.bmp', claudeLike)).toBe('Read this image: /tmp/x.bmp ');
    expect(resolveImagePasteText('"/tmp/my icon.svg"', '/tmp/my icon.svg', claudeLike))
      .toBe('Read this image: "/tmp/my icon.svg" ');
  });

  it('reads the extension off the file name, not off a dotted directory', () => {
    // The directory carries a ".png" segment; the file itself has no extension.
    expect(resolveImagePasteText('/tmp/shots.png/latest', '/tmp/shots.png/latest', claudeLike))
      .toBe('Read this image: /tmp/shots.png/latest ');
    expect(resolveImagePasteText('"C:\\shots.png\\latest"', 'C:\\shots.png\\latest', claudeLike))
      .toBe('Read this image: "C:\\shots.png\\latest" ');
  });

  it('uses the template for every image when the adapter declares no native set', () => {
    const templateOnly = { pastedImageReferenceTemplate: 'Read this image: {path} ' };
    expect(resolveImagePasteText('/tmp/x.png', '/tmp/x.png', templateOnly)).toBe('Read this image: /tmp/x.png ');
  });

  it('falls back to the template for a dotfile whose only dot is at index 0 (no extension)', () => {
    // `/tmp/.png` has no extension: fileExtension()'s `dot > 0` guard rejects a
    // leading dot, so this is treated the same as any other extensionless file
    // and falls outside the native set.
    expect(resolveImagePasteText('"/tmp/.png"', '/tmp/.png', claudeLike)).toBe('Read this image: "/tmp/.png" ');
  });

  it('pastes the bare quoted path when the adapter declares nothing at all', () => {
    expect(resolveImagePasteText('/tmp/x.png', '/tmp/x.png', {})).toBe('/tmp/x.png');
    expect(resolveImagePasteText('/tmp/x.bmp', '/tmp/x.bmp', undefined)).toBe('/tmp/x.bmp');
  });

  it('pastes the bare quoted path for a native extension even with no template declared', () => {
    const nativeOnly = { pastedImageNativeExtensions: ['png'] };
    expect(resolveImagePasteText('/tmp/x.png', '/tmp/x.png', nativeOnly)).toBe('/tmp/x.png');
    expect(resolveImagePasteText('/tmp/x.bmp', '/tmp/x.bmp', nativeOnly)).toBe('/tmp/x.bmp');
  });
});

describe('needsImageNormalization', () => {
  const claudeLike = {
    pastedImageNativeExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
    pastedImageReferenceTemplate: 'Read this image: {path} ',
  };

  it('asks for a PNG copy of an image outside the native set when the CLI attaches png', () => {
    expect(needsImageNormalization('C:\\shots\\diagram.bmp', claudeLike)).toBe(true);
    expect(needsImageNormalization('/tmp/icon.ico', claudeLike)).toBe(true);
    expect(needsImageNormalization('/tmp/DIAGRAM.BMP', claudeLike)).toBe(true);
  });

  it('leaves an image the CLI already attaches from its own format alone', () => {
    expect(needsImageNormalization('/tmp/shot.png', claudeLike)).toBe(false);
    expect(needsImageNormalization('/tmp/photo.JPG', claudeLike)).toBe(false);
    expect(needsImageNormalization('/tmp/anim.gif', claudeLike)).toBe(false);
  });

  it('never normalizes for an adapter that attaches nothing from a path', () => {
    // A PNG copy would be inert text there too; the original path plus the
    // template (or the bare path) is the better delivery.
    expect(needsImageNormalization('/tmp/diagram.bmp', undefined)).toBe(false);
    expect(needsImageNormalization('/tmp/diagram.bmp', {})).toBe(false);
    expect(needsImageNormalization('/tmp/diagram.bmp', { pastedImageReferenceTemplate: 'Look: {path}' })).toBe(false);
  });

  it('never normalizes for an adapter whose native set lacks png', () => {
    expect(needsImageNormalization('/tmp/diagram.bmp', { pastedImageNativeExtensions: ['jpg'] })).toBe(false);
  });

  it('asks for a PNG copy of a dotfile whose only dot is at index 0 (no extension)', () => {
    // Same `dot > 0` guard as above: `/tmp/.png` has no extension, so it reads
    // as outside the native set even though its name contains "png".
    expect(needsImageNormalization('/tmp/.png', claudeLike)).toBe(true);
  });
});

describe('pasteDroppedItems', () => {
  it('pastes one item per call, every item but the last carrying a trailing space', () => {
    const pasted: string[] = [];
    const delivered = pasteDroppedItems(['"a b.png"', '/tmp/c.png', 'notes.txt'], (text) => {
      pasted.push(text);
      return true;
    });
    expect(delivered).toBe(true);
    // Each call is its own packet under bracketed-paste mode; the separator
    // rides inside the preceding packet, so a shell prompt reads them
    // space-separated with no trailing space after the last.
    expect(pasted).toEqual(['"a b.png" ', '/tmp/c.png ', 'notes.txt']);
  });

  it('pastes a single item with no trailing space', () => {
    const pasted: string[] = [];
    expect(pasteDroppedItems(['/tmp/only.png'], (text) => { pasted.push(text); return true; })).toBe(true);
    expect(pasted).toEqual(['/tmp/only.png']);
  });

  it('reports false and pastes nothing further once a paste has no terminal to land in', () => {
    // useTerminal's paste handle returns false before its deferred initTerminal
    // has built the xterm; the drop hook then skips the focus that follows a
    // delivery instead of focusing a terminal that received nothing.
    const attempted: string[] = [];
    const delivered = pasteDroppedItems(['/tmp/a.png', '/tmp/b.png'], (text) => {
      attempted.push(text);
      return false;
    });
    expect(delivered).toBe(false);
    expect(attempted).toEqual(['/tmp/a.png ']);
  });

  it('reports true and never calls pasteText for an empty item list', () => {
    const pasteText = vi.fn(() => true);
    expect(pasteDroppedItems([], pasteText)).toBe(true);
    expect(pasteText).not.toHaveBeenCalled();
  });
});

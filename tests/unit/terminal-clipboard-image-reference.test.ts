import { describe, it, expect } from 'vitest';
import { formatImageReference } from '../../src/renderer/utils/terminal-clipboard';

/**
 * Unit coverage for the adapter-provided image-reference formatting used by
 * the Ctrl+V paste and drag-drop image paths (see agent-adapters-boundary.md:
 * the renderer never branches on agent name, only on the generic
 * `pastedImageReferenceTemplate` flag surfaced via `agents.list`).
 */
describe('formatImageReference', () => {
  it('returns the bare quoted path when no template is given (legacy behavior)', () => {
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

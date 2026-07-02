import { describe, it, expect } from 'vitest';
import { isChunkLoadError } from '../../src/renderer/utils/chunk-load-error';

describe('isChunkLoadError', () => {
  it('detects the Chromium dynamic-import failure message', () => {
    const error = new Error(
      'Failed to fetch dynamically imported module: http://localhost:5173/src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx',
    );
    expect(isChunkLoadError(error)).toBe(true);
  });

  it('detects other engines and bundler chunk messages case-insensitively', () => {
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Failed to load module script'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading chunk 42 failed'))).toBe(true);
    expect(isChunkLoadError(new Error('Loading CSS chunk foo failed'))).toBe(true);
  });

  it('accepts a plain string error message', () => {
    expect(isChunkLoadError('Failed to fetch dynamically imported module: /x.js')).toBe(true);
  });

  it('returns false for an ordinary render error', () => {
    expect(isChunkLoadError(new Error('Cannot read properties of undefined (reading map)'))).toBe(false);
  });

  it('returns false for non-error, empty, and nullish inputs', () => {
    expect(isChunkLoadError(new Error(''))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
    expect(isChunkLoadError(42)).toBe(false);
    expect(isChunkLoadError({})).toBe(false);
  });
});

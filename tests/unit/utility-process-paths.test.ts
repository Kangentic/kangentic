import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

/**
 * `unpacked()` (src/main/utility-process/paths.ts) is the hoisted helper
 * shared by every utilityProcess client that forks a worker bundled inside
 * the asar (embed-client.ts, line-count-client.ts, dictation-client.ts) -
 * each used to carry a byte-identical private copy. None of those clients'
 * tests exercise `app.isPackaged: true` (all three hardcode `false`), so the
 * asar-rewrite branch this hoist depends on has never run in any test, in
 * this PR or before it. `paths.ts` reads `app.isPackaged` at call time, so
 * the electron mock here is a mutable object flipped between tests rather
 * than a frozen per-test literal.
 */

const electronMock = vi.hoisted(() => ({ app: { isPackaged: false } }));

vi.mock('electron', () => ({ app: electronMock.app }));

import { unpacked } from '../../src/main/utility-process/paths';

describe('unpacked', () => {
  beforeEach(() => {
    electronMock.app.isPackaged = false;
  });

  it('returns the path unchanged when not packaged (dev mode)', () => {
    const devPath = 'C:/repo/.vite/build/dictation-worker.js';
    expect(unpacked(devPath)).toBe(devPath);
  });

  it('rewrites app.asar to app.asar.unpacked when packaged', () => {
    electronMock.app.isPackaged = true;
    expect(unpacked('C:/app/resources/app.asar/dictation-worker.js')).toBe(
      'C:/app/resources/app.asar.unpacked/dictation-worker.js',
    );
  });

  it('a packaged path with no app.asar segment passes through unchanged', () => {
    electronMock.app.isPackaged = true;
    const path = 'C:/app/resources/plain-dir/dictation-worker.js';
    expect(unpacked(path)).toBe(path);
  });

  it('replaces only the first app.asar occurrence, leaving a later literal match untouched', () => {
    // String.prototype.replace with a string search (not a /g regex) rewrites
    // only the first hit - pin that so a future regex "cleanup" can't
    // silently start rewriting every occurrence.
    electronMock.app.isPackaged = true;
    expect(unpacked('C:/app.asar/nested/app.asar/worker.js')).toBe(
      'C:/app.asar.unpacked/nested/app.asar/worker.js',
    );
  });
});

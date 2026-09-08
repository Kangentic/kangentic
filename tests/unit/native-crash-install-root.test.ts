import { describe, it, expect, afterEach } from 'vitest';
import { vi } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/electron/main';

/**
 * `resolveNativeCrashContext()` (error-reporting.ts) derives the macOS install
 * root one level ABOVE the executable's own directory
 * (`Contents/MacOS/<exe>` -> `Contents/`), because Frameworks/, the helper
 * bundles, and Resources/app.asar.unpacked all sit as siblings of MacOS/, not
 * inside it. Every OTHER platform branch uses the executable's own directory
 * directly. This is the only branch neither the local dev machine (Windows)
 * nor CI (Linux) exercises by just running the suite, since both pick their
 * branch from the REAL host `process.platform`.
 *
 * Node's `path` module is selected once by the actual host OS, not by
 * `process.platform` - mutating `process.platform` alone leaves `path` at
 * `path.win32` on a Windows runner, which would silently corrupt this test's
 * own path arithmetic rather than exercise the darwin branch. So this file
 * mocks `node:path` to `path.posix` (what a real macOS host provides) in
 * addition to mutating `process.platform`, in its own file so the posix mock
 * cannot affect any neighboring test's real path handling.
 */
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { default: actual.posix };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) =>
      name === 'exe'
        ? '/Applications/Kangentic.app/Contents/MacOS/Kangentic'
        : '/Users/dev/Library/Application Support/kangentic',
    getVersion: () => '0.39.0',
  },
}));

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

import { filterNativeCrashEvent } from '../../src/main/analytics/error-reporting';
import { buildMinidump } from '../fixtures/minidump-fixture';

/**
 * Under the install root's Resources/ subtree, not MacOS/. Deliberately the
 * ONLY module in the dump, with a basename ('pty.node') that does not match
 * the app executable ('Kangentic') and no 'Electron Framework' substring, so
 * this can only keep via the installRoot path-prefix match. If the darwin
 * derivation regressed to the executable's own directory
 * (Contents/MacOS/, same as every other platform), this module would fall
 * outside the install root on every guard and the crash would be dropped as
 * foreign.
 */
const SOLO_PTY_MODULE =
  '/Applications/Kangentic.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node';

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('resolveNativeCrashContext: macOS install root derivation', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('keeps a crash whose only module sits under Contents/, one level above the executable\'s own MacOS/ directory', () => {
    setPlatform('darwin');

    const result = filterNativeCrashEvent(
      { platform: 'native', release: 'Kangentic@0.39.0' } as ErrorEvent,
      {
        attachments: [
          {
            attachmentType: 'event.minidump',
            filename: 'crash.dmp',
            data: buildMinidump({ modules: [SOLO_PTY_MODULE] }),
          },
        ],
      } as EventHint
    );

    expect(result).not.toBeNull();
  });
});

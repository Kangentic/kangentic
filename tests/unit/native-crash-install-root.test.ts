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
 *
 * The same darwin setup also drives the unpackaged `npm start` case, where the
 * resolver blanks the executable name so a dev run trusts the install root
 * alone.
 */
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { default: actual.posix };
});

/** Mutable so a test can switch the mocked app to an unpackaged `npm start` run. */
const electronState = vi.hoisted(() => ({
  isPackaged: true,
  executablePath: '/Applications/Kangentic.app/Contents/MacOS/Kangentic',
}));

// Read from the hoisted state rather than repeating the literal. vi.hoisted
// runs before any other top-level const, so its factory cannot reference one.
const PACKAGED_EXECUTABLE = electronState.executablePath;
const DEV_EXECUTABLE =
  '/Users/dev/code/kangentic/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron';

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronState.isPackaged;
    },
    getPath: (name: string) =>
      name === 'exe' ? electronState.executablePath : '/Users/dev/Library/Application Support/kangentic',
    getVersion: () => '0.39.0',
  },
}));

vi.mock('@sentry/electron/main', () => ({
  init: vi.fn(),
  setUser: vi.fn(),
  captureException: vi.fn(),
  withScope: vi.fn(),
}));

import { filterNativeCrashEvent } from '../../src/main/analytics/error-reporting';
import { FOREIGN_CRASH_FINGERPRINT } from '../../src/main/analytics/native-crash-event';
import { buildMinidump } from '../fixtures/minidump-fixture';

/**
 * Under the install root's Resources/ subtree, not MacOS/. Deliberately the
 * ONLY module in the dump, with a basename ('pty.node') that does not match
 * the app executable ('Kangentic') and is not our bundle's Electron Framework,
 * so this can only keep via the installRoot path-prefix match. If the darwin
 * derivation regressed to the executable's own directory
 * (Contents/MacOS/, same as every other platform), this module would fall
 * outside the install root on every guard and the crash would read as foreign.
 */
const SOLO_PTY_MODULE =
  '/Applications/Kangentic.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/pty.node';

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * `ours` needs the `native_crash` context, which only the ownership check adds,
 * so a run that failed open (event and dump both untouched) cannot pass as ours.
 */
function classifyDump(modules: string[]): 'ours' | 'foreign' | 'failed open' {
  const hint: EventHint = {
    attachments: [
      {
        attachmentType: 'event.minidump',
        filename: 'crash.dmp',
        data: buildMinidump({ modules }),
      },
    ],
  };
  const event = filterNativeCrashEvent(
    { platform: 'native', release: 'Kangentic@0.39.0' } as ErrorEvent,
    hint
  );
  const dumpKept = (hint.attachments ?? []).some((attachment) => attachment.attachmentType === 'event.minidump');
  if (event.fingerprint?.[0] === FOREIGN_CRASH_FINGERPRINT[0] && !dumpKept) return 'foreign';
  if (event.contexts?.native_crash && dumpKept) return 'ours';
  return 'failed open';
}

const originalPlatform = process.platform;

afterEach(() => {
  setPlatform(originalPlatform);
  electronState.isPackaged = true;
  electronState.executablePath = PACKAGED_EXECUTABLE;
});

describe('resolveNativeCrashContext: macOS install root derivation', () => {
  it('keeps a crash whose only module sits under Contents/, one level above the executable\'s own MacOS/ directory', () => {
    setPlatform('darwin');

    expect(classifyDump([SOLO_PTY_MODULE])).toBe('ours');
  });
});

describe('resolveNativeCrashContext: a packaged run', () => {
  it('keeps a helper crash from a moved Kangentic.app, on the executable name the real resolver derives from app.getPath(\'exe\')', () => {
    // No module sits under the install root, so this keeps only through the
    // bundle fallback, which needs the executable name the resolver derives
    // on a packaged run. Every other test here keeps on the install root or
    // runs unpackaged, so without this one a resolver that blanked the name
    // on every run would still pass, and a real relocated crash would read as
    // foreign.
    setPlatform('darwin');

    expect(
      classifyDump([
        '/Users/dev/Downloads/Kangentic.app/Contents/Frameworks/Kangentic Helper (GPU).app/Contents/MacOS/Kangentic Helper (GPU)',
        '/Users/dev/Downloads/Kangentic.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
        '/usr/lib/dyld',
      ])
    ).toBe('ours');
  });
});

/**
 * In `npm start` the executable is `Electron` inside `Electron.app`. Every dev
 * Electron app shares both names, so matching on them would keep any dev
 * Electron app's crash as ours. An unpackaged run must trust the install root
 * alone.
 */
describe('resolveNativeCrashContext: an unpackaged dev run', () => {
  const OTHER_PROJECT_ELECTRON = '/Users/dev/other-project/node_modules/electron/dist/Electron.app/Contents';

  function useDevRun(): void {
    setPlatform('darwin');
    electronState.isPackaged = false;
    electronState.executablePath = DEV_EXECUTABLE;
  }

  it('keeps a crash from the checkout\'s own dev Electron', () => {
    useDevRun();

    expect(
      classifyDump([
        '/Users/dev/code/kangentic/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)',
        '/Users/dev/code/kangentic/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
        '/usr/lib/dyld',
      ])
    ).toBe('ours');
  });

  it('reads as foreign another project\'s dev Electron main process, whose executable is also named Electron', () => {
    useDevRun();

    expect(
      classifyDump([
        `${OTHER_PROJECT_ELECTRON}/MacOS/Electron`,
        `${OTHER_PROJECT_ELECTRON}/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
        '/usr/lib/dyld',
      ])
    ).toBe('foreign');
  });

  it('reads as foreign another project\'s dev Electron Helper, whose framework sits in a bundle also named Electron.app (DESKTOP-1D)', () => {
    useDevRun();

    expect(
      classifyDump([
        `${OTHER_PROJECT_ELECTRON}/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper`,
        `${OTHER_PROJECT_ELECTRON}/Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
        '/usr/lib/dyld',
      ])
    ).toBe('foreign');
  });
});

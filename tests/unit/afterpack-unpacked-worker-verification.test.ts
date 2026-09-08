/**
 * build/afterPack.js - the platform branch that computes `unpackedRoot`
 * (the `app.asar.unpacked` tree electron-builder just produced) and hands it
 * to `verifyUnpackedWorkerModules` (build/verify-unpacked-worker.js).
 *
 * Neither existing suite touches this wiring:
 * - tests/unit/verify-unpacked-worker.test.ts calls
 *   `verifyUnpackedWorkerModules` directly with a hand-built `unpackedRoot`,
 *   so it never exercises afterPack.js's own darwin-vs-Windows/Linux branch
 *   that COMPUTES that root.
 * - No other test imports build/afterPack.js at all.
 *
 * A wrong branch here (say, `Resources` on Windows, or a missing `.app/
 * Contents` segment on macOS) points the gate at a directory that does not
 * exist, so `verifyUnpackedWorkerModules` throws for the wrong reason (path
 * not found) or, worse, silently checks nothing if the path happens to
 * resolve elsewhere - either way the DESKTOP-H protection this file exists
 * for goes untested until a real release build fails.
 *
 * `@electron/fuses` interception: `vi.mock('@electron/fuses', ...)` does NOT
 * intercept afterPack.js's own `require('@electron/fuses')` call, for the
 * same reason documented in tests/unit/upload-native-debug-files.test.ts -
 * afterPack.js is loaded via vite-node's require/import interop as a plain
 * CJS module, and its top-level `require()` calls resolve through Node's own
 * module cache, not vitest's mock registry. The working technique is the same
 * one that file uses: pre-seed Node's OWN `require.cache`, at each
 * dependency's real resolved path, with a fake module BEFORE importing
 * afterPack.js, and re-import afterPack.js (via `vi.resetModules()` +
 * `import()`) for every test so its top-level `require()` calls re-run
 * against whichever fake is installed for that test.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ELECTRON_FUSES_RESOLVED_PATH = require.resolve('@electron/fuses');
const VERIFY_UNPACKED_WORKER_RESOLVED_PATH = require.resolve('../../build/verify-unpacked-worker.js');

interface FakeFlipFusesCall {
  electronBinaryPath: string;
}

interface FakeVerifyUnpackedWorkerCall {
  unpackedRoot: string;
}

/** electron-builder's AfterPackContext, narrowed to the fields afterPack.js
 *  actually reads. */
interface FakeAfterPackContext {
  packager: { appInfo: { productFilename: string }; executableName: string };
  electronPlatformName: 'darwin' | 'win32' | 'linux';
  appOutDir: string;
  arch: number;
}

function buildFakeContext(overrides: {
  platform: FakeAfterPackContext['electronPlatformName'];
  appOutDir: string;
}): FakeAfterPackContext {
  return {
    packager: { appInfo: { productFilename: 'Kangentic' }, executableName: 'kangentic' },
    electronPlatformName: overrides.platform,
    appOutDir: overrides.appOutDir,
    // 1 => 'x64' in afterPack.js's own archMap; a recognized arch keeps the
    // unrelated prebuild-stripping branch quiet (no "Unknown arch enum" warn).
    arch: 1,
  };
}

/** Installs a fake `@electron/fuses` export at its real resolved path in
 *  Node's require cache, so afterPack.js's `require('@electron/fuses')`
 *  returns it instead of the real package - the real `flipFuses` opens and
 *  rewrites an actual Electron binary, which no test here may touch.
 *  `restore()` must be called (a `finally` in every caller) to avoid leaking
 *  the fake into a sibling test. */
function installFakeElectronFuses(): {
  calls: FakeFlipFusesCall[];
  restore: () => void;
} {
  const calls: FakeFlipFusesCall[] = [];
  const fakeModule = {
    flipFuses: async (electronBinaryPath: string): Promise<void> => {
      calls.push({ electronBinaryPath });
    },
    FuseVersion: { V1: 'v1' },
    FuseV1Options: {
      RunAsNode: 'RunAsNode',
      EnableCookieEncryption: 'EnableCookieEncryption',
      EnableNodeOptionsEnvironmentVariable: 'EnableNodeOptionsEnvironmentVariable',
      EnableNodeCliInspectArguments: 'EnableNodeCliInspectArguments',
      EnableEmbeddedAsarIntegrityValidation: 'EnableEmbeddedAsarIntegrityValidation',
      OnlyLoadAppFromAsar: 'OnlyLoadAppFromAsar',
    },
  };

  const originalCacheEntry = require.cache[ELECTRON_FUSES_RESOLVED_PATH];
  require.cache[ELECTRON_FUSES_RESOLVED_PATH] = {
    id: ELECTRON_FUSES_RESOLVED_PATH,
    filename: ELECTRON_FUSES_RESOLVED_PATH,
    loaded: true,
    exports: fakeModule,
  } as unknown as NodeJS.Module;

  return {
    calls,
    restore: () => {
      if (originalCacheEntry) {
        require.cache[ELECTRON_FUSES_RESOLVED_PATH] = originalCacheEntry;
      } else {
        delete require.cache[ELECTRON_FUSES_RESOLVED_PATH];
      }
    },
  };
}

/** Installs a fake `verifyUnpackedWorkerModules` at
 *  build/verify-unpacked-worker.js's real resolved path, mirroring
 *  `installFakeElectronFuses` above. Records the `unpackedRoot` afterPack.js
 *  actually computed and passed in; `throwError`, when given, makes the fake
 *  throw it instead of returning, so a caller can prove afterPack.js
 *  propagates the verifier's failure rather than swallowing it. */
function installFakeVerifyUnpackedWorker(throwError?: Error): {
  calls: FakeVerifyUnpackedWorkerCall[];
  restore: () => void;
} {
  const calls: FakeVerifyUnpackedWorkerCall[] = [];
  const fakeModule = {
    verifyUnpackedWorkerModules: ({ unpackedRoot }: { unpackedRoot: string }): void => {
      calls.push({ unpackedRoot });
      if (throwError) throw throwError;
    },
  };

  const originalCacheEntry = require.cache[VERIFY_UNPACKED_WORKER_RESOLVED_PATH];
  require.cache[VERIFY_UNPACKED_WORKER_RESOLVED_PATH] = {
    id: VERIFY_UNPACKED_WORKER_RESOLVED_PATH,
    filename: VERIFY_UNPACKED_WORKER_RESOLVED_PATH,
    loaded: true,
    exports: fakeModule,
  } as unknown as NodeJS.Module;

  return {
    calls,
    restore: () => {
      if (originalCacheEntry) {
        require.cache[VERIFY_UNPACKED_WORKER_RESOLVED_PATH] = originalCacheEntry;
      } else {
        delete require.cache[VERIFY_UNPACKED_WORKER_RESOLVED_PATH];
      }
    },
  };
}

/** afterPack.js's own default export, typed to only what these tests call. */
type AfterPackFunction = (context: FakeAfterPackContext) => Promise<void>;

async function importAfterPack(): Promise<AfterPackFunction> {
  const imported = (await import('../../build/afterPack.js')) as unknown as {
    default: AfterPackFunction;
  };
  return imported.default;
}

beforeEach(() => {
  // Forces afterPack.js's top-level `require('@electron/fuses')` and
  // `require('./verify-unpacked-worker')` to re-run on the next import, so
  // each test's fakes (installed just before that import) are the ones
  // afterPack.js actually captures.
  vi.resetModules();
});

describe('afterPack: computing unpackedRoot for verifyUnpackedWorkerModules', () => {
  it('on darwin, points at <Product>.app/Contents/Resources/app.asar.unpacked - not the lowercase resources/ dir Windows and Linux use', async () => {
    const fakeFuses = installFakeElectronFuses();
    const fakeVerify = installFakeVerifyUnpackedWorker();
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'mac-out');
      await afterPack(buildFakeContext({ platform: 'darwin', appOutDir }));

      expect(fakeVerify.calls).toEqual([
        {
          unpackedRoot: path.join(
            appOutDir,
            'Kangentic.app',
            'Contents',
            'Resources',
            'app.asar.unpacked',
          ),
        },
      ]);
      // The verifier passed, so packaging must still proceed to flipFuses.
      expect(fakeFuses.calls).toHaveLength(1);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
    }
  });

  it('on win32, points directly at appOutDir/resources/app.asar.unpacked - no .app/Contents wrapper', async () => {
    const fakeFuses = installFakeElectronFuses();
    const fakeVerify = installFakeVerifyUnpackedWorker();
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'win-out');
      await afterPack(buildFakeContext({ platform: 'win32', appOutDir }));

      expect(fakeVerify.calls).toEqual([
        { unpackedRoot: path.join(appOutDir, 'resources', 'app.asar.unpacked') },
      ]);
      expect(fakeFuses.calls).toHaveLength(1);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
    }
  });

  it('propagates verifyUnpackedWorkerModules failure and never reaches flipFuses, so a broken unpacked tree cannot still ship a fuse-flipped, signed build', async () => {
    const fakeFuses = installFakeElectronFuses();
    const verificationError = new Error(
      '[afterPack] @huggingface/transformers does not load from the unpacked tree',
    );
    const fakeVerify = installFakeVerifyUnpackedWorker(verificationError);
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'win-out-broken');

      await expect(afterPack(buildFakeContext({ platform: 'win32', appOutDir }))).rejects.toBe(
        verificationError,
      );

      expect(fakeVerify.calls).toEqual([
        { unpackedRoot: path.join(appOutDir, 'resources', 'app.asar.unpacked') },
      ]);
      expect(fakeFuses.calls).toEqual([]);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
    }
  });
});

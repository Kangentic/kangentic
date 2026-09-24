/**
 * build/afterSign.js - re-runs the spawn-helper gate on the SIGNED app, before
 * notarization. afterPack proves the helper clears the inherited mach exception
 * ports before signing; hardened runtime is the one thing signing adds, and no
 * one on the team builds on a Mac, so this is the only proof on the bytes that
 * ship (Sentry DESKTOP-K, -N, -Q, -1D).
 *
 * `verifyPackagedSpawnHelpers` is faked at build/install-spawn-helper.js's real
 * resolved path in Node's own `require.cache`, the technique
 * tests/unit/afterpack-unpacked-worker-verification.test.ts documents: afterSign.js
 * is a plain CJS module, so vi.mock never reaches its top-level `require()`.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const INSTALL_SPAWN_HELPER_RESOLVED_PATH = require.resolve('../../build/install-spawn-helper.js');

interface FakeAfterSignContext {
  packager: { appInfo: { productFilename: string } };
  electronPlatformName: 'darwin' | 'win32' | 'linux';
  appOutDir: string;
}

function buildFakeContext(platform: FakeAfterSignContext['electronPlatformName'], appOutDir: string): FakeAfterSignContext {
  return {
    packager: { appInfo: { productFilename: 'Kangentic' } },
    electronPlatformName: platform,
    appOutDir,
  };
}

function installFakeVerifyPackagedSpawnHelpers(throwError?: Error): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const fakeModule = {
    verifyPackagedSpawnHelpers: ({ unpackedRoot }: { unpackedRoot: string }): void => {
      calls.push(unpackedRoot);
      if (throwError) throw throwError;
    },
  };

  const originalCacheEntry = require.cache[INSTALL_SPAWN_HELPER_RESOLVED_PATH];
  require.cache[INSTALL_SPAWN_HELPER_RESOLVED_PATH] = {
    id: INSTALL_SPAWN_HELPER_RESOLVED_PATH,
    filename: INSTALL_SPAWN_HELPER_RESOLVED_PATH,
    loaded: true,
    exports: fakeModule,
  } as unknown as NodeJS.Module;

  return {
    calls,
    restore: () => {
      if (originalCacheEntry) {
        require.cache[INSTALL_SPAWN_HELPER_RESOLVED_PATH] = originalCacheEntry;
      } else {
        delete require.cache[INSTALL_SPAWN_HELPER_RESOLVED_PATH];
      }
    },
  };
}

type AfterSignFunction = (context: FakeAfterSignContext) => Promise<void>;

async function importAfterSign(): Promise<AfterSignFunction> {
  const imported = (await import('../../build/afterSign.js')) as unknown as { default: AfterSignFunction };
  return imported.default;
}

beforeEach(() => {
  vi.resetModules();
  // No credentials: afterSign takes its "skip notarization" branch, so no test
  // here can reach a real notarytool call.
  vi.stubEnv('APPLE_ID', '');
  vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', '');
  vi.stubEnv('APPLE_TEAM_ID', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('afterSign: spawn-helper gate on the signed app', () => {
  it('on darwin, verifies <Product>.app/Contents/Resources/app.asar.unpacked, even when notarization is skipped', async () => {
    const fakeVerify = installFakeVerifyPackagedSpawnHelpers();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const afterSign = await importAfterSign();
      const appOutDir = path.join('aftersign-fake-out', 'mac-out');
      await afterSign(buildFakeContext('darwin', appOutDir));

      expect(fakeVerify.calls).toEqual([
        path.join(appOutDir, 'Kangentic.app', 'Contents', 'Resources', 'app.asar.unpacked'),
      ]);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping notarization'));
    } finally {
      fakeVerify.restore();
    }
  });

  it('propagates a failed gate before notarization, so a signed helper that no longer clears the ports is never notarized', async () => {
    vi.stubEnv('APPLE_ID', 'release@example.com');
    vi.stubEnv('APPLE_APP_SPECIFIC_PASSWORD', 'app-specific-password');
    vi.stubEnv('APPLE_TEAM_ID', 'TEAMID1234');
    const gateError = new Error('[spawn-helper] failed the exception-port gate');
    const fakeVerify = installFakeVerifyPackagedSpawnHelpers(gateError);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const afterSign = await importAfterSign();
      await expect(afterSign(buildFakeContext('darwin', path.join('aftersign-fake-out', 'mac-broken')))).rejects.toBe(
        gateError,
      );
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('Notarizing'));
    } finally {
      fakeVerify.restore();
    }
  });

  it('does nothing on win32 and linux', async () => {
    const fakeVerify = installFakeVerifyPackagedSpawnHelpers();
    try {
      const afterSign = await importAfterSign();
      await afterSign(buildFakeContext('win32', path.join('aftersign-fake-out', 'win-out')));
      await afterSign(buildFakeContext('linux', path.join('aftersign-fake-out', 'linux-out')));
      expect(fakeVerify.calls).toEqual([]);
    } finally {
      fakeVerify.restore();
    }
  });
});

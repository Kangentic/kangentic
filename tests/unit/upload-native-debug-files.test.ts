/**
 * Unit coverage for `uploadNativeDebugFiles` in scripts/build.js - the
 * release-only, Windows-only, token-gated upload of node-pty's shipped
 * Windows PDBs to Sentry as debug files (see the function's own doc comment
 * in build.js: DESKTOP-C had to be symbolicated offline with dbghelp because
 * this path had never run in a release).
 *
 * `uploadSourcemaps` is computed once at module load from
 * `KANGENTIC_SENTRY_TOKEN ?? SENTRY_AUTH_TOKEN`, so each scenario that needs
 * a different token/platform combination resets the module registry
 * (`vi.resetModules()`) and re-imports the script after stubbing env and
 * `process.platform` - mirroring how
 * tests/unit/assert-vendor-chunks-lazy.test.ts imports this same CJS script
 * via vite-node's require/import interop.
 *
 * `@sentry/cli` interception: `vi.mock('@sentry/cli', ...)` does NOT
 * intercept build.js's `require('@sentry/cli')` call - build.js is loaded
 * via vite-node's require/import interop as a plain CJS module, and its
 * function-scoped `require` resolves through Node's own module cache, not
 * vitest's mock registry (empirically confirmed: a probing `vi.mock` that
 * threw on load was never reached, and the real @sentry/cli constructor ran,
 * attempting an actual network call to Sentry's API - it failed only because
 * no valid token was supplied, not because anything here stopped it). The
 * working technique instead pre-seeds Node's OWN `require.cache` at
 * `@sentry/cli`'s resolved absolute path with a fake module before importing
 * build.js, so build.js's `require('@sentry/cli')` finds the cache hit and
 * returns the fake export without ever touching the real package. EVERY
 * scenario below installs the fake, including the three that expect the
 * require to never be reached at all: this worktree's real
 * node_modules/node-pty/prebuilds/win32-x64 and win32-arm64 exist (as empty
 * directories), so relying on the real filesystem state to keep those
 * scenarios away from `require('@sentry/cli')` is not safe - only asserting
 * `constructorCalls` stays empty, behind a fake that can never reach the
 * network, is. Every test that installs the fake restores the original
 * cache entry (or deletes the key) in a `finally`, so no test leaks state
 * into a sibling.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SENTRY_CLI_RESOLVED_PATH = require.resolve('@sentry/cli');

const ORIGINAL_PLATFORM = process.platform;

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

interface FakeSentryCliConstructorCall {
  configFile: unknown;
  options: unknown;
}

interface FakeSentryCliExecuteCall {
  args: string[];
  mode: string;
}

/**
 * Installs a fake `@sentry/cli` export at its real resolved path in Node's
 * require cache, so build.js's `require('@sentry/cli')` returns it instead
 * of the real package - the real package's `execute()` spawns an actual
 * sentry-cli process / network call, which no test here may ever trigger.
 * `restore()` must be called (a `finally` in every caller) to avoid leaking
 * the fake into a sibling test. Defaults `executeImplementation` to a
 * resolved no-op so scenarios that only care about the constructor (or that
 * expect the require to never happen at all) do not have to supply one.
 */
function installFakeSentryCli(
  executeImplementation: (args: string[], mode: string) => Promise<void> = async () => undefined,
): {
  constructorCalls: FakeSentryCliConstructorCall[];
  executeCalls: FakeSentryCliExecuteCall[];
  restore: () => void;
} {
  const constructorCalls: FakeSentryCliConstructorCall[] = [];
  const executeCalls: FakeSentryCliExecuteCall[] = [];

  class FakeSentryCli {
    constructor(configFile: unknown, options: unknown) {
      constructorCalls.push({ configFile, options });
    }
    execute(args: string[], mode: string): Promise<void> {
      executeCalls.push({ args, mode });
      return executeImplementation(args, mode);
    }
  }

  const originalCacheEntry = require.cache[SENTRY_CLI_RESOLVED_PATH];
  require.cache[SENTRY_CLI_RESOLVED_PATH] = {
    id: SENTRY_CLI_RESOLVED_PATH,
    filename: SENTRY_CLI_RESOLVED_PATH,
    loaded: true,
    exports: FakeSentryCli,
  } as unknown as NodeJS.Module;

  return {
    constructorCalls,
    executeCalls,
    restore: () => {
      if (originalCacheEntry) {
        require.cache[SENTRY_CLI_RESOLVED_PATH] = originalCacheEntry;
      } else {
        delete require.cache[SENTRY_CLI_RESOLVED_PATH];
      }
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  // Clear both token env vars so each test starts from the ungated state;
  // scenarios that need a token stub it explicitly.
  vi.stubEnv('KANGENTIC_SENTRY_TOKEN', '');
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('uploadNativeDebugFiles', () => {
  it('(1) no-ops without touching fs.existsSync or requiring @sentry/cli when no token is set, even on win32', async () => {
    setPlatform('win32');
    // Mocked (not pass-through): this worktree's real
    // node_modules/node-pty/prebuilds/win32-x64 happens to exist (an empty
    // dir), so a pass-through spy would make this test's "not called" proof
    // depend on incidental local disk state instead of on the token gate
    // actually short-circuiting before this call.
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fakeSentryCli = installFakeSentryCli();

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles()).resolves.toBeUndefined();

      expect(existsSyncSpy).not.toHaveBeenCalled();
      expect(fakeSentryCli.constructorCalls).toEqual([]);
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      fakeSentryCli.restore();
    }
  });

  it('(2) no-ops on a non-win32 platform even with a token set', async () => {
    setPlatform('linux');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    // See the same note in scenario (1): mocked, not pass-through.
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fakeSentryCli = installFakeSentryCli();

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles()).resolves.toBeUndefined();

      expect(existsSyncSpy).not.toHaveBeenCalled();
      expect(fakeSentryCli.constructorCalls).toEqual([]);
      expect(console.warn).not.toHaveBeenCalled();
    } finally {
      fakeSentryCli.restore();
    }
  });

  it('(3) warns and no-ops when token + win32 but no node-pty Windows prebuilds exist', async () => {
    setPlatform('win32');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fakeSentryCli = installFakeSentryCli();

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles()).resolves.toBeUndefined();

      // Proves the mock actually intercepted the call the function makes
      // (rather than this passing by coincidence because the real
      // node_modules/node-pty/prebuilds dir happens to be absent locally).
      expect(existsSyncSpy).toHaveBeenCalled();
      expect(existsSyncSpy.mock.calls.some((call) => String(call[0]).includes('win32-x64'))).toBe(true);
      expect(fakeSentryCli.constructorCalls).toEqual([]);
      expect(console.warn).toHaveBeenCalledWith(
        '[build] No node-pty Windows prebuilds found; skipping the debug-file upload',
      );
    } finally {
      fakeSentryCli.restore();
    }
  });

  it('(4) uploads with the org/project/prebuild-dir args and logs success once execute resolves', async () => {
    setPlatform('win32');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const fakeSentryCli = installFakeSentryCli(async () => undefined);

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles()).resolves.toBeUndefined();

      expect(fakeSentryCli.constructorCalls).toEqual([
        { configFile: null, options: { authToken: 'fake-token', silent: false } },
      ]);
      expect(fakeSentryCli.executeCalls).toEqual([
        {
          args: [
            'debug-files',
            'upload',
            '--org',
            'kangentic',
            '--project',
            'desktop',
            expect.stringContaining(path.join('node-pty', 'prebuilds', 'win32-x64')),
            expect.stringContaining(path.join('node-pty', 'prebuilds', 'win32-arm64')),
          ],
          mode: 'rejectOnError',
        },
      ]);
      expect(console.log).toHaveBeenCalledWith(
        '[build] Uploaded node-pty debug files to Sentry from 2 prebuild dir(s)',
      );
      expect(console.warn).not.toHaveBeenCalled();
    } finally {
      fakeSentryCli.restore();
    }
  });

  it('(5) warns and lets the build finish (does not throw) when execute rejects', async () => {
    setPlatform('win32');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const uploadError = new Error('sentry-cli exited with code 1');
    const fakeSentryCli = installFakeSentryCli(async () => {
      throw uploadError;
    });

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles()).resolves.toBeUndefined();

      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('node-pty debug-file upload failed; native frames from this release will not symbolicate on Sentry'),
        uploadError,
      );
      // A failed upload must not block the build: no success log, no throw.
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      fakeSentryCli.restore();
    }
  });
});

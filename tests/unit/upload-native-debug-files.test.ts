/**
 * Unit coverage for `uploadNativeDebugFiles` in scripts/build.js - the
 * release-only, Windows-only, token-gated upload of node-pty's shipped
 * Windows PDBs to Sentry as debug files (see the function's own doc comment
 * in build.js: DESKTOP-C had to be symbolicated offline with dbghelp because
 * this path had never run in a release).
 *
 * `uploadSourcemaps` is computed once at module load from
 * `resolveSentryAuthToken(process.env)`, so each scenario that needs
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
const SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH = require.resolve('@sentry/esbuild-plugin');

const ORIGINAL_PLATFORM = process.platform;
// build.js assigns process.env.NODE_ENV at module load (see its comment: the
// Sentry plugins skip their upload when it reads 'development'). Importing it
// here would otherwise leak that into every sibling test in this worker.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

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

/**
 * The subset of `sentryEsbuildPlugin`'s options object this repo's own build.js
 * code constructs and reads back in the test below. Typed locally rather than
 * imported from `@sentry/esbuild-plugin` because the fake below stands in for
 * the whole module - there is no real options type to satisfy at the call site.
 */
interface CapturedSentryEsbuildPluginOptions {
  org: string;
  project: string;
  authToken: string;
  telemetry: boolean;
  release: { name: string };
  errorHandler: (error: Error) => void;
  sourcemaps: { filesToDeleteAfterUpload: string[] };
}

/**
 * Installs a fake `@sentry/esbuild-plugin` export at its real resolved path in
 * Node's require cache, mirroring `installFakeSentryCli` above. Needed because
 * `resolveSentryEsbuildPlugins()` runs as an eager side effect of build.js's
 * top-level `esbuildCommon` object literal - by the time `import('../../scripts/build.js')`
 * resolves, the real `require('@sentry/esbuild-plugin')` will already have run
 * unless the fake is installed first, so every caller here installs it BEFORE
 * importing build.js. `restore()` must be called (a `finally` in every caller)
 * to avoid leaking the fake into a sibling test.
 */
function installFakeSentryEsbuildPlugin(): {
  calls: CapturedSentryEsbuildPluginOptions[];
  restore: () => void;
} {
  const calls: CapturedSentryEsbuildPluginOptions[] = [];

  const fakeModule = {
    sentryEsbuildPlugin: (options: CapturedSentryEsbuildPluginOptions) => {
      calls.push(options);
      return { name: 'fake-sentry-esbuild-plugin', setup: () => undefined };
    },
  };

  const originalCacheEntry = require.cache[SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH];
  require.cache[SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH] = {
    id: SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH,
    filename: SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH,
    loaded: true,
    exports: fakeModule,
  } as unknown as NodeJS.Module;

  return {
    calls,
    restore: () => {
      if (originalCacheEntry) {
        require.cache[SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH] = originalCacheEntry;
      } else {
        delete require.cache[SENTRY_ESBUILD_PLUGIN_RESOLVED_PATH];
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
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
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

  // Reaching this branch means a token was supplied AND this is the win32 leg, so an
  // upload was intended and there is nothing to upload. That is the same "green build,
  // no symbols" outcome as a failed upload, so it fails the same way. It warned and
  // resolved until 2026-09-07; the release-gates-fail-loudly rule forbids that shape.
  it('(3) THROWS when token + win32 but no node-pty Windows prebuilds exist', async () => {
    setPlatform('win32');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    const existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const fakeSentryCli = installFakeSentryCli();

    try {
      const buildModule = await import('../../scripts/build.js');

      await expect(buildModule.uploadNativeDebugFiles())
        .rejects.toThrow(/No node-pty Windows prebuilds found/);

      // Proves the mock actually intercepted the call the function makes
      // (rather than this passing by coincidence because the real
      // node_modules/node-pty/prebuilds dir happens to be absent locally).
      expect(existsSyncSpy).toHaveBeenCalled();
      expect(existsSyncSpy.mock.calls.some((call) => String(call[0]).includes('win32-x64'))).toBe(true);
      expect(fakeSentryCli.constructorCalls).toEqual([]);
      // It fails instead of warning, so the old warn line must be gone: a warn
      // here would mean the build kept going.
      expect(console.warn).not.toHaveBeenCalled();
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

  it('(5) THROWS when execute rejects, so a failed upload fails the release', async () => {
    setPlatform('win32');
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const uploadError = new Error('sentry-cli exited with code 1');
    const fakeSentryCli = installFakeSentryCli(async () => {
      throw uploadError;
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const buildModule = await import('../../scripts/build.js');

      // This used to warn and resolve. A token being present means an upload
      // was intended, and a release whose native frames cannot symbolicate is
      // exactly what v0.38.0 shipped, so the only outcomes now are "uploaded"
      // or "the build stopped".
      await expect(buildModule.uploadNativeDebugFiles()).rejects.toThrow(uploadError);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('refusing to ship a release whose native frames cannot symbolicate'),
      );
      // No false success line.
      expect(console.log).not.toHaveBeenCalled();
    } finally {
      fakeSentryCli.restore();
    }
  });
});

/**
 * The token pick is tested through its own exported function rather than
 * through `uploadSourcemaps`, which is computed once at module load. A case
 * that stubs env and re-imports proves only what the module registry happened
 * to cache.
 */
describe('resolveSentryAuthToken', () => {
  it('prefers the scoped name', async () => {
    const { resolveSentryAuthToken } = await import('../../scripts/build.js');
    expect(resolveSentryAuthToken({
      KANGENTIC_SENTRY_TOKEN: 'scoped',
      SENTRY_AUTH_TOKEN: 'conventional',
    })).toBe('scoped');
  });

  it('falls through to SENTRY_AUTH_TOKEN when the scoped name is an EMPTY STRING', async () => {
    // The regression this function exists for. GitHub Actions still injects an
    // `env:` key whose `${{ secrets.X }}` came back empty, so the old
    // `KANGENTIC_SENTRY_TOKEN ?? SENTRY_AUTH_TOKEN` returned '' (not nullish,
    // so `??` never fell through) and the documented CI fallback was dead.
    const { resolveSentryAuthToken } = await import('../../scripts/build.js');
    expect(resolveSentryAuthToken({
      KANGENTIC_SENTRY_TOKEN: '',
      SENTRY_AUTH_TOKEN: 'conventional',
    })).toBe('conventional');
  });

  it('treats a whitespace-only token as absent', async () => {
    const { resolveSentryAuthToken } = await import('../../scripts/build.js');
    expect(resolveSentryAuthToken({ KANGENTIC_SENTRY_TOKEN: '   ' })).toBeUndefined();
  });

  it('trims surrounding whitespace off a real token', async () => {
    const { resolveSentryAuthToken } = await import('../../scripts/build.js');
    expect(resolveSentryAuthToken({ KANGENTIC_SENTRY_TOKEN: ' sntryu_abc \n' })).toBe('sntryu_abc');
  });

  it('returns undefined when neither name is set', async () => {
    const { resolveSentryAuthToken } = await import('../../scripts/build.js');
    expect(resolveSentryAuthToken({})).toBeUndefined();
  });
});

/**
 * Two fields on the constructed sentryEsbuildPlugin options run under existing
 * tests as a side effect (they execute inside `esbuildCommon`'s eager
 * construction) but neither field's effect was ever asserted:
 *
 * - `release: { name: ... }` files the uploaded sourcemaps under
 *   `Kangentic@<version>`. Left unset, the plugin falls back to `GITHUB_SHA`
 *   and no runtime event, which reports `Kangentic@<version>`, ever matches
 *   the uploaded release.
 * - `errorHandler` overrides the plugin's default warn-and-continue behavior.
 *   Without it, a failed upload logs a warning and lets the build finish, so
 *   the release ships with unreadable maps while the release job still
 *   reports success.
 *
 * The fake `@sentry/esbuild-plugin` module must be installed BEFORE importing
 * build.js: `resolveSentryEsbuildPlugins()` runs eagerly as part of the
 * top-level `esbuildCommon` object literal, not lazily on first call.
 */
describe('resolveSentryEsbuildPlugins', () => {
  it('files the release under Kangentic@<version> and rethrows the exact error passed to it, not the plugin default', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    const fakeSentryEsbuildPlugin = installFakeSentryEsbuildPlugin();

    try {
      const buildModule = await import('../../scripts/build.js');
      const { version: packageVersion } = require('../../package.json');

      // Discard whatever the eager module-load side effect already captured
      // and call the exported function directly, so the assertion below is
      // about resolveSentryEsbuildPlugins's own behavior, not an artifact of
      // when esbuildCommon happens to be constructed.
      fakeSentryEsbuildPlugin.calls.length = 0;
      const plugins = buildModule.resolveSentryEsbuildPlugins();

      expect(plugins).toHaveLength(1);
      expect(fakeSentryEsbuildPlugin.calls).toHaveLength(1);
      const [capturedOptions] = fakeSentryEsbuildPlugin.calls;

      expect(capturedOptions.release).toBeDefined();
      expect(capturedOptions.release.name).toBe(`Kangentic@${packageVersion}`);

      const uploadError = new Error('sentry-cli exited with code 1');
      let thrownError: unknown;
      try {
        capturedOptions.errorHandler(uploadError);
      } catch (error) {
        thrownError = error;
      }
      // Identity, not message equality: a deleted errorHandler throws a
      // TypeError with a different message (still red, but for the wrong
      // reason), and a reverted warn-and-continue handler throws nothing at
      // all, leaving thrownError undefined. Both fail this exact comparison.
      expect(thrownError).toBe(uploadError);
    } finally {
      fakeSentryEsbuildPlugin.restore();
    }
  });
});

/**
 * The SECOND reason no release ever had sourcemaps, independent of the missing
 * CI secret and equally silent.
 *
 * Both Sentry bundler plugins share createSentryBuildPluginManager, which reads
 * `isDevMode = process.env.NODE_ENV === 'development'` at plugin CONSTRUCTION
 * time. A dev-mode plugin logs "Running in development mode. Will not upload
 * sourcemaps." at DEBUG level only, deletes the maps anyway in its finally
 * block, and lets the build exit 0. Measured in this worktree: a build with a
 * valid token uploaded zero bundles, and the identical build with
 * NODE_ENV=production uploaded five.
 */
describe('the NODE_ENV dev-mode skip', () => {
  it('is prevented: build.js pins NODE_ENV to production at module load', async () => {
    process.env.NODE_ENV = 'development';
    vi.resetModules();

    await import('../../scripts/build.js');

    expect(process.env.NODE_ENV).toBe('production');
  });

  // The guard asserts NODE_ENV IS 'production', not that it is not
  // 'development'. The negative form would be unreachable, since build.js pins
  // the value at module load and nothing runs in between. The positive form
  // still fires if that assignment is deleted, or if some future entry point
  // builds the plugins without going through build.js - which is the shape the
  // real bug had: nobody set it, rather than somebody set it wrong.
  it.each([
    ['development', 'the value the plugins explicitly skip on'],
    ['test', 'a value that is merely not production'],
    [undefined, 'unset, which is how the original bug actually presented'],
  ])('throws when NODE_ENV is %s (%s)', async (value) => {
    const { assertUploadCanActuallyRun } = await import('../../scripts/build.js');
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }

    expect(() => assertUploadCanActuallyRun()).toThrow(/rather than "production"/);
    expect(() => assertUploadCanActuallyRun()).toThrow(/unreadable stacks and a green build log/);
  });

  it('allows a production build through', async () => {
    const { assertUploadCanActuallyRun } = await import('../../scripts/build.js');
    process.env.NODE_ENV = 'production';

    expect(() => assertUploadCanActuallyRun()).not.toThrow();
  });
});

/**
 * The build must SAY which way the gate went. Printing nothing when the token
 * was absent is the whole reason v0.38.0 and v0.37.0 shipped with no symbols
 * and nothing in their release logs recorded it.
 */
describe('announceSentryUploadMode', () => {
  it('names the missing env vars when no token is set', async () => {
    const buildModule = await import('../../scripts/build.js');

    buildModule.announceSentryUploadMode();

    expect(console.log).toHaveBeenCalledWith(
      '[build] Sentry symbol upload: skipped (no KANGENTIC_SENTRY_TOKEN or SENTRY_AUTH_TOKEN)',
    );
  });

  it('names the release the artifacts will be filed under when a token is set', async () => {
    vi.stubEnv('KANGENTIC_SENTRY_TOKEN', 'fake-token');
    const buildModule = await import('../../scripts/build.js');

    buildModule.announceSentryUploadMode();

    // The release name must match what @sentry/electron reports at runtime
    // (`Kangentic@<version>`); left to the bundler default it would be
    // GITHUB_SHA, filing the maps under a name no event ever carries.
    expect(console.log).toHaveBeenCalledWith(
      expect.stringMatching(/^\[build\] Sentry symbol upload: enabled \(release Kangentic@\d+\.\d+\.\d+\)$/),
    );
  });
});

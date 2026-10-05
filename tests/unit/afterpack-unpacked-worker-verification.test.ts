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
 * build/install-spawn-helper.js is faked the same way. The real one compiles
 * C with xcrun on darwin, and its own suite (tests/unit/install-spawn-helper.test.ts)
 * covers what it does; this file pins only that afterPack.js calls it with the
 * computed `unpackedRoot` and propagates its failure.
 *
 * Tier: Unit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// The REAL enum and reader, through the ESM loader, which the require.cache fake below does not
// touch. The fake hands afterPack.js this same enum, so a fuse added to @electron/fuses is a fuse
// the config is checked against.
import { FuseV1Options as RealFuseV1Options, FuseVersion as RealFuseVersion, getCurrentFuseWire } from '@electron/fuses';

const require = createRequire(import.meta.url);
const ELECTRON_FUSES_RESOLVED_PATH = require.resolve('@electron/fuses');
const VERIFY_UNPACKED_WORKER_RESOLVED_PATH = require.resolve('../../build/verify-unpacked-worker.js');
const INSTALL_SPAWN_HELPER_RESOLVED_PATH = require.resolve('../../build/install-spawn-helper.js');

interface FakeFlipFusesCall {
  electronBinaryPath: string;
}

interface FakeVerifyUnpackedWorkerCall {
  unpackedRoot: string;
  moduleNames?: string[];
  /** Set on the retrieval load probe's call: the Electron binary it runs. */
  loadProbeBinary?: string;
  /** Set on the pty host load probe's call: the Electron binary it runs. */
  ptyHostProbeBinary?: string;
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
  /** electron-builder's Arch enum value: 1 is x64 (the default), 3 is arm64. */
  arch?: number;
}): FakeAfterPackContext {
  return {
    packager: { appInfo: { productFilename: 'Kangentic' }, executableName: 'kangentic' },
    electronPlatformName: overrides.platform,
    appOutDir: overrides.appOutDir,
    // 1 => 'x64' in afterPack.js's own archMap; a recognized arch keeps the
    // unrelated prebuild-stripping branch quiet (no "Unknown arch enum" warn).
    arch: overrides.arch ?? 1,
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
  /** The fuse config afterPack.js passed, one per flipFuses call. */
  configs: Record<string, unknown>[];
  restore: () => void;
} {
  const calls: FakeFlipFusesCall[] = [];
  const configs: Record<string, unknown>[] = [];
  const fakeModule = {
    flipFuses: async (electronBinaryPath: string, fuseConfig: Record<string, unknown>): Promise<void> => {
      calls.push({ electronBinaryPath });
      configs.push(fuseConfig);
    },
    FuseVersion: RealFuseVersion,
    FuseV1Options: RealFuseV1Options,
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
    configs,
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
 *  propagates the verifier's failure rather than swallowing it.
 *  `onRetrievalLoadProbe`, when given, runs at the moment the retrieval load
 *  probe is called, so a test can look at the unpacked tree as that probe would
 *  see it. */
function installFakeVerifyUnpackedWorker(
  throwError?: Error,
  loadProbeError?: Error,
  onRetrievalLoadProbe?: () => void,
): {
  calls: FakeVerifyUnpackedWorkerCall[];
  restore: () => void;
} {
  const calls: FakeVerifyUnpackedWorkerCall[] = [];
  const fakeModule = {
    verifyUnpackedWorkerModules: ({ unpackedRoot, moduleNames }: { unpackedRoot: string; moduleNames?: string[] }): void => {
      calls.push(moduleNames ? { unpackedRoot, moduleNames } : { unpackedRoot });
      if (throwError) throw throwError;
    },
    verifyRetrievalWorkerLoads: ({ unpackedRoot, electronBinaryPath }: { unpackedRoot: string; electronBinaryPath: string }): void => {
      calls.push({ unpackedRoot, loadProbeBinary: electronBinaryPath });
      onRetrievalLoadProbe?.();
      if (loadProbeError) throw loadProbeError;
    },
    verifyPtyHostLoads: ({ unpackedRoot, electronBinaryPath }: { unpackedRoot: string; electronBinaryPath: string }): void => {
      calls.push({ unpackedRoot, ptyHostProbeBinary: electronBinaryPath });
    },
    // afterPack.js destructures these alongside verifyUnpackedWorkerModules
    // for its dictation and retrieval calls; a fake missing them would
    // silently pass `moduleNames: undefined` and make those calls
    // indistinguishable from the first in the recorded calls below.
    DICTATION_WORKER_EXTERNALS: ['sherpa-onnx-node'],
    DICTATION_WORKER_PROBE_DEPENDENCIES: [],
    RETRIEVAL_WORKER_EXTERNALS: ['better-sqlite3'],
    RETRIEVAL_WORKER_PROBE_DEPENDENCIES: [],
    PTY_HOST_EXTERNALS: ['node-pty'],
    PTY_HOST_PROBE_DEPENDENCIES: [],
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

interface FakeInstallSpawnHelperCall {
  unpackedRoot: string;
  platform: string;
}

/** Installs a fake `installSpawnHelper` at build/install-spawn-helper.js's
 *  real resolved path. The real one compiles C with xcrun on darwin, which no
 *  test here can do. `throwError` makes the fake throw, so a caller can prove
 *  afterPack.js propagates a failed spawn-helper gate. */
function installFakeInstallSpawnHelper(throwError?: Error): {
  calls: FakeInstallSpawnHelperCall[];
  restore: () => void;
} {
  const calls: FakeInstallSpawnHelperCall[] = [];
  const fakeModule = {
    installSpawnHelper: ({ unpackedRoot, platform }: FakeInstallSpawnHelperCall): void => {
      calls.push({ unpackedRoot, platform });
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

/** afterPack.js's own default export, typed to only what these tests call. */
type AfterPackFunction = ((context: FakeAfterPackContext) => Promise<void>) & {
  stripBetterSqlitePrebuilds: (options: {
    unpackedRoot: string;
    platform: string;
    targetArch: string;
    log?: (line: string) => void;
  }) => void;
};

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
    const fakeSpawnHelper = installFakeInstallSpawnHelper();
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'mac-out');
      await afterPack(buildFakeContext({ platform: 'darwin', appOutDir }));

      const unpackedRoot = path.join(
        appOutDir,
        'Kangentic.app',
        'Contents',
        'Resources',
        'app.asar.unpacked',
      );
      // Every gate runs against the same unpackedRoot: the embed worker
      // (default moduleNames), the dictation worker (DESKTOP-X), the
      // retrieval worker's resolution probe and load probe, and the pty
      // host's. The load probes run under the packaged binary, before its
      // fuses are flipped.
      const binary = path.join(appOutDir, 'Kangentic.app', 'Contents', 'MacOS', 'Kangentic');
      expect(fakeVerify.calls).toEqual([
        { unpackedRoot },
        { unpackedRoot, moduleNames: ['sherpa-onnx-node'] },
        { unpackedRoot, moduleNames: ['better-sqlite3'] },
        { unpackedRoot, loadProbeBinary: binary },
        { unpackedRoot, moduleNames: ['node-pty'] },
        { unpackedRoot, ptyHostProbeBinary: binary },
      ]);
      expect(fakeFuses.calls).toEqual([{ electronBinaryPath: binary }]);
      // The spawn-helper replacement targets the same tree on the same platform.
      expect(fakeSpawnHelper.calls).toEqual([{ unpackedRoot, platform: 'darwin' }]);
      // Both verifiers passed, so packaging must still proceed to flipFuses.
      expect(fakeFuses.calls).toHaveLength(1);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
      fakeSpawnHelper.restore();
    }
  });

  it('on win32, points directly at appOutDir/resources/app.asar.unpacked - no .app/Contents wrapper', async () => {
    const fakeFuses = installFakeElectronFuses();
    const fakeVerify = installFakeVerifyUnpackedWorker();
    const fakeSpawnHelper = installFakeInstallSpawnHelper();
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'win-out');
      await afterPack(buildFakeContext({ platform: 'win32', appOutDir }));

      const unpackedRoot = path.join(appOutDir, 'resources', 'app.asar.unpacked');
      expect(fakeVerify.calls).toEqual([
        { unpackedRoot },
        { unpackedRoot, moduleNames: ['sherpa-onnx-node'] },
        { unpackedRoot, moduleNames: ['better-sqlite3'] },
        { unpackedRoot, loadProbeBinary: path.join(appOutDir, 'Kangentic.exe') },
        { unpackedRoot, moduleNames: ['node-pty'] },
        { unpackedRoot, ptyHostProbeBinary: path.join(appOutDir, 'Kangentic.exe') },
      ]);
      // Called on every platform so it can log that it does not apply; the
      // platform it receives is what makes it a no-op off darwin.
      expect(fakeSpawnHelper.calls).toEqual([{ unpackedRoot, platform: 'win32' }]);
      expect(fakeFuses.calls).toHaveLength(1);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
      fakeSpawnHelper.restore();
    }
  });

  it('propagates a failed spawn-helper gate and never reaches flipFuses, so a mac build whose terminals would leak crash ports cannot ship', async () => {
    const fakeFuses = installFakeElectronFuses();
    const fakeVerify = installFakeVerifyUnpackedWorker();
    const spawnHelperError = new Error('[spawn-helper] failed the exception-port gate');
    const fakeSpawnHelper = installFakeInstallSpawnHelper(spawnHelperError);
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'mac-out-broken');

      await expect(afterPack(buildFakeContext({ platform: 'darwin', appOutDir }))).rejects.toBe(
        spawnHelperError,
      );

      expect(fakeSpawnHelper.calls).toHaveLength(1);
      expect(fakeFuses.calls).toEqual([]);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
      fakeSpawnHelper.restore();
    }
  });

  it('propagates verifyUnpackedWorkerModules failure and never reaches flipFuses, so a broken unpacked tree cannot still ship a fuse-flipped, signed build', async () => {
    const fakeFuses = installFakeElectronFuses();
    const verificationError = new Error(
      '[afterPack] @huggingface/transformers does not load from the unpacked tree',
    );
    const fakeVerify = installFakeVerifyUnpackedWorker(verificationError);
    const fakeSpawnHelper = installFakeInstallSpawnHelper();
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
      fakeSpawnHelper.restore();
    }
  });

  it('propagates a failed retrieval load probe and never reaches flipFuses, so a build whose worker cannot open a database cannot ship', async () => {
    const fakeFuses = installFakeElectronFuses();
    const loadError = new Error("[afterPack] the retrieval worker's native modules do not load");
    const fakeVerify = installFakeVerifyUnpackedWorker(undefined, loadError);
    const fakeSpawnHelper = installFakeInstallSpawnHelper();
    try {
      const afterPack = await importAfterPack();
      const appOutDir = path.join('afterpack-fake-out', 'win-out-no-sqlite');
      await expect(afterPack(buildFakeContext({ platform: 'win32', appOutDir }))).rejects.toBe(loadError);
      expect(fakeVerify.calls.at(-1)).toEqual({
        unpackedRoot: path.join(appOutDir, 'resources', 'app.asar.unpacked'),
        loadProbeBinary: path.join(appOutDir, 'Kangentic.exe'),
      });
      expect(fakeFuses.calls).toEqual([]);
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
      fakeSpawnHelper.restore();
    }
  });
});

// Every fuse is set explicitly, and flipFuses is told to refuse a binary carrying one it was not
// given (strictlyRequireAllFuses). Without that, a fuse a future Electron adds ships at whatever
// default it came with and the build stays green. The values are decisions, so they are pinned
// by name; the members are read from the REAL enum, so a fuse @electron/fuses learns about fails
// here until it is decided.
const DECIDED_FUSE_VALUES: Record<string, boolean> = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  // The next three are Electron's own defaults, read off the 44.5.1 binary's fuse wire.
  LoadBrowserProcessSpecificV8Snapshot: false,
  // Load-bearing: the renderer, its lazy chunks and the Monaco workers load over file://.
  GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true,
};

/** Every fuse name the installed @electron/fuses knows (the enum's numeric members). */
function knownFuseNames(): string[] {
  return Object.keys(RealFuseV1Options).filter((key) => Number.isNaN(Number(key)));
}

describe('afterPack: fuse configuration', () => {
  async function flipFusesConfig(): Promise<Record<string, unknown>> {
    const fakeFuses = installFakeElectronFuses();
    const fakeVerify = installFakeVerifyUnpackedWorker();
    const fakeSpawnHelper = installFakeInstallSpawnHelper();
    try {
      const afterPack = await importAfterPack();
      await afterPack(buildFakeContext({ platform: 'win32', appOutDir: path.join('afterpack-fake-out', 'fuses') }));
      expect(fakeFuses.configs).toHaveLength(1);
      return fakeFuses.configs[0];
    } finally {
      fakeFuses.restore();
      fakeVerify.restore();
      fakeSpawnHelper.restore();
    }
  }

  it('sets every fuse @electron/fuses knows and asks flipFuses to refuse any it was not given', async () => {
    const config = await flipFusesConfig();
    expect(config.version).toBe(RealFuseVersion.V1);
    expect(config.strictlyRequireAllFuses).toBe(true);
    const unset = knownFuseNames().filter(
      (name) => typeof config[RealFuseV1Options[name as keyof typeof RealFuseV1Options]] !== 'boolean'
    );
    expect(unset, 'build/afterPack.js does not set these fuses; decide each one and add it to DECIDED_FUSE_VALUES too').toEqual([]);
  });

  it('keeps each fuse at its decided value, and decides no fuse the enum does not have', async () => {
    const config = await flipFusesConfig();
    expect(Object.keys(DECIDED_FUSE_VALUES).sort()).toEqual(knownFuseNames().sort());
    for (const [name, expected] of Object.entries(DECIDED_FUSE_VALUES)) {
      expect(config[RealFuseV1Options[name as keyof typeof RealFuseV1Options]], name).toBe(expected);
    }
  });

  // The installed Electron's own wire, read without writing. flipFuses with strictlyRequireAllFuses
  // already fails a PACKAGED build on a fuse it was not given, but packaging runs in the release
  // and package-smoke jobs only; this says so on the Electron bump itself.
  it('matches the installed Electron binary: no fuse there that @electron/fuses does not know', async () => {
    const electronBinaryPath = require('electron') as unknown as string;
    const wire = await getCurrentFuseWire(electronBinaryPath);
    const wireLength = Object.keys(wire).filter((key) => key !== 'version').length;
    expect(
      wireLength,
      `Electron's fuse wire has ${wireLength} fuses and @electron/fuses knows ${knownFuseNames().length}. ` +
        'Update @electron/fuses, then decide the new fuse in build/afterPack.js.'
    ).toBe(knownFuseNames().length);
  });
});

// better-sqlite3 13 ships every platform's addon in one package.
const ALL_PREBUILDS = [
  'darwin-arm64.node',
  'darwin-x64.node',
  'linux-arm64.node',
  'linux-x64.node',
  'linuxmusl-arm64.node',
  'linuxmusl-x64.node',
  'win32-arm64.node',
  'win32-x64.node',
];

describe('afterPack: stripping better-sqlite3 prebuilds to the target', () => {
  // These run the real strip against a throwaway unpacked tree.
  let unpackedRoot: string;
  let prebuildsDir: string;

  beforeEach(() => {
    unpackedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'afterpack-prebuilds-'));
    prebuildsDir = path.join(unpackedRoot, 'node_modules', 'better-sqlite3', 'prebuilds');
    fs.mkdirSync(prebuildsDir, { recursive: true });
    for (const name of ALL_PREBUILDS) fs.writeFileSync(path.join(prebuildsDir, name), 'addon');
  });

  afterEach(() => {
    fs.rmSync(unpackedRoot, { recursive: true, force: true });
  });

  it('keeps only the target prebuild and says so', async () => {
    const afterPack = await importAfterPack();
    const lines: string[] = [];
    afterPack.stripBetterSqlitePrebuilds({ unpackedRoot, platform: 'win32', targetArch: 'x64', log: (line) => lines.push(line) });

    expect(fs.readdirSync(prebuildsDir)).toEqual(['win32-x64.node']);
    expect(lines).toEqual(['[afterPack] better-sqlite3: kept prebuilds/win32-x64.node, removed 7 other prebuild(s)']);
  });

  it('keeps the glibc build on Linux and drops the musl ones', async () => {
    const afterPack = await importAfterPack();
    afterPack.stripBetterSqlitePrebuilds({ unpackedRoot, platform: 'linux', targetArch: 'arm64', log: () => {} });

    expect(fs.readdirSync(prebuildsDir)).toEqual(['linux-arm64.node']);
  });

  it('throws without deleting anything when the target has no prebuild', async () => {
    const afterPack = await importAfterPack();
    expect(() => afterPack.stripBetterSqlitePrebuilds({ unpackedRoot, platform: 'linux', targetArch: 'armv7l', log: () => {} }))
      .toThrow(/no prebuild for linux-armv7l/);
    expect(fs.readdirSync(prebuildsDir).sort()).toEqual(ALL_PREBUILDS);
  });

  it('does nothing, and says so, when the unpacked tree has no better-sqlite3 prebuilds directory', async () => {
    fs.rmSync(path.join(unpackedRoot, 'node_modules'), { recursive: true, force: true });
    const afterPack = await importAfterPack();
    const lines: string[] = [];

    expect(() => afterPack.stripBetterSqlitePrebuilds({ unpackedRoot, platform: 'win32', targetArch: 'x64', log: (line) => lines.push(line) }))
      .not.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/no prebuilds directory.*nothing to strip/);
    expect(fs.existsSync(path.join(unpackedRoot, 'node_modules'))).toBe(false);
  });
});

describe('afterPack: running the better-sqlite3 prebuild strip on the packed tree', () => {
  // The describe above calls the strip directly. Every afterPack() test before it
  // passes an appOutDir that does not exist, so the strip returns at "no prebuilds
  // directory" there and a call that was deleted, or moved, would change nothing.
  // These run afterPack() over a real tree holding every platform's prebuild.
  let appOutDir: string;
  let prebuildsDir: string;

  beforeEach(() => {
    appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'afterpack-packed-tree-'));
    // win32 and linux share this layout: a lowercase resources/ under appOutDir.
    prebuildsDir = path.join(appOutDir, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'prebuilds');
    fs.mkdirSync(prebuildsDir, { recursive: true });
    for (const name of ALL_PREBUILDS) fs.writeFileSync(path.join(prebuildsDir, name), 'addon');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(appOutDir, { recursive: true, force: true });
  });

  it.each([
    { platform: 'win32', arch: 1, kept: 'win32-x64.node' },
    { platform: 'linux', arch: 3, kept: 'linux-arm64.node' },
  ] as const)(
    'leaves only $kept, and has done so by the time the retrieval load probe runs, so the probe proves the addon that ships',
    async ({ platform, arch, kept }) => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      let prebuildsSeenByLoadProbe: string[] = [];
      const fakeFuses = installFakeElectronFuses();
      const fakeVerify = installFakeVerifyUnpackedWorker(undefined, undefined, () => {
        prebuildsSeenByLoadProbe = fs.readdirSync(prebuildsDir);
      });
      const fakeSpawnHelper = installFakeInstallSpawnHelper();
      try {
        const afterPack = await importAfterPack();
        await afterPack(buildFakeContext({ platform, appOutDir, arch }));

        expect(prebuildsSeenByLoadProbe).toEqual([kept]);
        expect(fs.readdirSync(prebuildsDir)).toEqual([kept]);
      } finally {
        fakeFuses.restore();
        fakeVerify.restore();
        fakeSpawnHelper.restore();
      }
    },
  );
});

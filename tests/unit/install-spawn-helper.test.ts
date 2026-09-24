/**
 * build/install-spawn-helper.js - compiles Kangentic's macOS spawn-helper over
 * node-pty's prebuilt one in the packaged tree, then proves it before the build
 * is accepted: a child exec'd through it has no inherited mach exception port
 * (Sentry DESKTOP-K, -N, -Q, -1D), and the cwd and exec contract node-pty relies
 * on still holds.
 *
 * The compiler and the probe only exist on macOS, so every child process is an
 * injected fake here and the tests pin the wiring: what gets compiled with which
 * flags, what gets overwritten, what the gate runs against, and that every
 * failure throws instead of skipping (.claude/rules/release-gates-fail-loudly.md).
 * The real compile and run happen in .github/workflows/macos-spawn-helper.yml
 * and on the release matrix's macOS leg.
 *
 * Imported through `createRequire` like tests/unit/verify-unpacked-worker.test.ts:
 * a plain CJS module's own `require` bypasses vitest's mock registry, so the
 * spawn is injected as a parameter instead of mocked.
 *
 * Tier: Unit.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { resolveShellLaunch } from '../../src/main/pty/spawn/shell-launch';

const require = createRequire(import.meta.url);
const {
  installSpawnHelper,
  verifyPackagedSpawnHelpers,
  verifyChildProcessLaunch,
  runChildProcessCheck,
  findDarwinSpawnHelpers,
  runSelfTest,
  signWithHardenedRuntime,
  MINIMUM_MACOS_VERSION,
  SPAWN_HELPER_SOURCE,
  EXCEPTION_PORT_PROBE_SOURCE,
  PROBE_EXIT_MEANINGS,
  CHILD_PROCESS_CHECK_FLAG,
  CHILD_PROCESS_CHECK_PASSED,
  CHILD_PROCESS_CHECK_SCRIPT,
} = require('../../build/install-spawn-helper.js');

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HARNESS_SUCCESS_LINE = "control saw the inherited port, the helper's child saw none";

interface SpawnCall {
  file: string;
  args: string[];
  /** The target helper's bytes at the moment the harness ran against it. */
  helperContentsAtCall?: string;
}

interface SpawnError extends Error {
  status?: number;
  stderr?: string;
  code?: string;
}

function makeSpawnError(fields: { status?: number; stderr?: string; code?: string }): SpawnError {
  return Object.assign(new Error('Command failed'), fields);
}

const temporaryDirectories: string[] = [];

function makeUnpackedRoot(prebuildDirectories: string[]): string {
  const unpackedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'install-spawn-helper-test-'));
  temporaryDirectories.push(unpackedRoot);
  for (const directory of prebuildDirectories) {
    const prebuildDirectory = path.join(unpackedRoot, 'node_modules', 'node-pty', 'prebuilds', directory);
    fs.mkdirSync(prebuildDirectory, { recursive: true });
    fs.writeFileSync(path.join(prebuildDirectory, 'spawn-helper'), 'stock helper');
  }
  return unpackedRoot;
}

function helperPathIn(unpackedRoot: string, prebuildDirectory: string): string {
  return path.join(unpackedRoot, 'node_modules', 'node-pty', 'prebuilds', prebuildDirectory, 'spawn-helper');
}

/**
 * A stand-in for execFileSync that behaves like a Mac on which everything works:
 * `xcrun clang ... -o <out> <source>` writes a marker naming the source, the
 * probe's harness reports success, and the helper's `/bin/pwd -P` prints the
 * directory it was given. `overrides` replaces the behavior for one kind of call.
 */
function makeSpawn(overrides: {
  compile?: (args: string[]) => void;
  harness?: () => string;
  contract?: (args: string[]) => string;
} = {}) {
  const calls: SpawnCall[] = [];
  const spawn = vi.fn((file: string, args: string[]) => {
    if (file === 'xcrun') {
      calls.push({ file, args });
      if (overrides.compile) overrides.compile(args);
      const outputPath = args[args.indexOf('-o') + 1];
      const sourcePath = args[args.length - 1];
      fs.writeFileSync(outputPath, `compiled ${path.basename(sourcePath)}`);
      return '';
    }
    if (path.basename(file) === 'exception-port-probe') {
      const helperPath = args[1];
      calls.push({ file, args, helperContentsAtCall: fs.readFileSync(helperPath, 'utf8') });
      return overrides.harness ? overrides.harness() : `${HARNESS_SUCCESS_LINE}\n`;
    }
    calls.push({ file, args });
    return overrides.contract ? overrides.contract(args) : `${fs.realpathSync(args[0])}\n`;
  });
  return { spawn, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('installSpawnHelper', () => {
  it('on win32 and linux, logs that the reset does not apply and never compiles', () => {
    for (const platform of ['win32', 'linux']) {
      const { spawn } = makeSpawn();
      const log = vi.fn();
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot([]), platform, spawn, log });
      expect(spawn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining(`not applicable on ${platform}`));
    }
  });

  it('on darwin, compiles a universal helper for the minimum macOS version and installs it over every darwin prebuild, executable', () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64', 'darwin-x64', 'win32-x64']);
    const { spawn, calls } = makeSpawn();
    const chmodSpy = vi.spyOn(fs, 'chmodSync');

    installSpawnHelper({ unpackedRoot, platform: 'darwin', spawn, log: vi.fn() });

    const helperCompile = calls.find((call) => call.file === 'xcrun' && call.args.includes(SPAWN_HELPER_SOURCE));
    expect(helperCompile?.args).toEqual([
      'clang',
      '-O2',
      '-arch',
      'arm64',
      '-arch',
      'x86_64',
      `-mmacosx-version-min=${MINIMUM_MACOS_VERSION}`,
      '-o',
      expect.any(String),
      SPAWN_HELPER_SOURCE,
    ]);

    for (const prebuildDirectory of ['darwin-arm64', 'darwin-x64']) {
      const helperPath = helperPathIn(unpackedRoot, prebuildDirectory);
      expect(fs.readFileSync(helperPath, 'utf8')).toBe('compiled spawn-helper.c');
      expect(chmodSpy).toHaveBeenCalledWith(helperPath, 0o755);
    }
    // A non-darwin prebuild is not ours to touch.
    expect(fs.readFileSync(helperPathIn(unpackedRoot, 'win32-x64'), 'utf8')).toBe('stock helper');
  });

  it('gates every INSTALLED helper: the harness and the cwd contract run against the shipped path, after the copy', () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64']);
    const { spawn, calls } = makeSpawn();
    const log = vi.fn();

    installSpawnHelper({ unpackedRoot, platform: 'darwin', spawn, log });

    const shippedHelperPath = helperPathIn(unpackedRoot, 'darwin-arm64');
    const probeCompile = calls.find((call) => call.file === 'xcrun' && call.args.includes(EXCEPTION_PORT_PROBE_SOURCE));
    // The probe runs on the build host and never ships, so it takes no -arch.
    expect(probeCompile?.args).not.toContain('-arch');

    const harnessCall = calls.find((call) => path.basename(call.file) === 'exception-port-probe');
    expect(harnessCall?.args).toEqual(['harness', shippedHelperPath]);
    expect(harnessCall?.helperContentsAtCall).toBe('compiled spawn-helper.c');

    const contractCall = calls.find((call) => call.file === shippedHelperPath);
    expect(contractCall?.args).toEqual([expect.any(String), '/bin/pwd', '-P']);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Verified ${shippedHelperPath}`));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(HARNESS_SUCCESS_LINE));
  });

  it('removes its build and probe work directories', () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64']);
    const { spawn, calls } = makeSpawn();

    installSpawnHelper({ unpackedRoot, platform: 'darwin', spawn, log: vi.fn() });

    const compileOutputs = calls
      .filter((call) => call.file === 'xcrun')
      .map((call) => call.args[call.args.indexOf('-o') + 1]);
    expect(compileOutputs).toHaveLength(2);
    for (const outputPath of compileOutputs) {
      expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
    }
  });

  it('throws, without compiling, when the package has no darwin spawn-helper', () => {
    const { spawn } = makeSpawn();
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['win32-x64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow(/No node-pty darwin-\*\/spawn-helper under/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('throws with install guidance when xcrun is missing', () => {
    const { spawn } = makeSpawn({
      compile: () => {
        throw makeSpawnError({ code: 'ENOENT' });
      },
    });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow(/Could not compile spawn-helper\.c: xcrun is not on PATH\. Install Xcode or the Command Line Tools \(xcode-select --install\)/);
  });

  it("throws with clang's stderr when the compile fails, and leaves the stock helper in place", () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64']);
    const { spawn } = makeSpawn({
      compile: () => {
        throw makeSpawnError({ status: 1, stderr: "spawn-helper.c:3:10: fatal error: 'mach/mach.h' file not found" });
      },
    });
    expect(() => installSpawnHelper({ unpackedRoot, platform: 'darwin', spawn, log: vi.fn() })).toThrow(
      /clang failed[\s\S]*'mach\/mach\.h' file not found/,
    );
    expect(fs.readFileSync(helperPathIn(unpackedRoot, 'darwin-arm64'), 'utf8')).toBe('stock helper');
  });

  it('throws when the control child sees no inherited port, since the gate would then prove nothing', () => {
    const { spawn, calls } = makeSpawn({
      harness: () => {
        throw makeSpawnError({ status: 4, stderr: 'harness: control child did not see the inherited exception port (exit 0)' });
      },
    });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow(/failed the exception-port gate: the control child did not inherit[\s\S]*control child did not see/);
    // The contract check never runs after a failed gate.
    expect(calls.some((call) => call.args.includes('/bin/pwd'))).toBe(false);
  });

  it('throws when a child exec\'d through the helper still has an exception port', () => {
    const { spawn } = makeSpawn({
      harness: () => {
        throw makeSpawnError({ status: 5, stderr: "harness: a child exec'd through the helper still had an exception port" });
      },
    });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow(/failed the exception-port gate: a child exec'd through the helper still had an exception port/);
  });

  it('maps probe exit 2 and 3 to their own meanings', () => {
    for (const { status, meaning } of [
      { status: 2, meaning: 'the probe was called with the wrong arguments' },
      { status: 3, meaning: 'the probe could not install its own exception port' },
    ]) {
      const { spawn } = makeSpawn({
        harness: () => {
          throw makeSpawnError({ status, stderr: `harness: exit ${status}` });
        },
      });
      expect(() =>
        installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
      ).toThrow(new RegExp(`failed the exception-port gate: ${meaning}\\.`));
    }
  });

  it('falls back to "the probe failed" for an unmapped or missing probe exit status', () => {
    for (const statusFields of [{ status: 1 }, {}]) {
      const { spawn } = makeSpawn({
        harness: () => {
          throw makeSpawnError({ ...statusFields, stderr: 'harness: unexpected' });
        },
      });
      expect(() =>
        installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
      ).toThrow(/failed the exception-port gate: the probe failed\./);
    }
  });

  it('removes its build work directory when the helper compile throws', () => {
    const { spawn, calls } = makeSpawn({
      compile: () => {
        throw makeSpawnError({ status: 1, stderr: 'fatal error' });
      },
    });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow();

    const helperCompiles = calls.filter((call) => call.file === 'xcrun' && call.args.includes(SPAWN_HELPER_SOURCE));
    expect(helperCompiles).toHaveLength(1);
    const outputPath = helperCompiles[0].args[helperCompiles[0].args.indexOf('-o') + 1];
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it('removes its probe work directory when the harness throws', () => {
    const { spawn, calls } = makeSpawn({
      harness: () => {
        throw makeSpawnError({ status: 5, stderr: "harness: a child exec'd through the helper still had an exception port" });
      },
    });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow();

    const probeCompiles = calls.filter((call) => call.file === 'xcrun' && call.args.includes(EXCEPTION_PORT_PROBE_SOURCE));
    expect(probeCompiles).toHaveLength(1);
    const outputPath = probeCompiles[0].args[probeCompiles[0].args.indexOf('-o') + 1];
    expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
  });

  it('throws when the helper runs its program in the wrong directory', () => {
    const { spawn } = makeSpawn({ contract: () => '/somewhere/else\n' });
    expect(() =>
      installSpawnHelper({ unpackedRoot: makeUnpackedRoot(['darwin-arm64']), platform: 'darwin', spawn, log: vi.fn() }),
    ).toThrow(/ran \/bin\/pwd in "\/somewhere\/else"[\s\S]*cwd and exec contract node-pty relies on is broken/);
  });
});

describe('verifyPackagedSpawnHelpers (the afterSign gate)', () => {
  it('verifies the helper in place, without compiling a new one over it', () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64']);
    const { spawn, calls } = makeSpawn();

    verifyPackagedSpawnHelpers({ unpackedRoot, spawn, log: vi.fn() });

    expect(calls.some((call) => call.args.includes(SPAWN_HELPER_SOURCE))).toBe(false);
    const harnessCall = calls.find((call) => path.basename(call.file) === 'exception-port-probe');
    expect(harnessCall?.args).toEqual(['harness', helperPathIn(unpackedRoot, 'darwin-arm64')]);
    expect(harnessCall?.helperContentsAtCall).toBe('stock helper');
  });

  it('throws when the signed app has no darwin spawn-helper', () => {
    const { spawn } = makeSpawn();
    expect(() => verifyPackagedSpawnHelpers({ unpackedRoot: makeUnpackedRoot([]), spawn, log: vi.fn() })).toThrow(
      /No node-pty darwin-\*\/spawn-helper under/,
    );
  });

  it('verifies each darwin helper once, against its own shipped path', () => {
    const unpackedRoot = makeUnpackedRoot(['darwin-arm64', 'darwin-x64']);
    const { spawn, calls } = makeSpawn();

    verifyPackagedSpawnHelpers({ unpackedRoot, spawn, log: vi.fn() });

    for (const prebuildDirectory of ['darwin-arm64', 'darwin-x64']) {
      const shippedHelperPath = helperPathIn(unpackedRoot, prebuildDirectory);
      const harnessCalls = calls.filter(
        (call) => path.basename(call.file) === 'exception-port-probe' && call.args[1] === shippedHelperPath,
      );
      expect(harnessCalls).toHaveLength(1);
      const contractCalls = calls.filter((call) => call.file === shippedHelperPath);
      expect(contractCalls).toHaveLength(1);
      expect(contractCalls[0].args).toEqual([expect.any(String), '/bin/pwd', '-P']);
    }
  });
});

describe('findDarwinSpawnHelpers', () => {
  it('returns nothing when node-pty has no prebuilds directory', () => {
    expect(findDarwinSpawnHelpers(path.join(os.tmpdir(), 'install-spawn-helper-test-missing-root'))).toEqual([]);
  });
});

describe('MINIMUM_MACOS_VERSION', () => {
  it('matches mac.minimumSystemVersion in electron-builder.yml, so the helper runs everywhere the app does', () => {
    const builderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    const match = builderConfig.match(/^\s*minimumSystemVersion:\s*"([^"]+)"/m);
    expect(match?.[1]).toBe(MINIMUM_MACOS_VERSION);
  });
});

describe('runSelfTest', () => {
  it('throws before compiling anything when the host is not darwin', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const makeTempDirectorySpy = vi.spyOn(fs, 'mkdtempSync');
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      await expect(runSelfTest({ log: vi.fn() })).rejects.toThrow(/runs on macOS only \(this is linux\)/);
      expect(makeTempDirectorySpy).not.toHaveBeenCalled();
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
  });
});

describe('CLI entry point (node build/install-spawn-helper.js)', () => {
  it('exits 2 and prints usage to stderr when run without --self-test', () => {
    const scriptPath = path.join(REPO_ROOT, 'build', 'install-spawn-helper.js');
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: node build/install-spawn-helper.js --self-test');
  });

  // Off darwin, runSelfTest's own platform guard rejects immediately (pinned
  // above), which is what makes this reachable without macOS. It proves the
  // OTHER half of the CLI wiring: without `process.exit(1)` in the rejection
  // branch, node would drain the event loop and exit 0 after only printing the
  // error, so a self-test failure on the real macOS workflow would still read
  // as a green run.
  it.runIf(process.platform !== 'darwin')(
    'exits 1 and prints the failure when --self-test rejects',
    () => {
      const scriptPath = path.join(REPO_ROOT, 'build', 'install-spawn-helper.js');
      const result = spawnSync(process.execPath, [scriptPath, '--self-test'], { encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/runs on macOS only/);
    },
  );

  // runChildProcessCheck itself carries no platform guard, so this reaches the
  // same control-spawn failure on every OS: neither path exists, so its first
  // spawnSync (the control child) fails with ENOENT before the helper path is
  // ever touched. This pins the CLI wiring `verifyChildProcessLaunch` depends
  // on: argv is sliced in [helperPath, probePath] order, the thrown message
  // reaches stderr, and the catch calls `process.exit(1)` rather than letting
  // Node exit 0 after only printing the error.
  it('exits 1 and names the missing probe path when --child-process-check runs against files that do not exist', () => {
    const scriptPath = path.join(REPO_ROOT, 'build', 'install-spawn-helper.js');
    const missingHelper = path.join(os.tmpdir(), 'install-spawn-helper-test-missing-helper');
    const missingProbe = path.join(os.tmpdir(), 'install-spawn-helper-test-missing-probe');

    const result = spawnSync(
      process.execPath,
      [scriptPath, CHILD_PROCESS_CHECK_FLAG, missingHelper, missingProbe],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot observe inheritance/);
    // The control spawn targets the probe, so its ENOENT names that path.
    expect(result.stderr).toContain(missingProbe);
    // The check throws before ever spawning the helper argument.
    expect(result.stderr).not.toContain(missingHelper);
  });
});

describe('signWithHardenedRuntime', () => {
  it('ad-hoc signs with hardened runtime and the entitlements electron-builder.yml names for the app', () => {
    const { spawn, calls } = makeSpawn({ contract: () => '' });
    const helperPath = path.join(os.tmpdir(), 'install-spawn-helper-test-fake-helper');

    signWithHardenedRuntime({ helperPath, spawn });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe('codesign');
    expect(call.args).toEqual([
      '--force',
      '--sign',
      '-',
      '--options',
      'runtime',
      '--entitlements',
      expect.any(String),
      helperPath,
    ]);

    const entitlementsPath = call.args[call.args.indexOf('--entitlements') + 1];
    expect(fs.existsSync(entitlementsPath)).toBe(true);
    // path.relative, not a hardcoded backslash join: avoids a Windows
    // drive-letter case mismatch between fileURLToPath (REPO_ROOT) and
    // __dirname (the module's own path), and reads the same on POSIX.
    const relativeEntitlementsPath = path.relative(REPO_ROOT, entitlementsPath).replace(/\\/g, '/');
    expect(relativeEntitlementsPath).toBe('build/entitlements.plist');

    // The expected value comes from electron-builder.yml, not from re-deriving
    // install-spawn-helper.js's own path.join call: the app's real signing
    // config is the contract this function exists to match on the self-test.
    const builderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    const entitlementsMatch = builderConfig.match(/^\s*entitlements:\s*(\S+)/m);
    const entitlementsInheritMatch = builderConfig.match(/^\s*entitlementsInherit:\s*(\S+)/m);
    expect(entitlementsMatch?.[1]).toBe(relativeEntitlementsPath);
    expect(entitlementsInheritMatch?.[1]).toBe(relativeEntitlementsPath);
  });

  it("throws with codesign's stderr when signing fails", () => {
    const { spawn } = makeSpawn({
      contract: () => {
        throw makeSpawnError({ status: 1, stderr: 'codesign: code object is not signed at all' });
      },
    });
    expect(() => signWithHardenedRuntime({ helperPath: '/tmp/fake-helper', spawn })).toThrow(
      /Could not ad-hoc sign \/tmp\/fake-helper with hardened runtime\.\ncodesign: code object is not signed at all/,
    );
  });
});

describe('PROBE_EXIT_MEANINGS parity with exception-port-probe.c', () => {
  it("covers exactly the C source's non-zero exit statuses other than EXIT_PORT_PRESENT", () => {
    const probeSource = fs.readFileSync(EXCEPTION_PORT_PROBE_SOURCE, 'utf8');
    const enumEntries = [...probeSource.matchAll(/(EXIT_[A-Z_]+)\s*=\s*(\d+)/g)].map((match) => ({
      name: match[1],
      value: Number(match[2]),
    }));
    expect(enumEntries.length).toBeGreaterThan(0);

    // EXIT_PORT_PRESENT (10) is what `check` mode returns; the harness never
    // exits with it, so it has no place in PROBE_EXIT_MEANINGS.
    const portPresentEntry = enumEntries.find((entry) => entry.name === 'EXIT_PORT_PRESENT');
    expect(portPresentEntry?.value).toBe(10);

    const nonZeroExcludingPortPresent = enumEntries
      .filter((entry) => entry.value !== 0 && entry.name !== 'EXIT_PORT_PRESENT')
      .map((entry) => entry.value)
      .sort((first, second) => first - second);
    expect(nonZeroExcludingPortPresent).toEqual([2, 3, 4, 5]);

    const mappedStatuses = Object.keys(PROBE_EXIT_MEANINGS)
      .map(Number)
      .sort((first, second) => first - second);
    expect(mappedStatuses).toEqual(nonZeroExcludingPortPresent);
  });

  it('contains the harness success line verbatim, so the tests fake the exact line the probe prints', () => {
    const probeSource = fs.readFileSync(EXCEPTION_PORT_PROBE_SOURCE, 'utf8');
    expect(probeSource).toContain(HARNESS_SUCCESS_LINE);
  });

  it('keeps a `with-port` mode, which the child_process launch check runs Node under', () => {
    const probeSource = fs.readFileSync(EXCEPTION_PORT_PROBE_SOURCE, 'utf8');
    expect(probeSource).toMatch(/strcmp\(argv\[1\], "with-port"\) == 0/);
  });
});

/**
 * The child_process half of the self-test. The real run needs macOS (the probe
 * is Mach code), so these pin the wiring with a fake spawnSync: what runs, with
 * which argv and stdio, and that every way it can go wrong throws.
 */
describe('runChildProcessCheck (runs inside Node under the probe)', () => {
  const HELPER = '/tmp/kangentic-test/spawn-helper';
  const PROBE = '/tmp/kangentic-test/exception-port-probe';

  interface FakeSpawnResult {
    status: number | null;
    pid?: number;
    stdout?: string;
    stderr?: string;
    error?: Error;
  }

  function makeSpawnSync(results: { control: FakeSpawnResult; launch?: FakeSpawnResult }) {
    return vi.fn((file: string, args: string[], _options: { stdio: unknown }) => {
      if (file === PROBE && args[0] === 'check') return results.control;
      if (file === HELPER && results.launch) return results.launch;
      throw new Error(`unexpected spawn: ${file} ${args.join(' ')}`);
    });
  }

  it('passes when the control sees the port and the shell launched through the helper does not, under its own pid', () => {
    const spawn = makeSpawnSync({
      control: { status: 10 },
      launch: { status: 0, pid: 4242, stdout: 'pid:4242\n' },
    });

    expect(runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toBe(CHILD_PROCESS_CHECK_PASSED);

    const launchCall = spawn.mock.calls.find(([file]) => file === HELPER);
    expect(launchCall?.[1]).toEqual(['', '/bin/sh', '-c', CHILD_PROCESS_CHECK_SCRIPT, PROBE]);
    // A pipe on stdin is the case under test: the helper's ttyname() fails on it.
    expect(launchCall?.[2].stdio).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('launches exactly what resolveShellLaunch builds on macOS for a command string', () => {
    const spawn = makeSpawnSync({
      control: { status: 10 },
      launch: { status: 0, pid: 7, stdout: 'pid:7\n' },
    });
    runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn });
    const launchCall = spawn.mock.calls.find(([file]) => file === HELPER);

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      const production = resolveShellLaunch({ command: CHILD_PROCESS_CHECK_SCRIPT }, () => HELPER);
      // The check passes the probe as `$0` after the command; everything before it
      // is the production launch.
      expect({ file: launchCall?.[0], args: launchCall?.[1].slice(0, 4) }).toEqual({
        file: production.file,
        args: production.args,
      });
    } finally {
      if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('throws without launching anything when the control child saw no port, since the check would prove nothing', () => {
    const spawn = makeSpawnSync({ control: { status: 0 } });

    expect(() => runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toThrow(
      /control child exited 0, not 10[\s\S]*cannot observe inheritance/,
    );
    expect(spawn.mock.calls.some(([file]) => file === HELPER)).toBe(false);
  });

  it('throws when the shell launched through the helper still has an exception port', () => {
    const spawn = makeSpawnSync({ control: { status: 10 }, launch: { status: 10, pid: 5, stdout: 'pid:5\n' } });

    expect(() => runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toThrow(
      /a shell launched through the helper still had an exception port/,
    );
  });

  it('throws when the launch exits with anything else', () => {
    const spawn = makeSpawnSync({ control: { status: 10 }, launch: { status: 1, pid: 5, stderr: 'sh: boom' } });

    expect(() => runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toThrow(
      /exited 1\.[\s\S]*sh: boom/,
    );
  });

  it('throws when the shell reports a pid other than the one child_process returned', () => {
    const spawn = makeSpawnSync({ control: { status: 10 }, launch: { status: 0, pid: 5, stdout: 'pid:6\n' } });

    expect(() => runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toThrow(
      /did not report pid 5[\s\S]*did not exec it in place/,
    );
  });

  it('throws when the helper cannot be launched at all', () => {
    const spawn = makeSpawnSync({
      control: { status: 10 },
      launch: { status: null, error: Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }) },
    });

    expect(() => runChildProcessCheck({ helperPath: HELPER, probePath: PROBE, spawn })).toThrow(
      /could not launch .*spawn-helper: spawn EACCES/,
    );
  });
});

describe('verifyChildProcessLaunch (the self-test step)', () => {
  const HELPER = path.join(os.tmpdir(), 'install-spawn-helper-test-helper');

  function makeProbeSpawn(probeRun: (args: string[]) => string) {
    const calls: SpawnCall[] = [];
    const spawn = vi.fn((file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'xcrun') {
        const outputPath = args[args.indexOf('-o') + 1];
        fs.writeFileSync(outputPath, 'compiled probe');
        return '';
      }
      return probeRun(args);
    });
    return { spawn, calls };
  }

  it('compiles the probe for the host and runs this script under `with-port` against the helper', () => {
    const { spawn, calls } = makeProbeSpawn(() => `${CHILD_PROCESS_CHECK_PASSED}\n`);
    const log = vi.fn();

    verifyChildProcessLaunch({ helperPath: HELPER, spawn, log });

    const probeCompile = calls.find((call) => call.file === 'xcrun');
    expect(probeCompile?.args).toContain(EXCEPTION_PORT_PROBE_SOURCE);
    expect(probeCompile?.args).not.toContain('-arch');

    const probeRun = calls.find((call) => path.basename(call.file) === 'exception-port-probe');
    const probePath = probeCompile?.args[probeCompile.args.indexOf('-o') + 1];
    expect(probeRun?.args).toEqual([
      'with-port',
      process.execPath,
      path.join(REPO_ROOT, 'build', 'install-spawn-helper.js'),
      CHILD_PROCESS_CHECK_FLAG,
      HELPER,
      probePath,
    ]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining(CHILD_PROCESS_CHECK_PASSED));
    // The probe's work directory is gone afterwards.
    expect(fs.existsSync(path.dirname(probePath as string))).toBe(false);
  });

  it("throws with the check's own message when it fails", () => {
    const { spawn } = makeProbeSpawn(() => {
      throw makeSpawnError({ status: 1, stderr: 'child_process check: a shell launched through the helper still had an exception port.' });
    });

    expect(() => verifyChildProcessLaunch({ helperPath: HELPER, spawn, log: vi.fn() })).toThrow(
      /failed the child_process launch check\.[\s\S]*still had an exception port/,
    );
  });

  it('throws when the run exits 0 without the pass line, rather than reading silence as a pass', () => {
    const { spawn } = makeProbeSpawn(() => 'something else entirely\n');

    expect(() => verifyChildProcessLaunch({ helperPath: HELPER, spawn, log: vi.fn() })).toThrow(
      /exited 0 without its pass line/,
    );
  });
});

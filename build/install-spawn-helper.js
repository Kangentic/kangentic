const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Ships Kangentic's build of node-pty's macOS spawn-helper
 * (build/spawn-helper/spawn-helper.c) and proves it works before the build is
 * accepted.
 *
 * node-pty never execs a PTY's program itself on macOS. It posix_spawns
 * `prebuilds/darwin-<arch>/spawn-helper`, which attaches the tty, changes
 * directory and execs the target. Mach exception ports survive both steps, so
 * once Crashpad owns Kangentic's task-level port, every process an agent starts
 * from a terminal inherits it and writes its crashes into our crash database
 * (Sentry DESKTOP-K, -N, -Q, -1D). Our helper clears those ports right before
 * exec. Nothing else in node-pty changes: `pty.node` stays the stock prebuild.
 *
 * `build/afterPack.js` calls `installSpawnHelper`, which compiles the helper
 * over the prebuilt one in the unpacked tree. electron-builder signs after
 * afterPack, so the helper is signed and notarized like the stock one was.
 * `build/afterSign.js` then runs `verifyPackagedSpawnHelpers` again on the
 * signed binary. Both gates throw rather than skip, per
 * .claude/rules/release-gates-fail-loudly.md, and log which way they went on
 * every platform. `node build/install-spawn-helper.js --self-test` is the PR-time
 * check (.github/workflows/macos-spawn-helper.yml): it also runs a real node-pty
 * session through the helper.
 *
 * Linux and Windows need none of this. Crashpad installs in-process there, and
 * exec resets it.
 */

const SPAWN_HELPER_SOURCE = path.join(__dirname, 'spawn-helper', 'spawn-helper.c');
const EXCEPTION_PORT_PROBE_SOURCE = path.join(__dirname, 'spawn-helper', 'exception-port-probe.c');

/** `mac.minimumSystemVersion` in electron-builder.yml. tests/unit/install-spawn-helper.test.ts
 *  pins the two together. */
const MINIMUM_MACOS_VERSION = '10.15';

/** Both slices, so the helper runs on either Mac arch, and the gate runs the
 *  exact shipped bytes on whichever host builds it. */
const SPAWN_HELPER_ARCHES = ['arm64', 'x86_64'];

/** What each non-zero exit of `exception-port-probe harness` means. */
const PROBE_EXIT_MEANINGS = {
  2: 'the probe was called with the wrong arguments',
  3: 'the probe could not install its own exception port',
  4: "the control child did not inherit the probe's exception port, so this host cannot show whether the helper clears it",
  5: "a child exec'd through the helper still had an exception port, or did not run",
};

const CHILD_OPTIONS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };

function describeFailure(error) {
  const stderr = error && typeof error.stderr === 'string' ? error.stderr.trim() : '';
  return stderr || String(error);
}

function makeWorkDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function compile({ sourcePath, outputPath, arches, spawn }) {
  const archArguments = arches.flatMap((arch) => ['-arch', arch]);
  try {
    spawn(
      'xcrun',
      [
        'clang',
        '-O2',
        ...archArguments,
        `-mmacosx-version-min=${MINIMUM_MACOS_VERSION}`,
        '-o',
        outputPath,
        sourcePath,
      ],
      { ...CHILD_OPTIONS, timeout: 120_000 },
    );
  } catch (error) {
    const cause = error && error.code === 'ENOENT' ? 'xcrun is not on PATH' : 'clang failed';
    throw new Error(
      `[spawn-helper] Could not compile ${path.basename(sourcePath)}: ${cause}. ` +
        'Install Xcode or the Command Line Tools (xcode-select --install).\n' +
        describeFailure(error),
    );
  }
}

/** Compiles the universal helper to `outputPath`. */
function compileSpawnHelper({ outputPath, spawn = execFileSync }) {
  compile({ sourcePath: SPAWN_HELPER_SOURCE, outputPath, arches: SPAWN_HELPER_ARCHES, spawn });
}

/**
 * Proves the helper at `helperPath` on this host, and throws if it cannot:
 * 1. `exception-port-probe harness` shows a child exec'd through the helper has
 *    no task exception port, after a control child shows it would have one.
 * 2. `<helper> <dir> /bin/pwd -P` prints `<dir>`, so the argv contract node-pty
 *    relies on (argv[1] is the directory, argv[2] the program, the rest its
 *    arguments) still holds.
 */
function verifySpawnHelper({ helperPath, spawn = execFileSync, log = console.log }) {
  const workDirectory = makeWorkDirectory('kangentic-spawn-helper-probe-');
  try {
    const probePath = path.join(workDirectory, 'exception-port-probe');
    // Host arch only: the probe runs here and never ships.
    compile({ sourcePath: EXCEPTION_PORT_PROBE_SOURCE, outputPath: probePath, arches: [], spawn });

    let harnessOutput;
    try {
      harnessOutput = spawn(probePath, ['harness', helperPath], { ...CHILD_OPTIONS, timeout: 60_000 });
    } catch (error) {
      const meaning = PROBE_EXIT_MEANINGS[error && error.status] || 'the probe failed';
      throw new Error(
        `[spawn-helper] ${helperPath} failed the exception-port gate: ${meaning}.\n${describeFailure(error)}`,
      );
    }

    const expectedDirectory = fs.realpathSync(workDirectory);
    let contractOutput;
    try {
      contractOutput = spawn(helperPath, [workDirectory, '/bin/pwd', '-P'], {
        ...CHILD_OPTIONS,
        timeout: 60_000,
      });
    } catch (error) {
      throw new Error(
        `[spawn-helper] ${helperPath} could not exec /bin/pwd in ${workDirectory}.\n${describeFailure(error)}`,
      );
    }
    const reportedDirectory = String(contractOutput).trim();
    if (reportedDirectory !== expectedDirectory) {
      throw new Error(
        `[spawn-helper] ${helperPath} ran /bin/pwd in "${reportedDirectory}", expected "${expectedDirectory}". ` +
          'The cwd and exec contract node-pty relies on is broken.',
      );
    }

    log(
      `[spawn-helper] Verified ${helperPath} on ${process.arch}: ${String(harnessOutput).trim()}; ` +
        'cwd and exec contract holds',
    );
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

/** Every `node-pty/prebuilds/darwin-*\/spawn-helper` present under `unpackedRoot`. */
function findDarwinSpawnHelpers(unpackedRoot) {
  const prebuildsDirectory = path.join(unpackedRoot, 'node_modules', 'node-pty', 'prebuilds');
  if (!fs.existsSync(prebuildsDirectory)) return [];
  return fs
    .readdirSync(prebuildsDirectory)
    .filter((entry) => entry.startsWith('darwin-'))
    .map((entry) => path.join(prebuildsDirectory, entry, 'spawn-helper'))
    .filter((helperPath) => fs.existsSync(helperPath));
}

function requireDarwinSpawnHelpers(unpackedRoot) {
  const helperPaths = findDarwinSpawnHelpers(unpackedRoot);
  if (helperPaths.length === 0) {
    throw new Error(
      `[spawn-helper] No node-pty darwin-*/spawn-helper under ${unpackedRoot}. ` +
        'Every macOS terminal spawns through it, so a package without one cannot open a terminal.',
    );
  }
  return helperPaths;
}

/** Runs `verifySpawnHelper` on every darwin helper in a packaged tree. Used by
 *  build/afterSign.js on the signed app. */
function verifyPackagedSpawnHelpers({ unpackedRoot, spawn = execFileSync, log = console.log }) {
  for (const helperPath of requireDarwinSpawnHelpers(unpackedRoot)) {
    verifySpawnHelper({ helperPath, spawn, log });
  }
}

/**
 * On darwin, compiles Kangentic's helper over every node-pty darwin
 * spawn-helper in `unpackedRoot` and verifies each. Elsewhere, logs that it
 * does not apply and returns.
 */
function installSpawnHelper({ unpackedRoot, platform, spawn = execFileSync, log = console.log }) {
  if (platform !== 'darwin') {
    log(
      `[spawn-helper] Exception-port reset not applicable on ${platform}: ` +
        'Crashpad installs in-process there, and exec resets it',
    );
    return;
  }

  const helperPaths = requireDarwinSpawnHelpers(unpackedRoot);
  const workDirectory = makeWorkDirectory('kangentic-spawn-helper-build-');
  try {
    const builtHelperPath = path.join(workDirectory, 'spawn-helper');
    compileSpawnHelper({ outputPath: builtHelperPath, spawn });
    for (const helperPath of helperPaths) {
      fs.copyFileSync(builtHelperPath, helperPath);
      fs.chmodSync(helperPath, 0o755);
      log(`[spawn-helper] Installed the exception-port-reset helper (${SPAWN_HELPER_ARCHES.join(' + ')}) at ${helperPath}`);
    }
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }

  verifyPackagedSpawnHelpers({ unpackedRoot, spawn, log });
}

/**
 * Runs a real node-pty session through the helper. node-pty resolves its
 * helper beside whichever `pty.node` its loader picks (build/Release first,
 * then prebuilds), so the helper is copied to exactly that directory. This
 * replaces the helper in the local `node_modules`, which is what a CI runner
 * wants and harmless on a Mac.
 */
async function runNodePtySmoke({ helperPath, log }) {
  const repositoryRoot = path.join(__dirname, '..');
  const nodePtyRoot = path.dirname(require.resolve('node-pty/package.json', { paths: [repositoryRoot] }));
  const nativeModule = require(path.join(nodePtyRoot, 'lib', 'utils.js')).loadNativeModule('pty');
  const installedHelperPath = path.resolve(nodePtyRoot, 'lib', nativeModule.dir, 'spawn-helper');
  fs.copyFileSync(helperPath, installedHelperPath);
  fs.chmodSync(installedHelperPath, 0o755);
  log(`[spawn-helper] Copied the helper to ${installedHelperPath} for the node-pty smoke run`);

  const pty = require(nodePtyRoot);
  const smokeDirectory = makeWorkDirectory('kangentic-spawn-helper-smoke-');
  const marker = 'kangentic-spawn-helper-smoke-done';
  try {
    // `ps -o tty=` names the CONTROLLING terminal ("??" when there is none),
    // which is the part of the contract `tty` alone cannot show. The sleep lets
    // the output drain before exit.
    const script = `pwd -P; ps -o tty= -p $$; echo ${marker}; sleep 1`;
    const output = await new Promise((resolve, reject) => {
      let collected = '';
      const terminal = pty.spawn('/bin/sh', ['-c', script], {
        cwd: smokeDirectory,
        cols: 120,
        rows: 30,
        env: process.env,
      });
      const timer = setTimeout(() => {
        terminal.kill();
        reject(new Error(`[spawn-helper] node-pty smoke run timed out. Output so far:\n${collected}`));
      }, 30_000);
      terminal.onData((data) => {
        collected += data;
      });
      terminal.onExit(({ exitCode }) => {
        clearTimeout(timer);
        if (exitCode === 0) resolve(collected);
        else reject(new Error(`[spawn-helper] node-pty smoke run exited ${exitCode}. Output:\n${collected}`));
      });
    });

    const expectedDirectory = fs.realpathSync(smokeDirectory);
    const lines = output.split(/\r?\n/).map((line) => line.trim());
    if (!lines.includes(expectedDirectory)) {
      throw new Error(`[spawn-helper] node-pty smoke run did not start in ${expectedDirectory}. Output:\n${output}`);
    }
    if (!lines.some((line) => /^ttys\d+$/.test(line))) {
      throw new Error(`[spawn-helper] node-pty smoke run has no controlling terminal. Output:\n${output}`);
    }
    if (!lines.includes(marker)) {
      throw new Error(`[spawn-helper] node-pty smoke run did not finish its script. Output:\n${output}`);
    }
    log('[spawn-helper] node-pty smoke run passed: right cwd, a controlling tty, script ran to completion');
  } finally {
    fs.rmSync(smokeDirectory, { recursive: true, force: true });
  }
}

/**
 * Ad-hoc signs the helper with hardened runtime and the app's entitlements.
 * That sets the same kernel flag (CS_RUNTIME) Developer ID signing does, with
 * no certificate, so the self-test sees the helper as the release ships it.
 */
function signWithHardenedRuntime({ helperPath, spawn = execFileSync }) {
  const entitlementsPath = path.join(__dirname, 'entitlements.plist');
  try {
    spawn(
      'codesign',
      ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlementsPath, helperPath],
      { ...CHILD_OPTIONS, timeout: 60_000 },
    );
  } catch (error) {
    throw new Error(`[spawn-helper] Could not ad-hoc sign ${helperPath} with hardened runtime.\n${describeFailure(error)}`);
  }
}

/**
 * The PR-time check. Runs the same sequence as a release build: the afterPack
 * gate on the unsigned helper, then the afterSign gate once it carries hardened
 * runtime, then a real node-pty session through the signed one.
 */
async function runSelfTest({ log = console.log } = {}) {
  if (process.platform !== 'darwin') {
    throw new Error(`[spawn-helper] --self-test compiles and runs Mach code, so it runs on macOS only (this is ${process.platform})`);
  }
  const workDirectory = makeWorkDirectory('kangentic-spawn-helper-self-test-');
  try {
    const helperPath = path.join(workDirectory, 'spawn-helper');
    compileSpawnHelper({ outputPath: helperPath });
    fs.chmodSync(helperPath, 0o755);
    log(`[spawn-helper] Compiled ${SPAWN_HELPER_ARCHES.join(' + ')} helper for the self-test`);
    verifySpawnHelper({ helperPath, log });

    signWithHardenedRuntime({ helperPath });
    log('[spawn-helper] Ad-hoc signed the helper with hardened runtime and build/entitlements.plist');
    verifySpawnHelper({ helperPath, log });

    await runNodePtySmoke({ helperPath, log });
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  EXCEPTION_PORT_PROBE_SOURCE,
  MINIMUM_MACOS_VERSION,
  PROBE_EXIT_MEANINGS,
  SPAWN_HELPER_ARCHES,
  SPAWN_HELPER_SOURCE,
  compileSpawnHelper,
  findDarwinSpawnHelpers,
  installSpawnHelper,
  runSelfTest,
  signWithHardenedRuntime,
  verifyPackagedSpawnHelpers,
  verifySpawnHelper,
};

if (require.main === module) {
  if (process.argv.includes('--self-test')) {
    // Exit explicitly: node-pty can keep the event loop alive after its child is gone.
    runSelfTest().then(
      () => {
        console.log('[spawn-helper] Self-test passed');
        process.exit(0);
      },
      (error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      },
    );
  } else {
    console.error('usage: node build/install-spawn-helper.js --self-test');
    process.exit(2);
  }
}

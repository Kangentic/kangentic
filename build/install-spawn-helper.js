const { execFileSync, spawnSync } = require('child_process');
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
 * session through the helper, and a `child_process` shell launch the way
 * src/main/pty/spawn/shell-launch.ts builds one.
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

/** What `exception-port-probe check` exits with when it sees a task exception port. */
const PROBE_PORT_PRESENT_EXIT = 10;

/** The argument that runs this script as the child_process check, under `with-port`. */
const CHILD_PROCESS_CHECK_FLAG = '--child-process-check';

/** What the child_process check prints when it passes. The parent looks for it. */
const CHILD_PROCESS_CHECK_PASSED =
  'child_process launch through the helper: the control child inherited the port, the shell launched through the helper did not';

/**
 * The command the check runs through the helper. It prints the shell's pid, then
 * execs the probe (passed as `$0`) in `check` mode, so the probe's verdict is the
 * exit code and the pid is the one child_process returned.
 */
const CHILD_PROCESS_CHECK_SCRIPT = 'echo "pid:$$"; exec "$0" check';

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
 * The child_process half of the self-test, run as `node install-spawn-helper.js
 * --child-process-check <helper> <probe>` under `exception-port-probe with-port`,
 * so this Node process holds a live inherited exception port the way
 * Kangentic's main process holds Crashpad's. Throws with the reason, or returns
 * CHILD_PROCESS_CHECK_PASSED.
 *
 * 1. Control: `<probe> check` launched straight from child_process must exit 10,
 *    so the check can see a port passed on through Node's own spawn. Without it
 *    a pass could mean nothing was ever inherited.
 * 2. The launch src/main/pty/spawn/shell-launch.ts builds on macOS for a command
 *    string, `[helper, '', '/bin/sh', '-c', command]`, with stdin a pipe. The
 *    helper calls ttyname() on stdin and must shrug off the failure. The probe
 *    run inside that shell must see no port (exit 0), and the shell's own pid
 *    must be the pid child_process reports, since a process-group kill and the
 *    pid SHELL_EXEC returns both rely on the helper exec'ing in place.
 */
function runChildProcessCheck({ helperPath, probePath, spawn = spawnSync }) {
  const control = spawn(probePath, ['check'], { encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
  if (control.status !== PROBE_PORT_PRESENT_EXIT) {
    throw new Error(
      `[spawn-helper] child_process check: the control child exited ${control.status}, not ${PROBE_PORT_PRESENT_EXIT}, ` +
        'so no exception port reached it through child_process and this check cannot observe inheritance.\n' +
        String(control.stderr || control.error || '').trim(),
    );
  }

  const launched = spawn(helperPath, ['', '/bin/sh', '-c', CHILD_PROCESS_CHECK_SCRIPT, probePath], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  const launchOutput = `${String(launched.stdout || '').trim()}\n${String(launched.stderr || '').trim()}`.trim();
  if (launched.error) {
    throw new Error(`[spawn-helper] child_process check: could not launch ${helperPath}: ${launched.error.message}`);
  }
  if (launched.status === PROBE_PORT_PRESENT_EXIT) {
    throw new Error(
      '[spawn-helper] child_process check: a shell launched through the helper still had an exception port.\n' +
        launchOutput,
    );
  }
  if (launched.status !== 0) {
    throw new Error(
      `[spawn-helper] child_process check: the shell launched through the helper exited ${launched.status}.\n${launchOutput}`,
    );
  }
  if (!String(launched.stdout || '').split(/\r?\n/).includes(`pid:${launched.pid}`)) {
    throw new Error(
      `[spawn-helper] child_process check: the shell did not report pid ${launched.pid}, the one child_process returned, ` +
        `so the helper did not exec it in place.\n${launchOutput}`,
    );
  }
  return CHILD_PROCESS_CHECK_PASSED;
}

/**
 * Runs runChildProcessCheck against the helper at `helperPath`: compiles the
 * probe, then runs this script under `exception-port-probe with-port` and
 * requires the check's pass line. Throws otherwise.
 */
function verifyChildProcessLaunch({ helperPath, spawn = execFileSync, log = console.log }) {
  const workDirectory = makeWorkDirectory('kangentic-spawn-helper-child-process-');
  try {
    const probePath = path.join(workDirectory, 'exception-port-probe');
    // Host arch only: the probe runs here and never ships.
    compile({ sourcePath: EXCEPTION_PORT_PROBE_SOURCE, outputPath: probePath, arches: [], spawn });

    let output;
    try {
      output = spawn(
        probePath,
        ['with-port', process.execPath, __filename, CHILD_PROCESS_CHECK_FLAG, helperPath, probePath],
        { ...CHILD_OPTIONS, timeout: 120_000 },
      );
    } catch (error) {
      throw new Error(`[spawn-helper] ${helperPath} failed the child_process launch check.\n${describeFailure(error)}`);
    }
    if (!String(output).includes(CHILD_PROCESS_CHECK_PASSED)) {
      throw new Error(
        `[spawn-helper] ${helperPath}: the child_process launch check exited 0 without its pass line. Output:\n${String(output).trim()}`,
      );
    }
    log(`[spawn-helper] ${CHILD_PROCESS_CHECK_PASSED}`);
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
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
 * runtime, then a real node-pty session and a `child_process` shell launch
 * through the signed one.
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
    verifyChildProcessLaunch({ helperPath, log });
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

module.exports = {
  CHILD_PROCESS_CHECK_FLAG,
  CHILD_PROCESS_CHECK_PASSED,
  CHILD_PROCESS_CHECK_SCRIPT,
  EXCEPTION_PORT_PROBE_SOURCE,
  MINIMUM_MACOS_VERSION,
  PROBE_EXIT_MEANINGS,
  SPAWN_HELPER_ARCHES,
  SPAWN_HELPER_SOURCE,
  compileSpawnHelper,
  findDarwinSpawnHelpers,
  installSpawnHelper,
  runChildProcessCheck,
  runSelfTest,
  signWithHardenedRuntime,
  verifyChildProcessLaunch,
  verifyPackagedSpawnHelpers,
  verifySpawnHelper,
};

if (require.main === module) {
  const childProcessCheckIndex = process.argv.indexOf(CHILD_PROCESS_CHECK_FLAG);
  if (childProcessCheckIndex !== -1) {
    // Run by verifyChildProcessLaunch under `exception-port-probe with-port`.
    const [helperPath, probePath] = process.argv.slice(childProcessCheckIndex + 1);
    try {
      console.log(runChildProcessCheck({ helperPath, probePath }));
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  } else if (process.argv.includes('--self-test')) {
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

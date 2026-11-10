/**
 * A launch through a REAL shell on a real PTY, typed as `performSpawn` types it,
 * reaching a stub agent. Tests here read what the stub received, never the
 * scrollback: the shell's own echo of a command is not the agent getting it. The
 * one exception is a launch that fails in the shell, where what the shell
 * printed is the thing under test (`a launch that fails in the shell`).
 *
 * The failure depends on timing, so the startup delay is a parameter. While a
 * shell is in its startup files its tty is in canonical mode, where the kernel
 * keeps one line up to its limit and drops the rest, the Enter included: 1024
 * bytes on macOS, about 4 KB on Linux. The old full line must therefore fail
 * during the delay and work once the shell has reached its prompt. Without that
 * control this file could pass on a rig that never reached canonical mode.
 *
 * Where it runs: bash in CI's unit tier on Linux, zsh in macos-spawn-helper.yml
 * (with a pinned powerlevel10k), and every shell in shell-quoting-posix.yml. Those
 * workflows set KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS, so a shell they need fails
 * rather than skips. Nothing here runs on Windows, which has no canonical mode. cmd
 * has a line limit of its own, and cmd-launcher-round-trip.test.ts covers that.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnClearPrelude, adaptCommandForShell, quoteArg } from '../../src/shared/paths';
import { buildTypedLaunch, TYPED_LINE_BYTE_BUDGET } from '../../src/main/pty/spawn/typed-launch';
import { classifyLaunchOutput, type LaunchOutputClass } from '../../src/main/pty/launch-output-class';
import { finalLinesOf } from '../../src/main/agent/shared/user-setup-failure';

/** Past the kernel's canonical limit on each platform, as the #744 command was on macOS. */
const OVERSIZED_BYTES = process.platform === 'darwin' ? 1_590 : 5_000;
const STARTUP_DELAY_MS = 1_500;
/** When `performSpawn` types: its fixed delay after the shell starts. */
const TYPED_AT_MS = 100;
/** Long enough for the line to run after a shell's delay, under a loaded runner. */
const STUB_DEADLINE_MS = 20_000;
/** How long the control waits after the delay before it says the agent never ran. */
const CONTROL_SETTLE_MS = 3_000;
const RESUME_ID = '535cf65a-0000-4000-8000-000000000000';

interface ProbeShell {
  program: string;
  /** What `resolveShellArgs` starts it with. Copied rather than imported: that module reaches electron, whose binary the macOS job does not install. */
  args: readonly string[];
  /** Write the startup file that holds the shell in its startup for `delayMs`. */
  writeStartup(root: string, delayMs: number): void;
}

const PROBE_SHELLS: readonly ProbeShell[] = [
  {
    program: 'bash',
    args: ['--login'],
    writeStartup: (root, delayMs) => fs.writeFileSync(path.join(root, '.bash_profile'), `sleep ${delayMs / 1000}\n`),
  },
  {
    program: 'zsh',
    args: ['--login'],
    writeStartup: (root, delayMs) => fs.writeFileSync(path.join(root, '.zshrc'), `sleep ${delayMs / 1000}\n`),
  },
  {
    program: 'fish',
    args: [],
    writeStartup: (root, delayMs) => {
      fs.mkdirSync(path.join(root, '.config', 'fish'), { recursive: true });
      fs.writeFileSync(path.join(root, '.config', 'fish', 'config.fish'), `sleep ${delayMs / 1000}\n`);
    },
  },
  {
    program: 'nu',
    args: [],
    writeStartup: (root, delayMs) => {
      fs.mkdirSync(path.join(root, '.config', 'nushell'), { recursive: true });
      fs.writeFileSync(path.join(root, '.config', 'nushell', 'config.nu'), `sleep ${delayMs}ms\n`);
    },
  },
  {
    program: 'pwsh',
    args: ['-NoLogo'],
    writeStartup: (root, delayMs) => {
      fs.mkdirSync(path.join(root, '.config', 'powershell'), { recursive: true });
      fs.writeFileSync(path.join(root, '.config', 'powershell', 'profile.ps1'), `Start-Sleep -Milliseconds ${delayMs}\n`);
    },
  },
];

const requiredShells = (process.env.KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS ?? '').split(',').filter(Boolean);

/** The shell that shows the limit on this platform, for the control. */
const CONTROL_PROGRAM = process.platform === 'darwin' ? 'zsh' : 'bash';

function isInstalled(program: string): boolean {
  if (process.platform === 'win32') return false;
  return spawnSync(program, ['--version'], { timeout: 15_000 }).status === 0;
}

/** Only the shells this run uses, since a probe runs at import. */
const installedShells = PROBE_SHELLS.filter((shell) => (
  (shell.program === CONTROL_PROGRAM || requiredShells.includes(shell.program)) && isInstalled(shell.program)
));
for (const program of requiredShells) {
  if (!installedShells.some((shell) => shell.program === program)) {
    throw new Error(`${program} is not on PATH, and KANGENTIC_TYPED_LAUNCH_REQUIRE_SHELLS requires it`);
  }
}

const controlShell = installedShells.find((shell) => shell.program === CONTROL_PROGRAM);

/** The workflows name their shells. Anywhere else, the unit tier included, the control shell alone. */
const shellsUnderTest = requiredShells.length > 0
  ? installedShells.filter((shell) => requiredShells.includes(shell.program))
  : installedShells.filter((shell) => shell === controlShell);

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

interface StubReport {
  argv: string[];
  stdoutIsTerminal: boolean;
}

interface Rig {
  root: string;
  sessionDirectory: string;
  agentPath: string;
  resultPath: string;
  /** An agent that stays up until it is ended, and writes its pid to `holdPidPath`. */
  holdAgentPath: string;
  holdPidPath: string;
}

function makeRig(shell: ProbeShell, delayMs: number): Rig {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kng-typed-launch-')));
  // Best-effort, with retries: a shell ending on its hangup still writes its
  // history file here as this runs, and a temp folder left behind harms nothing.
  cleanups.push(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* still held */ }
  });
  // Written at delay 0 too: zsh with no .zshrc can open its new-user prompt.
  shell.writeStartup(root, delayMs);
  // A run of spaces, as a real project folder may hold.
  const sessionDirectory = path.join(root, 'project  one', '.kangentic', 'sessions', 'session-1');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const agentDirectory = path.join(root, 'agent dir');
  fs.mkdirSync(agentDirectory);
  const resultPath = path.join(root, 'stub-report.json');
  const stubPath = path.join(agentDirectory, 'stub.cjs');
  fs.writeFileSync(stubPath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ argv: process.argv.slice(2), stdoutIsTerminal: process.stdout.isTTY === true }));`,
    '',
  ].join('\n'));
  const agentPath = path.join(agentDirectory, 'agent');
  fs.writeFileSync(agentPath, `#!/bin/sh\nexec "${process.execPath}" "${stubPath}" "$@"\n`);
  fs.chmodSync(agentPath, 0o755);
  const holdPidPath = path.join(root, 'hold-pid.txt');
  const holdStubPath = path.join(agentDirectory, 'hold.cjs');
  fs.writeFileSync(holdStubPath, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(holdPidPath)}, String(process.pid));`,
    'setInterval(() => undefined, 1000);',
    '',
  ].join('\n'));
  const holdAgentPath = path.join(agentDirectory, 'hold-agent');
  fs.writeFileSync(holdAgentPath, `#!/bin/sh\nexec "${process.execPath}" "${holdStubPath}" "$@"\n`);
  fs.chmodSync(holdAgentPath, 0o755);
  return { root, sessionDirectory, agentPath, resultPath, holdAgentPath, holdPidPath };
}

function commandFor(shell: ProbeShell, rig: Rig, args: readonly string[], agentPath: string = rig.agentPath): string {
  const quote = (value: string): string => quoteArg(value, shell.program, { multiline: true });
  return [agentPath, ...args].map(quote).join(' ');
}

/** Start the shell the way a session does, in a home holding only the rig's startup file. */
function startShell(shell: ProbeShell, rig: Rig): IPty {
  const environment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    HOME: rig.root,
    ZDOTDIR: rig.root,
    XDG_CONFIG_HOME: path.join(rig.root, '.config'),
  };
  const pty = ptySpawn(shell.program, [...shell.args], { cols: 120, rows: 30, cwd: rig.root, env: environment });
  // node-pty stalls a child whose output is never read.
  pty.onData(() => undefined);
  cleanups.push(() => {
    try { pty.kill(); } catch { /* already gone */ }
  });
  return pty;
}

async function waitForReport(rig: Rig, deadlineMs: number): Promise<StubReport | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(rig.resultPath)) {
      try {
        return JSON.parse(fs.readFileSync(rig.resultPath, 'utf8')) as StubReport;
      } catch {
        // Read while the stub was writing it.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Spawn the shell, then type `line` at `typedAtMs`, as the spawn timer does. */
function typeLine(shell: ProbeShell, rig: Rig, line: string, typedAtMs: number): IPty {
  const pty = startShell(shell, rig);
  setTimeout(() => pty.write(`${line}\r`), typedAtMs);
  return pty;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** How long a hung-up shell has to end its agent, which node-pty's kill asks for with a SIGHUP. */
const HANGUP_SETTLE_MS = 6_000;

/**
 * Run a long-lived agent from a launch typed at a shell that has reached its
 * prompt, hang the shell up, and say whether the agent ended. A suspend ends a
 * Linux Claude by exactly this hangup. Measured on bash, an agent started from a
 * sourced file outlived it where one typed at the prompt did not, and the
 * launcher's `source` form was replaced for it.
 */
async function agentEndsOnHangup(shell: ProbeShell, viaLauncher: boolean): Promise<boolean> {
  const rig = makeRig(shell, 0);
  const args = ['--append-system-prompt', policyOfBytes(OVERSIZED_BYTES)];
  const command = commandFor(shell, rig, args, rig.holdAgentPath);
  const line = viaLauncher ? launchLine(shell, rig, command) : fullLine(shell, command);
  const pty = typeLine(shell, rig, line, STARTUP_DELAY_MS);

  const deadline = Date.now() + STUB_DEADLINE_MS;
  while (Date.now() < deadline && !fs.existsSync(rig.holdPidPath)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const pidText = fs.existsSync(rig.holdPidPath) ? fs.readFileSync(rig.holdPidPath, 'utf8') : '';
  const agentPid = Number.parseInt(pidText, 10);
  expect(Number.isInteger(agentPid), 'the agent never started, so there is nothing to hang up').toBe(true);
  // A survivor must not outlive the test.
  cleanups.push(() => {
    try { process.kill(agentPid, 'SIGKILL'); } catch { /* gone */ }
  });

  pty.kill();
  const settleDeadline = Date.now() + HANGUP_SETTLE_MS;
  while (Date.now() < settleDeadline && isAlive(agentPid)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(agentPid);
}

/** The line `performSpawn` typed before the launcher: the whole command. */
function fullLine(shell: ProbeShell, command: string): string {
  return buildSpawnClearPrelude(shell.program) + adaptCommandForShell(command, shell.program);
}

function launchLine(shell: ProbeShell, rig: Rig, command: string): string {
  const launch = buildTypedLaunch({
    command,
    shell: shell.program,
    sessionDirectory: rig.sessionDirectory,
    platform: process.platform,
    batchShimLaunch: () => null,
  });
  expect(launch.launcher, 'an oversized command takes the launcher').not.toBeNull();
  expect(launch.typedLineBytes).toBeLessThan(TYPED_LINE_BYTE_BUDGET);
  if (launch.launcher) fs.writeFileSync(launch.launcher.filePath, launch.launcher.contents);
  return launch.typedLine;
}

/** A value of about `bytes` bytes, in plain words. */
function policyOfBytes(bytes: number): string {
  return 'BROWSER: drive only the pane the user watches. '.repeat(Math.ceil(bytes / 47)).slice(0, bytes);
}

/**
 * A launch shaped like a task's: a long prompt with an apostrophe, a newline and
 * multi-byte text. No double quote: `quoteArg` rewrites one for PowerShell.
 */
const LONG_PROMPT = [
  `it's the task's prompt, and a $HOME that stays literal`,
  'a second line, café',
  policyOfBytes(5_000),
].join('\n');

describe.skipIf(shellsUnderTest.length === 0)('a launch typed while the shell starts', () => {
  describe.each(shellsUnderTest.map((shell) => ({ program: shell.program, shell })))('$program', ({ shell }) => {
    it('reaches the agent with a --resume command too long to type, during the startup delay', async () => {
      const rig = makeRig(shell, STARTUP_DELAY_MS);
      const args = ['--append-system-prompt', policyOfBytes(OVERSIZED_BYTES), '--resume', RESUME_ID];
      typeLine(shell, rig, launchLine(shell, rig, commandFor(shell, rig, args)), TYPED_AT_MS);

      const report = await waitForReport(rig, STUB_DEADLINE_MS);

      expect(report?.argv).toEqual(args);
      expect(report?.stdoutIsTerminal).toBe(true);
    }, 30_000);

    it('reaches the agent with a 5 KB prompt, unchanged, during the startup delay', async () => {
      const rig = makeRig(shell, STARTUP_DELAY_MS);
      const args = ['--session-id', RESUME_ID, '--', LONG_PROMPT];
      typeLine(shell, rig, launchLine(shell, rig, commandFor(shell, rig, args)), TYPED_AT_MS);

      const report = await waitForReport(rig, STUB_DEADLINE_MS);

      expect(report?.argv).toEqual(args);
      expect(report?.stdoutIsTerminal).toBe(true);
    }, 30_000);

    // The launcher must change nothing about how a suspend ends the agent. Where
    // a shell does not pass a hangup on to a typed agent, it is no regression
    // that it does not for a launched one, so the invariant is equality.
    it('ends an agent started through the launcher when the shell is hung up, as it ends one typed whole', async () => {
      const typedEnds = await agentEndsOnHangup(shell, false);
      const launcherEnds = await agentEndsOnHangup(shell, true);

      console.log(`[typed-launch hangup] ${process.platform} ${shell.program}: typed ${typedEnds ? 'ended' : 'survived'}, launcher ${launcherEnds ? 'ended' : 'survived'}`);
      expect(launcherEnds).toBe(typedEnds);
    }, 60_000);
  });
});

/** A way a launch fails that the shell, not the agent, reports. */
type ShellFailure = 'missing_launcher' | 'killed' | 'crashed' | 'exec_format' | 'bad_cpu_type';

const FAILURE_CLASSES: Readonly<Record<ShellFailure, LaunchOutputClass>> = {
  missing_launcher: 'launcher_unreadable',
  killed: 'killed',
  crashed: 'crashed',
  exec_format: 'exec_format',
  bad_cpu_type: 'bad_cpu_type',
};

/**
 * What each shell printed for each failure, by `<platform>/<shell>`, with the
 * rig's folder written `<rig>`. Read off a real run, never written from memory:
 * the classifier's shapes are built on these lines (bash 5.2, zsh 5.9, fish
 * 3.7.0, nushell 0.116.0, on Ubuntu 24.04 as CI runs them). GNU cat quotes a
 * path that holds a space; BSD cat on macOS may not, which is why the platform
 * is in the key. A shell this run needs with no line here fails and prints what
 * it saw.
 *
 * Lines are compared with each run of spaces made one, since zsh pads its job
 * column, and with ` (core dumped)` dropped, since whether a crash dumps core is
 * the runner's setting. fish shortens a job's command text to a fixed length,
 * which depends on the rig's folder, so its job lines are pinned as patterns.
 * macOS ships zsh 5.9 too, and its job words are zsh's own, so darwin/zsh holds
 * the same job lines; its `cat` line comes from the first macOS run.
 */
const PRINTED_LINES: Readonly<Record<string, Partial<Record<ShellFailure, string | RegExp>>>> = {
  'linux/bash': {
    missing_launcher: "cat: '<rig>/project one/.kangentic/sessions/session-1/launch.sh': No such file or directory",
    killed: 'Killed',
    crashed: 'Segmentation fault',
    exec_format: 'bash: <rig>/agent dir/not-a-program: cannot execute binary file: Exec format error',
  },
  'linux/zsh': {
    missing_launcher: "cat: '<rig>/project one/.kangentic/sessions/session-1/launch.sh': No such file or directory",
    killed: "zsh: killed '<rig>/agent dir/signal-kill'",
    crashed: "zsh: segmentation fault '<rig>/agent dir/signal-segv'",
    exec_format: 'zsh: exec format error: <rig>/agent dir/not-a-program',
  },
  'darwin/zsh': {
    killed: "zsh: killed '<rig>/agent dir/signal-kill'",
    crashed: "zsh: segmentation fault '<rig>/agent dir/signal-segv'",
    exec_format: 'zsh: exec format error: <rig>/agent dir/not-a-program',
  },
  'linux/fish': {
    missing_launcher: "source: Error encountered while sourcing file ''<rig>/project one/.kangentic/sessions/session-1/launch.fish'':",
    killed: /^fish: Job 1, '.*' terminated by signal SIGKILL \(Forced quit\)$/,
    crashed: /^fish: Job 1, '.*' terminated by signal SIGSEGV \(Address boundary error\)$/,
    exec_format: "exec: Failed to execute process: '<rig>/agent dir/not-a-program' the file could not be run by the operating system.",
  },
  'linux/nu': {
    missing_launcher: 'Error: nu::parser::sourced_file_not_found',
    killed: '· ╰── terminated by SIGKILL (9)',
    // nushell said `core_dumped` with the core limit at 0 too; either header is its crash.
    crashed: /^(?:Error: nu::shell::core_dumped|· ╰── terminated by SIGSEGV \(11\))$/,
  },
};

/**
 * Failures a shell reports in words that name no cause, measured, so the case
 * is skipped with the reason rather than pinned.
 */
const UNCLASSIFIED: Readonly<Record<string, Partial<Record<ShellFailure, string>>>> = {
  nu: {
    exec_format: 'nushell hands a file it cannot run to /bin/sh, which reads its first bytes as a command not found',
  },
};

/** An agent that ends itself with `signal`, as a CLI the OS killed or that crashed would end. */
function signalAgent(rig: Rig, signal: 'KILL' | 'SEGV'): string {
  const agentPath = path.join(rig.root, 'agent dir', `signal-${signal.toLowerCase()}`);
  fs.writeFileSync(agentPath, `#!/bin/sh\nkill -${signal} $$\n`, { mode: 0o755 });
  return agentPath;
}

/** A file marked executable that holds no program this machine runs, and no shebang. */
function notAProgram(rig: Rig): string {
  const agentPath = path.join(rig.root, 'agent dir', 'not-a-program');
  fs.writeFileSync(agentPath, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x21, 0x21]), { mode: 0o755 });
  return agentPath;
}

/**
 * A 64-bit Mach-O header naming a CPU type no Mac runs (PowerPC, 18), so the
 * kernel refuses it for its architecture, as it refuses an Intel-only CLI on an
 * Apple silicon Mac without Rosetta.
 */
function wrongCpuBinary(rig: Rig): string {
  const agentPath = path.join(rig.root, 'agent dir', 'wrong-cpu');
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(18, 4);
  header.writeUInt32LE(2, 12);
  fs.writeFileSync(agentPath, header, { mode: 0o755 });
  return agentPath;
}

/** The launcher line for an oversized command, with its file never written: the launcher is gone. */
function missingLauncherLine(shell: ProbeShell, rig: Rig): string {
  const launch = buildTypedLaunch({
    command: commandFor(shell, rig, ['--append-system-prompt', policyOfBytes(OVERSIZED_BYTES)]),
    shell: shell.program,
    sessionDirectory: rig.sessionDirectory,
    platform: process.platform,
    batchShimLaunch: () => null,
  });
  expect(launch.launcher, 'an oversized command takes the launcher').not.toBeNull();
  return launch.typedLine;
}

/** Type `line` at a shell that has reached its prompt, and return what it printed once that names a class, or at the deadline. */
async function printedAfter(shell: ProbeShell, rig: Rig, line: string): Promise<string> {
  const pty = typeLine(shell, rig, line, STARTUP_DELAY_MS);
  let output = '';
  pty.onData((data) => { output += data; });
  const deadline = Date.now() + STUB_DEADLINE_MS;
  while (Date.now() < deadline && classifyLaunchOutput(output) === 'other') {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return output;
}

/**
 * These read the shell's output, unlike the rest of this file, because the line
 * the shell printed is the whole of what is under test: a launch that fails this
 * way leaves no agent to report anything, and the report sends only the class.
 */
describe.skipIf(shellsUnderTest.length === 0)('a launch that fails in the shell', () => {
  describe.each(shellsUnderTest.map((shell) => ({ program: shell.program, shell })))('$program', ({ shell }) => {
    async function expectPrinted(failure: ShellFailure, rig: Rig, line: string): Promise<void> {
      const output = await printedAfter(shell, rig, line);
      const printed = finalLinesOf(output)
        .map((printedLine) => printedLine.replaceAll(rig.root, '<rig>').replaceAll(' (core dumped)', '').replace(/\s+/g, ' '));
      const pinned = PRINTED_LINES[`${process.platform}/${shell.program}`]?.[failure];
      const seen = `it printed, newest first:\n${printed.join('\n')}`;
      expect(pinned, `no line is pinned for ${shell.program} on ${process.platform} (${failure}); ${seen}`).toBeDefined();
      const matches = (printedLine: string): boolean => (typeof pinned === 'string' ? printedLine === pinned : pinned?.test(printedLine) === true);
      expect(printed.some(matches), `no line matched ${String(pinned)}; ${seen}`).toBe(true);
      expect(classifyLaunchOutput(output)).toBe(FAILURE_CLASSES[failure]);
    }

    const unclassified = (failure: ShellFailure): boolean => UNCLASSIFIED[shell.program]?.[failure] !== undefined;

    it('names a launcher file that is gone', async () => {
      const rig = makeRig(shell, 0);
      await expectPrinted('missing_launcher', rig, missingLauncherLine(shell, rig));
    }, 30_000);

    it('names an agent the system killed', async () => {
      const rig = makeRig(shell, 0);
      await expectPrinted('killed', rig, fullLine(shell, commandFor(shell, rig, [], signalAgent(rig, 'KILL'))));
    }, 30_000);

    it('names an agent that crashed', async () => {
      const rig = makeRig(shell, 0);
      await expectPrinted('crashed', rig, fullLine(shell, commandFor(shell, rig, [], signalAgent(rig, 'SEGV'))));
    }, 30_000);

    it.skipIf(unclassified('exec_format'))('names a file that is not a program this machine runs', async () => {
      const rig = makeRig(shell, 0);
      await expectPrinted('exec_format', rig, fullLine(shell, commandFor(shell, rig, [], notAProgram(rig))));
    }, 30_000);

    it.skipIf(process.platform !== 'darwin')('names a binary built for a CPU this Mac does not run', async () => {
      const rig = makeRig(shell, 0);
      await expectPrinted('bad_cpu_type', rig, fullLine(shell, commandFor(shell, rig, [], wrongCpuBinary(rig))));
    }, 30_000);
  });
});

/**
 * The setup #744 ran: zsh with powerlevel10k's instant prompt, which draws a prompt
 * before the startup files finish, so a screen that looks ready is not one. Only
 * the macOS job names a checkout, pinned there, since the theme is not a dependency.
 */
const powerlevel10kDirectory = process.env.KANGENTIC_POWERLEVEL10K_DIRECTORY;
const zshShell = installedShells.find((shell) => shell.program === 'zsh');

describe.skipIf(!powerlevel10kDirectory || !zshShell)('a launch under powerlevel10k instant prompt', () => {
  const shell = zshShell as ProbeShell;
  const INSTANT_PROMPT_CACHE_DEADLINE_MS = 15_000;

  function writeInstantPromptRc(rig: Rig): void {
    fs.writeFileSync(path.join(rig.root, '.zshrc'), [
      'typeset -g POWERLEVEL9K_INSTANT_PROMPT=quiet',
      'typeset -g POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true',
      'typeset -g POWERLEVEL9K_DISABLE_GITSTATUS=true',
      'typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(dir)',
      'typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=()',
      'cache="$HOME/.cache/p10k-instant-prompt-${(%):-%n}.zsh"',
      '[[ -r "$cache" ]] && source "$cache"',
      `source "${powerlevel10kDirectory}/powerlevel10k.zsh-theme"`,
      `sleep ${STARTUP_DELAY_MS / 1000}`,
      '',
    ].join('\n'));
  }

  /** The instant prompt draws from a cache a first interactive start writes. */
  async function primeInstantPrompt(rig: Rig): Promise<void> {
    const first = startShell(shell, rig);
    const cacheDirectory = path.join(rig.root, '.cache');
    const deadline = Date.now() + INSTANT_PROMPT_CACHE_DEADLINE_MS;
    const cacheWritten = (): boolean => fs.existsSync(cacheDirectory)
      && fs.readdirSync(cacheDirectory).some((name) => name.startsWith('p10k-instant-prompt-'));
    while (Date.now() < deadline && !cacheWritten()) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    first.kill();
    expect(cacheWritten()).toBe(true);
  }

  it('reaches the agent with a --resume command too long to type', async () => {
    const rig = makeRig(shell, 0);
    writeInstantPromptRc(rig);
    await primeInstantPrompt(rig);
    const args = ['--append-system-prompt', policyOfBytes(OVERSIZED_BYTES), '--resume', RESUME_ID];

    typeLine(shell, rig, launchLine(shell, rig, commandFor(shell, rig, args)), TYPED_AT_MS);
    const report = await waitForReport(rig, STUB_DEADLINE_MS);

    expect(report?.argv).toEqual(args);
    expect(report?.stdoutIsTerminal).toBe(true);
  }, 45_000);
});

describe.skipIf(!controlShell)('the same long line typed whole (the control)', () => {
  const shell = controlShell as ProbeShell;
  const args = ['--append-system-prompt', policyOfBytes(OVERSIZED_BYTES), '--resume', RESUME_ID];

  it('never reaches the agent while the shell is in its startup files', async () => {
    const rig = makeRig(shell, STARTUP_DELAY_MS);
    typeLine(shell, rig, fullLine(shell, commandFor(shell, rig, args)), TYPED_AT_MS);

    const report = await waitForReport(rig, STARTUP_DELAY_MS + CONTROL_SETTLE_MS);

    expect(report).toBeNull();
  }, 30_000);

  it('reaches the agent once the shell has reached its prompt', async () => {
    const rig = makeRig(shell, 0);
    typeLine(shell, rig, fullLine(shell, commandFor(shell, rig, args)), STARTUP_DELAY_MS);

    const report = await waitForReport(rig, STUB_DEADLINE_MS);

    expect(report?.argv).toEqual(args);
  }, 30_000);
});

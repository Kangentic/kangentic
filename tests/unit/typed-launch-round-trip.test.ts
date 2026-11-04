/**
 * A launch through a REAL shell on a real PTY, typed as `performSpawn` types it,
 * reaching a stub agent. Tests here read what the stub received, never the
 * scrollback: the shell's own echo of a command is not the agent getting it.
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
 * rather than skips. Nothing here runs on Windows, whose shells have no such limit.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSpawnClearPrelude, adaptCommandForShell, quoteArg } from '../../src/shared/paths';
import { buildTypedLaunch, TYPED_LINE_BYTE_BUDGET } from '../../src/main/pty/spawn/typed-launch';

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
  return { root, sessionDirectory, agentPath, resultPath };
}

function commandFor(shell: ProbeShell, rig: Rig, args: readonly string[]): string {
  const quote = (value: string): string => quoteArg(value, shell.program, { multiline: true });
  return [rig.agentPath, ...args].map(quote).join(' ');
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
function typeLine(shell: ProbeShell, rig: Rig, line: string, typedAtMs: number): void {
  const pty = startShell(shell, rig);
  setTimeout(() => pty.write(`${line}\r`), typedAtMs);
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

  // A measurement, not a pin: a reporter found no key had any effect after a cut
  // line, and why is not established. It logs and never fails, since the launcher
  // stops the line from being cut either way. Only the jobs that name their shells
  // run it: the unit tier hides the log, so there it would be seven idle seconds.
  it.runIf(requiredShells.length > 0)('measures whether keys still reach the shell after a cut line', async () => {
    const rig = makeRig(shell, STARTUP_DELAY_MS);
    const pty = startShell(shell, rig);
    const keysDuringDelayMs = 700;
    const keysAfterDelayMs = STARTUP_DELAY_MS + 1_500;
    setTimeout(() => pty.write(`${fullLine(shell, commandFor(shell, rig, args))}\r`), TYPED_AT_MS);
    // A key while the shell is still in its startup files: the queue is full.
    setTimeout(() => pty.write('\r'), keysDuringDelayMs);
    // At the prompt: Ctrl+C clears the cut line, then a short line runs the stub.
    // Two writes: an interrupt flushes the tty's input queue, and whatever shared
    // its write would go with it.
    const probeArgs = ['--keys-reached-the-shell'];
    setTimeout(() => pty.write('\x03'), keysAfterDelayMs);
    setTimeout(() => pty.write(`${commandFor(shell, rig, probeArgs)}\r`), keysAfterDelayMs + 700);

    const report = await waitForReport(rig, keysAfterDelayMs + 700 + CONTROL_SETTLE_MS);

    console.log(`[typed-launch measurement] ${process.platform} ${shell.program}: keys after the startup delay ${
      report ? `reached the shell, stub argv ${JSON.stringify(report.argv.slice(0, 1))}` : 'did NOT reach the shell'
    }`);
  }, 30_000);
});

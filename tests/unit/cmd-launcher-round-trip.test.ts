/**
 * A long launch through a real cmd.exe in a real ConPTY, built by the real Claude
 * builder and `buildTypedLaunch`, with `launch.cmd` written as `performSpawn` writes
 * it. Tests read the argv the child received, never the scrollback.
 *
 * cmd refuses a typed line past 8190 characters (Sentry DESKTOP-2D), and a batch
 * file does not read a line the way a prompt does, so these catch what a string pin
 * cannot: percent expansion, the code page a batch file is read in, `call` parsing
 * its line twice, and the parser losing its place in a quote past 8191 characters,
 * where a `&` runs the rest of the prompt as a command. That is why every awkward
 * character here appears at the head of the prompt and again at its tail, and why a
 * test watches for what a command in the tail would have written: a filler of one
 * repeated letter ran 15769 characters clean. node-pty rather than `typeAtCmdPrompt`,
 * which refuses non-ASCII text, and `chcp` needs a real console.
 *
 * "Exact" means what typing the line would have delivered: cmd writes a content `"`
 * as `'`, the trade every Windows prompt quote makes (`escapeForDoubleQuotedShell`).
 *
 * A shim that stayed under PowerShell or Git Bash meets the same limit with no
 * `launch.cmd` at all, so those two cases are here as well.
 *
 * Windows only, in shell-quoting-windows.yml.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';
import { directLaunchOfBatchShim } from '../../src/main/agent/shared/npm-shim-target';
import { classifyLaunchOutput } from '../../src/main/pty/agent-launch-report';
import { buildTypedLaunch, type TypedLaunch } from '../../src/main/pty/spawn/typed-launch';
import { quoteArg } from '../../src/shared/paths';

const CMD = 'cmd.exe';
const DEADLINE_MS = 20_000;
const POLL_MS = 50;
/** The agent head the builder is given, swapped for a real program by `headFor`. */
const AGENT_HEAD = 'C:\\agent\\agent.exe';
/** Where Git for Windows installs by default. A machine with it elsewhere skips those cases. */
const GIT_BASH = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');

/** npm's cmd-shim, as in shell-argv-probe.ts, with the script beside it. */
const NPM_STYLE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\receiver.js" %*',
  '',
].join('\r\n');

const RECEIVER = `const fs = require('node:fs');
fs.writeFileSync(process.env.KANGENTIC_RECEIVER_OUT, JSON.stringify(process.argv.slice(2)), 'utf8');
fs.writeFileSync(\`\${process.env.KANGENTIC_RECEIVER_OUT}.tty\`, JSON.stringify({ stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true }), 'utf8');
`;

const AWKWARD = `Fix %PATH% at 100% with %KNG_PROBE% and %NOTSET% café 日本語 \u{1F389} a&b a|b a<b a>b a^b !bang! ; say "hi" C:\\dir\\%KNG_PROBE%\\x`;
/** What a command in the tail would write, if cmd ever read the tail as a command. */
const INJECTED_FILE = 'injected.txt';
const INJECTION = `& echo pwned> ${INJECTED_FILE} & rem `;
const FILLER = 'filler text '.repeat(760);
const PROMPT = `${AWKWARD} ${FILLER}${AWKWARD} ${INJECTION}<task> </task> END`;

describe.runIf(process.platform === 'win32')('launch.cmd through a real cmd', () => {
  let root: string;
  const shells: IPty[] = [];

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-launcher-'));
    expect(PROMPT.length).toBeGreaterThan(9000);
  });

  afterEach(() => {
    for (const shell of shells.splice(0)) {
      try {
        shell.kill();
      } catch {
        // Already gone.
      }
    }
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  /** A session folder and a receiver, under a folder of this name. */
  function folderNamed(name: string): { directory: string; receiver: string; resultFile: string } {
    const directory = path.join(root, name);
    fs.mkdirSync(directory, { recursive: true });
    const receiver = path.join(directory, 'receiver.js');
    fs.writeFileSync(receiver, RECEIVER);
    return { directory, receiver, resultFile: path.join(directory, 'argv.json') };
  }

  function builtCommand(cliPath: string, { prompt = PROMPT, shell = CMD } = {}): string {
    return new CommandBuilder().buildClaudeCommand({
      cliPath,
      taskId: 'task-1',
      cwd: root,
      permissionMode: 'default',
      sessionId: 'session-1',
      shell,
      prompt,
    });
  }

  /** The builder's command with its head swapped for node and the receiver, an `.exe` head. */
  function exeCommand(receiver: string): string {
    const built = builtCommand(AGENT_HEAD);
    const head = quoteArg(AGENT_HEAD, CMD);
    expect(built.startsWith(`${head} `)).toBe(true);
    // By hand, not `quoteArg`: it collapses a run of spaces, and the folder holds one.
    return `${quoteArg(process.execPath, CMD)} "${receiver.replace(/(\\*)%/g, '$1$1"^%"')}"${built.slice(head.length)}`;
  }

  function launchFor(command: string, directory: string): TypedLaunch {
    return buildTypedLaunch({
      command,
      shell: CMD,
      sessionDirectory: path.join(directory, 'session'),
      platform: 'win32',
      batchShimLaunch: directLaunchOfBatchShim,
    });
  }

  /** Type a launch as `performSpawn` does, 100 ms after cmd starts. Other shells take longer to reach a prompt. */
  function run(
    launch: TypedLaunch,
    resultFile: string,
    { program = CMD, args = [] as string[], typeAfterMs = 100 } = {},
  ): { output: () => string } {
    if (launch.launcher) {
      fs.mkdirSync(path.dirname(launch.launcher.filePath), { recursive: true });
      fs.writeFileSync(launch.launcher.filePath, launch.launcher.contents, { encoding: 'utf8', mode: 0o600 });
    }
    const shell = ptySpawn(program, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: path.dirname(resultFile),
      env: {
        ...process.env,
        KNG_PROBE: 'EXPANDED',
        KANGENTIC_RECEIVER_OUT: resultFile,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });
    shells.push(shell);
    let output = '';
    shell.onData((chunk) => { output += chunk; });
    setTimeout(() => shell.write(`${launch.typedLine}\r`), typeAfterMs);
    return { output: () => output };
  }

  async function waitFor(condition: () => boolean, label: () => string): Promise<void> {
    const deadline = Date.now() + DEADLINE_MS;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label()}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  async function argvReceived(resultFile: string, runOutput: () => string): Promise<string[]> {
    await waitFor(() => fs.existsSync(resultFile), () => `the child, with output: ${JSON.stringify(runOutput().slice(-400))}`);
    return JSON.parse(fs.readFileSync(resultFile, 'utf8')) as string[];
  }

  const delivered = PROMPT.replaceAll('"', "'");

  it.each([
    { label: 'a plain folder', name: 'plain' },
    { label: 'a folder holding a run of spaces', name: 'two  spaces' },
    { label: 'a folder holding %NAME%', name: '%KNG_PROBE%dir' },
    { label: 'a folder holding a caret and an ampersand', name: 'a^b & c' },
    { label: 'a folder holding non-ASCII text', name: 'café' },
  ])('delivers the whole prompt to an .exe from $label', async ({ name }) => {
    const { directory, receiver, resultFile } = folderNamed(`exe-${name}`);
    const launch = launchFor(exeCommand(receiver), directory);
    expect(launch.launcher).not.toBeNull();

    const { output } = run(launch, resultFile);

    expect((await argvReceived(resultFile, output)).at(-1)).toBe(delivered);
    expect(fs.existsSync(path.join(directory, INJECTED_FILE))).toBe(false);
  }, 30_000);

  it('leaves the agent a real console: a TUI needs stdin and stdout on it', async () => {
    const { directory, receiver, resultFile } = folderNamed('console');
    const { output } = run(launchFor(exeCommand(receiver), directory), resultFile);

    await argvReceived(resultFile, output);
    await waitFor(() => fs.existsSync(`${resultFile}.tty`), () => 'the console report');

    expect(JSON.parse(fs.readFileSync(`${resultFile}.tty`, 'utf8'))).toEqual({ stdin: true, stdout: true });
  }, 30_000);

  it('carries a far longer command whole, with an escape across every alignment of the limit', async () => {
    const { directory, receiver, resultFile } = folderNamed('far-longer');
    const longPrompt = `${AWKWARD} ${'^&'.repeat(4400)} ${'filler text '.repeat(1800)}${INJECTION}END`;
    const built = builtCommand(AGENT_HEAD, { prompt: longPrompt });
    const head = quoteArg(AGENT_HEAD, CMD);
    const command = `${quoteArg(process.execPath, CMD)} "${receiver}"${built.slice(head.length)}`;
    const launch = launchFor(command, directory);
    expect(launch.launcher).not.toBeNull();

    const { output } = run(launch, resultFile);

    expect((await argvReceived(resultFile, output)).at(-1)).toBe(longPrompt.replaceAll('"', "'"));
    expect(fs.existsSync(path.join(directory, INJECTED_FILE))).toBe(false);
  }, 30_000);

  it.each([
    { label: 'a plain folder', name: 'plain' },
    { label: 'a folder holding %NAME%', name: '%KNG_PROBE%dir' },
  ])('delivers the whole prompt past an npm .cmd shim from $label', async ({ name }) => {
    const { directory, resultFile } = folderNamed(`shim-${name}`);
    const shimPath = path.join(directory, 'agent.cmd');
    fs.writeFileSync(shimPath, NPM_STYLE_SHIM);
    const launch = launchFor(builtCommand(shimPath), directory);
    expect(launch.launcher?.contents).not.toContain('agent.cmd');

    const { output } = run(launch, resultFile);

    expect((await argvReceived(resultFile, output)).at(-1)).toBe(delivered);
    expect(fs.existsSync(path.join(directory, INJECTED_FILE))).toBe(false);
  }, 30_000);

  it('still types a line cmd can take, and that line reaches the shim', async () => {
    const { directory, resultFile } = folderNamed('short-shim');
    const shimPath = path.join(directory, 'agent.cmd');
    fs.writeFileSync(shimPath, NPM_STYLE_SHIM);
    const launch = launchFor(builtCommand(shimPath, { prompt: `${AWKWARD} ${'filler text '.repeat(500)}END` }), directory);
    expect(launch.launcher).toBeNull();

    const { output } = run(launch, resultFile);

    expect((await argvReceived(resultFile, output)).at(-1)).toContain(' END');
  }, 30_000);

  describe.each([
    { label: 'Windows PowerShell', shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] },
    ...(fs.existsSync(GIT_BASH) ? [{ label: 'Git Bash', shell: GIT_BASH, args: ['--noprofile', '--norc', '-i'] }] : []),
  ])('a shim that stayed under $label', ({ shell, args }) => {
    // ASCII on purpose: this reads the shim's line, and Windows PowerShell drops some
    // characters from a typed line. 8050 is the length that used to run nothing and
    // print nothing, and 9000 the one that used to be refused.
    it.each([8050, 9000])('delivers a prompt of %i characters past it, with a command in the tail', async (length) => {
      const { directory, resultFile } = folderNamed(`stayed-${path.basename(shell)}-${length}`);
      const shimPath = path.join(directory, 'agent.cmd');
      fs.writeFileSync(shimPath, NPM_STYLE_SHIM);
      const tail = `x ${INJECTION}END`;
      const prompt = `${'a'.repeat(length - tail.length)}${tail}`;
      const launch = buildTypedLaunch({
        command: builtCommand(shimPath, { prompt, shell }),
        shell,
        sessionDirectory: path.join(directory, 'session'),
        platform: 'win32',
        batchShimLaunch: directLaunchOfBatchShim,
      });
      expect(launch.typedLine).not.toContain('agent.cmd');

      const { output } = run(launch, resultFile, { program: shell, args, typeAfterMs: 1500 });

      expect((await argvReceived(resultFile, output)).at(-1)).toBe(prompt);
      expect(fs.existsSync(path.join(directory, INJECTED_FILE))).toBe(false);
    }, 30_000);
  });

  it('names a typed line past the limit, and starts nothing', async () => {
    const { directory, receiver, resultFile } = folderNamed('refused');
    const launch = buildTypedLaunch({ command: exeCommand(receiver), shell: CMD, sessionDirectory: null, platform: 'win32', batchShimLaunch: directLaunchOfBatchShim });
    expect(launch.launcher).toBeNull();
    expect(launch.typedLineBytes).toBeGreaterThan(8191);

    const { output } = run(launch, resultFile);
    await waitFor(() => output().includes('too long'), () => 'the refusal');

    expect(classifyLaunchOutput(output())).toBe('line_too_long');
    expect(fs.existsSync(resultFile)).toBe(false);
  }, 30_000);

  it('names a shim it cannot get past, rather than failing with no error', async () => {
    const { directory, resultFile } = folderNamed('unreadable-shim');
    const shimPath = path.join(directory, 'agent.cmd');
    fs.writeFileSync(shimPath, '@echo off\r\nexit /b 1\r\n');
    const launch = launchFor(builtCommand(shimPath), directory);
    expect(launch.launcher).toBeNull();

    const { output } = run(launch, resultFile);
    await waitFor(() => classifyLaunchOutput(output()) === 'line_too_long', () => `the refusal, with output: ${JSON.stringify(output().slice(-400))}`);

    expect(fs.existsSync(resultFile)).toBe(false);
  }, 30_000);
});

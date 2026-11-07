/**
 * What a spawn types into a shell. A line past the kernel's canonical limit loses
 * its tail and its Enter while the shell is still starting, so the agent never
 * starts (TYPED_LINE_BYTE_BUDGET). `typed-launch-round-trip.test.ts` runs these
 * lines through real shells; this file pins the choice per shell and platform,
 * including the ones CI has no shell for.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  buildTypedLaunch,
  CMD_COMMAND_LINE_LIMIT,
  CMD_TYPED_LINE_BYTE_BUDGET,
  commandFitsShell,
  commandLineLimit,
  LINUX_ARGUMENT_BYTE_LIMIT,
  TYPED_LINE_BYTE_BUDGET,
  WINDOWS_COMMAND_LINE_LIMIT,
  type TypedLaunchInput,
} from '../../src/main/pty/spawn/typed-launch';
import { classifyLaunchOutput } from '../../src/main/pty/agent-launch-report';
import { buildSpawnClearPrelude, quoteArg } from '../../src/shared/paths';

const SESSION_DIRECTORY = path.join(path.sep, 'projects', 'demo', '.kangentic', 'sessions', 'session-1');
const CMD_SHELL = 'C:\\Windows\\System32\\cmd.exe';
const NO_SHIM = (): null => null;

/** A command of `bytes` bytes, in single-byte text. */
function commandOfBytes(bytes: number): string {
  return `agent ${'x'.repeat(bytes - 'agent '.length)}`;
}

describe('commandLineLimit', () => {
  const nativeProgram = 'C:\\Users\\dev\\.local\\bin\\claude.exe';
  const shim = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.CMD';

  it('reads the process limit for a native program, and for an npm `.ps1` or sh sibling', () => {
    expect(commandLineLimit({ program: nativeProgram, shell: 'powershell', platform: 'win32' })).toBe(WINDOWS_COMMAND_LINE_LIMIT);
    expect(commandLineLimit({ program: 'C:\\npm\\claude.ps1', shell: 'pwsh', platform: 'win32' })).toBe(WINDOWS_COMMAND_LINE_LIMIT);
    expect(commandLineLimit({ program: 'C:\\npm\\claude', shell: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' })).toBe(WINDOWS_COMMAND_LINE_LIMIT);
  });

  it('reads cmd.exe\'s limit for a batch shim under any shell, and for any program under cmd.exe', () => {
    expect(commandLineLimit({ program: shim, shell: 'powershell', platform: 'win32' })).toBe(CMD_COMMAND_LINE_LIMIT);
    expect(commandLineLimit({ program: shim, shell: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' })).toBe(CMD_COMMAND_LINE_LIMIT);
    expect(commandLineLimit({ program: nativeProgram, shell: 'cmd.exe', platform: 'win32' })).toBe(CMD_COMMAND_LINE_LIMIT);
  });

  it('reads none on POSIX or in a WSL distro, which have no limit in characters', () => {
    expect(commandLineLimit({ program: '/usr/local/bin/claude', shell: '/bin/bash', platform: 'linux' })).toBeNull();
    expect(commandLineLimit({ program: '/usr/local/bin/claude', shell: '/bin/zsh', platform: 'darwin' })).toBeNull();
    expect(commandLineLimit({ program: '/usr/local/bin/claude', shell: 'wsl -d Ubuntu', platform: 'win32' })).toBeNull();
  });
});

describe('commandFitsShell', () => {
  const head = '"C:\\Users\\dev\\.local\\bin\\claude.exe"';
  const commandOf = (length: number): string => `${head} ${'x'.repeat(length - head.length - 1)}`;

  it('fits at the limit, and refuses one past it', () => {
    expect(commandFitsShell({ command: commandOf(WINDOWS_COMMAND_LINE_LIMIT), shell: 'powershell', platform: 'win32' })).toBe(true);
    expect(commandFitsShell({ command: commandOf(WINDOWS_COMMAND_LINE_LIMIT + 1), shell: 'powershell', platform: 'win32' })).toBe(false);
  });

  it('reads the head through its quotes, and past spaces in its path', () => {
    const shimCommand = (length: number, quote: string): string => {
      const quotedHead = `${quote}C:\\Program Files\\npm\\claude.cmd${quote}`;
      return `${quotedHead} ${'x'.repeat(length - quotedHead.length - 1)}`;
    };
    for (const quote of ['"', '\'']) {
      expect(commandFitsShell({ command: shimCommand(CMD_COMMAND_LINE_LIMIT, quote), shell: 'powershell', platform: 'win32' })).toBe(true);
      expect(commandFitsShell({ command: shimCommand(CMD_COMMAND_LINE_LIMIT + 1, quote), shell: 'powershell', platform: 'win32' })).toBe(false);
    }
  });

  it('counts a PowerShell escape once: it is spent before the process starts', () => {
    const escapedNewlines = '`n'.repeat(WINDOWS_COMMAND_LINE_LIMIT / 2);
    const command = `${head} ${escapedNewlines}`;
    expect(command.length).toBeGreaterThan(WINDOWS_COMMAND_LINE_LIMIT);
    expect(commandFitsShell({ command, shell: 'pwsh', platform: 'win32' })).toBe(true);
  });

  it('counts a double quote twice under Git Bash, where it reaches the program as \\"', () => {
    const quotes = '"'.repeat(WINDOWS_COMMAND_LINE_LIMIT / 2 + 1);
    expect(commandFitsShell({ command: `claude ${quotes}`, shell: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' })).toBe(false);
  });

  it('counts a cmd.exe command as written, its `%` escapes included', () => {
    const command = `claude ${'"^%"'.repeat(CMD_COMMAND_LINE_LIMIT / 4 + 1)}`;
    expect(commandFitsShell({ command, shell: 'cmd.exe', platform: 'win32' })).toBe(false);
  });

  it('leaves the terminating NUL out of what a process can take', () => {
    expect(WINDOWS_COMMAND_LINE_LIMIT).toBe(32_766);
  });

  it('reads a batch shim past an apostrophe a POSIX shell quoted', () => {
    const quotedHead = "'C:\\Users\\O'\\''Brien\\npm\\claude.cmd'";
    const command = `${quotedHead} ${'x'.repeat(CMD_COMMAND_LINE_LIMIT)}`;
    expect(commandFitsShell({ command, shell: 'C:\\Program Files\\Git\\bin\\bash.exe', platform: 'win32' })).toBe(false);
  });

  it('holds a Linux launch and a WSL distro to one argument\'s bytes, in multi-byte text', () => {
    const fits = `claude ${'x'.repeat(LINUX_ARGUMENT_BYTE_LIMIT - 'claude '.length)}`;
    const threeByteText = `claude ${'界'.repeat(LINUX_ARGUMENT_BYTE_LIMIT / 3)}`;
    expect(commandFitsShell({ command: fits, shell: '/bin/bash', platform: 'linux' })).toBe(true);
    expect(commandFitsShell({ command: `${fits}x`, shell: '/bin/bash', platform: 'linux' })).toBe(false);
    expect(commandFitsShell({ command: threeByteText, shell: '/bin/bash', platform: 'linux' })).toBe(false);
    expect(commandFitsShell({ command: threeByteText, shell: 'wsl -d Ubuntu', platform: 'win32' })).toBe(false);
  });

  it('never refuses on macOS, which has no limit per argument', () => {
    expect(commandFitsShell({ command: commandOf(LINUX_ARGUMENT_BYTE_LIMIT * 2), shell: '/bin/zsh', platform: 'darwin' })).toBe(true);
  });
});

describe('buildTypedLaunch', () => {
  it('types a command within the budget as it is, with no launcher', () => {
    const launch = buildTypedLaunch({
      command: 'claude --resume abc',
      shell: '/bin/zsh',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.typedLine).toBe('clear; claude --resume abc');
    expect(launch.launcher).toBeNull();
    expect(launch.typedLineBytes).toBe('clear; claude --resume abc\r'.length);
  });

  it('holds the budget at the exact byte, Enter and prelude included', () => {
    const overhead = 'clear; \r'.length;
    const atBudget = buildTypedLaunch({
      command: commandOfBytes(TYPED_LINE_BYTE_BUDGET - overhead),
      shell: '/bin/zsh',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(atBudget.typedLineBytes).toBe(TYPED_LINE_BYTE_BUDGET);
    expect(atBudget.launcher).toBeNull();

    const overBudget = buildTypedLaunch({
      command: commandOfBytes(TYPED_LINE_BYTE_BUDGET - overhead + 1),
      shell: '/bin/zsh',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(overBudget.launcher).not.toBeNull();
    expect(overBudget.typedLineBytes).toBeLessThan(TYPED_LINE_BYTE_BUDGET);
  });

  it('counts bytes, not characters: multi-byte text past the budget in bytes alone moves to a file', () => {
    // 500 characters, 1000 bytes.
    const command = `agent ${'é'.repeat(500)}`;
    expect(command.length).toBeLessThan(TYPED_LINE_BYTE_BUDGET);
    const launch = buildTypedLaunch({
      command,
      shell: '/bin/zsh',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher?.contents).toBe(`${command}\n`);
  });

  it.each([
    { shell: '/bin/zsh', fileName: 'launch.sh', statement: 'clear; eval "$(cat' },
    { shell: '/bin/bash', fileName: 'launch.sh', statement: 'clear; eval "$(cat' },
    { shell: '/bin/dash', fileName: 'launch.sh', statement: 'clear; eval "$(cat' },
    { shell: '/usr/bin/fish', fileName: 'launch.fish', statement: 'clear; source' },
    { shell: '/opt/homebrew/bin/nu', fileName: 'launch.nu', statement: 'clear; source' },
    { shell: '/usr/local/bin/pwsh', fileName: 'launch.ps1', statement: 'Clear-Host; .' },
  ])('runs $fileName from $shell with its own statement', ({ shell, fileName, statement }) => {
    const launch = buildTypedLaunch({
      command: commandOfBytes(2000),
      shell,
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'linux',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher?.filePath).toBe(path.join(SESSION_DIRECTORY, fileName));
    expect(launch.typedLine.startsWith(`${statement} `)).toBe(true);
    expect(launch.typedLine).toContain(fileName);
  });

  it('puts the command in the file adapted for its shell, without the prelude', () => {
    const quotedHead = `"/opt/homebrew/opt/node@22/bin/agent"`;
    const command = `${quotedHead} ${'x'.repeat(2000)}`;
    const launch = buildTypedLaunch({
      command,
      shell: '/opt/homebrew/bin/nu',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher?.contents).toBe(`^${command}\n`);
  });

  it('keeps a run of spaces in the path it sources', () => {
    const directory = path.join(path.sep, 'projects', 'two  spaces', 'session-1');
    const launch = buildTypedLaunch({
      command: commandOfBytes(2000),
      shell: '/bin/zsh',
      sessionDirectory: directory,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.typedLine).toContain('two  spaces');
  });

  it('stays under the budget on every shell family with a long project path', () => {
    const longDirectory = path.join(path.sep, 'p'.repeat(300), '.kangentic', 'sessions', 'd1e2f3a4-0000-4000-8000-000000000000');
    for (const shell of ['/bin/zsh', '/bin/bash', '/usr/bin/fish', '/usr/bin/nu', '/usr/bin/pwsh']) {
      const launch = buildTypedLaunch({
        command: commandOfBytes(5000),
        shell,
        sessionDirectory: longDirectory,
        platform: 'linux',
        batchShimLaunch: NO_SHIM,
      });
      expect(launch.typedLineBytes, shell).toBeLessThan(TYPED_LINE_BYTE_BUDGET);
    }
  });

  it('sources the path the distro sees from a WSL shell, and writes the Windows path', () => {
    const windowsDirectory = 'C:\\Users\\dev\\project\\.kangentic\\sessions\\session-1';
    const launch = buildTypedLaunch({
      command: commandOfBytes(5000),
      shell: 'wsl -d Ubuntu',
      sessionDirectory: windowsDirectory,
      platform: 'win32',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher?.filePath.startsWith('C:')).toBe(true);
    expect(launch.typedLine).toBe('clear; eval "$(cat /mnt/c/Users/dev/project/.kangentic/sessions/session-1/launch.sh)"');
  });

  describe('a WSL shell with a session folder on a Windows share', () => {
    // Backslash paths on purpose: these are Windows UNC names. The code under
    // test reads either slash, so they hold on a POSIX runner too.
    const WSL_FOLDER_SUFFIX = 'home\\dev\\p\\.kangentic\\sessions\\s';

    function launchFor(shell: string, sessionDirectory: string) {
      return buildTypedLaunch({
        command: commandOfBytes(5000),
        shell,
        sessionDirectory,
        platform: 'win32',
        batchShimLaunch: NO_SHIM,
      });
    }

    it('types the whole command when the folder is on a plain network share', () => {
      const launch = launchFor('wsl -d Ubuntu', '\\\\server\\share\\project\\.kangentic\\sessions\\s');
      expect(launch.launcher).toBeNull();
      expect(launch.typedLine).toBe(`clear; ${commandOfBytes(5000)}`);
    });

    it('types the whole command when the folder is another distro\'s', () => {
      const launch = launchFor('wsl -d Ubuntu', `\\\\wsl.localhost\\Debian\\${WSL_FOLDER_SUFFIX}`);
      expect(launch.launcher).toBeNull();
      expect(launch.typedLine).toBe(`clear; ${commandOfBytes(5000)}`);
    });

    it('sources the folder\'s own path in the distro, comparing the distro name without case', () => {
      const launch = launchFor('wsl -d Ubuntu', `\\\\wsl.localhost\\ubuntu\\${WSL_FOLDER_SUFFIX}`);
      expect(launch.launcher).not.toBeNull();
      expect(launch.typedLine).toBe('clear; eval "$(cat /home/dev/p/.kangentic/sessions/s/launch.sh)"');
    });

    it('sources it under a bare wsl, which runs the default distro', () => {
      const launch = launchFor('wsl', `\\\\wsl.localhost\\Ubuntu\\${WSL_FOLDER_SUFFIX}`);
      expect(launch.launcher).not.toBeNull();
      expect(launch.typedLine).toBe('clear; eval "$(cat /home/dev/p/.kangentic/sessions/s/launch.sh)"');
    });

    it('writes a POSIX launcher for a distro whose name contains pwsh, never a PowerShell one', () => {
      const launch = launchFor('wsl -d my-pwsh', `\\\\wsl.localhost\\my-pwsh\\${WSL_FOLDER_SUFFIX}`);
      expect(launch.typedLine).toBe('clear; eval "$(cat /home/dev/p/.kangentic/sessions/s/launch.sh)"');
      expect(launch.launcher?.filePath.endsWith('launch.sh')).toBe(true);
      expect(launch.launcher?.contents).toBe(`${commandOfBytes(5000)}\n`);
      expect(launch.launcher?.contents.startsWith('& ')).toBe(false);
    });
  });

  it.each([
    { label: 'PowerShell', shell: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
    { label: 'cmd', shell: 'C:\\Windows\\System32\\cmd.exe' },
    { label: 'Git Bash', shell: 'C:\\Program Files\\Git\\bin\\bash.exe' },
  ])('types a command past the POSIX budget whole under a native Windows shell: $label', ({ shell }) => {
    const launch = buildTypedLaunch({
      command: commandOfBytes(5000),
      shell,
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'win32',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher).toBeNull();
    expect(launch.typedLine).toContain(commandOfBytes(5000));
  });

  it('types a long command whole when the session has no folder for a launcher', () => {
    const launch = buildTypedLaunch({
      command: commandOfBytes(5000),
      shell: '/bin/zsh',
      sessionDirectory: null,
      platform: 'darwin',
      batchShimLaunch: NO_SHIM,
    });
    expect(launch.launcher).toBeNull();
    expect(launch.typedLine).toBe(`clear; ${commandOfBytes(5000)}`);
  });

  describe('cmd, which refuses a line past 8190 characters', () => {
    function cmdLaunch(command: string, overrides: Partial<TypedLaunchInput> = {}) {
      return buildTypedLaunch({
        command,
        shell: CMD_SHELL,
        sessionDirectory: SESSION_DIRECTORY,
        platform: 'win32',
        batchShimLaunch: NO_SHIM,
        ...overrides,
      });
    }
    /** The lines of a launcher, split as cmd reads them. */
    function launcherLines(launch: ReturnType<typeof cmdLaunch>): string[] {
      return (launch.launcher?.contents ?? '').split('\r\n');
    }

    it('types a line under its budget, so most launches do not change', () => {
      const launch = cmdLaunch(commandOfBytes(CMD_TYPED_LINE_BYTE_BUDGET - 'cls & \r'.length));
      expect(launch.typedLineBytes).toBe(CMD_TYPED_LINE_BYTE_BUDGET);
      expect(launch.launcher).toBeNull();
    });

    it('counts UTF-8 bytes, so multi-byte text well under 8190 characters still moves to launch.cmd', () => {
      // 3600 characters, 7200 bytes: far under cmd's 8190-character limit, past the byte budget.
      const command = `agent ${'é'.repeat(3600)}`;
      expect(`cls & ${command}\r`.length).toBeLessThan(CMD_TYPED_LINE_BYTE_BUDGET);
      expect(Buffer.byteLength(`cls & ${command}\r`, 'utf8')).toBeGreaterThan(CMD_TYPED_LINE_BYTE_BUDGET);
      const launch = cmdLaunch(command);
      expect(launch.launcher?.filePath).toBe(path.join(SESSION_DIRECTORY, 'launch.cmd'));
      expect(launch.typedLine.startsWith('cls & call "')).toBe(true);
    });

    it('moves a line past the budget to launch.cmd and calls it, with the clear first', () => {
      const launch = cmdLaunch(commandOfBytes(CMD_TYPED_LINE_BYTE_BUDGET + 1));
      expect(launch.launcher?.filePath).toBe(path.join(SESSION_DIRECTORY, 'launch.cmd'));
      expect(launch.typedLine.startsWith('cls & call "')).toBe(true);
      expect(launch.typedLineBytes).toBeLessThan(TYPED_LINE_BYTE_BUDGET);
    });

    it('sets the code page first, then runs the command with its echo off', () => {
      const command = commandOfBytes(9000);
      const [program, argument] = command.split(' ');
      expect(launcherLines(cmdLaunch(command))).toEqual(['@chcp 65001 >nul', `@"${program}" ${argument}`, '']);
    });

    it('turns quoteArg\'s typed percent escape into what a batch file reads', () => {
      const prompt = quoteArg(`100% of %PATH% in C:\\dir\\%HOME% ${'x'.repeat(8000)}`, 'cmd.exe');
      expect(prompt).toContain('"^%"');
      const [, line] = launcherLines(cmdLaunch(`agent.exe ${prompt}`));
      expect(line.startsWith('@"agent.exe" ^"100%% of %%PATH%% in C:\\dir\\%%HOME%% ')).toBe(true);
      expect(line).not.toContain('"^%"');
    });

    // Past 8191 characters cmd's parser forgets it is inside a quote, and a `&` runs
    // the rest of the prompt as a command. So nothing here is ever inside one.
    it('never puts cmd inside a quote, whatever the argument holds', () => {
      const prompt = quoteArg(`a&b|c<d>e(f)g^h "i" ${'x'.repeat(8000)} & del /q *`, 'cmd.exe');
      const [, line] = launcherLines(cmdLaunch(`"C:\\tools\\agent.exe" ${prompt}`));
      const argumentsText = line.slice('@"C:\\tools\\agent.exe"'.length);
      expect(argumentsText).toContain('a^&b^|c^<d^>e^(f^)g^^h');
      expect(argumentsText.endsWith(`^& del /q *^"`)).toBe(true);
      // Every quote and metacharacter sits behind a caret: read left to right, an
      // escape takes the character after it, and nothing live is left.
      expect(argumentsText.replace(/\^./g, '')).not.toMatch(/["&|<>()^]/);
    });

    it('doubles a percent the quoting left bare, such as one in a bare word', () => {
      const [, line] = launcherLines(cmdLaunch(`agent.exe 50% ${'x'.repeat(8000)}`));
      expect(line.startsWith('@"agent.exe" 50%% ')).toBe(true);
    });

    it('escapes a content caret, which cmd then removes one of', () => {
      const [, line] = launcherLines(cmdLaunch(`agent.exe "a^b ${'x'.repeat(8000)}"`));
      expect(line).toContain('a^^b');
    });

    it('calls a percent in the folder through the escape a prompt needs', () => {
      const launch = cmdLaunch(commandOfBytes(9000), { sessionDirectory: 'C:\\Users\\dev\\%X%dir' });
      expect(launch.typedLine.startsWith('cls & call "')).toBe(true);
      expect(launch.typedLine).toContain('"^%"');
    });

    it('drops call for a folder holding a caret, whose path call cannot find', () => {
      const launch = cmdLaunch(commandOfBytes(9000), { sessionDirectory: 'C:\\Users\\dev\\a^b' });
      expect(launch.typedLine.startsWith('cls & "')).toBe(true);
    });

    it('keeps a run of spaces in the path it calls', () => {
      const launch = cmdLaunch(commandOfBytes(9000), { sessionDirectory: 'C:\\Users\\dev\\two  spaces' });
      expect(launch.typedLine).toContain('two  spaces');
    });

    it('types the whole line with no folder for a launcher, and cmd names the refusal', () => {
      const command = commandOfBytes(9000);
      const launch = cmdLaunch(command, { sessionDirectory: null });
      expect(launch.launcher).toBeNull();
      expect(launch.typedLine).toBe(`cls & ${command}`);
    });

    describe('with a .cmd shim at the head', () => {
      const shim = 'C:\\tools\\npm\\claude.cmd';
      const tail = `--session-id abc "${'x'.repeat(8000)}"`;
      const escapedTail = `--session-id abc ^"${'x'.repeat(8000)}^"`;
      const command = `"${shim}" ${tail}`;

      it('runs what the shim would start, never the shim', () => {
        const launch = cmdLaunch(command, {
          batchShimLaunch: () => ({ program: 'C:\\tools\\npm\\node.exe', script: 'C:\\tools\\npm\\cli.js' }),
        });
        expect(launcherLines(launch)[1]).toBe(`@"C:\\tools\\npm\\node.exe" "C:\\tools\\npm\\cli.js" ${escapedTail}`);
        expect(launch.launcher?.contents).not.toContain('claude.cmd');
      });

      it('runs a binary target alone', () => {
        const launch = cmdLaunch(command, {
          batchShimLaunch: () => ({ program: 'C:\\tools\\claude.exe', script: null }),
        });
        expect(launcherLines(launch)[1]).toBe(`@"C:\\tools\\claude.exe" ${escapedTail}`);
      });

      it('takes .JS off PATHEXT for a bare node, as the shim does', () => {
        const launch = cmdLaunch(command, {
          batchShimLaunch: () => ({ program: 'node', script: 'C:\\tools\\npm\\cli.js' }),
        });
        expect(launcherLines(launch)[1]).toBe('@set "PATHEXT=%PATHEXT:;.JS;=;%"');
        expect(launcherLines(launch)[2].startsWith('@"node" ')).toBe(true);
      });

      it('finds a shim whose folder holds a percent, and doubles it in what it starts', () => {
        const percentHead = `"C:\\tools\\"^%"X"^%"\\claude.cmd"`;
        const seen: string[] = [];
        const launch = cmdLaunch(`${percentHead} ${tail}`, {
          batchShimLaunch: (shimPath) => {
            seen.push(shimPath);
            return { program: 'C:\\tools\\%X%\\claude.exe', script: null };
          },
        });
        expect(seen).toEqual(['C:\\tools\\%X%\\claude.cmd']);
        expect(launcherLines(launch)[1].startsWith('@"C:\\tools\\%%X%%\\claude.exe" ')).toBe(true);
      });

      it('names a shim it cannot get past, and writes nothing', () => {
        const launch = cmdLaunch(command);
        expect(launch.launcher).toBeNull();
        expect(launch.typedLine).toBe('cls & echo The command line is too long.');
      });

      it('types a line under the budget through the shim as before', () => {
        const short = `"${shim}" --resume abc`;
        const launch = cmdLaunch(short);
        expect(launch.typedLine).toBe(`cls & ${short}`);
      });

      it('echoes a sentence the launch report classifies as a line too long', () => {
        const launch = cmdLaunch(command);
        const sentence = launch.typedLine.slice(`${buildSpawnClearPrelude(CMD_SHELL.toLowerCase())}echo `.length);
        expect(classifyLaunchOutput(`${sentence}\r\n`)).toBe('line_too_long');
      });
    });

    describe('a shim that stayed under PowerShell or Git Bash, whose %* line has cmd\'s limit', () => {
      const POWERSHELL = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
      const shim = 'C:\\tools\\npm\\claude.cmd';
      const direct = () => ({ program: 'C:\\tools\\npm\\node.exe', script: 'C:\\tools\\npm\\cli.js' });
      const longArguments = `--session-id abc -- ${'x'.repeat(CMD_TYPED_LINE_BYTE_BUDGET)}`;

      it('starts what the shim would have under PowerShell, with no launcher', () => {
        const launch = cmdLaunch(`"${shim}" ${longArguments}`, { shell: POWERSHELL, batchShimLaunch: direct });
        expect(launch.launcher).toBeNull();
        expect(launch.typedLine).toBe(`Clear-Host; & "C:\\tools\\npm\\node.exe" "C:\\tools\\npm\\cli.js" ${longArguments}`);
      });

      it('starts it under Git Bash, with the program as bash reads it and the script as node does', () => {
        const launch = cmdLaunch(`'${shim}' ${longArguments}`, { shell: GIT_BASH, batchShimLaunch: direct });
        expect(launch.typedLine).toBe(`clear; '/c/tools/npm/node.exe' 'C:\\tools\\npm\\cli.js' ${longArguments}`);
      });

      it('starts a bare node and a binary target', () => {
        const bareNode = cmdLaunch(`"${shim}" ${longArguments}`, {
          shell: POWERSHELL,
          batchShimLaunch: () => ({ program: 'node', script: 'C:\\tools\\npm\\cli.js' }),
        });
        expect(bareNode.typedLine.startsWith('Clear-Host; & node "C:\\tools\\npm\\cli.js" ')).toBe(true);
        const binary = cmdLaunch(`"${shim}" ${longArguments}`, {
          shell: POWERSHELL,
          batchShimLaunch: () => ({ program: 'C:\\tools\\claude.exe', script: null }),
        });
        expect(binary.typedLine.startsWith('Clear-Host; & "C:\\tools\\claude.exe" --session-id ')).toBe(true);
      });

      it('names a shim it cannot get past, as a line each shell prints as one sentence', () => {
        expect(cmdLaunch(`"${shim}" ${longArguments}`, { shell: POWERSHELL }).typedLine)
          .toBe('Clear-Host; echo "The command line is too long."');
        expect(cmdLaunch(`'${shim}' ${longArguments}`, { shell: GIT_BASH }).typedLine)
          .toBe("clear; echo 'The command line is too long.'");
      });

      it('echoes a sentence the launch report classifies as a line too long, once the shell\'s quotes are off', () => {
        const launch = cmdLaunch(`"${shim}" ${longArguments}`, { shell: POWERSHELL });
        const prelude = buildSpawnClearPrelude(POWERSHELL.toLowerCase());
        expect(launch.typedLine.startsWith(`${prelude}echo `)).toBe(true);
        const sentence = launch.typedLine.slice(`${prelude}echo `.length).replace(/^"|"$/g, '');
        expect(classifyLaunchOutput(`${sentence}\r\n`)).toBe('line_too_long');
      });

      it('starts what the shim would have with no folder for a launcher, since PowerShell needs none', () => {
        const launch = cmdLaunch(`"${shim}" ${longArguments}`, { shell: POWERSHELL, batchShimLaunch: direct, sessionDirectory: null });
        expect(launch.launcher).toBeNull();
        expect(launch.typedLine).toBe(`Clear-Host; & "C:\\tools\\npm\\node.exe" "C:\\tools\\npm\\cli.js" ${longArguments}`);
      });

      it('does the same under Git Bash with no folder for a launcher', () => {
        const launch = cmdLaunch(`'${shim}' ${longArguments}`, { shell: GIT_BASH, batchShimLaunch: direct, sessionDirectory: null });
        expect(launch.launcher).toBeNull();
        expect(launch.typedLine).toBe(`clear; '/c/tools/npm/node.exe' 'C:\\tools\\npm\\cli.js' ${longArguments}`);
      });

      it('types a line under the budget through the shim as before', () => {
        const short = `"${shim}" --resume abc`;
        expect(cmdLaunch(short, { shell: POWERSHELL, batchShimLaunch: direct }).typedLine).toBe(`Clear-Host; & ${short}`);
      });

      it('leaves a WSL shell alone, which cannot start a .cmd at all', () => {
        const launch = cmdLaunch(`'${shim}' ${longArguments}`, { shell: 'wsl -d Ubuntu', batchShimLaunch: direct });
        expect(launch.launcher?.filePath.endsWith('launch.sh')).toBe(true);
      });
    });

    it('leaves PowerShell and Git Bash on Windows typed at any length', () => {
      for (const shell of ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
        const launch = cmdLaunch(commandOfBytes(15_000), { shell });
        expect(launch.launcher, shell).toBeNull();
        expect(launch.typedLine, shell).toContain(commandOfBytes(15_000));
      }
    });
  });
});

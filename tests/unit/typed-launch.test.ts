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
  commandFitsShell,
  commandLineLimit,
  LINUX_ARGUMENT_BYTE_LIMIT,
  TYPED_LINE_BYTE_BUDGET,
  WINDOWS_COMMAND_LINE_LIMIT,
} from '../../src/main/pty/spawn/typed-launch';

const SESSION_DIRECTORY = path.join(path.sep, 'projects', 'demo', '.kangentic', 'sessions', 'session-1');

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
    });
    expect(atBudget.typedLineBytes).toBe(TYPED_LINE_BYTE_BUDGET);
    expect(atBudget.launcher).toBeNull();

    const overBudget = buildTypedLaunch({
      command: commandOfBytes(TYPED_LINE_BYTE_BUDGET - overhead + 1),
      shell: '/bin/zsh',
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'darwin',
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
  ])('types a long command whole under a native Windows shell: $label', ({ shell }) => {
    const launch = buildTypedLaunch({
      command: commandOfBytes(5000),
      shell,
      sessionDirectory: SESSION_DIRECTORY,
      platform: 'win32',
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
    });
    expect(launch.launcher).toBeNull();
    expect(launch.typedLine).toBe(`clear; ${commandOfBytes(5000)}`);
  });
});

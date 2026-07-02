import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import {
  resolveShellArgs,
  buildSpawnEnv,
  resolveSpawnCwd,
  diagnoseSpawnFailure,
} from '../../src/main/pty/spawn/pty-spawn';

describe('resolveShellArgs', () => {
  it('splits WSL specs into exe + args', () => {
    expect(resolveShellArgs('wsl -d Ubuntu')).toEqual({ exe: 'wsl', args: ['-d', 'Ubuntu'] });
  });

  it('returns cmd with no args', () => {
    expect(resolveShellArgs('cmd.exe')).toEqual({ exe: 'cmd.exe', args: [] });
  });

  it('passes -NoLogo to powershell/pwsh', () => {
    expect(resolveShellArgs('powershell')).toEqual({ exe: 'powershell', args: ['-NoLogo'] });
    expect(resolveShellArgs('pwsh')).toEqual({ exe: 'pwsh', args: ['-NoLogo'] });
  });

  it('passes nothing to fish and nushell', () => {
    expect(resolveShellArgs('/usr/bin/fish')).toEqual({ exe: '/usr/bin/fish', args: [] });
    expect(resolveShellArgs('/usr/bin/nu')).toEqual({ exe: '/usr/bin/nu', args: [] });
  });

  it('defaults to --login for bash/zsh', () => {
    expect(resolveShellArgs('/bin/bash')).toEqual({ exe: '/bin/bash', args: ['--login'] });
    expect(resolveShellArgs('/bin/zsh')).toEqual({ exe: '/bin/zsh', args: ['--login'] });
  });

  it('is case-insensitive', () => {
    expect(resolveShellArgs('CMD.EXE')).toEqual({ exe: 'CMD.EXE', args: [] });
    expect(resolveShellArgs('PowerShell')).toEqual({ exe: 'PowerShell', args: ['-NoLogo'] });
  });
});

describe('buildSpawnEnv', () => {
  it('strips CLAUDECODE so a spawned Claude CLI does not abort', () => {
    const env = buildSpawnEnv({ CLAUDECODE: '1', OTHER: 'kept' });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.OTHER).toBe('kept');
  });

  it('strips every parent Claude session identity marker (CLAUDE_CODE_*)', () => {
    // Leaked from a parent Claude session, these make the spawned child attach
    // to the parent's identity and never persist its own --session-id
    // transcript, so a later --resume reports "No conversation found".
    const env = buildSpawnEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'parent-session-uuid',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_EXECPATH: 'C:/Users/dev/.local/bin/claude.exe',
      OTHER: 'kept',
    });
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
    expect(env.OTHER).toBe('kept');
  });

  it('preserves ANTHROPIC_* auth keys (BYOK / API auth must pass through)', () => {
    const env = buildSpawnEnv({ ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_SESSION_ID: 'parent' });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-test');
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  it('inherits process.env but lets input override', () => {
    const original = process.env.PATH;
    const env = buildSpawnEnv({ PATH: '/custom' });
    expect(env.PATH).toBe('/custom');
    expect(original).toBe(process.env.PATH); // process.env untouched
  });

  it('handles undefined input', () => {
    const env = buildSpawnEnv(undefined);
    expect(env.CLAUDECODE).toBeUndefined();
  });
});

describe('resolveSpawnCwd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the cwd unchanged when it exists', () => {
    const existing = os.homedir();
    const result = resolveSpawnCwd({
      requestedCwd: existing,
      shellName: '/bin/bash',
      platform: 'linux',
    });
    expect(result.effectiveCwd).toBe(existing);
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('falls back to home when cwd does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const result = resolveSpawnCwd({
      requestedCwd: '/does/not/exist',
      shellName: '/bin/bash',
      platform: 'linux',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
  });

  it('emits a pushd fixup for UNC paths under cmd.exe on Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBe('pushd "\\\\server\\share\\project"');
  });

  it('does NOT emit a pushd fixup for UNC paths under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\project');
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a pushd fixup on non-Windows platforms', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'linux',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  // Windows PowerShell 5.1 treats `[` / `]` in its startup path as wildcards
  // and falls back to $PSHOME, so the agent CLI runs in the wrong folder. The
  // Win32 cwd is still valid, so effectiveCwd is left unchanged and a
  // Set-Location -LiteralPath fixup corrects the provider location.
  it('emits a Set-Location fixup for bracketed paths under powershell on Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('C:\\Users\\dev\\[foo]\\bar');
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('emits the Set-Location fixup for pwsh too (family-wide)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'pwsh',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('matches a full PowerShell 7 exe path (powershell substring in the folder name)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[foo]\\bar'");
  });

  it('doubles single quotes inside a bracketed path for the fixup', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: "C:\\Users\\dev\\[o'brien]\\bar",
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath 'C:\\Users\\dev\\[o''brien]\\bar'");
  });

  it('emits the Set-Location fixup for a bracketed UNC path under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\[x]',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\[x]');
    expect(result.cwdFixupCommand).toBe("Set-Location -LiteralPath '\\\\server\\share\\[x]'");
  });

  it('does NOT emit a fixup for a nonexistent bracketed cwd (falls back to home)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    // Mock homedir to a bracket-free placeholder so the assertion is hermetic
    // and does not depend on the host's real home directory.
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\dev');
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under cmd.exe (cmd is bracket-safe)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  // A bracketed UNC path under cmd.exe must still take the UNC pushd branch
  // (which precedes the PowerShell bracket branch), not the Set-Location one:
  // cmd cannot use a UNC cwd, and cmd handles brackets fine. This pins the
  // branch precedence so a future reorder can't silently emit Set-Location.
  it('emits the pushd fixup (not Set-Location) for a bracketed UNC path under cmd.exe', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\[x]',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.cwdFixupCommand).toBe('pushd "\\\\server\\share\\[x]"');
  });

  // The cmd branch matches on the basename (via isCmdShell), NOT a raw
  // substring: a shell whose PATH merely contains "cmd" (e.g. Cmder's
  // cmder.exe) must not be misclassified as cmd.exe and have its cwd
  // force-replaced with home plus a spurious pushd written into the PTY.
  it('does NOT emit a pushd fixup for a non-cmd shell whose path contains "cmd" (e.g. cmder)', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'C:\\tools\\cmder\\cmder.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\project');
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under bash', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: '/bin/bash',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for bracketed paths under WSL', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\[foo]\\bar',
      shellName: 'wsl -d Ubuntu',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a fixup for a plain (bracket-free) path under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: 'C:\\Users\\dev\\project',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });

  it('does NOT emit a Set-Location fixup for bracketed paths on non-Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '/home/dev/[foo]/bar',
      shellName: 'pwsh',
      platform: 'linux',
    });
    expect(result.cwdFixupCommand).toBeNull();
  });
});

describe('diagnoseSpawnFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a posix_spawnp-specific scrollback message with dev-mode chmod instructions', () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).includes('/bin/bash'));
    const result = diagnoseSpawnFailure({
      err: new Error('posix_spawnp failed: EACCES'),
      shellExe: '/bin/bash',
      effectiveCwd: '/home/user/project',
      originalCwd: '/home/user/project',
    });
    expect(result.errorMessage).toContain('posix_spawnp');
    expect(result.scrollbackSuffix).toContain('spawn-helper');
    expect(result.scrollbackSuffix).toContain('chmod +x');
    expect(result.shellExists).toBe(true);
    expect(result.cwdExists).toBe(false);
  });

  it('points packaged-app users at reinstall rather than chmod', () => {
    const result = diagnoseSpawnFailure({
      err: new Error('posix_spawnp failed'),
      shellExe: '/Applications/Kangentic.app/Contents/Resources/app.asar/node_modules/node-pty/bin/sh',
      effectiveCwd: '/Users/dev/project',
      originalCwd: '/Users/dev/project',
    });
    expect(result.scrollbackSuffix).toContain('Reinstalling');
    expect(result.scrollbackSuffix).not.toContain('chmod');
  });

  it('emits an empty scrollback suffix for unrelated errors', () => {
    const result = diagnoseSpawnFailure({
      err: new Error('ENOENT: no such file'),
      shellExe: '/missing/shell',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.scrollbackSuffix).toBe('');
  });

  it('carries the errno code through', () => {
    const err: NodeJS.ErrnoException = new Error('EACCES');
    err.code = 'EACCES';
    err.errno = -13;
    const result = diagnoseSpawnFailure({
      err,
      shellExe: '/bin/bash',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.errno).toBe('EACCES');
  });

  it('handles non-Error throwables', () => {
    const result = diagnoseSpawnFailure({
      err: 'weird string error',
      shellExe: '/bin/bash',
      effectiveCwd: '/tmp',
      originalCwd: '/tmp',
    });
    expect(result.errorMessage).toBe('weird string error');
  });
});

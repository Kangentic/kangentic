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
    expect(result.uncPushdPrefix).toBeNull();
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

  it('emits a pushd prefix for UNC paths under cmd.exe on Windows', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe(os.homedir());
    expect(result.uncPushdPrefix).toBe('pushd "\\\\server\\share\\project"');
  });

  it('does NOT emit a pushd prefix for UNC paths under PowerShell', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'powershell',
      platform: 'win32',
    });
    expect(result.effectiveCwd).toBe('\\\\server\\share\\project');
    expect(result.uncPushdPrefix).toBeNull();
  });

  it('does NOT emit a pushd prefix on non-Windows platforms', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const result = resolveSpawnCwd({
      requestedCwd: '\\\\server\\share\\project',
      shellName: 'cmd.exe',
      platform: 'linux',
    });
    expect(result.uncPushdPrefix).toBeNull();
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

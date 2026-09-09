import { describe, it, expect } from 'vitest';
import { buildCommand, envPrefix, parseEnvArgs } from '../../scripts/worktree-preview.js';

/**
 * `worktree-preview.js --env KEY=VALUE` splices a variable into the terminal
 * command it launches, because the terminal tab the launcher opens inherits
 * the terminal HOST's environment, not the launcher's. A quoting bug here is
 * silent (the preview launches, the variable is simply wrong or missing), so
 * the shell forms are pinned mechanically.
 */

const WORKTREE = 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\1';

describe('parseEnvArgs', () => {
  it('collects both spellings, in order, and keeps an = inside the value', () => {
    expect(parseEnvArgs(['node', 'x', '--env', 'A=1', '--env=B=two words', '--env', 'C=a=b'])).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: 'a=b' },
    ]);
  });

  it('returns an empty list when the flag is absent', () => {
    expect(parseEnvArgs(['node', 'x', '--fresh'])).toEqual([]);
  });

  it('rejects a missing assignment, an invalid key, and characters that would break the quoting', () => {
    expect(() => parseEnvArgs(['--env'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', 'NOVALUE'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', '=1'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', 'BAD-KEY=1'])).toThrow(/not a valid environment variable name/);
    expect(() => parseEnvArgs(['--env', 'A="quoted"'])).toThrow(/may not contain/);
    expect(() => parseEnvArgs(['--env', 'A=x&&calc'])).toThrow(/may not contain/);
    expect(() => parseEnvArgs(['--env', 'A=%PATH%'])).toThrow(/may not contain/);
  });
});

describe('envPrefix', () => {
  const env = [
    { key: 'KANGENTIC_TELEMETRY', value: '1' },
    { key: 'SPACED', value: 'two words' },
  ];

  it('uses the quoted set form for cmd.exe', () => {
    expect(envPrefix(env, 'win32')).toBe('set "KANGENTIC_TELEMETRY=1"&& set "SPACED=two words"&& ');
  });

  it('uses single-quoted assignments for the POSIX shells', () => {
    expect(envPrefix(env, 'darwin')).toBe("KANGENTIC_TELEMETRY='1' SPACED='two words' ");
    expect(envPrefix(env, 'linux')).toBe("KANGENTIC_TELEMETRY='1' SPACED='two words' ");
  });

  it('is empty with no variables', () => {
    expect(envPrefix([], 'win32')).toBe('');
  });
});

describe('buildCommand', () => {
  it('prefixes the dev server command with the variables and keeps the flags', () => {
    const command = buildCommand(WORKTREE, 5188, {
      env: [{ key: 'KANGENTIC_TELEMETRY', value: '1' }],
      platform: 'win32',
    });
    expect(command.startsWith('set "KANGENTIC_TELEMETRY=1"&& node "')).toBe(true);
    expect(command.endsWith('--port=5188 --ephemeral')).toBe(true);
    expect(command).toContain('dev.js');
  });

  it('is unchanged without --env', () => {
    const command = buildCommand(WORKTREE, 5174, { fresh: true, platform: 'win32' });
    expect(command.startsWith('node "')).toBe(true);
    expect(command.endsWith('--port=5174 --ephemeral --fresh')).toBe(true);
  });
});

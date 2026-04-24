/**
 * Unit tests for restoreShellEnv - verifies PATH merging semantics,
 * platform gating, delimiter parsing, and error handling. Covers the
 * macOS GUI launch bug where Finder/Spotlight hand Electron a minimal
 * PATH from launchd instead of the user's full shell PATH.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  mergePathSegments,
  parsePathFromEnvDump,
  restoreShellEnv,
} from '../../src/main/shell-env';

type ExecFileCallback = (
  err: Error | null,
  result?: { stdout: string; stderr: string },
) => void;

// Helper: force execFile (which restoreShellEnv wraps in promisify)
// to resolve with the given stdout.
function mockExecFileStdout(stdout: string): void {
  vi.mocked(execFile).mockImplementation(
    // @ts-expect-error - promisify forwards (file, args, options, callback)
    (_file: string, _args: string[], _opts: object, callback: ExecFileCallback) => {
      callback(null, { stdout, stderr: '' });
    },
  );
}

function mockExecFileFailure(error: Error): void {
  vi.mocked(execFile).mockImplementation(
    // @ts-expect-error - promisify forwards (file, args, options, callback)
    (_file: string, _args: string[], _opts: object, callback: ExecFileCallback) => {
      callback(error);
    },
  );
}

const START = '___KANGENTIC_ENV_BEGIN___';
const END = '___KANGENTIC_ENV_END___';

function buildEnvDump(pathValue: string, extras: Record<string, string> = {}): string {
  const lines = [`PATH=${pathValue}`];
  for (const [key, value] of Object.entries(extras)) {
    lines.push(`${key}=${value}`);
  }
  return START + lines.join('\n') + END;
}

describe('mergePathSegments', () => {
  it('preserves existing order and appends unique new segments', () => {
    const result = mergePathSegments('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin');
    expect(result).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('drops empty segments from either side', () => {
    const result = mergePathSegments('/usr/bin::/bin', ':/opt/homebrew/bin:');
    expect(result).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('returns empty string when both sides are empty', () => {
    expect(mergePathSegments('', '')).toBe('');
  });

  it('returns existing unchanged when shellPath is empty', () => {
    expect(mergePathSegments('/usr/bin:/bin', '')).toBe('/usr/bin:/bin');
  });

  it('returns shellPath when existing is empty', () => {
    expect(mergePathSegments('', '/opt/homebrew/bin')).toBe('/opt/homebrew/bin');
  });

  it('dedupes segments that already appear in existing', () => {
    const result = mergePathSegments('/usr/bin:/bin', '/usr/bin:/opt/homebrew/bin:/bin');
    expect(result).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });
});

describe('parsePathFromEnvDump', () => {
  it('extracts PATH from an env block between delimiters', () => {
    const dump = buildEnvDump('/opt/homebrew/bin:/usr/bin', { HOME: '/Users/dev', SHELL: '/bin/zsh' });
    expect(parsePathFromEnvDump(dump)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('strips oh-my-zsh banner noise before the start marker', () => {
    const dump = `Oh My Zsh autoupdate disabled
Welcome to zsh\n` + buildEnvDump('/opt/homebrew/bin:/usr/bin');
    expect(parsePathFromEnvDump(dump)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('ignores trailing rc noise after the end marker', () => {
    const dump = buildEnvDump('/opt/homebrew/bin:/usr/bin') + '\nSome trailing noise\n';
    expect(parsePathFromEnvDump(dump)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('returns empty string when markers are found but no PATH= line present', () => {
    const dump = START + 'HOME=/Users/dev\nSHELL=/bin/zsh' + END;
    expect(parsePathFromEnvDump(dump)).toBe('');
  });

  it('returns null when start marker missing (shell failed to run probe)', () => {
    expect(parsePathFromEnvDump('PATH=/usr/bin' + END)).toBeNull();
  });

  it('returns null when end marker missing (shell stdout truncated)', () => {
    expect(parsePathFromEnvDump(START + 'PATH=/usr/bin')).toBeNull();
  });

  it('returns null on completely empty stdout', () => {
    expect(parsePathFromEnvDump('')).toBeNull();
  });

  it('handles multiple env entries with PATH in the middle', () => {
    const dump = START + 'LANG=en_US.UTF-8\nPATH=/opt/homebrew/bin:/usr/bin\nUSER=dev' + END;
    expect(parsePathFromEnvDump(dump)).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('trims trailing whitespace from PATH value', () => {
    const dump = START + 'PATH=/opt/homebrew/bin:/usr/bin  \nHOME=/x' + END;
    expect(parsePathFromEnvDump(dump)).toBe('/opt/homebrew/bin:/usr/bin');
  });
});

describe('restoreShellEnv', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  const originalShell = process.env.SHELL;
  const originalOptOut = process.env.KANGENTIC_SHELL_ENV;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PATH = '/usr/bin:/bin';
    process.env.SHELL = '/bin/zsh';
    delete process.env.KANGENTIC_SHELL_ENV;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalOptOut === undefined) delete process.env.KANGENTIC_SHELL_ENV;
    else process.env.KANGENTIC_SHELL_ENV = originalOptOut;
  });

  it('no-op on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.PATH = 'C:\\Windows\\system32';

    await restoreShellEnv();

    expect(execFile).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe('C:\\Windows\\system32');
  });

  it('no-op when KANGENTIC_SHELL_ENV=off', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.KANGENTIC_SHELL_ENV = 'off';

    await restoreShellEnv();

    expect(execFile).not.toHaveBeenCalled();
    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('merges shell PATH into process.env.PATH on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecFileStdout(
      buildEnvDump('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/Users/dev/.claude/local'),
    );

    await restoreShellEnv();

    expect(process.env.PATH).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:/Users/dev/.claude/local',
    );
  });

  it('merges shell PATH on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExecFileStdout(buildEnvDump('/home/dev/.local/bin:/usr/bin:/bin'));

    await restoreShellEnv();

    expect(process.env.PATH).toBe('/usr/bin:/bin:/home/dev/.local/bin');
  });

  it('tolerates oh-my-zsh banner output around the env dump', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const noisy = 'p10k instant prompt loaded\n' + buildEnvDump('/opt/homebrew/bin') + '\ngoodbye\n';
    mockExecFileStdout(noisy);

    await restoreShellEnv();

    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('leaves PATH unchanged when shell returns env dump with no PATH', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecFileStdout(START + 'HOME=/Users/dev' + END);

    await restoreShellEnv();

    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('leaves PATH unchanged when shell stdout has no markers (rc error before probe)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecFileStdout('zsh: command not found: some-alias\n');

    await restoreShellEnv();

    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('leaves PATH unchanged on shell failure (timeout, rc error, etc.)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecFileFailure(new Error('ETIMEDOUT'));

    await restoreShellEnv();

    expect(process.env.PATH).toBe('/usr/bin:/bin');
  });

  it('uses /bin/zsh when $SHELL is unset on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    delete process.env.SHELL;
    mockExecFileStdout(buildEnvDump('/opt/homebrew/bin'));

    await restoreShellEnv();

    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('/bin/zsh');
    expect(process.env.PATH).toBe('/usr/bin:/bin:/opt/homebrew/bin');
  });

  it('uses /bin/bash when $SHELL is unset on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.SHELL;
    mockExecFileStdout(buildEnvDump('/usr/local/bin'));

    await restoreShellEnv();

    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('/bin/bash');
  });

  it('invokes shell with -ilc and passes DISABLE_AUTO_UPDATE + TERM=dumb', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mockExecFileStdout(buildEnvDump('/opt/homebrew/bin'));

    await restoreShellEnv();

    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('/bin/zsh');
    expect(call[1]?.[0]).toBe('-ilc');
    expect(call[1]?.[1]).toContain('/usr/bin/env');
    expect(call[1]?.[1]).toContain('___KANGENTIC_ENV_BEGIN___');
    expect(call[1]?.[1]).toContain('___KANGENTIC_ENV_END___');

    const opts = call[2] as { env: Record<string, string>; timeout: number };
    expect(opts.env.DISABLE_AUTO_UPDATE).toBe('true');
    expect(opts.env.TERM).toBe('dumb');
    expect(opts.timeout).toBeGreaterThanOrEqual(10_000);
  });

  it('works when user shell is fish (env output is identical regardless of shell)', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    process.env.SHELL = '/opt/homebrew/bin/fish';
    // fish produces env output in the same KEY=VALUE format because we
    // invoke /usr/bin/env, not a shell builtin.
    mockExecFileStdout(buildEnvDump('/Users/dev/.cargo/bin:/opt/homebrew/bin:/usr/bin'));

    await restoreShellEnv();

    const call = vi.mocked(execFile).mock.calls[0];
    expect(call[0]).toBe('/opt/homebrew/bin/fish');
    expect(process.env.PATH).toBe('/usr/bin:/bin:/Users/dev/.cargo/bin:/opt/homebrew/bin');
  });
});

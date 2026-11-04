/**
 * The real execVersion, with only the off-main exec wrappers doubled. A
 * `launch` must start that program directly on every platform and never go
 * through cmd (Warp's oz.cmd runs a GUI-subsystem exe whose output cmd loses).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const execMocks = vi.hoisted(() => ({
  execAsync: vi.fn(),
  execFileAsync: vi.fn(),
}));

vi.mock('../../src/main/utility-process/off-main-exec', () => execMocks);

import { execVersion } from '../../src/main/agent/shared/exec-version';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  execMocks.execAsync.mockReset();
  execMocks.execFileAsync.mockReset();
  execMocks.execAsync.mockResolvedValue({ stdout: '', stderr: '' });
  execMocks.execFileAsync.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('execVersion with a launch', () => {
  for (const platform of ['win32', 'linux'] as const) {
    it(`starts the launch file directly on ${platform} and never uses a shell`, async () => {
      setPlatform(platform);

      await execVersion('C:\\Tools\\oz.cmd', 7000, ['dump-debug-info'], {
        file: 'C:\\Tools\\cli.exe',
        env: { SOME_MODE: '1' },
      });

      expect(execMocks.execAsync).not.toHaveBeenCalled();
      expect(execMocks.execFileAsync).toHaveBeenCalledTimes(1);
      const [file, args, options] = execMocks.execFileAsync.mock.calls[0];
      expect(file).toBe('C:\\Tools\\cli.exe');
      expect(args).toEqual(['dump-debug-info']);
      expect(options.timeout).toBe(7000);
      expect(options.windowsHide).toBe(true);
      expect(options.env.SOME_MODE).toBe('1');
      expect(options.env.CHROME_CRASHPAD_PIPE_NAME).toBeUndefined();
    });
  }

  it('defaults the args to --version when none are given', async () => {
    await execVersion('C:\\Tools\\oz.cmd', undefined, undefined, { file: 'C:\\Tools\\cli.exe' });

    expect(execMocks.execFileAsync.mock.calls[0][1]).toEqual(['--version']);
    expect(execMocks.execFileAsync.mock.calls[0][2].timeout).toBe(5000);
  });
});

describe('execVersion without a launch', () => {
  it('goes through execAsync with a quoted head on win32 when launch is null', async () => {
    setPlatform('win32');

    await execVersion('C:\\Program Files\\Tool\\tool.cmd', 5000, ['--version'], null);

    expect(execMocks.execFileAsync).not.toHaveBeenCalled();
    expect(execMocks.execAsync).toHaveBeenCalledTimes(1);
    const [command, options] = execMocks.execAsync.mock.calls[0];
    expect(command).toMatch(/^"C:\\Program Files\\Tool\\tool\.cmd" --version$/);
    expect(options).toEqual({ timeout: 5000, windowsHide: true });
  });

  it('uses execFileAsync with the candidate path off win32', async () => {
    setPlatform('linux');

    await execVersion('/usr/local/bin/tool', 5000, ['-V']);

    expect(execMocks.execAsync).not.toHaveBeenCalled();
    expect(execMocks.execFileAsync).toHaveBeenCalledWith('/usr/local/bin/tool', ['-V'], { timeout: 5000 });
  });
});

/**
 * `spawnOffMainPty` (src/main/utility-process/off-main-pty.ts) starts a probe's
 * PTY (the Claude model picker, the Antigravity print runner) in the pty host.
 * Pinned: the env it hands on never carries Crashpad's pipe name, whatever the
 * caller built (child-env.ts), and the caller's own options object is left as
 * it was.
 *
 * Tier: Unit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setOffMainPtySpawner, spawnOffMainPty, type OffMainPty, type OffMainPtyOptions } from '../../src/main/utility-process/off-main-pty';

afterEach(() => {
  setOffMainPtySpawner(null);
});

describe('spawnOffMainPty', () => {
  it('hands the host the caller\'s env without Crashpad\'s pipe name', async () => {
    const shipped: OffMainPtyOptions[] = [];
    const fakePty = { pid: 1 } as OffMainPty;
    setOffMainPtySpawner(async (_file, _args, options) => {
      shipped.push(options);
      return fakePty;
    });
    const requested: OffMainPtyOptions = {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/mock/scratch',
      env: { PATH: '/usr/bin', CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP' },
    };

    await expect(spawnOffMainPty('claude', ['--safe-mode'], requested)).resolves.toBe(fakePty);

    expect(shipped).toHaveLength(1);
    expect(shipped[0]).toEqual({ name: 'xterm-256color', cols: 80, rows: 24, cwd: '/mock/scratch', env: { PATH: '/usr/bin' } });
    expect(requested.env.CHROME_CRASHPAD_PIPE_NAME).toBeDefined();
  });
});

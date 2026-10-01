import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * node-pty's ConPTY kill forks a helper with `child_process.fork`. In a
 * packaged build the RunAsNode fuse is off, so that fork boots a second
 * Kangentic.exe, which focuses the running window through 'second-instance'.
 * `skipConsoleListHelper` answers the helper's question (the shell's pid) at
 * once instead, so no child process starts.
 */

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  setPlatform(originalPlatform);
  vi.resetModules();
});

describe('skipConsoleListHelper', () => {
  it('replaces the helper fork with the shell pid on Windows', async () => {
    setPlatform('win32');
    const { WindowsPtyAgent } = await import('node-pty/lib/windowsPtyAgent');
    const original = WindowsPtyAgent.prototype._getConsoleProcessList;
    try {
      const { skipConsoleListHelper } = await import('../../src/main/pty/spawn/conpty-console-list');
      skipConsoleListHelper();
      // The original forks conpty_console_list_agent; it must be gone.
      expect(WindowsPtyAgent.prototype._getConsoleProcessList).not.toBe(original);
      const agent = Object.create(WindowsPtyAgent.prototype) as InstanceType<typeof WindowsPtyAgent>;
      agent._innerPid = 4242;
      await expect(agent._getConsoleProcessList()).resolves.toEqual([4242]);
    } finally {
      WindowsPtyAgent.prototype._getConsoleProcessList = original;
    }
  });

  it('leaves node-pty untouched off Windows', async () => {
    setPlatform('linux');
    const { WindowsPtyAgent } = await import('node-pty/lib/windowsPtyAgent');
    const original = WindowsPtyAgent.prototype._getConsoleProcessList;
    const { skipConsoleListHelper } = await import('../../src/main/pty/spawn/conpty-console-list');
    skipConsoleListHelper();
    expect(WindowsPtyAgent.prototype._getConsoleProcessList).toBe(original);
  });

  it('is installed by main at startup', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf-8');
    expect(source).toMatch(/^skipConsoleListHelper\(\);$/m);
  });
});

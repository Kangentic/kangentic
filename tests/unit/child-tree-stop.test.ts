/**
 * child-tree-stop.ts: how a CLI run and everything it started is stopped, for
 * a local run (`stopCli`), a run in the pty host (`host-cli-processes.ts`), and
 * main's backstop by pid. Real children run in host-cli-processes.test.ts; this
 * pins each branch with an injected spawn and a stubbed `process.kill`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { spawn } from 'node:child_process';
import {
  TREE_STOP_GRACE_MS,
  childHasExited,
  killChildTreeByPid,
  killChildTreeNow,
  signalChildOrGroup,
  stopChildTree,
  type StoppableChild,
} from '../../src/main/shared/child-tree-stop';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

/** A child that records the signals it is sent and can be marked exited. */
function fakeChild(pid: number | undefined = 4321): StoppableChild & { signals: Array<NodeJS.Signals | number | undefined>; exit(): void } {
  const child = {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    signals: [] as Array<NodeJS.Signals | number | undefined>,
    kill(signal?: NodeJS.Signals | number): boolean {
      child.signals.push(signal);
      return true;
    },
    exit(): void {
      child.exitCode = 0;
    },
  };
  return child;
}

/**
 * A spawn double whose returned handle supports the `.on().unref()` chain.
 * `emit` fires the listeners taskkill's handle was given (`exit`, `error`).
 */
function fakeSpawn(): {
  spawnProcess: typeof spawn;
  calls: Array<{ command: string; args: readonly string[]; options: unknown }>;
  emit(event: 'exit' | 'error'): void;
} {
  const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  const listeners: Array<{ event: string; listener: () => void }> = [];
  const handle = {
    on: (event: string, listener: () => void) => {
      listeners.push({ event, listener });
      return handle;
    },
    unref: () => handle,
  };
  const spawnProcess = ((command: string, args: readonly string[], options: unknown) => {
    calls.push({ command, args, options });
    return handle;
  }) as unknown as typeof spawn;
  return {
    spawnProcess,
    calls,
    emit: (event) => {
      for (const entry of listeners) if (entry.event === event) entry.listener();
    },
  };
}

describe('child-tree-stop', () => {
  let processKill: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    processKill.mockRestore();
    setPlatform(originalPlatform);
  });

  it('reads exit from the exit code and signal, not from a signal having been sent', () => {
    const child = fakeChild();
    expect(childHasExited(child)).toBe(false);
    child.kill('SIGTERM');
    expect(childHasExited(child)).toBe(false);
    child.exit();
    expect(childHasExited(child)).toBe(true);
    const signalled = fakeChild();
    (signalled as { signalCode: NodeJS.Signals | null }).signalCode = 'SIGKILL';
    expect(childHasExited(signalled)).toBe(true);
  });

  describe('on Windows', () => {
    beforeEach(() => setPlatform('win32'));

    it('takes the whole tree with taskkill /T /F', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const child = fakeChild(4321);
      stopChildTree(child, { leadsGroup: false, spawnProcess });
      expect(calls).toEqual([
        { command: 'taskkill', args: ['/pid', '4321', '/T', '/F'], options: { windowsHide: true, stdio: 'ignore' } },
      ]);
      // No signal: child.kill would end one process and leave the CLI under cmd.exe.
      expect(child.signals).toEqual([]);
      expect(processKill).not.toHaveBeenCalled();
    });

    it('spawns one taskkill per run when the run is its own latch', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const child = fakeChild();
      const latch = { treeKillStarted: false };
      stopChildTree(child, { leadsGroup: false, spawnProcess, treeKillLatch: latch });
      stopChildTree(child, { leadsGroup: false, spawnProcess, treeKillLatch: latch });
      expect(calls).toHaveLength(1);
      expect(latch.treeKillStarted).toBe(true);
    });

    it('spawns again without a latch', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const child = fakeChild();
      stopChildTree(child, { leadsGroup: false, spawnProcess });
      stopChildTree(child, { leadsGroup: false, spawnProcess });
      expect(calls).toHaveLength(2);
    });

    it('kills by pid with taskkill', () => {
      const { spawnProcess, calls } = fakeSpawn();
      killChildTreeByPid(99, spawnProcess);
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([['taskkill', '/pid', '99', '/T', '/F']]);
      expect(processKill).not.toHaveBeenCalled();
    });

    it('pins the run\'s pid before taskkill starts and holds the pin until taskkill exits, releasing it once', () => {
      const { spawnProcess, calls, emit } = fakeSpawn();
      const order: string[] = [];
      const release = vi.fn(() => order.push('release'));
      const pinRoot = vi.fn((pid: number) => {
        order.push(`pin ${pid}`);
        return release;
      });
      const recordingSpawn = ((...args: Parameters<typeof spawn>) => {
        order.push('taskkill');
        return (spawnProcess as (...spawnArgs: Parameters<typeof spawn>) => unknown)(...args);
      }) as unknown as typeof spawn;
      stopChildTree(fakeChild(4321), { leadsGroup: false, spawnProcess: recordingSpawn, pinRoot });
      expect(calls).toHaveLength(1);
      expect(release).not.toHaveBeenCalled();
      emit('exit');
      emit('error');
      expect(order).toEqual(['pin 4321', 'taskkill', 'release']);
    });

    it('releases the pin when taskkill cannot start', () => {
      const { spawnProcess, emit } = fakeSpawn();
      const release = vi.fn();
      stopChildTree(fakeChild(), { leadsGroup: false, spawnProcess, pinRoot: () => release });
      emit('error');
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('releases the pin once and rethrows when taskkill cannot be spawned at all, so no pin outlives a stop that never started', () => {
      const release = vi.fn();
      const pinRoot = vi.fn((_pid: number) => release);
      const spawnProcess = (() => {
        throw new Error('spawn EAGAIN');
      }) as unknown as typeof spawn;
      const child = fakeChild(4321);
      expect(() => stopChildTree(child, { leadsGroup: false, spawnProcess, pinRoot })).toThrow('spawn EAGAIN');
      // Positive control: the pin was taken before the spawn threw, so the release is the catch's own.
      expect(pinRoot).toHaveBeenCalledWith(4321);
      expect(release).toHaveBeenCalledTimes(1);
      expect(child.signals).toEqual([]);
      expect(processKill).not.toHaveBeenCalled();
    });

    it('releases the pin once, however late taskkill\'s own events come, when the spawn throws after taskkill\'s handle took a listener', () => {
      const release = vi.fn();
      const lateListeners: Array<() => void> = [];
      const spawnProcess = (() => {
        const handle = {
          on: (event: string, listener: () => void) => {
            // Stands in for any throw after a listener was attached: the first `on` took one, the second throws.
            if (event === 'exit') throw new Error('listener refused');
            lateListeners.push(listener);
            return handle;
          },
          unref: () => handle,
        };
        return handle;
      }) as unknown as typeof spawn;
      expect(() => stopChildTree(fakeChild(), { leadsGroup: false, spawnProcess, pinRoot: () => release })).toThrow('listener refused');
      expect(release).toHaveBeenCalledTimes(1);
      // The attached listener is still live: taskkill failing to start later must not release the pin a second time.
      expect(lateListeners).toHaveLength(1);
      for (const listener of lateListeners) listener();
      expect(release).toHaveBeenCalledTimes(1);
    });

    it('killChildTreeNow takes a running child\'s tree, and leaves an exited one alone, whose pid nothing pins any more', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const running = fakeChild(4321);
      killChildTreeNow(running, { leadsGroup: true, spawnProcess });
      expect(calls.map((call) => [call.command, ...call.args])).toEqual([['taskkill', '/pid', '4321', '/T', '/F']]);

      const exited = fakeChild(4322);
      exited.exit();
      killChildTreeNow(exited, { leadsGroup: true, spawnProcess });
      expect(calls).toHaveLength(1);
      expect(exited.signals).toEqual([]);
      expect(processKill).not.toHaveBeenCalled();
    });
  });

  describe('on POSIX', () => {
    beforeEach(() => setPlatform('linux'));

    it('sends the group SIGTERM, then SIGKILL after the grace while it is still alive', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const child = fakeChild(500);
      stopChildTree(child, { leadsGroup: true, spawnProcess });
      expect(processKill.mock.calls).toEqual([[-500, 'SIGTERM']]);
      vi.advanceTimersByTime(TREE_STOP_GRACE_MS - 1);
      expect(processKill).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(processKill.mock.calls).toEqual([[-500, 'SIGTERM'], [-500, 'SIGKILL']]);
      expect(calls).toEqual([]);
      expect(child.signals).toEqual([]);
    });

    it('sends no SIGKILL to a child that exited within the grace', () => {
      const child = fakeChild(500);
      stopChildTree(child, { leadsGroup: true });
      child.exit();
      vi.advanceTimersByTime(TREE_STOP_GRACE_MS);
      expect(processKill.mock.calls).toEqual([[-500, 'SIGTERM']]);
    });

    it('signals the child itself when it leads no group', () => {
      const child = fakeChild(500);
      stopChildTree(child, { leadsGroup: false });
      vi.advanceTimersByTime(TREE_STOP_GRACE_MS);
      expect(processKill).not.toHaveBeenCalled();
      expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    });

    it('falls back to the child when the group cannot be signalled', () => {
      processKill.mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      const child = fakeChild(500);
      signalChildOrGroup(child, true, 'SIGTERM');
      expect(child.signals).toEqual(['SIGTERM']);
    });

    it('kills by pid: the group first, else the process', () => {
      killChildTreeByPid(77);
      expect(processKill.mock.calls).toEqual([[-77, 'SIGKILL']]);

      processKill.mockReset();
      processKill.mockImplementationOnce(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      processKill.mockImplementationOnce(() => true);
      killChildTreeByPid(78);
      expect(processKill.mock.calls).toEqual([[-78, 'SIGKILL'], [78, 'SIGKILL']]);
    });

    it('swallows a kill by pid of a process that is already gone', () => {
      processKill.mockImplementation(() => {
        throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      });
      expect(() => killChildTreeByPid(79)).not.toThrow();
    });

    it('killChildTreeNow SIGKILLs the group at once, even once the leader has exited, since its group lives on', () => {
      const { spawnProcess, calls } = fakeSpawn();
      const leader = fakeChild(500);
      killChildTreeNow(leader, { leadsGroup: true, spawnProcess });
      leader.exit();
      killChildTreeNow(leader, { leadsGroup: true, spawnProcess });
      expect(processKill.mock.calls).toEqual([[-500, 'SIGKILL'], [-500, 'SIGKILL']]);
      expect(calls).toEqual([]);
    });
  });

  it('leaves a child that already exited alone on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      setPlatform(platform);
      const { spawnProcess, calls } = fakeSpawn();
      const child = fakeChild();
      child.exit();
      stopChildTree(child, { leadsGroup: true, spawnProcess, treeKillLatch: { treeKillStarted: false } });
      vi.advanceTimersByTime(TREE_STOP_GRACE_MS);
      expect(calls, platform).toEqual([]);
      expect(child.signals, platform).toEqual([]);
    }
    expect(processKill).not.toHaveBeenCalled();
  });
});

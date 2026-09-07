/**
 * Tests for the session-end reap: killing what a session left running in its
 * worktree, from the snapshot the bg-shell watcher published before the PTY was
 * killed.
 *
 * Covers:
 *   - Every live pid in the captured tree is killed
 *   - Already-dead pids cost no kill (the common case: everything died with the
 *     agent, so a teardown issues zero taskkill spawns)
 *   - Own pid and the init/System pid floor are never killed
 *   - Kills are issued in parallel, not serially behind a 2000ms cap each
 *   - A failing kill never propagates into the teardown
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockKillProcess, mockIsProcessAlive } = vi.hoisted(() => ({
  mockKillProcess: vi.fn(),
  mockIsProcessAlive: vi.fn(),
}));

vi.mock('../../src/main/git/zombie-reaper', () => ({
  killProcess: mockKillProcess,
}));

vi.mock('../../src/main/shared/process-liveness', () => ({
  isProcessAlive: mockIsProcessAlive,
}));

import { reapCapturedTree } from '../../src/main/pty/session-tree-reap';
import type { CapturedSessionTree } from '../../src/main/activity-engine/background-shell/process-tree';

function captured(pids: number[]): CapturedSessionTree {
  return { rootPid: 1234, pids, capturedAt: Date.now() };
}

describe('reapCapturedTree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockKillProcess.mockReset().mockResolvedValue(undefined);
    mockIsProcessAlive.mockReset().mockReturnValue(true);
  });

  it('kills every live pid in the captured tree', async () => {
    const killed = await reapCapturedTree(captured([5001, 5002]));

    expect(killed.sort((a, b) => a - b)).toEqual([5001, 5002]);
    expect(mockKillProcess).toHaveBeenCalledWith(5001);
    expect(mockKillProcess).toHaveBeenCalledWith(5002);
  });

  it('does nothing when there is no snapshot', async () => {
    const killed = await reapCapturedTree(null);

    expect(killed).toEqual([]);
    expect(mockKillProcess).not.toHaveBeenCalled();
  });

  it('does not double-kill a pid listed twice', async () => {
    const killed = await reapCapturedTree(captured([5001, 5001, 5002]));

    expect(killed.sort((a, b) => a - b)).toEqual([5001, 5002]);
    expect(mockKillProcess).toHaveBeenCalledTimes(2);
  });

  it('issues no kill at all when every captured pid already exited', async () => {
    // The common case. Everything the agent spawned died with it, so a Done move
    // must not pay for a single taskkill spawn.
    mockIsProcessAlive.mockReturnValue(false);

    const killed = await reapCapturedTree(captured([5001, 5002]));

    expect(killed).toEqual([]);
    expect(mockKillProcess).not.toHaveBeenCalled();
  });

  it('never kills its own process', async () => {
    const killed = await reapCapturedTree(captured([process.pid, 5001]));

    expect(killed).toEqual([5001]);
    expect(mockKillProcess).not.toHaveBeenCalledWith(process.pid);
  });

  it('never kills init / System / csrss', async () => {
    const killed = await reapCapturedTree(captured([0, 1, 4, 5001]));

    expect(killed).toEqual([5001]);
  });

  it('ignores non-integer and negative pids', async () => {
    const killed = await reapCapturedTree(captured([Number.NaN, -1, 5001]));

    expect(killed).toEqual([5001]);
  });

  it('issues kills in parallel, not one after another', async () => {
    // Each Windows taskkill carries a 2000ms timeout and the teardown holds the
    // per-task lock, so serial kills would stack on the drag-to-Done path.
    let inFlight = 0;
    let peakInFlight = 0;
    mockKillProcess.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    await reapCapturedTree(captured([5001, 5002, 5003]));

    expect(peakInFlight).toBe(3);
  });

  it('does not propagate a failing kill to the caller', async () => {
    mockKillProcess.mockRejectedValue(new Error('access denied'));

    await expect(reapCapturedTree(captured([5001]))).resolves.toEqual([5001]);
  });
});

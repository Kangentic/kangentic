/**
 * The task reap's two passes, its report, request coalescing, and the stop of
 * one reported process (src/main/pty/process-tag/tagged-reap.ts), against a
 * fake reader.
 */

import { describe, it, expect } from 'vitest';
import {
  TaggedReaper,
  reapTaggedOnce,
  stopProcessTree,
  REAP_GRACE_MS,
  SURVIVOR_CHECK_MS,
  type TaggedReapTask,
} from '../../src/main/pty/process-tag/tagged-reap';
import type { KillStrength, ProcessScan, ScannedProcess, TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const MAIN_PID = 1000;
const PROJECT = '/home/dev/project';
const WORKTREE = `${PROJECT}/.kangentic/worktrees/task-1`;
const OTHER_PROJECT = '/home/dev/other';

function tagged(pid: number, tagValue: string, startKey = `start-${pid}`, workingDirectory = PROJECT, ppid = 1): ScannedProcess {
  return { pid, ppid, startKey, startedAtMs: null, tagValue, workingDirectory };
}

function reapTask(taskId: string, directory = PROJECT, worktreePath: string | null = null): TaggedReapTask {
  return { taskId, directories: [directory], worktreePath };
}

class FakeReader implements TaggedProcessReader {
  scans: ProcessScan[];
  scanCount = 0;
  kills: Array<{ pid: number; startKey: string; strength: KillStrength }> = [];
  described: number[] = [];
  failScan = false;

  constructor(scans: ScannedProcess[][], private readonly labels: Record<number, string> = {}) {
    this.scans = scans.map((processes) => ({ processes: [{ pid: MAIN_PID, ppid: 900, startKey: 'main', startedAtMs: null, tagValue: null }, ...processes], unreadableCount: 0 }));
  }

  async scan(): Promise<ProcessScan> {
    if (this.failScan) throw new Error('probe failed');
    const result = this.scans[Math.min(this.scanCount, this.scans.length - 1)];
    this.scanCount += 1;
    return result;
  }

  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    this.kills.push({ pid: target.pid, startKey: target.startKey, strength });
    return true;
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    this.described.push(...targets.map((target) => target.pid));
    return new Map(targets.filter((target) => this.labels[target.pid]).map((target) => [target.pid, this.labels[target.pid]]));
  }
}

function deps(reader: FakeReader, waits: number[] = [], liveRootPids: number[] = []) {
  return {
    reader,
    liveRootPids: () => liveRootPids,
    wait: async (ms: number) => { waits.push(ms); },
    caseInsensitivePaths: false,
  };
}

describe('reapTaggedOnce', () => {
  it('asks targets to exit, waits the grace, rescans, force-kills what is still there, and checks it went', async () => {
    const reader = new FakeReader([
      [tagged(2001, TASK), tagged(2002, TASK)],
      // 2001 exited on SIGTERM; 2002 ignored it.
      [tagged(2002, TASK)],
      // 2002 went on SIGKILL.
      [],
    ]);
    const waits: number[] = [];
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader, waits));
    expect(reader.kills).toEqual([
      { pid: 2001, startKey: 'start-2001', strength: 'graceful' },
      { pid: 2002, startKey: 'start-2002', strength: 'graceful' },
      { pid: 2002, startKey: 'start-2002', strength: 'force' },
    ]);
    expect(waits).toEqual([REAP_GRACE_MS, SURVIVOR_CHECK_MS]);
    expect(result.killedPids).toEqual([2001, 2002]);
    expect(result.entries.map((entry) => `${entry.pid}:${entry.outcome}`)).toEqual(['2001:stopped', '2002:stopped']);
  });

  it('catches a child a tagged supervisor respawned between the two scans', async () => {
    const reader = new FakeReader([
      [tagged(2001, TASK)],
      [tagged(2005, TASK)],
      [],
    ]);
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(reader.kills.map((kill) => `${kill.pid}:${kill.strength}`)).toEqual(['2001:graceful', '2005:force']);
    expect(result.killedPids).toEqual([2001, 2005]);
  });

  it('a pid reused between the scans is killed only under its new start key', async () => {
    const reader = new FakeReader([
      [tagged(2001, TASK, 'old')],
      [tagged(2001, OTHER_TASK, 'new')],
    ]);
    await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(reader.kills).toEqual([{ pid: 2001, startKey: 'old', strength: 'graceful' }]);
  });

  it('scans once and waits nothing when the task left nothing running in its directories', async () => {
    const reader = new FakeReader([[tagged(2001, OTHER_TASK), tagged(2002, TASK, 'start-2002', '/')]]);
    const waits: number[] = [];
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader, waits));
    expect(reader.scanCount).toBe(1);
    expect(waits).toEqual([]);
    expect(result.killedPids).toEqual([]);
    expect(result.entries).toEqual([]);
  });

  it('refuses an id that is not a task id, without scanning', async () => {
    const reader = new FakeReader([[tagged(2001, 'not-a-task-id')]]);
    const result = await reapTaggedOnce({ tasks: [reapTask('not-a-task-id'), reapTask('')], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(reader.scanCount).toBe(0);
    expect(result.killedPids).toEqual([]);
  });

  it('never throws when the scan fails', async () => {
    const reader = new FakeReader([[]]);
    reader.failScan = true;
    await expect(reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader))).resolves.toEqual({
      killedPids: [], unreadableCount: 0, failureReason: 'probe failed', failureCode: 'reap_error', entries: [],
    });
  });

  it('says the reader would not load, without scanning, when its native calls cannot load', async () => {
    const reader = new FakeReader([[tagged(2001, TASK)]]);
    const loading = Object.assign(reader, { ready: async () => { throw new Error('Cannot find module koffi'); } });
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(loading));
    expect(result).toMatchObject({ failureCode: 'reader_load', failureReason: 'Cannot find module koffi', killedPids: [] });
    expect(reader.scanCount).toBe(0);
  });

  it('treats a scan that lists no process at all as a failure, never as nothing to do', async () => {
    const reader = new FakeReader([]);
    reader.scans = [{ processes: [], unreadableCount: 0 }];
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(result).toMatchObject({ failureCode: 'empty_scan', killedPids: [], entries: [] });
    expect(reader.kills).toEqual([]);
  });

  it('kills a macOS withheld orphan only inside a reaped worktree', async () => {
    const orphan: ScannedProcess = { pid: 2001, ppid: 1, startKey: 'start-2001', startedAtMs: null, tagValue: null, environmentWithheld: true, workingDirectory: WORKTREE };
    const reader = new FakeReader([[orphan], []]);
    const result = await reapTaggedOnce({ tasks: [{ taskId: TASK, directories: [PROJECT], worktreePath: WORKTREE }], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(result.killedPids).toEqual([2001]);
    expect(result.entries).toEqual([expect.objectContaining({ pid: 2001, taskId: TASK, outcome: 'stopped', place: 'worktree' })]);

    const withoutWorktree = new FakeReader([[orphan]]);
    expect((await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(withoutWorktree))).killedPids).toEqual([]);
  });
});

describe('reapTaggedOnce report', () => {
  it('names the top of each stopped tree under its task, never the processes under it', async () => {
    const reader = new FakeReader([
      [
        tagged(2001, TASK, 'start-2001', WORKTREE),
        tagged(2002, TASK, 'start-2002', WORKTREE, 2001),
        tagged(2003, TASK, 'start-2003', PROJECT),
      ],
      [],
    ], { 2001: 'node (npm)', 2003: 'python3 (http.server)' });
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK, PROJECT, WORKTREE)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(result.killedPids).toEqual([2001, 2002, 2003]);
    expect(result.entries).toEqual([
      { taskId: TASK, pid: 2001, startKey: 'start-2001', label: 'node (npm)', outcome: 'stopped', reason: null, place: 'worktree' },
      { taskId: TASK, pid: 2003, startKey: 'start-2003', label: 'python3 (http.server)', outcome: 'stopped', reason: null, place: 'project' },
    ]);
    // Only the reported processes are described: the command line is read for nothing else.
    expect(reader.described.sort()).toEqual([2001, 2003]);
  });

  it('reports a process that outlived the force pass as not stopped', async () => {
    const reader = new FakeReader([
      [tagged(2001, TASK)],
      [tagged(2001, TASK)],
      [tagged(2001, TASK)],
    ], { 2001: 'node (vite)' });
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(result.entries).toEqual([expect.objectContaining({ pid: 2001, outcome: 'failed', label: 'node (vite)' })]);
  });

  it('names a process when its command line could not be read', async () => {
    const reader = new FakeReader([[tagged(2001, TASK)], []]);
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(result.entries[0].label).toBe('process');
  });

  it('reports a window the task opened as left running, and never kills it', async () => {
    const window: ScannedProcess = { ...tagged(2001, TASK), role: 'visible-app' };
    const reader = new FakeReader([[window, tagged(2002, TASK)], []], { 2001: 'chrome' });
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true }, deps(reader));
    expect(reader.kills.map((kill) => kill.pid)).toEqual([2002]);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 2001, outcome: 'kept', reason: 'window', label: 'chrome' }),
      expect.objectContaining({ pid: 2002, outcome: 'stopped' }),
    ]));
  });

  it('with stopping turned off, kills nothing and reports what kept running', async () => {
    const window: ScannedProcess = { ...tagged(2001, TASK), role: 'visible-app' };
    const reader = new FakeReader([[window, tagged(2002, TASK)]]);
    const waits: number[] = [];
    const result = await reapTaggedOnce({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: false }, deps(reader, waits));
    expect(reader.kills).toEqual([]);
    expect(reader.scanCount).toBe(1);
    expect(waits).toEqual([]);
    expect(result.killedPids).toEqual([]);
    expect(result.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ pid: 2001, outcome: 'kept', reason: 'window' }),
      expect.objectContaining({ pid: 2002, outcome: 'kept', reason: null }),
    ]));
  });
});

describe('TaggedReaper', () => {
  it('coalesces requests that arrive during a reap into one more batch, each task keeping its own directories and report', async () => {
    const reader = new FakeReader([[
      tagged(2001, TASK),
      tagged(3001, OTHER_TASK, 'start-3001', OTHER_PROJECT),
      // In the first task's project, but tagged for the second: not the second's directory.
      tagged(3002, OTHER_TASK, 'start-3002', PROJECT),
    ]]);
    let releaseFirstWait: () => void = () => {};
    const waits: number[] = [];
    const reaper = new TaggedReaper({
      reader,
      liveRootPids: () => [],
      caseInsensitivePaths: false,
      wait: (ms) => {
        waits.push(ms);
        if (waits.length === 1) return new Promise<void>((resolve) => { releaseFirstWait = resolve; });
        return Promise.resolve();
      },
    });

    const first = reaper.request({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true });
    // Let the first reap reach its grace wait.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const second = reaper.request({ tasks: [reapTask(OTHER_TASK, OTHER_PROJECT)], mainPid: MAIN_PID, stop: true });
    const third = reaper.request({ tasks: [reapTask(OTHER_TASK, OTHER_PROJECT)], mainPid: MAIN_PID, stop: true });
    releaseFirstWait();

    const [firstResult, secondResult, thirdResult] = await Promise.all([first, second, third]);
    expect(firstResult.killedPids).toEqual([2001]);
    expect(secondResult.killedPids).toEqual([3001]);
    expect(thirdResult).toEqual(secondResult);
    expect(firstResult.entries.map((entry) => entry.taskId)).toEqual([TASK]);
    // Two batches. The fake never lets a process go, so each runs its survivor check too.
    expect(reader.scanCount).toBe(6);
  });

  it('gives each request only its own tasks in the report', async () => {
    const reader = new FakeReader([[tagged(2001, TASK), tagged(3001, OTHER_TASK, 'start-3001', OTHER_PROJECT)], []]);
    let releaseWait: () => void = () => {};
    let blocked = true;
    const reaper = new TaggedReaper({
      reader,
      liveRootPids: () => [],
      caseInsensitivePaths: false,
      wait: () => (blocked ? new Promise<void>((resolve) => { blocked = false; releaseWait = resolve; }) : Promise.resolve()),
    });
    // A request that holds the reaper busy, so the next two join one batch.
    const holder = reaper.request({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: true });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const forTask = reaper.request({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: false });
    const forOther = reaper.request({ tasks: [reapTask(OTHER_TASK, OTHER_PROJECT)], mainPid: MAIN_PID, stop: false });
    releaseWait();
    await holder;
    const [taskResult, otherResult] = await Promise.all([forTask, forOther]);
    expect(taskResult.entries.every((entry) => entry.taskId === TASK)).toBe(true);
    expect(otherResult.entries.every((entry) => entry.taskId === OTHER_TASK)).toBe(true);
  });

  it('never folds a report-only request into a batch that kills', async () => {
    const reader = new FakeReader([[tagged(2001, TASK)]]);
    let releaseWait: () => void = () => {};
    let blocked = true;
    const reaper = new TaggedReaper({
      reader,
      liveRootPids: () => [],
      caseInsensitivePaths: false,
      wait: () => (blocked ? new Promise<void>((resolve) => { blocked = false; releaseWait = resolve; }) : Promise.resolve()),
    });
    const killing = reaper.request({ tasks: [reapTask(OTHER_TASK, OTHER_PROJECT)], mainPid: MAIN_PID, stop: true });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    const reportOnly = reaper.request({ tasks: [reapTask(TASK)], mainPid: MAIN_PID, stop: false });
    const alsoKilling = reaper.request({ tasks: [reapTask(OTHER_TASK, OTHER_PROJECT)], mainPid: MAIN_PID, stop: true });
    releaseWait();
    await Promise.all([killing, reportOnly, alsoKilling]);
    expect(reader.kills.map((kill) => kill.pid)).not.toContain(2001);
  });
});

describe('stopProcessTree', () => {
  it('stops the named process and everything under it', async () => {
    const reader = new FakeReader([
      [{ ...tagged(2001, TASK), role: 'visible-app' }, tagged(2002, TASK, 'start-2002', PROJECT, 2001)],
      [],
    ]);
    const outcome = await stopProcessTree({ pid: 2001, startKey: 'start-2001', mainPid: MAIN_PID }, deps(reader));
    expect(outcome).toBe('stopped');
    expect(reader.kills.map((kill) => `${kill.pid}:${kill.strength}`).sort()).toEqual(['2001:graceful', '2002:graceful']);
  });

  it('answers ended for a pid that is gone or now names another process', async () => {
    const reader = new FakeReader([[tagged(2001, TASK, 'new')]]);
    expect(await stopProcessTree({ pid: 2001, startKey: 'old', mainPid: MAIN_PID }, deps(reader))).toBe('ended');
    expect(await stopProcessTree({ pid: 4242, startKey: 'start-4242', mainPid: MAIN_PID }, deps(reader))).toBe('ended');
    expect(reader.kills).toEqual([]);
  });

  it('answers failed, not ended, when the scan lists nothing at all', async () => {
    const reader = new FakeReader([]);
    reader.scans = [{ processes: [], unreadableCount: 0 }];
    expect(await stopProcessTree({ pid: 2001, startKey: 'start-2001', mainPid: MAIN_PID }, deps(reader))).toBe('failed');
    expect(reader.kills).toEqual([]);
  });

  it('force-kills what ignored the first signal, and answers failed for what survives even that', async () => {
    const survivor = tagged(2001, TASK);
    const reader = new FakeReader([[survivor], [survivor], [survivor]]);
    const waits: number[] = [];
    expect(await stopProcessTree({ pid: 2001, startKey: 'start-2001', mainPid: MAIN_PID }, deps(reader, waits))).toBe('failed');
    expect(reader.kills.map((kill) => kill.strength)).toEqual(['graceful', 'force']);
    expect(waits).toEqual([REAP_GRACE_MS, SURVIVOR_CHECK_MS]);
  });

  it('never stops Kangentic, a held PTY, or anything under them', async () => {
    const underMain = tagged(2001, TASK, 'start-2001', PROJECT, MAIN_PID);
    const ptyRoot = tagged(3000, TASK);
    const underPty = tagged(3001, TASK, 'start-3001', PROJECT, 3000);
    const reader = new FakeReader([[underMain, ptyRoot, underPty]]);
    for (const target of [underMain, ptyRoot, underPty]) {
      expect(await stopProcessTree({ pid: target.pid, startKey: target.startKey, mainPid: MAIN_PID }, deps(reader, [], [3000]))).toBe('failed');
    }
    expect(reader.kills).toEqual([]);
  });

  it('leaves out a held PTY under the named process', async () => {
    const reader = new FakeReader([[tagged(2001, TASK), tagged(3000, TASK, 'start-3000', PROJECT, 2001)], []]);
    expect(await stopProcessTree({ pid: 2001, startKey: 'start-2001', mainPid: MAIN_PID }, deps(reader, [], [3000]))).toBe('stopped');
    expect(reader.kills.map((kill) => kill.pid)).toEqual([2001]);
  });
});

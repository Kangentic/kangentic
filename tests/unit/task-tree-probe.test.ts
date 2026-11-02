/**
 * What a task still has running, and whether anything outside it uses that
 * (src/main/pty/process-tag/task-tree-probe.ts, probeTaskTrees in tagged-reap.ts).
 * A project's Stop script runs on these answers, so each one is pinned: the two
 * different sets of processes the two questions want, and that a probe signals
 * nothing and never reads a failed scan as "nothing runs".
 *
 * The fixture is shaped from a measured stack: a host process in the worktree,
 * a tagged dashboard working in a package cache, and an untagged child.
 */
import { describe, it, expect, vi } from 'vitest';
import { probeTaskTrees, type TaskProbeRequest } from '../../src/main/pty/process-tag/tagged-reap';
import { buildProtectedPids } from '../../src/main/pty/process-tag/reap-plan';
import {
  hasOutsideClient,
  runningInTaskFolders,
  topOfRunning,
  treeConnectionQueryOf,
} from '../../src/main/pty/process-tag/task-tree-probe';
import type { LocalConnectionRead, ProcessScan, ScannedProcess, TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OTHER_TASK = '0b1c2d3e-4f50-4617-8829-3a4b5c6d7e8f';
const MAIN_PID = 1000;
const PROJECT = '/home/dev/project';
const WORKTREE = `${PROJECT}/.kangentic/worktrees/task-1`;
const PACKAGE_CACHE = '/home/dev/.nuget/packages/dashboard';

const HOST_PID = 2001;
const DASHBOARD_PID = 2002;
const CHILD_PID = 2003;
const BROWSER_PID = 3001;

function process_(pid: number, overrides: Partial<ScannedProcess> = {}): ScannedProcess {
  return { pid, ppid: 1, startKey: `start-${pid}`, startedAtMs: null, tagValue: null, workingDirectory: '/home/dev', ...overrides };
}

const MAIN = process_(MAIN_PID, { ppid: 900 });
const HOST = process_(HOST_PID, { tagValue: TASK, workingDirectory: WORKTREE });
const DASHBOARD = process_(DASHBOARD_PID, { ppid: HOST_PID, tagValue: TASK, workingDirectory: PACKAGE_CACHE });
const CHILD = process_(CHILD_PID, { ppid: HOST_PID, tagValue: null, workingDirectory: PACKAGE_CACHE });
const BROWSER = process_(BROWSER_PID, { tagValue: null });
const SCOPE = { directories: [PROJECT], worktreePath: WORKTREE };

function input(processes: ScannedProcess[], liveRootPids: number[] = []) {
  return { processes: [MAIN, ...processes], mainPid: MAIN_PID, liveRootPids, caseInsensitivePaths: false };
}

class ProbeReader implements TaggedProcessReader {
  scans = 0;
  connectionReads: Array<{ listeners: number[]; clients: number[] }> = [];
  kill = vi.fn(async () => true);
  read: LocalConnectionRead = { pairs: [], listeningPids: [] };
  failScan = false;
  emptyScan = false;

  constructor(private readonly processes: ScannedProcess[]) {}

  async scan(): Promise<ProcessScan> {
    this.scans += 1;
    if (this.failScan) throw new Error('no table');
    return { processes: this.emptyScan ? [] : [MAIN, ...this.processes], unreadableCount: 0 };
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    return new Map(targets.map((target) => [target.pid, `label-${target.pid}`]));
  }

  async connections(listeners: readonly ScannedProcess[], clients: readonly ScannedProcess[]): Promise<LocalConnectionRead> {
    this.connectionReads.push({ listeners: listeners.map((one) => one.pid), clients: clients.map((one) => one.pid) });
    return this.read;
  }
}

function deps(reader: ProbeReader, liveRootPids: number[] = []) {
  return { reader, liveRootPids: () => liveRootPids, wait: async () => {}, caseInsensitivePaths: false, homeDirectory: '/home/dev' };
}

function request(readConnections = true, taskId = TASK): TaskProbeRequest {
  return { tasks: [{ taskId, directories: [PROJECT], worktreePath: WORKTREE }], mainPid: MAIN_PID, readConnections };
}

describe('what a task has running in its folders', () => {
  it('counts a tagged process inside the task\'s folders and not a tagged one working elsewhere', () => {
    const scan = input([HOST, DASHBOARD]);
    expect(runningInTaskFolders(scan, buildProtectedPids(scan), TASK, SCOPE).map((one) => one.pid)).toEqual([HOST_PID]);
  });

  it('counts nothing when the only tagged process works outside them', () => {
    const scan = input([DASHBOARD]);
    expect(runningInTaskFolders(scan, buildProtectedPids(scan), TASK, SCOPE)).toEqual([]);
  });

  it('leaves out another task, an exited process and one with no readable folder', () => {
    const scan = input([
      process_(2100, { tagValue: OTHER_TASK, workingDirectory: WORKTREE }),
      process_(2101, { tagValue: TASK, workingDirectory: WORKTREE, exited: true }),
      process_(2102, { tagValue: TASK, workingDirectory: null }),
    ]);
    expect(runningInTaskFolders(scan, buildProtectedPids(scan), TASK, SCOPE)).toEqual([]);
  });

  it('leaves out what a held PTY, a visible app or a tmux server protects', () => {
    const scan = input([
      process_(2200, { tagValue: TASK, workingDirectory: WORKTREE }),
      process_(2201, { tagValue: TASK, workingDirectory: WORKTREE, ppid: 2200 }),
      process_(2202, { tagValue: TASK, workingDirectory: WORKTREE, role: 'visible-app' }),
      process_(2203, { tagValue: TASK, workingDirectory: WORKTREE, role: 'multiplexer' }),
    ], [2200]);
    expect(runningInTaskFolders(scan, buildProtectedPids(scan), TASK, SCOPE)).toEqual([]);
  });

  it('names the top of each subtree, so one server is one name', () => {
    const child = process_(2301, { ppid: HOST_PID, tagValue: TASK, workingDirectory: WORKTREE });
    expect(topOfRunning([HOST, child]).map((one) => one.pid)).toEqual([HOST_PID]);
  });
});

describe('who counts as a client of the task\'s tree', () => {
  it('takes the tree from the tag alone, so a stack\'s tagged dashboard working elsewhere is inside it', () => {
    const scan = input([HOST, DASHBOARD, BROWSER]);
    const query = treeConnectionQueryOf(scan, buildProtectedPids(scan), TASK);

    expect([...query.treePids].sort()).toEqual([HOST_PID, DASHBOARD_PID]);
    expect(query.clients.map((one) => one.pid)).toEqual([MAIN_PID, BROWSER_PID]);
  });

  it('keeps an untagged child of the tree inside it, so it is never its own stack\'s client', () => {
    const scan = input([HOST, CHILD, BROWSER]);
    const query = treeConnectionQueryOf(scan, buildProtectedPids(scan), TASK);

    expect(query.treePids.has(CHILD_PID)).toBe(true);
    expect(query.clients.map((one) => one.pid)).not.toContain(CHILD_PID);
  });

  it('reads a connection from outside as connected, and one inside the tree as not', () => {
    const tree = new Set([HOST_PID, DASHBOARD_PID]);

    expect(hasOutsideClient({ pairs: [{ listenerPid: HOST_PID, clientPid: BROWSER_PID }], listeningPids: [HOST_PID] }, tree)).toBe(true);
    expect(hasOutsideClient({ pairs: [{ listenerPid: HOST_PID, clientPid: DASHBOARD_PID }], listeningPids: [HOST_PID] }, tree)).toBe(false);
    expect(hasOutsideClient({ pairs: [], listeningPids: [HOST_PID] }, tree)).toBe(false);
  });

  it('never reads an exited process as a client', () => {
    const scan = input([HOST, process_(2400, { exited: true })]);
    const query = treeConnectionQueryOf(scan, buildProtectedPids(scan), TASK);

    expect(query.clients.map((one) => one.pid)).toEqual([MAIN_PID]);
  });
});

describe('probeTaskTrees', () => {
  it('answers what runs, named, and whether a client outside the tree is connected', async () => {
    const reader = new ProbeReader([HOST, DASHBOARD, BROWSER]);
    reader.read = { pairs: [{ listenerPid: HOST_PID, clientPid: BROWSER_PID }], listeningPids: [HOST_PID] };

    const result = await probeTaskTrees(request(), deps(reader));

    expect(result.failed).toBe(false);
    expect(result.entries).toEqual([{
      taskId: TASK,
      processes: [{ pid: HOST_PID, startKey: `start-${HOST_PID}`, label: `label-${HOST_PID}` }],
      connected: true,
    }]);
  });

  it('signals nothing', async () => {
    const reader = new ProbeReader([HOST, DASHBOARD]);

    await probeTaskTrees(request(), deps(reader));

    expect(reader.kill).not.toHaveBeenCalled();
  });

  it('reads no connections when asked not to, as a terminal transition asks', async () => {
    const reader = new ProbeReader([HOST]);

    const result = await probeTaskTrees(request(false), deps(reader));

    expect(reader.connectionReads).toEqual([]);
    expect(result.entries[0].connected).toBe(false);
  });

  it('reads no connections for a task with nothing running', async () => {
    const reader = new ProbeReader([DASHBOARD]);

    const result = await probeTaskTrees(request(), deps(reader));

    expect(reader.connectionReads).toEqual([]);
    expect(result.entries).toEqual([{ taskId: TASK, processes: [], connected: false }]);
  });

  it('answers failed for a scan that throws or lists nothing, never an empty table', async () => {
    const throwing = new ProbeReader([HOST]);
    throwing.failScan = true;
    const empty = new ProbeReader([HOST]);
    empty.emptyScan = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await probeTaskTrees(request(), deps(throwing))).toEqual({ entries: [], failed: true });
    expect(await probeTaskTrees(request(), deps(empty))).toEqual({ entries: [], failed: true });
    vi.restoreAllMocks();
  });

  it('scans nothing for a task whose only folder is the home directory', async () => {
    const reader = new ProbeReader([HOST]);

    const result = await probeTaskTrees({ tasks: [{ taskId: TASK, directories: ['/home/dev'], worktreePath: null }], mainPid: MAIN_PID, readConnections: true }, deps(reader));

    expect(result).toEqual({ entries: [], failed: false });
    expect(reader.scans).toBe(0);
  });
});

/**
 * The pty host's `reapTaggedProcesses` request (pty-host-core.ts): the host
 * protects every PTY it still holds, read from its own table at reap time, so a
 * young session whose kill main deferred for its exit grace is never
 * force-killed by a reap of the same task. A raw PTY (a probe's) is held in a
 * table of its own and is protected the same way. Once a PTY has exited, what
 * it left behind is fair game. The core also says when each reap batch and
 * Stop starts, which restarts main's budget for a request queued behind one.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as nodePty from 'node-pty';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import { PtyHostClient, type PtyHostTransport } from '../../src/main/pty/host/pty-host-client';
import type { PtyHostRawSpawnParams, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import { ScanStepError, type KillStrength, type ProcessScan, type ScannedProcess, type TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const MAIN_PID = 1000;
const PTY_ROOT_PID = 4242;

function fakePty(pid: number): { pty: nodePty.IPty; exit: (exitCode: number) => void } {
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: () => ({ dispose: () => {} }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as nodePty.IPty;
  return { pty, exit: (exitCode) => exitListener?.({ exitCode }) };
}

function spawnParams(): PtyHostSpawnParams {
  return {
    ptyId: 1,
    sessionId: 'session-1',
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'bash',
    args: [],
    cwd: '/mock/project',
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
  };
}

function rawSpawnParams(): PtyHostRawSpawnParams {
  return {
    ptyId: 2,
    file: 'bash',
    args: [],
    cwd: '/mock/project',
    env: {},
    cols: 120,
    rows: 30,
    name: 'xterm-256color',
  };
}

class TableReader implements TaggedProcessReader {
  kills: Array<{ pid: number; strength: KillStrength }> = [];
  constructor(private readonly processes: ScannedProcess[]) {}
  async scan(): Promise<ProcessScan> {
    return { processes: this.processes, unreadableCount: 0 };
  }
  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    this.kills.push({ pid: target.pid, strength });
    return true;
  }
  async describe(): Promise<Map<number, string>> {
    return new Map();
  }
}

function row(pid: number, ppid: number, tagValue: string | null): ScannedProcess {
  return { pid, ppid, startKey: `start-${pid}`, startedAtMs: null, tagValue, workingDirectory: '/mock/project' };
}

const REQUEST = { tasks: [{ taskId: TASK, directories: ['/mock/project'], worktreePath: null }], mainPid: MAIN_PID, stop: true };

describe('PtyHostCore reapTaggedProcesses', () => {
  it('protects a PTY it still holds and its tree, and reaps it once the PTY has exited', async () => {
    // The PTY root's parent is NOT main here, so only the host's own table can
    // protect it: the shape of a PTY whose main-side handle is already gone.
    const reader = new TableReader([
      row(MAIN_PID, 900, null),
      row(PTY_ROOT_PID, 7777, TASK),
      row(4300, PTY_ROOT_PID, TASK),
      row(5000, 1, TASK),
    ]);
    const fake = fakePty(PTY_ROOT_PID);
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnPty: (() => fake.pty) as unknown as typeof nodePty.spawn,
      createTaggedProcessReader: () => reader,
    });
    expect(core.spawn(spawnParams())).toMatchObject({ ok: true, pid: PTY_ROOT_PID });

    const whileLive = await core.reapTaggedProcesses(REQUEST);
    expect(whileLive.killedPids).toEqual([5000]);
    expect(reader.kills.map((kill) => kill.pid)).not.toContain(4300);
    expect(reader.kills.map((kill) => kill.pid)).not.toContain(PTY_ROOT_PID);

    fake.exit(0);
    reader.kills = [];
    const afterExit = await core.reapTaggedProcesses(REQUEST);
    expect(afterExit.killedPids).toEqual([4300, 5000, PTY_ROOT_PID].sort((left, right) => left - right));
  }, 10_000);

  it('protects a raw PTY (a model-picker or probe PTY) it still holds and its tree, and reaps it once the PTY has exited', async () => {
    // As above, the root's parent is not main, so only the host's own table can protect it. A raw PTY
    // is not a session PTY: it lives in `rawPtys`, which is a separate table from the sessions'.
    const RAW_ROOT_PID = 4343;
    const reader = new TableReader([
      row(MAIN_PID, 900, null),
      row(RAW_ROOT_PID, 7777, TASK),
      row(4400, RAW_ROOT_PID, TASK),
      row(5000, 1, TASK),
    ]);
    const fake = fakePty(RAW_ROOT_PID);
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnPty: (() => fake.pty) as unknown as typeof nodePty.spawn,
      createTaggedProcessReader: () => reader,
    });
    expect(core.spawnRaw(rawSpawnParams())).toEqual({ ok: true, pid: RAW_ROOT_PID });

    const whileLive = await core.reapTaggedProcesses(REQUEST);
    // Positive control: the reap ran and killed the task's ordinary leftover, so the two spared are protection and not a no-op.
    expect(whileLive.killedPids).toEqual([5000]);
    expect(reader.kills.map((kill) => kill.pid)).not.toContain(4400);
    expect(reader.kills.map((kill) => kill.pid)).not.toContain(RAW_ROOT_PID);

    fake.exit(0);
    reader.kills = [];
    const afterExit = await core.reapTaggedProcesses(REQUEST);
    expect(afterExit.killedPids).toEqual([RAW_ROOT_PID, 4400, 5000].sort((left, right) => left - right));
  }, 10_000);

  it('answers with nothing killed on a platform with no reader', async () => {
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => null,
    });
    await expect(core.reapTaggedProcesses(REQUEST)).resolves.toEqual({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, failureCause: null, entries: [] });
    await expect(core.stopReportedProcess({ pid: 5000, startKey: 'start-5000', mainPid: MAIN_PID })).resolves.toEqual({
      outcome: 'failed', failureCode: null, failurePass: null, failureCause: null, failureReason: null,
    });
  });

  it('hands main the cause a reader step failed with, for a reap and for a Stop', async () => {
    // A non-null cause is what a field-by-field rebuild of the result in the host would drop,
    // and every other assertion here sees null.
    const failingReader: TaggedProcessReader = {
      async scan(): Promise<ProcessScan> {
        throw new ScanStepError('window_list', 'lsappinfo list did not run: timeout', 'timeout');
      },
      async kill(): Promise<boolean> {
        throw new Error('a failed scan kills nothing');
      },
      async describe(): Promise<Map<number, string>> {
        return new Map();
      },
    };
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => failingReader,
    });

    const reapResult = await core.reapTaggedProcesses(REQUEST);
    expect(reapResult).toMatchObject({
      killedPids: [],
      failureCode: 'window_list',
      failurePass: 'first',
      failureCause: 'timeout',
      failureReason: 'lsappinfo list did not run: timeout',
    });

    const stopResult = await core.stopReportedProcess({ pid: 5000, startKey: 'start-5000', mainPid: MAIN_PID });
    expect(stopResult).toMatchObject({
      outcome: 'failed',
      failureCode: 'window_list',
      failurePass: 'first',
      failureCause: 'timeout',
      failureReason: 'lsappinfo list did not run: timeout',
    });
  });

  it('never stops a PTY it still holds, even when the user names it', async () => {
    const reader = new TableReader([
      row(MAIN_PID, 900, null),
      row(PTY_ROOT_PID, 7777, TASK),
    ]);
    const fake = fakePty(PTY_ROOT_PID);
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      spawnPty: (() => fake.pty) as unknown as typeof nodePty.spawn,
      createTaggedProcessReader: () => reader,
    });
    core.spawn(spawnParams());
    // A refusal, not a failure: no code goes back to main.
    await expect(core.stopReportedProcess({ pid: PTY_ROOT_PID, startKey: `start-${PTY_ROOT_PID}`, mainPid: MAIN_PID })).resolves.toEqual({
      outcome: 'failed', failureCode: null, failurePass: null, failureCause: null, failureReason: null,
    });
    expect(reader.kills).toEqual([]);
  });

  it('says when each reap batch and each Stop starts, by the request method main restarts the budget of', async () => {
    const reader = new TableReader([row(MAIN_PID, 900, null)]);
    const started: string[] = [];
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => reader,
      onBatchStarted: (method) => { started.push(method); },
    });
    await core.reapTaggedProcesses(REQUEST);
    await core.stopReportedProcess({ pid: 5000, startKey: 'start-5000', mainPid: MAIN_PID });
    expect(started).toEqual(['reapTaggedProcesses', 'stopReportedProcess']);
  });
});

describe('PtyHostCore checkReportedProcesses', () => {
  it('answers through the reader\'s identity check, with no scan, and starts no queued batch', async () => {
    const reader = new TableReader([row(MAIN_PID, 900, null)]);
    const scan = vi.spyOn(reader, 'scan');
    const isRunning = vi.fn(async (target: Pick<ScannedProcess, 'pid' | 'startKey'>) => target.pid === 5000);
    Object.assign(reader, { isRunning });
    const started: string[] = [];
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => reader,
      onBatchStarted: (method) => { started.push(method); },
    });

    const answers = await core.handleRequest('checkReportedProcesses', { identities: [{ pid: 5000, startKey: 'start-5000' }, { pid: 5001, startKey: 'start-5001' }] });

    expect(answers).toEqual([true, false]);
    expect(isRunning).toHaveBeenCalledTimes(2);
    expect(scan).not.toHaveBeenCalled();
    expect(started).toEqual([]);
  });

  it('answers unknown for every identity on a platform with no reader', async () => {
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => null,
    });
    await expect(core.checkReportedProcesses([{ pid: 5000, startKey: 'start-5000' }])).resolves.toEqual([null]);
  });
});

describe('PtyHostCore probeTaskProcesses request (the Stop script\'s question)', () => {
  const PROBE_REQUEST = { tasks: REQUEST.tasks, mainPid: MAIN_PID, readConnections: false };

  it('reaches the reaper\'s probe: scans, signals nothing, and answers what the task has running', async () => {
    const reader = new TableReader([
      row(MAIN_PID, 900, null),
      row(5000, 1, TASK),
    ]);
    const scan = vi.spyOn(reader, 'scan');
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => reader,
    });

    const answer = await core.handleRequest('probeTaskProcesses', PROBE_REQUEST);

    expect(scan).toHaveBeenCalledTimes(1);
    expect(answer.failed).toBe(false);
    expect(answer.entries).toHaveLength(1);
    expect(answer.entries[0]).toMatchObject({ taskId: TASK, connected: false });
    expect(answer.entries[0].processes.map((probed) => probed.pid)).toEqual([5000]);
    expect(reader.kills).toEqual([]);
  });

  it('answers failed, with no entries, on a platform with no reader', async () => {
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => null,
    });

    await expect(core.handleRequest('probeTaskProcesses', PROBE_REQUEST)).resolves.toEqual({ entries: [], failed: true });
  });
});

describe('PtyHostClient.probeTaskProcesses', () => {
  it('sends the probeTaskProcesses request with the budget it was given, and returns the host\'s answer', async () => {
    const answer = { entries: [], failed: false };
    const request = vi.fn(async () => answer);
    const transport: PtyHostTransport = {
      post: () => undefined,
      request: request as unknown as PtyHostTransport['request'],
      setEventListener: () => undefined,
      hostPid: 1234,
      shutdown: () => undefined,
    };
    const probe = { tasks: REQUEST.tasks, mainPid: MAIN_PID, readConnections: true };

    const result = await new PtyHostClient(transport).probeTaskProcesses(probe, 5_000);

    expect(request).toHaveBeenCalledWith('probeTaskProcesses', probe, { timeoutMs: 5_000 });
    expect(result).toBe(answer);
  });
});

describe('PtyHostCore awaitAgentExit request', () => {
  it('dispatches to awaitAgentExit with the task ids, and answers at once when the host holds no root for them', async () => {
    const core = new PtyHostCore({
      emit: () => {},
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      createTaggedProcessReader: () => null,
    });
    const awaitAgentExit = vi.spyOn(core, 'awaitAgentExit');

    const answer = await core.handleRequest('awaitAgentExit', { taskIds: [TASK, 'other-task'] });

    // Called with the unwrapped list, not the whole params object.
    expect(awaitAgentExit).toHaveBeenCalledTimes(1);
    expect(awaitAgentExit).toHaveBeenCalledWith([TASK, 'other-task']);
    // No ledger root for either task: nothing found, nothing waited on.
    expect(answer).toEqual({ found: [], stillRunning: [], waitedMs: 0 });
  });
});

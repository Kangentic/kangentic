/**
 * The pty host's `reapTaggedProcesses` request (pty-host-core.ts): the host
 * protects every PTY it still holds, read from its own table at reap time, so a
 * young session whose kill main deferred for its exit grace is never
 * force-killed by a reap of the same task. A raw PTY (a probe's) is held in a
 * table of its own and is protected the same way. Once a PTY has exited, what
 * it left behind is fair game.
 */
import { describe, it, expect, vi } from 'vitest';
import type * as nodePty from 'node-pty';
import { PtyHostCore } from '../../src/main/pty/host/pty-host-core';
import type { PtyHostRawSpawnParams, PtyHostSpawnParams } from '../../src/main/pty/host/protocol';
import type { KillStrength, ProcessScan, ScannedProcess, TaggedProcessReader } from '../../src/main/pty/process-tag/process-scan';

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
    await expect(core.reapTaggedProcesses(REQUEST)).resolves.toEqual({ killedPids: [], unreadableCount: 0, failureReason: null, failureCode: null, failurePass: null, entries: [] });
    await expect(core.stopReportedProcess({ pid: 5000, startKey: 'start-5000', mainPid: MAIN_PID })).resolves.toEqual({
      outcome: 'failed', failureCode: null, failurePass: null, failureReason: null,
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
      outcome: 'failed', failureCode: null, failurePass: null, failureReason: null,
    });
    expect(reader.kills).toEqual([]);
  });
});

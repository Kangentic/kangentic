/**
 * The update of an SSH host's program after an update of the app (`program-update.ts`, task #1227), against
 * an in-memory host and session layer: when it swaps, when it waits, what it holds, and that every failure
 * leaves the old program running with the agents resumed.
 *
 * On Linux, the stop, list and wait scripts also run for real under `sh` against stand-in processes.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIST_CHILDREN_SCRIPT, STOP_DAEMON_SCRIPT, WAIT_FOR_EXIT_SCRIPT } from '../../src/main/remote/program-update-scripts';
import {
  createProgramUpdater,
  type EndedTerminal,
  type HeldRemoteSession,
  type LinkState,
  type ProgramUpdateStage,
  type ProgramUpdater,
} from '../../src/main/remote/program-update';
import type { HelperSnapshot, HostCommandRequest, HostCommandResult, HostProgramInfo } from '../../src/main/remote/protocol/messages';

const HOST = 'host-1';
const APP_VERSION = '0.65.0';

interface FakeSession {
  held: HeldRemoteSession;
  pid: number;
  alive: boolean;
  atSafePoint: boolean;
  freshDraft: boolean;
  /** For a Command Terminal: whether it can come back in its slot. */
  restartability?: 'restart' | 'unused' | 'unresumable';
}

type StopBehavior = 'exits' | 'ignored' | 'never-back' | 'refused' | 'other-version';

/** A host and this app's sessions on it, with every call the updater makes written down. */
class FakeRig {
  version: string | null = '0.62.0';
  daemonPid = 4000;
  sessions: FakeSession[] = [];
  /** Live terminals the host runs that the app holds no PTY for. */
  unheldLive = 0;
  stopBehavior: StopBehavior = 'exits';
  retireSupported = false;
  programInfoFails = false;
  resumeFails = false;
  suspendLeavesTerminal = false;
  startInFlight = false;
  startsHeld = false;
  /** Replaced by a test that changes a session's answer at a given moment. */
  isAtSafePointOf: (sessionId: string) => boolean = (sessionId) => this.find(sessionId)?.atSafePoint ?? false;
  readonly calls: string[] = [];
  readonly reports: ProgramUpdateStage[] = [];
  readonly resumed: Array<Map<string, Set<string>>> = [];
  readonly terminalsStarted: string[] = [];
  readonly terminalsGivenUp: string[] = [];
  /** Command Terminals whose `startAgain` rejects. */
  readonly failingStarts = new Set<string>();
  /** When set, a task's suspend waits for it, so a test can act while the swap is mid-suspend. */
  suspendGate: Promise<void> | null = null;
  suspendEntered = false;
  readonly heldDuringResume: boolean[] = [];
  readonly logs: string[] = [];
  private changeListener: (() => void) | null = null;
  readonly updater: ProgramUpdater;

  constructor() {
    this.updater = createProgramUpdater({
      appVersion: () => APP_VERSION,
      programInfo: async () => this.programInfo(),
      snapshot: async () => this.snapshot(),
      runCommand: async (_hostId, request) => this.runCommand(request),
      supports: (_hostId, method) => method !== 'retireIfIdle' || this.retireSupported,
      retireIfIdle: async () => {
        this.calls.push('retire');
        const liveSessions = this.liveCount();
        if (liveSessions > 0) return { retired: false, liveSessions };
        this.scheduleExit();
        return { retired: true, liveSessions: 0 };
      },
      liveRemotePtys: () => this.sessions.filter((session) => session.alive).map((session, index) => ({ sessionId: session.held.sessionId, ptyId: index + 1 })),
      heldSessions: () => this.sessions.filter((session) => session.alive).map((session) => session.held),
      isAtSafePoint: (held) => this.isAtSafePointOf(held.sessionId),
      hasStartInFlight: () => this.startInFlight,
      hasFreshDraft: async (sessionId) => this.find(sessionId)?.freshDraft ?? false,
      suspendTask: async (held, stillEligible) => {
        this.suspendEntered = true;
        if (this.suspendGate) await this.suspendGate;
        const session = this.find(held.sessionId);
        if (!session?.alive) return 'not-live';
        if (!stillEligible()) return 'declined';
        session.alive = false;
        if (this.suspendLeavesTerminal) this.unheldLive = 1;
        this.calls.push(`suspend:${held.sessionId}`);
        return 'paused';
      },
      terminalRestartability: (held) => this.find(held.sessionId)?.restartability ?? 'restart',
      endUnusedTerminal: (held) => {
        const session = this.find(held.sessionId);
        if (session) session.alive = false;
        this.calls.push(`end-unused:${held.sessionId}`);
      },
      endTerminal: (held, stillEligible) => {
        const session = this.find(held.sessionId);
        if (!session?.alive) return 'failed';
        if (!stillEligible()) return 'deferred';
        session.alive = false;
        this.calls.push(`end-terminal:${held.sessionId}`);
        const terminal: EndedTerminal = {
          startAgain: async () => {
            this.terminalsStarted.push(held.sessionId);
            this.calls.push(`start-terminal:${held.sessionId}`);
            if (this.failingStarts.has(held.sessionId)) throw new Error('start failed');
          },
          giveUp: () => { this.terminalsGivenUp.push(held.sessionId); },
        };
        return terminal;
      },
      resumeTasks: async (sessionIdsByProject) => {
        this.calls.push('resume');
        this.heldDuringResume.push(this.startsHeld);
        if (this.resumeFails) throw new Error('resume failed');
        this.resumed.push(new Map([...sessionIdsByProject].map(([projectId, ids]) => [projectId, new Set(ids)])));
      },
      holdStarts: () => {
        this.calls.push('hold');
        this.startsHeld = true;
        return () => {
          this.calls.push('release');
          this.startsHeld = false;
        };
      },
      onSessionChange: (listener) => {
        this.changeListener = listener;
        return () => { this.changeListener = null; };
      },
      stageReporter: { report: (_error, stage) => { this.reports.push(stage); } },
      log: (line) => { this.logs.push(line); },
      timing: { settleMs: 20, emptyBoundMs: 200, emptyPollMs: 10, dropBoundMs: 150, reconnectBoundMs: 150, agentExitFallbackMs: 5 },
    });
    this.updater.onLinkState(HOST, 'connected');
  }

  addSession(sessionId: string, kind: HeldRemoteSession['kind'] = 'task', projectId = 'project-1'): FakeSession {
    const session: FakeSession = {
      held: { sessionId, taskId: kind === 'task' ? `task-${sessionId}` : null, projectId, kind },
      pid: 5000 + this.sessions.length,
      alive: true,
      atSafePoint: true,
      freshDraft: false,
    };
    this.sessions.push(session);
    return session;
  }

  /** Something about a session changed: the updater re-checks, as the session events make it. */
  change(): void {
    this.changeListener?.();
  }

  setLink(state: LinkState): void {
    this.updater.onLinkState(HOST, state);
  }

  private find(sessionId: string): FakeSession | undefined {
    return this.sessions.find((session) => session.held.sessionId === sessionId);
  }

  private liveCount(): number {
    return this.sessions.filter((session) => session.alive).length + this.unheldLive;
  }

  private programInfo(): HostProgramInfo {
    if (this.programInfoFails) throw new Error('no answer');
    return { version: this.version, startedAt: '2026-11-27T00:00:00.000Z', liveSessions: this.liveCount(), installedVersions: [] };
  }

  private snapshot(): HelperSnapshot {
    const records = this.sessions.map((session) => ({
      sessionId: session.held.sessionId, taskId: session.held.taskId, projectId: session.held.projectId, pid: session.pid,
      alive: session.alive, exitCode: null, wirePtyId: null, inAltScreen: false,
    }));
    for (let index = 0; index < this.unheldLive; index += 1) {
      records.push({ sessionId: `unheld-${index}`, taskId: null, projectId: 'project-1', pid: 9000 + index, alive: true, exitCode: null, wirePtyId: null, inAltScreen: false });
    }
    return { ownerEpoch: 1, daemonPid: this.daemonPid, daemonStartedAt: '2026-11-27T00:00:00.000Z', sessions: records };
  }

  private runCommand(request: HostCommandRequest): HostCommandResult {
    const name = request.args[2];
    if (name === 'kangentic-list') {
      this.calls.push('list');
      return { code: 0, stdout: request.args.slice(3).map((pid) => String(Number(pid) + 100)).join('\n'), stderr: '', timedOut: false };
    }
    if (name === 'kangentic-wait') {
      this.calls.push('wait');
      return { code: 0, stdout: '0\n', stderr: '', timedOut: false };
    }
    if (name === 'kangentic-stop') {
      this.calls.push(`stop:${request.args[3]}:${request.args[4]}`);
      if (this.stopBehavior === 'refused') return { code: 5, stdout: 'kangentic-stop:not-the-program\n', stderr: '', timedOut: false };
      this.scheduleExit();
      return { code: 0, stdout: 'kangentic-stop:scheduled\n', stderr: '', timedOut: false };
    }
    throw new Error(`unexpected command ${name}`);
  }

  /** What the old program's exit does to the link. */
  private scheduleExit(): void {
    if (this.stopBehavior === 'ignored') return;
    setTimeout(() => {
      this.setLink('reconnecting');
      if (this.stopBehavior === 'never-back') return;
      setTimeout(() => {
        this.version = this.stopBehavior === 'other-version' ? '0.63.0' : APP_VERSION;
        this.daemonPid += 1;
        this.setLink('connected');
      }, 5);
    }, 5);
  }
}

const rigs: FakeRig[] = [];
function makeRig(): FakeRig {
  const rig = new FakeRig();
  rigs.push(rig);
  return rig;
}

afterEach(() => {
  for (const rig of rigs.splice(0)) rig.updater.dispose();
});

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('which programs are swapped', () => {
  it('swaps an older, empty program at once: hold, stop, the link back on the new program, release, no suspend', async () => {
    const rig = makeRig();
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('release'));
    expect(rig.calls).toEqual(['hold', 'stop:4000:0.62.0', 'release']);
    expect(rig.version).toBe(APP_VERSION);
    expect(rig.reports).toEqual([]);
  });

  it.each([
    ['newer', '0.66.0'],
    ['equal', APP_VERSION],
    ['a development run', null],
  ])('never swaps a %s program', async (_label, version) => {
    const rig = makeRig();
    rig.version = version;
    await rig.updater.consider(HOST);
    await settle();
    expect(rig.calls).toEqual([]);
  });

  it('never swaps when the host cannot say which program it runs', async () => {
    const rig = makeRig();
    rig.programInfoFails = true;
    await rig.updater.consider(HOST);
    await settle();
    expect(rig.calls).toEqual([]);
    expect(rig.reports).toEqual([]);
  });

  it('never swaps while the host runs a terminal this app holds no PTY for, and looks again later', async () => {
    const rig = makeRig();
    rig.unheldLive = 1;
    await rig.updater.consider(HOST);
    await settle();
    expect(rig.calls).toEqual([]);
    // Recovery took it back: the next look swaps.
    rig.unheldLive = 0;
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('release'));
    expect(rig.calls).toContain('stop:4000:0.62.0');
  });

  // The look and the swap are a settle apart, and another computer on the same host can start a terminal in it.
  // Red-green: drop the `everyLiveSessionIsHeld` check in `swap` and the agent is suspended, then reported at suspend.
  it('stops nothing when a terminal this app does not hold appears between the look and the swap, and looks again later', async () => {
    const rig = makeRig();
    const session = rig.addSession('a');
    await rig.updater.consider(HOST);
    // Watching, with the settle armed: the unheld terminal starts inside it.
    rig.unheldLive = 1;
    await until(() => rig.calls.includes('release'));
    expect(rig.calls).toEqual(['hold', 'release']);
    expect(rig.reports).toEqual([]);
    expect(session.alive).toBe(true);

    // Not failed: once nothing unheld runs, the next look swaps.
    rig.unheldLive = 0;
    rig.calls.length = 0;
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).toContain('stop:4000:0.62.0');
  });

  it("stops a program that has retireIfIdle through it, not by its pid", async () => {
    const rig = makeRig();
    rig.retireSupported = true;
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('release'));
    expect(rig.calls).toEqual(['hold', 'retire', 'release']);
  });
});

describe('a busy program waits until every agent is between turns', () => {
  it('waits while any agent is off its safe point, and swaps once all are idle', async () => {
    const rig = makeRig();
    rig.addSession('a');
    // A turn, an open prompt, a typed draft and a held message on its way each read as "not at a safe
    // point" (`isAtSafePoint`, pinned in `program-update-sessions.test.ts`).
    const busy = rig.addSession('b');
    busy.atSafePoint = false;
    await rig.updater.consider(HOST);
    await settle(80);
    expect(rig.calls).toEqual([]);
    busy.atSafePoint = true;
    rig.change();
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).toEqual(['hold', 'list', 'suspend:a', 'suspend:b', 'wait', 'stop:4000:0.62.0', 'release', 'resume']);
    expect(rig.resumed).toEqual([new Map([['project-1', new Set(['a', 'b'])]])]);
  });

  it('starts the settle over when a turn starts during it', async () => {
    const rig = makeRig();
    const session = rig.addSession('a');
    await rig.updater.consider(HOST);
    // Busy again before the 20 ms settle ends, idle again later.
    session.atSafePoint = false;
    rig.change();
    await settle(60);
    expect(rig.calls).toEqual([]);
    session.atSafePoint = true;
    rig.change();
    await until(() => rig.calls.includes('resume'));
  });

  it('asks every agent before stopping any: a draft the mirror missed stops nothing and the wait goes on', async () => {
    const rig = makeRig();
    rig.addSession('a');
    const second = rig.addSession('b');
    second.freshDraft = true;
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('release'));
    expect(rig.calls).toEqual(['hold', 'release']);
    expect(rig.reports).toEqual([]);
    // The draft is sent: the next settle swaps.
    second.freshDraft = false;
    rig.change();
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).toContain('stop:4000:0.62.0');
  });

  it('rolls back and waits again when a turn begins under a task lock, after another agent was stopped', async () => {
    const rig = makeRig();
    rig.addSession('a');
    const second = rig.addSession('b');
    // `b` is idle when asked, and starts a turn while its pause waits for its task lock.
    let asked = 0;
    const original = rig.isAtSafePointOf.bind(rig);
    rig.isAtSafePointOf = (sessionId) => {
      if (sessionId === 'b' && rig.calls.includes('suspend:a')) {
        asked += 1;
        return false;
      }
      return original(sessionId);
    };
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).toEqual(['hold', 'list', 'suspend:a', 'release', 'resume']);
    expect(asked).toBeGreaterThan(0);
    expect(second.alive).toBe(true);
    expect(rig.version).toBe('0.62.0');
    expect(rig.reports).toEqual([]);
  });

  it('waits while a start is on its way', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.startInFlight = true;
    await rig.updater.consider(HOST);
    await settle(80);
    expect(rig.calls).toEqual([]);
    rig.startInFlight = false;
    rig.change();
    await until(() => rig.calls.includes('resume'));
  });

  it('holds starts from the hold to the release, and releases before the resume', async () => {
    const rig = makeRig();
    rig.addSession('a');
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls.indexOf('hold')).toBeLessThan(rig.calls.indexOf('suspend:a'));
    expect(rig.calls.indexOf('release')).toBeLessThan(rig.calls.indexOf('resume'));
    expect(rig.heldDuringResume).toEqual([false]);
  });

  it('ends a Command Terminal and starts it again in its slot after the tasks', async () => {
    const rig = makeRig();
    rig.addSession('terminal', 'command-terminal');
    rig.addSession('a');
    await rig.updater.consider(HOST);
    await until(() => rig.terminalsStarted.length === 1);
    expect(rig.calls).toEqual(['hold', 'list', 'end-terminal:terminal', 'suspend:a', 'wait', 'stop:4000:0.62.0', 'release', 'resume', 'start-terminal:terminal']);
  });

  // A terminal nobody typed into has no conversation to resume. Read as "a turn began", it rolled the swap back
  // every settle, restarting the task agents beside it each time.
  it('ends an unused Command Terminal as any untouched terminal ends, and stops each task agent once', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.addSession('unused-terminal', 'command-terminal').restartability = 'unused';
    rig.addSession('b');
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    await settle(80);
    expect(rig.calls).toEqual(['hold', 'list', 'suspend:a', 'end-unused:unused-terminal', 'suspend:b', 'wait', 'stop:4000:0.62.0', 'release', 'resume']);
    expect(rig.terminalsStarted).toEqual([]);
  });

  it('holds the swap while a used Command Terminal cannot resume its conversation, stopping nothing', async () => {
    const rig = makeRig();
    rig.addSession('a');
    const terminal = rig.addSession('terminal', 'command-terminal');
    terminal.restartability = 'unresumable';
    await rig.updater.consider(HOST);
    await settle(80);
    expect(rig.calls).toEqual([]);
    terminal.alive = false;
    rig.change();
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).toContain('suspend:a');
  });

  it("waits for a workflow's own agent to end", async () => {
    const rig = makeRig();
    rig.addSession('a');
    const workflow = rig.addSession('workflow-agent', 'workflow');
    await rig.updater.consider(HOST);
    await settle(80);
    expect(rig.calls).toEqual([]);
    workflow.alive = false;
    rig.change();
    await until(() => rig.calls.includes('resume'));
    expect(rig.calls).not.toContain('suspend:workflow-agent');
  });
});

describe('a swap that cannot finish leaves the old program and the agents back', () => {
  it('fails at stop when the pid is not the program, resumes, and does not try again this run', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.stopBehavior = 'refused';
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    expect(rig.reports).toEqual(['stop']);
    expect(rig.calls.indexOf('release')).toBeLessThan(rig.calls.indexOf('resume'));
    expect(rig.version).toBe('0.62.0');
    rig.calls.length = 0;
    rig.setLink('connected');
    await rig.updater.consider(HOST);
    await settle();
    expect(rig.calls).toEqual([]);
  });

  it('fails at stop when the program does not exit', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.stopBehavior = 'ignored';
    await rig.updater.consider(HOST);
    await until(() => rig.calls.includes('resume'));
    expect(rig.reports).toEqual(['stop']);
  });

  it('fails at reconnect, and resumes once the link is back', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.stopBehavior = 'never-back';
    await rig.updater.consider(HOST);
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['reconnect']);
    expect(rig.calls).not.toContain('resume');
    expect(rig.startsHeld).toBe(false);
    rig.setLink('connected');
    await until(() => rig.calls.includes('resume'));
    expect(rig.resumed).toEqual([new Map([['project-1', new Set(['a'])]])]);
  });

  it('fails at reconnect when the link comes back to another version', async () => {
    const rig = makeRig();
    rig.stopBehavior = 'other-version';
    await rig.updater.consider(HOST);
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['reconnect']);
  });

  it('fails at suspend when a terminal is still running after the suspend', async () => {
    const rig = makeRig();
    rig.addSession('a');
    // The host still counts a terminal once the agent was suspended.
    rig.suspendLeavesTerminal = true;
    await rig.updater.consider(HOST);
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['suspend']);
    expect(rig.calls).toContain('resume');
    expect(rig.calls.filter((call) => call.startsWith('stop'))).toEqual([]);
  });

  it('fails at hold when the host cannot be asked again under the hold, and stops nothing', async () => {
    const rig = makeRig();
    rig.addSession('a');
    await rig.updater.consider(HOST);
    // The host stops answering between the look and the swap.
    rig.programInfoFails = true;
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['hold']);
    expect(rig.calls).toEqual(['hold', 'release']);
    expect(rig.sessions[0].alive).toBe(true);
  });

  // The pid and the version come from the host and become the stop script's arguments. The script refuses a bad
  // one too, but only on the host; these never leave this computer. Red-green: drop either check in `stopProgram`
  // and the fake host records a `stop:` call and the swap succeeds.
  it.each([
    ['a daemon pid that can name no program', (rig: FakeRig) => { rig.daemonPid = 1; }],
    ['a version that names no program folder', (rig: FakeRig) => { rig.version = '0.62.0/../../x'; }],
  ])('fails at stop without sending the stop for %s', async (_label, adjust) => {
    const rig = makeRig();
    adjust(rig);
    const versionBefore = rig.version;
    await rig.updater.consider(HOST);
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['stop']);
    expect(rig.calls).toEqual(['hold', 'release']);
    expect(rig.version).toBe(versionBefore);
  });

  // `remote-hosting.ts` chains the look under `void`, so a throw out of it would be an unhandled rejection.
  // Red-green: remove the try/catch in `consider` and the promise rejects.
  it('never rejects when its own check throws, and reports it at hold', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.isAtSafePointOf = () => { throw new Error('safe point read failed'); };
    await expect(rig.updater.consider(HOST)).resolves.toBeUndefined();
    expect(rig.reports).toEqual(['hold']);
    expect(rig.calls).toEqual([]);
  });

  it('reports resume when the agents cannot be brought back', async () => {
    const rig = makeRig();
    rig.addSession('a');
    rig.resumeFails = true;
    await rig.updater.consider(HOST);
    await until(() => rig.reports.length === 1);
    expect(rig.reports).toEqual(['resume']);
    expect(rig.version).toBe(APP_VERSION);
  });
});

describe('a host removed or an app quitting during the update', () => {
  /** A swap that ended a Command Terminal and could not finish with the link up: the set waits for the next connection. */
  async function keepTerminalForNextConnection(rig: FakeRig): Promise<void> {
    rig.addSession('terminal', 'command-terminal');
    rig.stopBehavior = 'never-back';
    await rig.updater.consider(HOST);
    await until(() => rig.logs.some((line) => line.includes('resume once its link is back')));
    expect(rig.reports).toEqual(['reconnect']);
  }

  it('cancels the swap when the host is forgotten during its settle window', async () => {
    const rig = makeRig();
    const session = rig.addSession('a');
    session.atSafePoint = false;
    await rig.updater.consider(HOST);
    session.atSafePoint = true;
    rig.change();
    // The recheck is queued as a microtask; once it ran, the settle (20 ms) is running. The host is removed inside it.
    await Promise.resolve();
    await Promise.resolve();
    rig.updater.forgetHost(HOST);
    await settle(100);
    expect(rig.calls).toEqual([]);
    expect(rig.reports).toEqual([]);
  });

  it('gives up a Command Terminal kept for the next connection when the host is forgotten, and never starts it, even when the link returns', async () => {
    const rig = makeRig();
    await keepTerminalForNextConnection(rig);
    expect(rig.terminalsGivenUp).toEqual([]);
    rig.updater.forgetHost(HOST);
    expect(rig.terminalsGivenUp).toEqual(['terminal']);
    rig.setLink('connected');
    await settle(60);
    expect(rig.terminalsGivenUp).toEqual(['terminal']);
    expect(rig.terminalsStarted).toEqual([]);
  });

  it('gives up a terminal kept for the next connection when the updater is disposed', async () => {
    const rig = makeRig();
    await keepTerminalForNextConnection(rig);
    rig.updater.dispose();
    expect(rig.terminalsGivenUp).toEqual(['terminal']);
    rig.setLink('connected');
    await settle(60);
    expect(rig.terminalsGivenUp).toEqual(['terminal']);
    expect(rig.terminalsStarted).toEqual([]);
  });

  it('stops the swap before the stop when the host is forgotten mid-suspend, and reports nothing', async () => {
    const rig = makeRig();
    rig.retireSupported = true;
    rig.addSession('a');
    let openGate: () => void = () => undefined;
    rig.suspendGate = new Promise<void>((resolve) => { openGate = resolve; });
    await rig.updater.consider(HOST);
    await until(() => rig.suspendEntered);
    rig.updater.forgetHost(HOST);
    openGate();
    await until(() => rig.calls.includes('release'));
    await settle(60);
    expect(rig.calls.filter((call) => call === 'retire' || call.startsWith('stop'))).toEqual([]);
    expect(rig.version).toBe('0.62.0');
    expect(rig.reports).toEqual([]);
  });

  it('reports a Command Terminal that cannot start again once under resume, and still starts the next one', async () => {
    const rig = makeRig();
    rig.addSession('first', 'command-terminal');
    rig.addSession('second', 'command-terminal');
    rig.failingStarts.add('first');
    await rig.updater.consider(HOST);
    await until(() => rig.terminalsStarted.length === 2);
    expect(rig.terminalsStarted).toEqual(['first', 'second']);
    expect(rig.reports).toEqual(['resume']);
  });
});

/** The scripts on a real `sh` and real processes. `/proc` is Linux's. */
describe.runIf(process.platform === 'linux')('the stop, list and wait scripts', () => {
  const children: ChildProcess[] = [];
  const roots: string[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  /** A process whose command line reads as `<home>/.kangentic/host/<version>/app/host.js daemon`. */
  function standInDaemon(version: string, options: { ignoresTerm?: boolean } = {}): ChildProcess {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-update-'));
    roots.push(home);
    const program = path.join(home, '.kangentic', 'host', version, 'app', 'host.js');
    fs.mkdirSync(path.dirname(program), { recursive: true });
    fs.writeFileSync(program, options.ignoresTerm
      ? "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);\n"
      : 'setInterval(() => undefined, 1000);\n');
    const child = spawn(process.execPath, [program, 'daemon'], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  const runScript = (script: string, name: string, args: string[]): { code: number | null; stdout: string } => {
    const result = spawnSync('sh', ['-c', script, name, ...args], { encoding: 'utf8' });
    return { code: result.status, stdout: result.stdout };
  };

  const exited = (child: ChildProcess): Promise<NodeJS.Signals | null> => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.signalCode);
    else child.once('exit', (_code, signal) => resolve(signal));
  });

  it('stops the daemon it names with a TERM, in the background', async () => {
    const daemon = standInDaemon('0.62.0');
    await settle(200);
    const result = runScript(STOP_DAEMON_SCRIPT, 'kangentic-stop', [String(daemon.pid), '0.62.0']);
    expect(result).toEqual({ code: 0, stdout: 'kangentic-stop:scheduled\n' });
    expect(await exited(daemon)).toBe('SIGTERM');
  });

  it('refuses a pid that is not that version of the program, and a hostile argument', async () => {
    const daemon = standInDaemon('0.62.0');
    await settle(200);
    expect(runScript(STOP_DAEMON_SCRIPT, 'kangentic-stop', [String(daemon.pid), '0.63.0'])).toEqual({ code: 5, stdout: 'kangentic-stop:not-the-program\n' });
    expect(runScript(STOP_DAEMON_SCRIPT, 'kangentic-stop', [`${daemon.pid}; kill -9 ${daemon.pid}`, '0.62.0'])).toEqual({ code: 3, stdout: 'kangentic-stop:bad-pid\n' });
    expect(runScript(STOP_DAEMON_SCRIPT, 'kangentic-stop', ['1', '0.62.0'])).toEqual({ code: 3, stdout: 'kangentic-stop:bad-pid\n' });
    await settle(1_500);
    expect(daemon.exitCode).toBeNull();
    expect(daemon.signalCode).toBeNull();
  });

  it('sends KILL when the TERM does not take within its bound', async () => {
    const daemon = standInDaemon('0.62.0', { ignoresTerm: true });
    await settle(200);
    expect(runScript(STOP_DAEMON_SCRIPT, 'kangentic-stop', [String(daemon.pid), '0.62.0']).code).toBe(0);
    expect(await exited(daemon)).toBe('SIGKILL');
  }, 20_000);

  it("lists a shell's children and waits for them to exit", async () => {
    const shell = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore' });
    children.push(shell);
    await settle(200);
    const listed = runScript(LIST_CHILDREN_SCRIPT, 'kangentic-list', [String(shell.pid)]);
    const pids = listed.stdout.split(/\s+/).filter(Boolean);
    expect(pids).toHaveLength(1);
    process.kill(Number(pids[0]), 'SIGTERM');
    expect(runScript(WAIT_FOR_EXIT_SCRIPT, 'kangentic-wait', pids)).toEqual({ code: 0, stdout: '0\n' });
  });
});

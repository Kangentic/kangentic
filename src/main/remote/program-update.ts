/**
 * Swap the program on an SSH host for the app's own version after an update of the app, with no button
 * and no notice (task #1227).
 *
 * A new relay joins whatever program already listens on the host's socket (`helper/host-main.ts`), so an
 * update of the app leaves the old daemon running, and every fix in the helper stranded, until something
 * stops it. The daemon holds every remote agent's terminal, so stopping it ends them. This waits for the
 * moment every agent this app runs there is between turns, suspends them through the normal paths, stops
 * the daemon, lets the link dial again (its relay command is this app's version, so the relay starts a
 * daemon of that version), and brings the agents back as a restart does.
 *
 * - **When.** After a host's first connection of the run, once its recovery has taken back the agents a
 *   quit left running, and only for a program older than the app's. Never a newer one (another computer
 *   on the account may have put it there), an equal one, or a development run (no version).
 * - **Whose agents.** A connected link means this install owns the daemon: the helper refuses another
 *   install while it holds terminals or a connection (`vetPeer`). So a live terminal there that this app
 *   holds no PTY for is an agent of ours not taken back yet, and the swap waits for another try.
 * - **Never a turn cut short.** Every task agent and Command Terminal on the host must be idle at its
 *   prompt (`quickSafePoint`), with no draft typed and no held message on its way, for `SETTLE_MS`. A turn
 *   that starts resets the wait. A workflow's own agent holds the swap until it ends.
 * - **Never an agent left suspended.** A swap that cannot finish leaves the old program running and resumes
 *   what it suspended, and with the link down keeps them for its next connection. Each stage that stops it
 *   reports under its fixed `stage`.
 */

import { compareVersions } from '../../shared/announcements';
import { ranForBucket } from '../analytics/handled-report';
import { LIST_CHILDREN_SCRIPT, STOP_DAEMON_SCRIPT, WAIT_FOR_EXIT_SCRIPT } from './program-update-scripts';
import type { HelperMethod, HelperSnapshot, HostCommandRequest, HostCommandResult, HostProgramInfo, RemoteSessionRoute } from './protocol/messages';

export type ProgramUpdateStage = 'hold' | 'suspend' | 'stop' | 'reconnect' | 'resume';

export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** One of this app's sessions on a host, as the updater needs it. */
export interface HeldRemoteSession {
  sessionId: string;
  taskId: string | null;
  projectId: string;
  kind: 'task' | 'command-terminal' | 'workflow';
}

/** A Command Terminal the swap ended, holding its slot and conversation until it starts again. */
export interface EndedTerminal {
  startAgain(): Promise<void>;
  giveUp(): void;
}

export interface ProgramUpdaterDeps {
  /** The host program version this build installs, or undefined when it carries none. */
  appVersion: () => string | undefined;
  programInfo: (hostId: string) => Promise<HostProgramInfo>;
  snapshot: (hostId: string) => Promise<HelperSnapshot>;
  runCommand: (hostId: string, request: HostCommandRequest) => Promise<HostCommandResult>;
  supports: (hostId: string, method: HelperMethod) => boolean;
  retireIfIdle: (hostId: string, daemonPid: number) => Promise<{ retired: boolean; liveSessions: number }>;
  /** The PTYs main holds on the host. */
  liveRemotePtys: (hostId: string) => RemoteSessionRoute[];
  /** This app's running sessions on the host. */
  heldSessions: (hostId: string) => HeldRemoteSession[];
  /** Whether the session is idle at its prompt with nothing open, typed or about to be sent. Synchronous. */
  isAtSafePoint: (session: HeldRemoteSession) => boolean;
  /** Whether a start is on its way anywhere: one that passed the launch check before the hold would land on the old program. */
  hasStartInFlight: () => boolean;
  /** The draft read fresh from the host, just before a stop. */
  hasFreshDraft: (sessionId: string) => Promise<boolean>;
  /** Suspend a task agent through the normal pause, re-checking `stillEligible` under its task lock. */
  suspendTask: (session: HeldRemoteSession, stillEligible: () => boolean) => Promise<'paused' | 'not-live' | 'declined'>;
  /**
   * Whether a Command Terminal can come back in its slot with its conversation (`restart`), has none to bring
   * back (`unused`), or was used and could not be brought back (`unresumable`), asked without ending it.
   */
  terminalRestartability: (session: HeldRemoteSession) => 'restart' | 'unused' | 'unresumable';
  /** End a Command Terminal for a restart in its slot. */
  endTerminal: (session: HeldRemoteSession, stillEligible: () => boolean) => EndedTerminal | 'deferred' | 'failed';
  /** End a Command Terminal nobody has used, as any untouched terminal ends: it has nothing to bring back. */
  endUnusedTerminal: (session: HeldRemoteSession) => void;
  /** Resume these suspended task records through startup recovery, whatever the resume settings say. */
  resumeTasks: (sessionIdsByProject: ReadonlyMap<string, ReadonlySet<string>>) => Promise<void>;
  /** Refuse every start on the host until the answer is called. */
  holdStarts: (hostId: string) => () => void;
  /** Subscribe to anything that can change whether a session is at a safe point. Returns the unsubscribe. */
  onSessionChange: (listener: () => void) => () => void;
  /** Reports a swap that stopped, under its stage (`remoteProgramUpdateReporter`). */
  stageReporter: { report(error: unknown, stage: ProgramUpdateStage, ranForMs: number): void };
  log: (line: string) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
  sleep?: (delayMs: number) => Promise<void>;
  /** Shortened by tests. */
  timing?: Partial<ProgramUpdateTiming>;
}

export interface ProgramUpdateTiming {
  /** How long every agent must stay at a safe point before the swap starts. */
  settleMs: number;
  /** How long the suspended terminals get to be gone from the host's ledger and main's. */
  emptyBoundMs: number;
  emptyPollMs: number;
  /** How long the stopped program gets to drop the link: the stop script's own TERM, its wait and KILL. */
  dropBoundMs: number;
  /** How long the link gets to come back on the new program. */
  reconnectBoundMs: number;
  /** The wait for the agents' own exit when their processes could not be listed. */
  agentExitFallbackMs: number;
}

const DEFAULT_TIMING: ProgramUpdateTiming = {
  settleMs: 2_000,
  emptyBoundMs: 10_000,
  emptyPollMs: 250,
  // 1 s before TERM, up to 10 s for it to take, then KILL.
  dropBoundMs: 15_000,
  reconnectBoundMs: 60_000,
  // Past Claude's longest measured exit after a close (about 2.6 s under lock contention).
  agentExitFallbackMs: 3_000,
};

/** A command the stop and wait scripts get, past their own bound. */
const SCRIPT_TIMEOUT_MS = 20_000;

/** A program version folder's name, as the host's listing accepts it (`program-versions.ts`). */
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

/** Why a swap stopped at a stage. The message is fixed text: it is logged, and the report sends only its name. */
export class ProgramUpdateStepError extends Error {
  constructor(readonly stage: ProgramUpdateStage, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProgramUpdateStepError';
  }
}

type HostPhase = 'idle' | 'watching' | 'swapping' | 'done' | 'failed';

interface HostState {
  phase: HostPhase;
  /** When the host's link first came up this run, for the measured time to agents back. */
  firstConnectedAt: number;
  settleTimer: { cancel(): void } | null;
  /** What a swap could not resume because the link was down: resumed on the next connection. */
  pendingResume: SuspendedSet | null;
}

interface SuspendedSet {
  tasks: Map<string, Set<string>>;
  terminals: EndedTerminal[];
}

export interface ProgramUpdater {
  /** Look at a host once its recovery has run. Idempotent: a host already being watched or swapped is left. */
  consider(hostId: string): Promise<void>;
  /** The host's link changed state. */
  onLinkState(hostId: string, state: LinkState): void;
  /** Forget a host that is being removed: its watch ends, nothing is swapped. */
  forgetHost(hostId: string): void;
  dispose(): void;
}

function isSafePid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 1;
}

/** Counts of a host's link changes, so a wait reads "a new connection since then" and never a state that happened to match. */
interface LinkCounts {
  state: LinkState | null;
  connections: number;
  drops: number;
}

export function createProgramUpdater(deps: ProgramUpdaterDeps): ProgramUpdater {
  const timing: ProgramUpdateTiming = { ...DEFAULT_TIMING, ...deps.timing };
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const sleep = deps.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => { setTimer(resolve, delayMs); }));
  const hosts = new Map<string, HostState>();
  const links = new Map<string, LinkCounts>();
  const linkWaiters = new Set<{ hostId: string; reached: () => boolean; resolve: (reached: boolean) => void }>();
  let disposed = false;
  /** The session events are listened to only while a host is being watched: every local event would pay otherwise. */
  let unsubscribe: (() => void) | null = null;
  let recheckQueued = false;

  const linkOf = (hostId: string): LinkCounts => {
    let counts = links.get(hostId);
    if (!counts) {
      counts = { state: null, connections: 0, drops: 0 };
      links.set(hostId, counts);
    }
    return counts;
  };
  const isConnected = (hostId: string): boolean => links.get(hostId)?.state === 'connected';

  const stateOf = (hostId: string): HostState => {
    let state = hosts.get(hostId);
    if (!state) {
      state = { phase: 'idle', firstConnectedAt: now(), settleTimer: null, pendingResume: null };
      hosts.set(hostId, state);
    }
    return state;
  };

  const shortHostId = (hostId: string): string => hostId.slice(0, 8);

  const rechecksAll = (): void => {
    recheckQueued = false;
    for (const [hostId, state] of hosts) if (state.phase === 'watching') recheck(hostId);
  };

  /** Listen to the session events while any host is watched, and let go of them once none is. */
  const syncSessionListener = (): void => {
    const anyWatching = !disposed && [...hosts.values()].some((candidate) => candidate.phase === 'watching');
    if (anyWatching && !unsubscribe) {
      unsubscribe = deps.onSessionChange(() => {
        if (recheckQueued) return;
        recheckQueued = true;
        queueMicrotask(rechecksAll);
      });
    } else if (!anyWatching && unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const setPhase = (state: HostState, phase: HostPhase): void => {
    state.phase = phase;
    if (phase !== 'watching') cancelSettle(state);
    syncSessionListener();
  };

  /** Give back the slots and conversations of ended Command Terminals nothing will start again this run. */
  const giveUpTerminals = (suspended: SuspendedSet): void => {
    for (const terminal of suspended.terminals) terminal.giveUp();
    suspended.terminals = [];
  };

  /** Every live terminal the host's program holds is one main holds a PTY for. */
  const everyLiveSessionIsHeld = (hostId: string, snapshot: HelperSnapshot): boolean => {
    const held = new Set(deps.liveRemotePtys(hostId).map((route) => route.sessionId));
    return snapshot.sessions.every((record) => !record.alive || held.has(record.sessionId));
  };

  /** The host's version when it is older than the app's, else null (newer, equal, or either unknown). */
  const olderHostVersion = (hostVersion: string | null, appVersion: string | undefined): string | null =>
    hostVersion !== null && appVersion !== undefined && compareVersions(hostVersion, appVersion) < 0 ? hostVersion : null;

  /**
   * Whether a session is one the swap may stop and bring back at all. A workflow's own agent never is, and a
   * Command Terminal that was used but cannot resume its conversation would lose it: each holds the swap.
   */
  const isStoppable = (session: HeldRemoteSession): boolean => {
    if (session.kind === 'workflow') return false;
    return session.kind !== 'command-terminal' || deps.terminalRestartability(session) !== 'unresumable';
  };

  /** Whether every held session is where a swap may stop it, and nothing is starting. */
  const allAtSafePoint = (hostId: string): boolean =>
    !deps.hasStartInFlight()
    && deps.heldSessions(hostId).every((session) => isStoppable(session) && deps.isAtSafePoint(session));

  function cancelSettle(state: HostState): void {
    state.settleTimer?.cancel();
    state.settleTimer = null;
  }

  /** Re-run the wait for one watched host: any session off its safe point starts it over. */
  function recheck(hostId: string): void {
    const state = hosts.get(hostId);
    if (!state || state.phase !== 'watching' || disposed) return;
    if (!isConnected(hostId) || !allAtSafePoint(hostId)) {
      cancelSettle(state);
      return;
    }
    if (state.settleTimer) return;
    state.settleTimer = setTimer(() => {
      state.settleTimer = null;
      if (state.phase !== 'watching' || disposed) return;
      if (!isConnected(hostId) || !allAtSafePoint(hostId)) return;
      void swap(hostId);
    }, timing.settleMs);
  }

  /** Resolve true once `reached` holds after a link change, or false at the bound. */
  const waitForLink = (hostId: string, reached: () => boolean, boundMs: number): Promise<boolean> => {
    if (reached()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiter = { hostId, reached, resolve: (outcome: boolean) => { timer.cancel(); linkWaiters.delete(waiter); resolve(outcome); } };
      const timer = setTimer(() => waiter.resolve(false), boundMs);
      linkWaiters.add(waiter);
    });
  };

  /**
   * Bring back what a swap suspended. With the link down the set waits for the next connection, kept on
   * `owner`. A host forgotten (removed) or an updater disposed meanwhile keeps nothing: the Command
   * Terminals give their slots and conversations back to Earlier, and the task records stay suspended as
   * the system's, which the next launch's recovery resumes.
   */
  const resumeSuspended = async (hostId: string, owner: HostState, suspended: SuspendedSet, startedAt: number): Promise<void> => {
    if (disposed || (!isConnected(hostId) && hosts.get(hostId) !== owner)) {
      giveUpTerminals(suspended);
      deps.log(`[remote] the agents of host ${shortHostId(hostId)} stay paused: the host was removed or the app is quitting`);
      return;
    }
    if (!isConnected(hostId)) {
      owner.pendingResume = suspended;
      deps.log(`[remote] the agents of host ${shortHostId(hostId)} resume once its link is back`);
      return;
    }
    owner.pendingResume = null;
    try {
      if (suspended.tasks.size > 0) await deps.resumeTasks(suspended.tasks);
    } catch (error) {
      deps.stageReporter.report(error, 'resume', now() - startedAt);
      deps.log(`[remote] could not resume every agent on host ${shortHostId(hostId)} after its program update: ${error instanceof Error ? error.name : 'unknown'}`);
    }
    // After the tasks, so they keep first claim on the cap, as a restart's restore orders it.
    for (const terminal of suspended.terminals) {
      try {
        await terminal.startAgain();
      } catch (error) {
        deps.stageReporter.report(error, 'resume', now() - startedAt);
      }
    }
  };

  /**
   * The pids of the agents the held terminals' shells started, read before they are hung up: once a shell
   * is gone its agent is re-parented, and nothing on the host still says it was this terminal's.
   */
  const listAgentPids = async (hostId: string, shellPids: number[]): Promise<number[] | null> => {
    if (shellPids.length === 0) return [];
    try {
      const result = await deps.runCommand(hostId, { file: 'sh', args: ['-c', LIST_CHILDREN_SCRIPT, 'kangentic-list', ...shellPids.map(String)], timeoutMs: SCRIPT_TIMEOUT_MS });
      if (result.code !== 0) return null;
      return result.stdout.split(/\s+/).map((word) => Number(word)).filter(isSafePid);
    } catch {
      // report-ok: an unlisted agent is waited for by time instead (`agentExitFallbackMs`).
      return null;
    }
  };

  /** Wait for the suspended agents' own exit, so a resume never starts beside one still writing its transcript. */
  const waitForAgentExit = async (hostId: string, agentPids: number[] | null): Promise<void> => {
    if (agentPids === null) {
      await sleep(timing.agentExitFallbackMs);
      return;
    }
    if (agentPids.length === 0) return;
    try {
      const result = await deps.runCommand(hostId, { file: 'sh', args: ['-c', WAIT_FOR_EXIT_SCRIPT, 'kangentic-wait', ...agentPids.map(String)], timeoutMs: SCRIPT_TIMEOUT_MS });
      const left = Number(result.stdout.trim());
      if (left > 0) deps.log(`[remote] ${left} agent process(es) on host ${shortHostId(hostId)} still ran after the wait`);
    } catch {
      // report-ok: the wait could not be asked; the stop and the redial that follow take longer than an agent's exit.
      await sleep(timing.agentExitFallbackMs);
    }
  };

  /** Whether neither the host's program nor main holds a live terminal there. A failed ask is never "empty". */
  const isEmpty = async (hostId: string): Promise<boolean> => {
    try {
      return (await deps.programInfo(hostId)).liveSessions === 0 && deps.liveRemotePtys(hostId).length === 0;
    } catch {
      // report-ok: not empty, so the caller polls again or fails its stage at the bound.
      return false;
    }
  };

  const waitUntilEmpty = async (hostId: string): Promise<boolean> => {
    const deadline = now() + timing.emptyBoundMs;
    for (;;) {
      if (await isEmpty(hostId)) return true;
      if (now() >= deadline) return false;
      await sleep(timing.emptyPollMs);
    }
  };

  /** Ask the old program to go: its own `retireIfIdle` where it has one, else a TERM of its pid. */
  const stopProgram = async (hostId: string, snapshot: HelperSnapshot, version: string): Promise<void> => {
    if (deps.supports(hostId, 'retireIfIdle')) {
      // Named by pid: the link resends an unacknowledged ask to the program that answers next, the new one.
      const answer = await deps.retireIfIdle(hostId, snapshot.daemonPid);
      if (!answer.retired) throw new ProgramUpdateStepError('stop', `the program still held ${answer.liveSessions} terminal(s)`);
      return;
    }
    if (!isSafePid(snapshot.daemonPid)) throw new ProgramUpdateStepError('stop', 'the host reported no usable daemon pid');
    if (!VERSION_PATTERN.test(version)) throw new ProgramUpdateStepError('stop', 'the host reported a version that names no program folder');
    const result = await deps.runCommand(hostId, { file: 'sh', args: ['-c', STOP_DAEMON_SCRIPT, 'kangentic-stop', String(snapshot.daemonPid), version], timeoutMs: SCRIPT_TIMEOUT_MS });
    if (result.code !== 0 || !result.stdout.includes('kangentic-stop:scheduled')) {
      throw new ProgramUpdateStepError('stop', `the stop was refused (${result.stdout.trim().split(/\s+/).pop() ?? 'no answer'})`);
    }
  };

  /** Whether every held session is at its safe point with no draft the mirror missed. Asked before any is stopped. */
  const everyoneStillIdle = async (held: HeldRemoteSession[]): Promise<boolean> => {
    if (deps.hasStartInFlight()) return false;
    for (const session of held) {
      if (!isStoppable(session) || !deps.isAtSafePoint(session)) return false;
      if (await deps.hasFreshDraft(session.sessionId)) return false;
    }
    return true;
  };

  /** One swap, from the hold to the release. Ends `done`, `failed`, or back to `watching` when a turn began. */
  const swap = async (hostId: string): Promise<void> => {
    const state = stateOf(hostId);
    if (state.phase === 'swapping' || state.phase === 'done' || state.phase === 'failed') return;
    setPhase(state, 'swapping');
    const startedAt = now();
    const suspended: SuspendedSet = { tasks: new Map(), terminals: [] };
    const suspendedAny = (): boolean => suspended.tasks.size > 0 || suspended.terminals.length > 0;
    let release: (() => void) | null = null;
    let stage: ProgramUpdateStage = 'hold';
    const releaseStarts = (): void => {
      release?.();
      release = null;
    };
    /** False once the host was forgotten (it is being removed) or the updater disposed: nothing more is stopped. */
    const stillOurs = (): boolean => !disposed && hosts.get(hostId) === state;
    /** A turn began or a start is on its way: not a failure. What was stopped comes back on the program it ran on. */
    const waitAgain = async (): Promise<void> => {
      releaseStarts();
      if (suspendedAny()) await resumeSuspended(hostId, state, suspended, startedAt);
      setPhase(state, 'watching');
      recheck(hostId);
    };
    try {
      release = deps.holdStarts(hostId);
      // Asked again under the hold: the program, its version, and that everything live is ours.
      const info = await deps.programInfo(hostId);
      const appVersion = deps.appVersion();
      const oldVersion = olderHostVersion(info.version, appVersion);
      if (oldVersion === null) {
        releaseStarts();
        setPhase(state, 'done');
        return;
      }
      const snapshot = await deps.snapshot(hostId);
      if (!everyLiveSessionIsHeld(hostId, snapshot)) {
        deps.log(`[remote] host ${shortHostId(hostId)} runs a terminal this app does not hold; its program update waits for a remote project's next cold open`);
        releaseStarts();
        setPhase(state, 'idle');
        return;
      }

      stage = 'suspend';
      if (!stillOurs()) throw new ProgramUpdateStepError('suspend', 'the host was removed before its agents were stopped');
      const held = deps.heldSessions(hostId);
      // Every session is asked before any is stopped, so a draft found late costs no agent a restart.
      if (!await everyoneStillIdle(held)) {
        deps.log(`[remote] an agent on host ${shortHostId(hostId)} left its safe point as the program update began; waiting again`);
        await waitAgain();
        return;
      }
      const shellPids = snapshot.sessions
        .filter((record) => record.alive && held.some((session) => session.sessionId === record.sessionId))
        .map((record) => record.pid)
        .filter(isSafePid);
      const agentPids = await listAgentPids(hostId, shellPids);
      for (const session of held) {
        // Re-checked under the task lock, or just before a terminal's end: the lock may have waited.
        const stillEligible = (): boolean => deps.isAtSafePoint(session);
        if (session.kind === 'command-terminal' && deps.terminalRestartability(session) === 'unused') {
          // Nothing reached it, so there is no conversation to bring back: it ends as any untouched terminal does.
          deps.endUnusedTerminal(session);
          continue;
        }
        if (session.kind === 'command-terminal') {
          const ended = deps.endTerminal(session, stillEligible);
          if (ended === 'deferred') {
            deps.log(`[remote] a Command Terminal on host ${shortHostId(hostId)} left its safe point while the agents stopped; waiting again`);
            await waitAgain();
            return;
          }
          if (ended === 'failed') throw new ProgramUpdateStepError('suspend', 'a Command Terminal could not be ended for a restart');
          suspended.terminals.push(ended);
          continue;
        }
        const outcome = await deps.suspendTask(session, stillEligible);
        if (outcome === 'declined') {
          deps.log(`[remote] a turn began on host ${shortHostId(hostId)} while its program update stopped the agents; waiting again`);
          await waitAgain();
          return;
        }
        if (outcome === 'paused') {
          const suspendedSessionIds = suspended.tasks.get(session.projectId) ?? new Set<string>();
          suspendedSessionIds.add(session.sessionId);
          suspended.tasks.set(session.projectId, suspendedSessionIds);
        }
      }
      if (!await waitUntilEmpty(hostId)) throw new ProgramUpdateStepError('suspend', 'a terminal was still running after the suspend');
      await waitForAgentExit(hostId, agentPids);
      // Asked once more just before the stop: the pid path has no check of its own on the host.
      if (!await isEmpty(hostId)) throw new ProgramUpdateStepError('suspend', 'a terminal started on the host before the stop');

      stage = 'stop';
      if (!stillOurs()) throw new ProgramUpdateStepError('stop', 'the host was removed before the stop');
      const oldPid = snapshot.daemonPid;
      const counts = linkOf(hostId);
      const connectionsBefore = counts.connections;
      const dropsBefore = counts.drops;
      await stopProgram(hostId, snapshot, oldVersion);
      const dropped = await waitForLink(hostId, () => counts.drops > dropsBefore || counts.connections > connectionsBefore, timing.dropBoundMs);
      if (!dropped) throw new ProgramUpdateStepError('stop', 'the program did not exit');

      stage = 'reconnect';
      const back = await waitForLink(hostId, () => counts.connections > connectionsBefore && counts.state === 'connected', timing.reconnectBoundMs);
      if (!back) throw new ProgramUpdateStepError('reconnect', 'the link did not come back');
      const newInfo = await deps.programInfo(hostId);
      const newSnapshot = await deps.snapshot(hostId);
      if (newSnapshot.daemonPid === oldPid) throw new ProgramUpdateStepError('stop', 'the old program answered after the stop');
      if (newInfo.version !== appVersion) throw new ProgramUpdateStepError('reconnect', 'the link came back to another version');

      // Released before the resume: recovery's starts go through the same launch check the hold refuses.
      releaseStarts();
      stage = 'resume';
      const busy = suspendedAny();
      if (busy) await resumeSuspended(hostId, state, suspended, startedAt);
      setPhase(state, 'done');
      deps.log(`[remote] host ${shortHostId(hostId)} updated its program from ${oldVersion} to ${appVersion}: ${busy ? 'busy' : 'idle'} swap, ${now() - startedAt} ms from the start of the swap and ${now() - state.firstConnectedAt} ms from the first connection to agents back`);
    } catch (error) {
      // A host being removed, or a quit, is no failure of the update: nothing is reported for it.
      if (stillOurs()) deps.stageReporter.report(error, error instanceof ProgramUpdateStepError ? error.stage : stage, now() - startedAt);
      deps.log(`[remote] the program update of host ${shortHostId(hostId)} stopped at ${stage}: ${error instanceof Error ? error.message : String(error)}`);
      releaseStarts();
      setPhase(state, 'failed');
      if (suspendedAny()) await resumeSuspended(hostId, state, suspended, startedAt);
    }
  };

  const considerHost = async (hostId: string): Promise<void> => {
    if (disposed) return;
    const state = stateOf(hostId);
    if (state.phase !== 'idle') return;
    const appVersion = deps.appVersion();
    if (!appVersion) return;
    let info: HostProgramInfo;
    let snapshot: HelperSnapshot;
    try {
      info = await deps.programInfo(hostId);
      if (olderHostVersion(info.version, appVersion) === null) {
        setPhase(state, 'done');
        return;
      }
      snapshot = await deps.snapshot(hostId);
    } catch (error) {
      // report-ok: a host that cannot answer is never "empty", so nothing is swapped. The host stays idle,
      // and a remote project's next cold open on it looks again; until then it keeps its older program.
      deps.log(`[remote] could not ask host ${shortHostId(hostId)} about its program: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (state.phase !== 'idle' || disposed) return;
    if (!everyLiveSessionIsHeld(hostId, snapshot)) {
      deps.log(`[remote] host ${shortHostId(hostId)} runs program ${info.version}, older than ${appVersion}, and a terminal this app does not hold yet; a remote project's next cold open looks again`);
      return;
    }
    deps.log(`[remote] host ${shortHostId(hostId)} runs program ${info.version}, older than ${appVersion}: ${info.liveSessions === 0 ? 'updating it now' : 'updating it once its agents are between turns'}`);
    if (info.liveSessions === 0 && deps.heldSessions(hostId).length === 0) {
      await swap(hostId);
      return;
    }
    setPhase(state, 'watching');
    recheck(hostId);
  };

  /** Never rejects: its caller is a link callback with nobody to hand a rejection to. */
  const consider = async (hostId: string): Promise<void> => {
    try {
      await considerHost(hostId);
    } catch (error) {
      // This side's own logic failed before any hold was taken; filed under the stage that decides on it.
      deps.stageReporter.report(error, 'hold', 0);
      deps.log(`[remote] the program update check of host ${shortHostId(hostId)} failed: ${error instanceof Error ? error.name : 'unknown'}`);
    }
  };

  return {
    consider,
    onLinkState(hostId, linkState) {
      const counts = linkOf(hostId);
      counts.state = linkState;
      if (linkState === 'connected') counts.connections += 1;
      else counts.drops += 1;
      // The measured time to agents back starts at the host's first connection of the run, before its recovery.
      if (linkState === 'connected' && counts.connections === 1) stateOf(hostId).firstConnectedAt = now();
      for (const waiter of [...linkWaiters]) {
        if (waiter.hostId === hostId && waiter.reached()) waiter.resolve(true);
      }
      const state = hosts.get(hostId);
      if (!state) return;
      if (linkState === 'connected' && state.pendingResume) {
        const pending = state.pendingResume;
        state.pendingResume = null;
        void resumeSuspended(hostId, state, pending, now());
      }
      if (state.phase === 'watching') recheck(hostId);
    },
    forgetHost(hostId) {
      const state = hosts.get(hostId);
      hosts.delete(hostId);
      if (state) {
        cancelSettle(state);
        // A set kept for the next connection will not be resumed by this host: its terminals give back their slots.
        if (state.pendingResume) giveUpTerminals(state.pendingResume);
        state.pendingResume = null;
      }
      syncSessionListener();
    },
    dispose() {
      disposed = true;
      syncSessionListener();
      for (const state of hosts.values()) {
        cancelSettle(state);
        if (state.pendingResume) giveUpTerminals(state.pendingResume);
        state.pendingResume = null;
      }
      for (const waiter of [...linkWaiters]) waiter.resolve(false);
    },
  };
}

/** The report's `ran_for` bucket, beside its stage. */
export function programUpdateReportTags(stage: ProgramUpdateStage, ranForMs: number): { tags: Record<string, string>; detailTags: Record<string, string> } {
  return { tags: { stage }, detailTags: { ran_for: ranForBucket(ranForMs) } };
}

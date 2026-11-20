/**
 * Main's transport to the `kangentic-pty-host` utility process
 * (`pty-host-entry.ts`), which owns every PTY.
 *
 * The shape follows the other workers (`retrieval-client.ts`): a fork through
 * `UTILITY_PROCESS_STDIO` with stderr captured, an init handshake, a
 * request-id map, and a restart policy that is the route to crash telemetry.
 * What differs, because terminals are the app's core:
 *
 * - Forked eagerly and kept for the app's life. Commands and requests posted
 *   before it is ready queue in the process's own message pipe, in order.
 * - A crash restarts the host at once (then after 1, 5 and 15 s), as VS Code
 *   restarts its pty host. Every PTY the dead host held is reported exited,
 *   and main replays its focus and tap sets to the new one.
 * - Past the crash cap it does not latch off: it falls back to the host core
 *   running inside main (`InProcessPtyHostTransport`), which is how every
 *   terminal ran before the host existed. A slower app beats no terminals.
 * - A request with no answer rejects by type: `PtyHostTimeoutError` when a
 *   running host let its budget run out, `PtyHostExitedError` when the host
 *   exited first or was still down. An error the host sends back stays a plain
 *   `Error`. A timeout cancels nothing in the host, so a caller can ask for the
 *   late answer (`onLateResult`): a reap main gave up on may still kill.
 * - The host runs reaps and Stops one batch at a time. It posts
 *   `batch-started` as each starts, and every request of that method still
 *   waiting gets its budget back, so time spent queued never counts.
 * - A heartbeat (VS Code's intervals) logs a host that stops answering, and
 *   reports the stall once it ends, with how it ended and the host's stderr.
 * - Quit posts `shutdown`; the host flushes, kills, waits for the exit
 *   callbacks and exits itself. Its pid joins the before-quit drain.
 */

import path from 'node:path';
import { app, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import { recordRelayedSyncSpan } from '../../diagnostics/event-loop-lag';
import { unpacked } from '../../utility-process/paths';
import { STDERR_DRAIN_BOUND_MS, UtilityRestartPolicy } from '../../utility-process/restart-policy';
import { killChildTreeByPid } from '../../shared/child-tree-stop';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr } from '../../utility-process/stderr-tail';
import type { PtyHostLifecycleListener, PtyHostRequestOptions, PtyHostTransport } from './pty-host-client';
import {
  type FromPtyHostMessage,
  type PtyHostCommand,
  type PtyHostEvent,
  type PtyHostMethod,
  type PtyHostRequest,
  type PtyHostRequestMap,
  type QueuedPtyHostMethod,
  type ToPtyHostMessage,
  fromPtyHostError,
} from './protocol';
import { PtyHostExitedError, PtyHostTimeoutError } from './pty-host-request-errors';
import {
  recordPtyHostStallAtQuit,
  reportPtyHostHeartbeatStall,
  type PtyHostHeartbeatStall,
  type PtyHostHeartbeatStallOutcome,
} from './pty-host-report';

const SERVICE_NAME = 'kangentic-pty-host';
/** VS Code's pty host restart cap. */
const MAX_CRASHES = 5;
/** The first restart is immediate: every terminal is waiting on it. */
const RESTART_BACKOFF_MS: readonly number[] = [0, 1_000, 5_000, 15_000];
/** How often a restart waiting out its backoff checks the policy again. */
const RESTART_POLL_MS = 250;
/** A request's budget. The host answers between output chunks; a scrollback
 *  sample waits at most a 400 ms repaint settle plus a 1 s serialize. */
const REQUEST_TIMEOUT_MS = 15_000;
/** VS Code's heartbeat: a beat every 5 s, unresponsive after 11 s. */
const HEARTBEAT_INTERVAL_MS = 5_000;
const HEARTBEAT_UNRESPONSIVE_MS = 11_000;
/** A threshold timer this late did not watch the host: the machine slept, or main's own loop
 *  did not run, for over four times the ping's budget. The budget ran out while nothing was
 *  measuring, so the beat says nothing about the host and is voided (Sentry DESKTOP-43 fired
 *  15.7 h late). Four budgets is far above any hold of main the stall report exists to name,
 *  and a host that stays frozen is still caught by the next beat, whose timer fires on time. */
const HEARTBEAT_UNMEASURED_LATE_MS = 4 * REQUEST_TIMEOUT_MS;
/** Late answers kept waiting at once. A live host whose reap hung never answers,
 *  so past this the oldest entry goes rather than one per reap for the run. */
const MAX_LATE_RESULTS = 64;

/**
 * Where to fork the host from. Windows and Linux fork it from the unpacked
 * tree, where node-pty's ConPTY conout worker thread loads from a real
 * directory. macOS forks it from inside the asar: node-pty finds its
 * spawn-helper by rewriting `app.asar` to `app.asar.unpacked` in its own
 * path (lib/unixTerminal.js), which on an already unpacked path doubles to
 * `app.asar.unpacked.unpacked` and no terminal spawns. From the asar, node-pty
 * and better-sqlite3 load as they did in main, with Electron's asar support
 * (asar-fs-wrapper, active in utility processes) redirecting their native
 * binaries to the unpacked tree.
 */
export function ptyHostEntryPath(bundleDirectory: string, platform: NodeJS.Platform = process.platform): string {
  const bundled = path.join(bundleDirectory, 'pty-host.js');
  return platform === 'darwin' ? bundled : unpacked(bundled);
}

/**
 * Where the host starts its spawn worker from (`spawn-worker-entry.ts`): the
 * unpacked tree on every platform. A worker thread loads its file with Node's
 * own loader, so the bundle is a real file, not one inside the asar.
 */
export function ptyHostSpawnWorkerPath(bundleDirectory: string): string {
  return unpacked(path.join(bundleDirectory, 'pty-host-spawn-worker.js'));
}

interface PendingRequest {
  method: PtyHostMethod;
  /** The request's budget, restarted in full when a batch of its method starts. */
  budgetMs: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  /** Where the answer goes if it arrives after the budget ran out. */
  onLateResult?: (result: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** One heartbeat's ping, from its send until it settles. */
interface HeartbeatBeat {
  startedAt: number;
  /** The host's stderr when the beat was sent. Kept here because a host exit
   *  drops `childStderr` before the ping's rejection runs. */
  stderrTail: StderrTail | null;
  /** Watchdog lines in that tail when the beat was sent, so the report names
   *  only a hold written during this stall. */
  watchdogLinesBefore: number;
  /** Set when the ping passed `HEARTBEAT_UNRESPONSIVE_MS`. */
  stalled: boolean;
  /** How late the threshold timer fired on main's own loop. */
  timerLateMs: number;
  /** The other requests waiting on the host when the stall was seen. */
  inFlight: string[];
  /** The stall was handed to the report once, whichever way it ended first. */
  ended: boolean;
}

export interface UtilityPtyHostTransportOptions {
  projectsDir: string;
  /** Where a heartbeat stall the app quits on is written for the next launch
   *  to report (`recordPtyHostStallAtQuit`). Without one it is dropped. */
  stallAtQuitFilePath?: string;
}

export class UtilityPtyHostTransport implements PtyHostTransport {
  private child: UtilityProcess | null = null;
  private childStderr: StderrTail | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  /**
   * Timed-out requests the running host may still answer, by id, oldest first.
   * An entry goes when its answer arrives, with the host that owed it, or as
   * the oldest once `MAX_LATE_RESULTS` are waiting.
   */
  private readonly lateResults = new Map<number, (result: unknown) => void>();
  private nextRequestId = 1;
  private listener: ((event: PtyHostEvent) => void) | null = null;
  private lifecycle: PtyHostLifecycleListener | null = null;
  private readonly restartPolicy = new UtilityRestartPolicy({
    service: SERVICE_NAME,
    maxCrashes: MAX_CRASHES,
    backoffMs: RESTART_BACKOFF_MS,
    // Each host crash ends every terminal, so the first one of a run reports,
    // not only the fifth inside the window.
    reportFirstCrash: true,
  });
  /** Set once the crash cap is reached: the host core runs in main from then on. */
  private fallback: PtyHostTransport | null = null;
  private fallbackFactory: (() => PtyHostTransport) | null = null;
  /** Messages for a host that is restarting after a crash, sent once it is up,
   *  each with the ports it transfers (a renderer's, for `attachRendererPort`). */
  private readonly queuedWhileDown: Array<{ message: ToPtyHostMessage; transfer?: MessagePortMain[] }> = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
  /** The beat whose ping has not settled yet, for a quit that ends its stall. */
  private currentBeat: HeartbeatBeat | null = null;
  private shuttingDown = false;
  private hadHost = false;
  /** A host exited unexpectedly since the last `ready`, before or after its
   *  own. Commands posted straight to it died with it, so the next `ready` is
   *  a restart even when the lost host never said ready itself. */
  private lostSinceReady = false;

  constructor(private readonly options: UtilityPtyHostTransportOptions) {}

  get hostPid(): number | null {
    if (this.fallback) return null;
    return this.child?.pid ?? null;
  }

  stopLostPtyTree(pid: number): void {
    killChildTreeByPid(pid);
  }

  setEventListener(listener: (event: PtyHostEvent) => void): void {
    this.listener = listener;
    this.fallback?.setEventListener(listener);
  }

  setLifecycleListener(listener: PtyHostLifecycleListener): void {
    this.lifecycle = listener;
  }

  setFallbackFactory(factory: () => PtyHostTransport): void {
    this.fallbackFactory = factory;
  }

  /** Fork the host now, ahead of the first spawn. */
  start(): void {
    if (this.fallback || this.shuttingDown) return;
    this.ensureChild();
  }

  post(command: PtyHostCommand): void {
    if (this.fallback) {
      this.fallback.post(command);
      return;
    }
    this.send(command);
  }

  /** Hand a renderer's port to the host, transferred with the message, in order
   *  with every command posted before and after it. */
  attachRendererPort(rendererId: number, port: MessagePortMain): void {
    if (this.fallback) {
      this.fallback.attachRendererPort(rendererId, port);
      return;
    }
    this.send({ type: 'attachRendererPort', rendererId }, [port]);
  }

  request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: PtyHostRequestOptions<PtyHostRequestMap[M]['result']>,
  ): Promise<PtyHostRequestMap[M]['result']> {
    if (this.fallback) return this.fallback.request(method, params, options);
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<PtyHostRequestMap[M]['result']>((resolve, reject) => {
      const budgetMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
      this.pending.set(requestId, {
        method,
        budgetMs,
        resolve: resolve as (result: unknown) => void,
        reject,
        onLateResult: options?.onLateResult as ((result: unknown) => void) | undefined,
        timer: this.armTimer(requestId, budgetMs),
      });
      const message: PtyHostRequest<M> = { type: 'request', id: requestId, method, params };
      this.send(message);
    });
  }

  /**
   * A request's timeout. A request still queued for a host that is down never
   * reached a running one, so it fails as a lost host, not a slow one: the
   * task reap reports the two apart (`host_exited`, `host_timeout`). A running
   * host keeps working on a request that timed out, so a caller that asked for
   * its late answer still gets it.
   */
  private armTimer(requestId: number, budgetMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      this.pending.delete(requestId);
      const neverPosted = this.queuedWhileDown.some(({ message }) => message.type === 'request' && message.id === requestId);
      if (neverPosted) {
        entry.reject(new PtyHostExitedError(`The pty host exited and did not answer ${entry.method} in time`));
        return;
      }
      if (entry.onLateResult) {
        this.lateResults.set(requestId, entry.onLateResult);
        if (this.lateResults.size > MAX_LATE_RESULTS) {
          const oldestId = this.lateResults.keys().next().value;
          if (oldestId !== undefined) this.lateResults.delete(oldestId);
        }
      }
      entry.reject(new PtyHostTimeoutError(entry.method));
    }, budgetMs);
    timer.unref();
    return timer;
  }

  /** Hand a late answer to the caller that asked for it, once. An error answer has nothing to report. */
  private deliverLateResult(requestId: number, ok: boolean, result: unknown): void {
    const onLateResult = this.lateResults.get(requestId);
    if (!onLateResult) return;
    this.lateResults.delete(requestId);
    if (!ok) return;
    try {
      onLateResult(result);
    } catch (error) {
      console.warn('[pty-host] a late answer could not be handled:', error);
    }
  }

  /**
   * The host started a reap batch or a Stop: every request of that method
   * still waiting gets its full budget again from now. The host runs them one
   * at a time, so a request queued behind a healthy batch is charged only for
   * its own; it times out when the batch running overruns, or when the host
   * stops answering.
   */
  private restartBudgets(method: QueuedPtyHostMethod): void {
    for (const [requestId, entry] of this.pending) {
      if (entry.method !== method) continue;
      clearTimeout(entry.timer);
      entry.timer = this.armTimer(requestId, entry.budgetMs);
    }
  }

  shutdown(exitWaitMs?: number): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopHeartbeat();
    this.recordStallAtQuit();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    if (this.fallback) {
      this.fallback.shutdown();
      return;
    }
    const child = this.child;
    if (!child) return;
    try {
      child.postMessage({ type: 'shutdown', exitWaitMs } satisfies PtyHostCommand);
    } catch {
      child.kill();
    }
  }

  private send(message: ToPtyHostMessage, transfer?: MessagePortMain[]): void {
    const child = this.ensureChild();
    if (!child) {
      this.queuedWhileDown.push({ message, transfer });
      return;
    }
    try {
      child.postMessage(message, transfer);
    } catch {
      // The host died between the check and the post; its exit handling
      // reports what it held.
    }
  }

  private ensureChild(): UtilityProcess | null {
    if (this.child) return this.child;
    if (this.shuttingDown || this.fallback || this.restartTimer) return null;
    if (!this.restartPolicy.maySpawn()) return null;

    const hostPath = ptyHostEntryPath(__dirname);
    let child: UtilityProcess;
    try {
      child = utilityProcess.fork(hostPath, [], { serviceName: SERVICE_NAME, stdio: UTILITY_PROCESS_STDIO });
    } catch (error) {
      console.warn('[pty-host] fork failed:', error);
      this.restartPolicy.recordCrash(null, undefined, { cause: 'fork_failed' });
      this.afterHostLost();
      return null;
    }
    this.child = child;
    const stderrTail = new StderrTail();
    this.childStderr = stderrTail;
    captureWorkerStderr(child, stderrTail, !app.isPackaged);
    child.on('message', (message: unknown) => this.onHostMessage(child, message));
    child.on('exit', (code: number) => this.onHostExit(child, code, stderrTail));
    child.postMessage({
      type: 'init',
      projectsDir: this.options.projectsDir,
      mainExecutable: process.execPath,
      spawnWorkerPath: ptyHostSpawnWorkerPath(__dirname),
    } satisfies ToPtyHostMessage);
    // Whatever was posted while the previous host was down goes after init,
    // except a request whose caller already timed out (`switchToFallback`
    // skips it too): that caller was told it failed and may retry, and an
    // exec that writes (`git worktree remove --force`) would then run twice.
    for (const { message, transfer } of this.queuedWhileDown.splice(0)) {
      if (message.type === 'request' && !this.pending.has(message.id)) continue;
      child.postMessage(message, transfer);
    }
    return child;
  }

  private onHostMessage(child: UtilityProcess, message: unknown): void {
    if (child !== this.child || typeof message !== 'object' || message === null) return;
    const record = message as FromPtyHostMessage;
    switch (record.type) {
      case 'reply': {
        const entry = this.pending.get(record.id);
        if (!entry) {
          this.deliverLateResult(record.id, record.ok, record.ok ? record.result : null);
          return;
        }
        this.pending.delete(record.id);
        clearTimeout(entry.timer);
        if (record.ok) entry.resolve(record.result);
        else entry.reject(fromPtyHostError(record.error));
        return;
      }
      case 'ready': {
        const restarted = this.hadHost || this.lostSinceReady;
        this.hadHost = true;
        this.lostSinceReady = false;
        this.startHeartbeat();
        this.lifecycle?.onHostUp(restarted);
        return;
      }
      case 'log':
        logFromHost(record.level, record.text);
        return;
      case 'slow-span':
        recordRelayedSyncSpan(`pty-host:${record.label}`, record.ms);
        return;
      case 'batch-started':
        this.restartBudgets(record.method);
        return;
      default:
        this.listener?.(record);
    }
  }

  private onHostExit(child: UtilityProcess, exitCode: number, stderrTail: StderrTail): void {
    if (child !== this.child) return;
    this.child = null;
    this.childStderr = null;
    this.stopHeartbeat();
    const lost = new PtyHostExitedError();
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lost);
      this.pending.delete(requestId);
    }
    // The late answers this host owed died with it.
    this.lateResults.clear();
    if (this.shuttingDown) return;
    this.lostSinceReady = true;
    console.error(`[pty-host] exited unexpectedly (code ${exitCode}); every terminal it held has ended`);
    this.restartPolicy.recordCrash(exitCode, stderrTail);
    this.lifecycle?.onHostDown();
    this.afterHostLost();
  }

  /**
   * Restart the host once the policy's backoff allows it (at once after a
   * first crash), or fall back to the in-process core past the cap. Polls the
   * policy rather than computing the delay, so the policy stays the one
   * source of the backoff.
   */
  private afterHostLost(firstAttemptDelayMs = 0): void {
    if (this.shuttingDown || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.shuttingDown) return;
      if (this.restartPolicy.exhausted) {
        this.switchToFallback();
        return;
      }
      if (!this.restartPolicy.maySpawn() || !this.ensureChild()) this.afterHostLost(RESTART_POLL_MS);
    }, firstAttemptDelayMs);
    this.restartTimer.unref?.();
  }

  private switchToFallback(): void {
    if (!this.fallbackFactory) {
      console.error('[pty-host] gave up restarting and has no in-process fallback; terminals are unavailable');
      return;
    }
    console.error('[pty-host] gave up restarting after repeated crashes; running terminals in the main process for the rest of this run');
    const fallback = this.fallbackFactory();
    if (this.listener) fallback.setEventListener(this.listener);
    this.fallback = fallback;
    // Requests that were waiting for a restart are answered by the fallback.
    for (const { message, transfer } of this.queuedWhileDown.splice(0)) {
      if (message.type === 'init') continue;
      if (message.type === 'request') {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        fallback.request(message.method, message.params).then(entry.resolve, entry.reject);
        continue;
      }
      if (message.type === 'attachRendererPort') {
        const port = transfer?.[0];
        if (port) fallback.attachRendererPort(message.rendererId, port);
        continue;
      }
      fallback.post(message);
    }
    this.lifecycle?.onHostUp(true);
  }

  /**
   * A ping every `HEARTBEAT_INTERVAL_MS`. One that passes
   * `HEARTBEAT_UNRESPONSIVE_MS` is logged at once and reported when it
   * settles, so the report says how the stall ended: answered late, the host
   * exited, no answer within the ping's budget, or the app quit. A beat whose
   * threshold timer fires over `HEARTBEAT_UNMEASURED_LATE_MS` late spanned a
   * sleep or a held main loop, and reports nothing.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      const beat: HeartbeatBeat = {
        startedAt: Date.now(),
        stderrTail: this.childStderr,
        watchdogLinesBefore: this.childStderr?.watchdogLineCount() ?? 0,
        stalled: false,
        timerLateMs: 0,
        inFlight: [],
        ended: false,
      };
      this.currentBeat = beat;
      const warnTimer = setTimeout(() => {
        const timerLateMs = Math.max(0, Date.now() - beat.startedAt - HEARTBEAT_UNRESPONSIVE_MS);
        // A beat that spans a sleep never stalls, so however its ping settles, nothing is sent.
        if (timerLateMs > HEARTBEAT_UNMEASURED_LATE_MS) {
          console.info(`[pty-host] a heartbeat spanned ${Math.round(timerLateMs / 1000)} s with main not running; not measured`);
          return;
        }
        beat.stalled = true;
        beat.timerLateMs = timerLateMs;
        beat.inFlight = this.pendingMethodsBesidePing();
        console.warn(`[pty-host] has not answered a heartbeat for ${HEARTBEAT_UNRESPONSIVE_MS / 1000} s; terminals may be stalled`);
      }, HEARTBEAT_UNRESPONSIVE_MS);
      warnTimer.unref();
      this.request('ping', {}).then(() => {
        const elapsedMs = Date.now() - beat.startedAt;
        if (beat.stalled) console.warn(`[pty-host] answered a heartbeat after ${elapsedMs} ms`);
        this.endStall(beat, 'answered', elapsedMs);
      }, (error: unknown) => {
        // A ping that fails is how a stall ends without an answer. Any other
        // error the host sent back for a ping has nothing to report.
        if (error instanceof PtyHostExitedError) this.endStall(beat, 'host_exited', null);
        else if (error instanceof PtyHostTimeoutError) this.endStall(beat, 'no_answer', null);
      }).finally(() => {
        clearTimeout(warnTimer);
        if (this.currentBeat === beat) this.currentBeat = null;
        this.heartbeatInFlight = false;
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  /**
   * The quit ends a stall still waiting. A host that never answers usually
   * ends this way: a person quits a window of frozen terminals. Nothing
   * sent from the quit path lands (`synchronous-shutdown.md`, rule 3), so it
   * goes on disk for the next launch to report. The ping's own rejection, when
   * the host exits, is then the quit's and reports nothing.
   */
  private recordStallAtQuit(): void {
    const beat = this.currentBeat;
    if (!beat?.stalled || beat.ended) return;
    beat.ended = true;
    const filePath = this.options.stallAtQuitFilePath;
    if (!filePath) return;
    try {
      recordPtyHostStallAtQuit(filePath, this.stallOf(beat, 'shutdown', null));
    } catch (error) {
      // report-ok: a report from the quit path never lands; the disk write was the one way it could.
      console.warn('[pty-host] could not record a heartbeat stall for the next launch:', error);
    }
  }

  private stallOf(beat: HeartbeatBeat, outcome: PtyHostHeartbeatStallOutcome, answeredAfterMs: number | null): PtyHostHeartbeatStall {
    return {
      unansweredMs: HEARTBEAT_UNRESPONSIVE_MS,
      outcome,
      answeredAfterMs,
      timerLateMs: beat.timerLateMs,
      inFlight: beat.inFlight,
      stderrTail: beat.stderrTail?.snapshot() ?? '',
      watchdogLinesBefore: beat.watchdogLinesBefore,
    };
  }

  /** Report a stalled beat's end, once. A beat that never stalled reports nothing. */
  private endStall(beat: HeartbeatBeat, outcome: PtyHostHeartbeatStallOutcome, answeredAfterMs: number | null): void {
    if (!beat.stalled || beat.ended) return;
    beat.ended = true;
    // The host a quit shuts down exits too; that stall is the quit's to record.
    if (this.shuttingDown) return;
    const send = (): void => reportPtyHostHeartbeatStall(this.stallOf(beat, outcome, answeredAfterMs));
    // A host that exited can still be draining its last stderr, the
    // watchdog's line among it (see `StderrTail.whenDrained`).
    const drained = outcome === 'host_exited' && beat.stderrTail ? beat.stderrTail.whenDrained(STDERR_DRAIN_BOUND_MS) : null;
    if (drained) void drained.then(send);
    else send();
  }

  /** The methods of the requests waiting on the host, the heartbeat's own ping left out. */
  private pendingMethodsBesidePing(): string[] {
    const methods = new Set<string>();
    for (const entry of this.pending.values()) {
      if (entry.method !== 'ping') methods.add(entry.method);
    }
    return [...methods].sort();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}

/** A host log line into main's log. An error also went to the host's stderr,
 *  which a dev build already passes through, so it is printed here only in a
 *  packaged build, where nothing else would show it. */
function logFromHost(level: 'log' | 'info' | 'warn' | 'error', text: string): void {
  if (level === 'error' && !app.isPackaged) return;
  // `[pty-host-log]`, not `[pty-host]`: the host's own text is not vetted for
  // user content, so it stays out of the Sentry breadcrumbs.
  console[level](`[pty-host-log] ${text}`);
}

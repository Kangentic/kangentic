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
 * - A heartbeat (VS Code's intervals) logs a host that stops answering.
 * - Quit posts `shutdown`; the host flushes, kills, waits for the exit
 *   callbacks and exits itself. Its pid joins the before-quit drain.
 */

import path from 'node:path';
import { app, utilityProcess, type UtilityProcess } from 'electron';
import { recordSyncSpan } from '../../diagnostics/event-loop-lag';
import { unpacked } from '../../utility-process/paths';
import { UtilityRestartPolicy } from '../../utility-process/restart-policy';
import { StderrTail, UTILITY_PROCESS_STDIO, captureWorkerStderr } from '../../utility-process/stderr-tail';
import type { PtyHostLifecycleListener, PtyHostTransport } from './pty-host-client';
import {
  type FromPtyHostMessage,
  type PtyHostCommand,
  type PtyHostEvent,
  type PtyHostMethod,
  type PtyHostRequest,
  type PtyHostRequestMap,
  type ToPtyHostMessage,
  fromPtyHostError,
} from './protocol';

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

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface UtilityPtyHostTransportOptions {
  projectsDir: string;
}

export class UtilityPtyHostTransport implements PtyHostTransport {
  private child: UtilityProcess | null = null;
  private childStderr: StderrTail | null = null;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private listener: ((event: PtyHostEvent) => void) | null = null;
  private lifecycle: PtyHostLifecycleListener | null = null;
  private readonly restartPolicy = new UtilityRestartPolicy({
    service: SERVICE_NAME,
    maxCrashes: MAX_CRASHES,
    backoffMs: RESTART_BACKOFF_MS,
  });
  /** Set once the crash cap is reached: the host core runs in main from then on. */
  private fallback: PtyHostTransport | null = null;
  private fallbackFactory: (() => PtyHostTransport) | null = null;
  /** Messages for a host that is restarting after a crash, sent once it is up. */
  private readonly queuedWhileDown: ToPtyHostMessage[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatInFlight = false;
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

  request<M extends PtyHostMethod>(
    method: M,
    params: PtyHostRequestMap[M]['params'],
    options?: { timeoutMs?: number },
  ): Promise<PtyHostRequestMap[M]['result']> {
    if (this.fallback) return this.fallback.request(method, params, options);
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise<PtyHostRequestMap[M]['result']>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        reject(new Error(`The pty host did not answer ${method} in time`));
      }, options?.timeoutMs ?? REQUEST_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, { resolve: resolve as (result: unknown) => void, reject, timer });
      const message: PtyHostRequest<M> = { type: 'request', id: requestId, method, params };
      this.send(message);
    });
  }

  shutdown(exitWaitMs?: number): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopHeartbeat();
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

  private send(message: ToPtyHostMessage): void {
    const child = this.ensureChild();
    if (!child) {
      this.queuedWhileDown.push(message);
      return;
    }
    try {
      child.postMessage(message);
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
      this.restartPolicy.recordCrash(null);
      this.afterHostLost();
      return null;
    }
    this.child = child;
    const stderrTail = new StderrTail();
    this.childStderr = stderrTail;
    captureWorkerStderr(child, stderrTail, !app.isPackaged);
    child.on('message', (message: unknown) => this.onHostMessage(child, message));
    child.on('exit', (code: number) => this.onHostExit(child, code, stderrTail));
    child.postMessage({ type: 'init', projectsDir: this.options.projectsDir, mainExecutable: process.execPath } satisfies ToPtyHostMessage);
    // Whatever was posted while the previous host was down goes after init,
    // except a request whose caller already timed out (`switchToFallback`
    // skips it too): that caller was told it failed and may retry, and an
    // exec that writes (`git worktree remove --force`) would then run twice.
    for (const queued of this.queuedWhileDown.splice(0)) {
      if (queued.type === 'request' && !this.pending.has(queued.id)) continue;
      child.postMessage(queued);
    }
    return child;
  }

  private onHostMessage(child: UtilityProcess, message: unknown): void {
    if (child !== this.child || typeof message !== 'object' || message === null) return;
    const record = message as FromPtyHostMessage;
    switch (record.type) {
      case 'reply': {
        const entry = this.pending.get(record.id);
        if (!entry) return;
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
        recordSyncSpan(`pty-host:${record.label}`, record.ms);
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
    const lost = new Error('The pty host exited');
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(lost);
      this.pending.delete(requestId);
    }
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
    for (const queued of this.queuedWhileDown.splice(0)) {
      if (queued.type === 'init') continue;
      if (queued.type === 'request') {
        const entry = this.pending.get(queued.id);
        if (!entry) continue;
        this.pending.delete(queued.id);
        clearTimeout(entry.timer);
        fallback.request(queued.method, queued.params).then(entry.resolve, entry.reject);
        continue;
      }
      fallback.post(queued);
    }
    this.lifecycle?.onHostUp(true);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      const startedAt = Date.now();
      const warnTimer = setTimeout(() => {
        console.warn(`[pty-host] has not answered a heartbeat for ${HEARTBEAT_UNRESPONSIVE_MS / 1000} s; terminals may be stalled`);
      }, HEARTBEAT_UNRESPONSIVE_MS);
      warnTimer.unref();
      this.request('ping', {}).then(() => {
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs >= HEARTBEAT_UNRESPONSIVE_MS) console.warn(`[pty-host] answered a heartbeat after ${elapsedMs} ms`);
      }, () => undefined).finally(() => {
        clearTimeout(warnTimer);
        this.heartbeatInFlight = false;
      });
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
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
  console[level](`[pty-host] ${text}`);
}

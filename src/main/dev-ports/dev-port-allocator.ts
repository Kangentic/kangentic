import net from 'node:net';
import { devPortRepository } from '../db/repositories/dev-port-repository';
import type { DevPortLease } from '../../shared/types';

/**
 * Dev-server port allocation.
 *
 * Kangentic allocates and REMEMBERS a port per task; it never launches or
 * supervises a dev server. The user's own column `auto_command` runs
 * `npm run dev -- --port {{port}}`, so this stays framework-agnostic: nothing
 * here parses a dev server's output or owns a child process.
 *
 * Two-source truth, and the ordering matters:
 *   1. the lease table says what Kangentic has PROMISED,
 *   2. a bind probe says what is ACTUALLY free.
 * A candidate must clear both. That is what makes a leaked lease self-correct
 * rather than permanently burning a port, and it is also what stops Kangentic
 * handing out a port some unrelated process already holds.
 */

/**
 * Default scan window, chosen to avoid every common framework default.
 *
 * This started at 4200 on the reasoning that 5173 (Vite's default) is the port a
 * user is most likely to already be running. That reasoning was right and the
 * choice was still wrong: 4200 is ANGULAR's default, so the very first lease on
 * an Angular developer's machine landed on their own running app - observed
 * directly, with a task's pane opening onto an unrelated dashboard.
 *
 * The bind probe means a lease can never take a port that is currently bound,
 * but it cannot help when the user's server is merely stopped at that moment:
 * Kangentic would lease it, and the task's `npm run dev -- --port {{port}}`
 * would then fight the app the next time it starts.
 *
 * 7300-7499 is deliberately boring. Nothing in common use defaults there:
 * 3000 (Next/CRA/Express), 4200 (Angular), 4321 (Astro), 5000 (Flask/.NET),
 * 5173-5174 (Vite, and Kangentic's own preview), 8000 (Django), 8080 (webpack),
 * 9000, 9229 (node inspect). Keep it that way - the point of the range is that a
 * collision should be the exception the probe handles, not the first thing that
 * happens.
 */
export const DEFAULT_DEV_PORT_RANGE_START = 7300;
export const DEFAULT_DEV_PORT_RANGE_END = 7499;

/** How long a probe waits before treating a port as occupied. */
const PROBE_TIMEOUT_MS = 500;

export interface DevPortRangeOptions {
  rangeStart?: number;
  rangeEnd?: number;
  /**
   * Whether a lease may be reclaimed if its port also turns out to be free.
   *
   * Consulted ONLY when the range is exhausted, which is what keeps the normal
   * path free of any extra work. Both conditions are required: a task whose dev
   * server is merely restarting has a live lease and a temporarily silent port,
   * and stealing that would hand its port to someone else moments before it
   * comes back.
   *
   * Omit it and nothing is ever reclaimed, which is the safe default for a
   * caller that cannot judge liveness.
   */
  isLeaseReclaimable?: (lease: DevPortLease) => boolean;
}

/**
 * True when nothing is listening on `port` on the loopback interface.
 *
 * Probes 127.0.0.1 specifically because that is what the Browser pane connects
 * to. A dev server bound to 0.0.0.0 still collides with this bind, so the
 * broader case is covered without probing every interface.
 *
 * Any bind error at all (not just EADDRINUSE) counts as "not free": a port we
 * cannot bind is a port we cannot promise, whatever the reason.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;

    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      probe.removeAllListeners();
      try {
        probe.close();
      } catch {
        // Already closed, or never opened. Nothing to do.
      }
      resolve(free);
    };

    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    timer.unref?.();

    probe.once('error', () => finish(false));
    probe.once('listening', () => finish(true));

    try {
      probe.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch {
      finish(false);
    }
  });
}

function resolveRange(options: DevPortRangeOptions | undefined): {
  start: number;
  end: number;
} {
  const start = options?.rangeStart ?? DEFAULT_DEV_PORT_RANGE_START;
  const end = options?.rangeEnd ?? DEFAULT_DEV_PORT_RANGE_END;
  // A reversed or nonsense range would otherwise silently allocate nothing.
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
    return { start: DEFAULT_DEV_PORT_RANGE_START, end: DEFAULT_DEV_PORT_RANGE_END };
  }
  return { start, end };
}

/**
 * The port this task already holds, or null. A pure read - callers that must
 * not allocate (notably the `{{port}}` template resolver) use this.
 */
export function getDevPortForTask(taskId: string): number | null {
  return devPortRepository.getByTaskId(taskId)?.port ?? null;
}

/**
 * Lease a port for a task, or return the one it already holds.
 *
 * Idempotent per task: calling twice never allocates twice, which is what lets
 * `ensureWorktree` call it unconditionally.
 *
 * Returns null when the whole range is exhausted. Callers treat that as "no
 * port", not as an error - a task with no lease resolves `{{port}}` to empty
 * and the user's `auto_command` falls back to its own default.
 */
export async function allocateDevPort(
  projectId: string,
  taskId: string,
  options?: DevPortRangeOptions,
): Promise<number | null> {
  const existing = devPortRepository.getByTaskId(taskId);
  if (existing) return existing.port;

  const { start, end } = resolveRange(options);

  const leased = await scanRange(start, end, projectId, taskId);
  if (leased !== null) return leased;

  // Exhausted. Before giving up, reclaim leases that are provably dead and try
  // once more.
  //
  // Deliberately here rather than on a timer or a startup pass: a timer would
  // run for the life of the app to serve a table most sessions never fill, and
  // a startup pass only helps the crash that happened before the last launch.
  // Running out of ports is the exact moment reclaiming is worth anything, so
  // that is when it runs - and the normal path pays nothing for it.
  if (!options?.isLeaseReclaimable) return null;
  const reclaimed = await reclaimStaleDevPorts((lease) => !options.isLeaseReclaimable!(lease));
  if (reclaimed.length === 0) return null;

  return scanRange(start, end, projectId, taskId);
}

/** One pass over the range: first port that is both unleased and bindable. */
async function scanRange(
  start: number,
  end: number,
  projectId: string,
  taskId: string,
): Promise<number | null> {
  for (let port = start; port <= end; port += 1) {
    // Cheap check first: skip anything already promised to another task
    // without paying for a socket probe.
    if (devPortRepository.getByPort(port)) continue;

    // Sequential on purpose: a parallel sweep of the whole range would open
    // hundreds of sockets at once just to find one free port.
    if (!(await isPortFree(port))) continue;

    // The claim can still lose to a concurrent allocator between the probe and
    // the write. INSERT OR IGNORE makes that a `false`, not a throw, so we
    // simply move to the next candidate.
    if (devPortRepository.claim(port, projectId, taskId)) {
      return port;
    }
  }

  return null;
}

export function releaseDevPortForTask(taskId: string): void {
  devPortRepository.releaseByTaskId(taskId);
}

export function releaseDevPortsForProject(projectId: string): void {
  devPortRepository.releaseForProject(projectId);
}

/**
 * Drop leases whose task no longer exists AND whose port nothing is listening
 * on. Both conditions are required: a task mid dev-server restart has a live
 * lease and a temporarily silent port, and reclaiming that would hand its port
 * to someone else moments before it comes back.
 *
 * `isTaskAlive` is injected rather than imported so this stays testable without
 * a project database, and so the caller decides what "alive" means (a task can
 * exist in a project whose DB is not currently open).
 *
 * Returns the ports actually reclaimed, for logging.
 */
export async function reclaimStaleDevPorts(
  isTaskAlive: (lease: DevPortLease) => boolean,
): Promise<number[]> {
  const reclaimed: number[] = [];

  for (const lease of devPortRepository.list()) {
    if (isTaskAlive(lease)) continue;

    // Sequential on purpose; this runs once at startup over a small table.
    if (!(await isPortFree(lease.port))) continue;

    devPortRepository.releaseByPort(lease.port);
    reclaimed.push(lease.port);
  }

  return reclaimed;
}

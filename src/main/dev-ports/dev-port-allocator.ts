import net from 'node:net';
import { devPortRepository } from '../db/repositories/dev-port-repository';

/**
 * Dev-server port reservations.
 *
 * Kangentic does NOT decide what a project's ports should be. The project
 * already does, in angular.json, a vite config, a compose file - and a real
 * project often pins several. Nothing is reserved up front, and a task that
 * never asks never holds a port.
 *
 * What Kangentic can do that a project cannot is see across every task and
 * every project it holds. So this answers a QUESTION - "give me N ports nothing
 * else is using" - and its only job is to stop two agents starting servers at
 * the same moment from picking the same number. It never launches or supervises
 * a dev server, and nothing here parses a server's output or owns a child
 * process.
 *
 * SCOPE, precisely: the ledger lives in the global database, which resolves
 * under `PATHS.configDir` and therefore honours KANGENTIC_DATA_DIR. So it spans
 * every project in ONE Kangentic instance, not the machine. A `/preview` runs
 * with its own data dir and so keeps its own ledger - correct for a throwaway
 * instance, but it means a reservation made in one instance is invisible to
 * another. Which is fine, because of the next paragraph.
 *
 * Two-source truth, and the ordering matters:
 *   1. the lease table says what Kangentic has PROMISED,
 *   2. a bind probe says what is ACTUALLY free.
 * A candidate must clear both. The probe is the part that holds across
 * instances and across every process on the machine: it is what stops a port
 * some unrelated process already holds - another Kangentic included - from ever
 * being handed out.
 *
 * LEASE LIFETIME, stated plainly because there is no sweeper. A lease is
 * released when its task is deleted (TaskRepository.delete) or its project is
 * removed (ProjectRepository.delete), and those are the only two paths. There
 * is deliberately no background reclaim: judging whether some other project's
 * task is still alive would mean opening that project's database from here, and
 * the two release paths above cover every ordinary case.
 *
 * The residual, untreated: a task that reserves ports, finishes, and is neither
 * deleted nor archived away holds them for its whole life. Reservations are
 * on-demand and the default range is 200 wide, so this drains slowly if at all -
 * but it drains in one direction only. If the range ever runs dry in practice,
 * that is the signal to add a reclaim, not a sign the probe failed.
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
 *
 * Accepted race, stated because it is inherent to bind-probing rather than a
 * bug to fix: for the ~0.4ms this holds a free port, a dev server trying to
 * bind that exact port fails with EADDRINUSE. A connect probe would avoid it
 * but cannot tell "nothing listening" from "listening and refusing us", which
 * is the distinction the whole ledger rests on. The window is sub-millisecond
 * and the ports probed are ones a caller is about to bind itself.
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
 * Reserve `count` free ports for a task, in one pass.
 *
 * This is the primitive the whole subsystem exists for. Kangentic does not
 * decide what a project's ports should be - the project already does, in its own
 * config - so nothing is assigned up front. A caller about to BIND ports asks
 * for them, and the ledger's job is only to stop two concurrent agents being
 * handed the same number.
 *
 * Reserved TOGETHER on purpose: a project that needs an API and a frontend needs
 * both before it starts either, and asking twice leaves a window where a sibling
 * task takes the second one. Each candidate still clears the bind probe, so a
 * port something else already holds is never handed out.
 *
 * Returns fewer than `count` only when the range runs out; callers should treat
 * a short result as "use my own configured ports for the rest" rather than an
 * error. Already-held ports are returned first and do not count against fresh
 * reservations, so calling twice with the same count is stable.
 */
export async function reserveDevPorts(
  projectId: string,
  taskId: string,
  count: number,
  options?: DevPortRangeOptions,
): Promise<number[]> {
  const wanted = Math.max(1, Math.floor(count));
  const held = devPortRepository.listForTask(taskId).map((lease) => lease.port);
  if (held.length >= wanted) return held.slice(0, wanted);

  const { start, end } = resolveRange(options);
  const reserved = [...held];

  for (let port = start; port <= end && reserved.length < wanted; port += 1) {
    if (devPortRepository.getByPort(port)) continue;
    // Sequential by design: a parallel sweep would open the whole range's
    // worth of sockets just to find a few.
    if (!(await isPortFree(port))) continue;
    if (devPortRepository.claim(port, projectId, taskId)) reserved.push(port);
  }

  return reserved;
}

/** Every port currently reserved by a task. */
export function getDevPortsForTask(taskId: string): number[] {
  return devPortRepository.listForTask(taskId).map((lease) => lease.port);
}

export function releaseDevPortForTask(taskId: string): void {
  devPortRepository.releaseByTaskId(taskId);
}

/** What Kangentic PROMISED about a port, and what the machine actually says. */
export interface DevPortStatus {
  port: number;
  /**
   * Who holds a Kangentic reservation: the asking task, some other task in this
   * instance's ledger, or nobody. The other task is not named - a caller needs
   * to know a port is spoken for, not whose it is.
   */
  reservation: 'this-task' | 'other-task' | null;
  /** Whether something is listening RIGHT NOW, reserved or not. */
  listening: boolean;
}

/**
 * Report both sources of truth for each port.
 *
 * The reason this exists: a reservation is a promise, not a fact. Reading the
 * ledger alone answers "what did Kangentic hand out", which is silent about the
 * case that actually bites - a dev server the user started outside Kangentic
 * entirely, on a port the ledger has never heard of. Only the bind probe sees
 * that, and the probe used to be private to `reserveDevPorts`.
 *
 * The four answers a caller cares about fall out of the two fields: their own
 * reserved port with a server up, their own with nothing on it (restart it),
 * someone else's reservation (do not take it), and `reservation: null` with
 * `listening: true` - in use by something outside this ledger, which is the
 * one no amount of ledger reading could have told them.
 *
 * CHEAP, measured rather than assumed - a loopback bind is a syscall pair, not
 * a network round trip. Medians on a Windows dev machine over 200 samples each:
 *
 *   free port    0.41ms   (the bind succeeds, so a socket is actually created)
 *   busy port    0.03ms   (EADDRINUSE returns before anything is allocated)
 *   20 ports     7ms      (the MCP handler's whole ceiling)
 *
 * Note the inversion: the OCCUPIED case is ~15x faster, so a caller probing
 * ports that are genuinely in use pays even less than these numbers suggest.
 * PROBE_TIMEOUT_MS (500) is a hang guard for a bind that neither succeeds nor
 * errors; it does not fire on loopback and is nowhere near the operating cost.
 * Do not quote it as the budget - a previous version of this comment did, and
 * overstated a 20-port call by three orders of magnitude.
 *
 * Probes sequentially anyway, like every other probe here: at 7ms for the full
 * cap there is nothing to win by opening 20 sockets at once, and serial keeps
 * the momentary bind below one at a time (see the race note under isPortFree).
 *
 * It takes no cap of its own, so a caller that probes an UNBOUNDED list should
 * bring one - not for time, but because each probe momentarily binds a free
 * port.
 */
export async function describeDevPorts(taskId: string, ports: number[]): Promise<DevPortStatus[]> {
  const statuses: DevPortStatus[] = [];

  for (const port of ports) {
    const lease = devPortRepository.getByPort(port);
    const listening = !(await isPortFree(port));
    statuses.push({
      port,
      reservation: lease ? (lease.taskId === taskId ? 'this-task' : 'other-task') : null,
      listening,
    });
  }

  return statuses;
}

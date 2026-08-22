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
 * True when `port` is genuinely available: nothing is listening on it, and we
 * can still bind it ourselves.
 *
 * TWO PHASES, and both are load-bearing. This shipped as bind-only and was
 * wrong - caught by driving a preview, not by any test.
 *
 *   1. CONNECT to the loopback address on both families. Answers "is something
 *      listening", including servers this process could never have detected by
 *      binding.
 *   2. Only if nothing answered, BIND 127.0.0.1. Answers "can we actually take
 *      it" - a port can be unbindable while nothing accepts on it.
 *
 * Why the connect phase exists, measured on Windows (Electron 41, Node 24). A
 * bind conflict is per-exact-address here, so a bind probe only sees a listener
 * on the identical address:
 *
 *   listener      bind 127.0.0.1   bind ::1     connect (both families)
 *   127.0.0.1     detected         MISSED       detected
 *   ::1           MISSED           detected     detected
 *   0.0.0.0       MISSED           MISSED       detected
 *   :: (default)  MISSED           MISSED       detected
 *
 * The old header claimed "a dev server bound to 0.0.0.0 still collides with
 * this bind, so the broader case is covered". That is false on Windows - row
 * three - and the miss that mattered is row two: VITE binds ::1 by default, so
 * the single most common dev server was invisible to the probe. Reserving could
 * hand out a port Vite already held, and checking reported it free.
 *
 * Linux is stricter about cross-address binds, so some of those rows detect
 * there. Do not rely on that: assert the OUTCOME (a listener on any of the four
 * is seen), never which phase caught it. See cross-platform-parity.md.
 *
 * Both families are connected EXPLICITLY rather than via 'localhost', so the
 * answer does not depend on how a machine resolves that name. A host with no
 * IPv6 errors immediately on the ::1 attempt, which falls through to the bind
 * phase exactly as "nothing listening" should.
 *
 * Any error at all (not just EADDRINUSE) counts as "not free": a port we cannot
 * bind is a port we cannot promise, whatever the reason.
 *
 * Accepted race, inherent to the bind phase rather than a bug to fix: for the
 * ~0.4ms it holds a free port, a dev server binding that exact port fails with
 * EADDRINUSE. Connecting FIRST shrinks the exposure - a port anything is
 * listening on short-circuits and is never bound at all - and the ports that do
 * reach phase two are ones the caller is about to bind itself.
 */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let socket: net.Socket | null = null;
    let binder: net.Server | null = null;

    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
      }
      if (binder) {
        binder.removeAllListeners();
        try {
          binder.close();
        } catch {
          // Already closed, or never opened. Nothing to do.
        }
        binder = null;
      }
      resolve(free);
    };

    // One budget across BOTH phases: a connect can hang where a bind cannot
    // (a firewalled address drops the SYN rather than refusing it).
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    timer.unref?.();

    /** Phase 2: nothing answered, so can we take it? */
    const tryBind = (): void => {
      if (settled) return;
      binder = net.createServer();
      binder.once('error', () => finish(false));
      binder.once('listening', () => finish(true));
      try {
        binder.listen({ port, host: '127.0.0.1', exclusive: true });
      } catch {
        finish(false);
      }
    };

    /** Phase 1, once per family. `next` runs when this family finds nothing. */
    const tryConnect = (host: string, next: () => void): void => {
      if (settled) return;
      const attempt = net.createConnection({ port, host });
      socket = attempt;
      attempt.once('connect', () => finish(false));
      attempt.once('error', () => {
        attempt.removeAllListeners();
        attempt.destroy();
        if (socket === attempt) socket = null;
        next();
      });
    };

    tryConnect('127.0.0.1', () => tryConnect('::1', tryBind));
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
 * CHEAP, measured rather than assumed - loopback syscalls, not network round
 * trips. Medians on a Windows dev machine, 200 samples each:
 *
 *   free port    0.84ms   (two connects find nothing, then a bind succeeds)
 *   busy port    0.37ms   (the first connect answers; no bind happens at all)
 *   20 ports     15ms     (the MCP handler's whole ceiling)
 *   200 ports    145ms    (a full default range, which only a scan reaches)
 *
 * Note the inversion: the OCCUPIED case is ~2x faster, because a port something
 * answers on short-circuits at phase one. PROBE_TIMEOUT_MS (500) is a hang
 * guard covering both phases; it does not fire on loopback and is nowhere near
 * the operating cost. Do not quote it as the budget - an earlier version of
 * this comment did, and overstated a 20-port call by three orders of magnitude.
 *
 * Probes sequentially, like every other probe here: at 15ms for the full cap
 * there is nothing to win by opening 20 sockets at once, and serial keeps the
 * momentary bind to one at a time (see the race note under isPortFree).
 *
 * It takes no cap of its own, so a caller that probes an UNBOUNDED list should
 * bring one - not for time, but because a free port gets momentarily bound.
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

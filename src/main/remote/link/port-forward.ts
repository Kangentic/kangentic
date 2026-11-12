/**
 * Carries a dev server's port from an SSH host to this computer (#913), so `http://localhost:<port>`
 * here, and the Browser pane, reach a server an agent started there.
 *
 * Each forward is its own `ssh -N -L 127.0.0.1:<port>:localhost:<port>` child, started with the host's
 * link options (`RemoteHostConnection.args`: BatchMode, keepalives, the key pin, the destination last).
 * It is not carried over the link. A running `ssh` cannot take another forward on Windows (no
 * `ControlMaster`), and a dev server's traffic would share one stream with the terminals' keystrokes.
 * The forward is bound to 127.0.0.1 and named explicitly: `ExitOnForwardFailure` does not reliably fail
 * for a `localhost` bind that is only half taken (OpenSSH bug 3017). The far end says `localhost`, so
 * sshd tries both `127.0.0.1` and `::1` (Vite listens on `::1`).
 *
 * Main sends the full set of ports it wants forwarded for a host (`setPorts`). A port is forwarded once a
 * server listens on it on the host, found by asking the helper (`listeningPorts`) every `pollMs` while a
 * wanted port is still waiting and the link is up. A forward then stays until its port is no longer
 * wanted, the host is removed, or the process ends: a stopped server leaves an idle listener, which costs
 * nothing and spares a restart of the server from tearing the forward down and up.
 *
 * A forward that ends while wanted (the network dropped, ssh refused the forward, the local port was
 * taken) is retried after a backoff, and says why in `list()` meanwhile, in ssh's own words.
 *
 * Imports nothing of electron. Starts `ssh`, so it is classified beside `ssh-connection.ts`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { childProcessEnv } from '../../shared/child-env';
import { killChildTreeNow, stopChildTree } from '../../shared/child-tree-stop';
import type { PortForwardStatus, RemoteHostConnection } from '../protocol/messages';

const STDERR_TAIL_BYTES = 2048;
/** How long ssh gets to open its local listener before the forward counts as failed. */
const READY_TIMEOUT_MS = 15_000;
const READY_PROBE_MS = 150;

export interface PortForwarderOptions {
  /** The ports listening on the host, from its helper. Rejects when the helper cannot be asked. */
  requestListening(hostId: string): Promise<number[]>;
  /** A test swaps the spawner. */
  spawnProcess?: typeof spawn;
  /** Whether something on this computer already holds the port. A test swaps it. */
  isLocalPortBound?: (port: number) => Promise<boolean>;
  /** How a forward's child is ended (its whole tree). A test swaps it. */
  stopProcess?: (child: ChildProcess, immediately: boolean) => void;
  pollMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  log?: (line: string) => void;
}

interface Forward {
  port: number;
  state: PortForwardStatus['state'];
  detail?: string;
  child: ChildProcess | null;
  /** Set when this side ends the child, so its exit is not mistaken for a failure. */
  stopping: boolean;
  stderrTail: string;
  retryMs: number;
  retryTimer: NodeJS.Timeout | null;
  readyTimer: NodeJS.Timeout | null;
}

interface HostForwards {
  connection: Pick<RemoteHostConnection, 'sshPath' | 'args'>;
  linkUp: boolean;
  forwards: Map<number, Forward>;
  pollTimer: NodeJS.Timeout | null;
  polling: boolean;
}

/** Whether the port is held on this computer's loopback: binding it fails only when something has it. */
export function isLocalPortBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/** The `ssh` arguments for one forward: the host's link options, no remote command, the destination last. */
export function forwardArguments(connectionArgs: readonly string[], port: number): string[] {
  const destination = connectionArgs[connectionArgs.length - 1];
  const options = connectionArgs.slice(0, -1);
  return [...options, '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${port}:localhost:${port}`, destination];
}

export class PortForwarder {
  private readonly hosts = new Map<string, HostForwards>();
  private readonly wantedPorts = new Map<string, readonly number[]>();
  private readonly spawnProcess: typeof spawn;
  private readonly localPortBound: (port: number) => Promise<boolean>;
  private readonly pollMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;

  constructor(private readonly options: PortForwarderOptions) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.localPortBound = options.isLocalPortBound ?? isLocalPortBound;
    this.pollMs = options.pollMs ?? 2000;
    this.retryInitialMs = options.retryInitialMs ?? 2000;
    this.retryMaxMs = options.retryMaxMs ?? 30_000;
  }

  /** A host the forwarder may forward for. A re-add keeps what is running and takes the new options. */
  addHost(hostId: string, connection: Pick<RemoteHostConnection, 'sshPath' | 'args'>): void {
    const existing = this.hosts.get(hostId);
    if (existing) {
      existing.connection = connection;
      return;
    }
    const host: HostForwards = { connection, linkUp: false, forwards: new Map(), pollTimer: null, polling: false };
    this.hosts.set(hostId, host);
    const wanted = this.wantedPorts.get(hostId);
    if (wanted) this.applyPorts(hostId, host, wanted);
  }

  removeHost(hostId: string): void {
    this.wantedPorts.delete(hostId);
    const host = this.hosts.get(hostId);
    if (!host) return;
    for (const forward of host.forwards.values()) this.stop(forward, false);
    host.forwards.clear();
    if (host.pollTimer) clearTimeout(host.pollTimer);
    this.hosts.delete(hostId);
  }

  /** The link's state. Forwards already running are left alone; the state only gates new ones. */
  linkState(hostId: string, state: string): void {
    const host = this.hosts.get(hostId);
    if (!host) return;
    host.linkUp = state === 'connected';
    if (host.linkUp) this.schedulePoll(hostId, 0);
  }

  /**
   * The full set of ports wanted for the host. One left out is stopped. Remembered when the host is not
   * added yet, so main may say what it wants before the link is set up.
   */
  setPorts(hostId: string, ports: readonly number[]): void {
    this.wantedPorts.set(hostId, ports);
    const host = this.hosts.get(hostId);
    if (host) this.applyPorts(hostId, host, ports);
  }

  private applyPorts(hostId: string, host: HostForwards, ports: readonly number[]): void {
    const wanted = new Set(ports.filter((port) => Number.isInteger(port) && port > 0 && port <= 65535));
    for (const [port, forward] of host.forwards) {
      if (wanted.has(port)) continue;
      this.stop(forward, false);
      host.forwards.delete(port);
    }
    for (const port of wanted) {
      if (host.forwards.has(port)) continue;
      host.forwards.set(port, { port, state: 'waiting', child: null, stopping: false, stderrTail: '', retryMs: this.retryInitialMs, retryTimer: null, readyTimer: null });
    }
    this.schedulePoll(hostId, 0);
  }

  list(hostId: string): PortForwardStatus[] {
    const host = this.hosts.get(hostId);
    if (!host) return [];
    return [...host.forwards.values()]
      .sort((left, right) => left.port - right.port)
      .map((forward) => ({ port: forward.port, state: forward.state, ...(forward.detail ? { detail: forward.detail } : {}) }));
  }

  /** The process is ending: every forward is stopped at once. */
  dispose(): void {
    for (const host of this.hosts.values()) {
      for (const forward of host.forwards.values()) this.stop(forward, true);
      host.forwards.clear();
      if (host.pollTimer) clearTimeout(host.pollTimer);
    }
    this.hosts.clear();
  }

  private schedulePoll(hostId: string, delayMs: number): void {
    const host = this.hosts.get(hostId);
    if (!host || host.pollTimer || host.polling || !host.linkUp) return;
    if (![...host.forwards.values()].some((forward) => forward.state === 'waiting' && !forward.child)) return;
    host.pollTimer = setTimeout(() => {
      host.pollTimer = null;
      void this.poll(hostId);
    }, delayMs);
    host.pollTimer.unref?.();
  }

  private async poll(hostId: string): Promise<void> {
    const host = this.hosts.get(hostId);
    if (!host || !host.linkUp) return;
    host.polling = true;
    try {
      const listening = new Set(await this.options.requestListening(hostId));
      for (const forward of [...host.forwards.values()]) {
        // Each start awaits, so a forward later in this list can have been dropped by then.
        if (forward.state === 'waiting' && !forward.child && listening.has(forward.port) && host.forwards.get(forward.port) === forward) {
          await this.start(host, forward);
        }
      }
    } catch (error) {
      this.options.log?.(`could not list the ports listening on ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      host.polling = false;
    }
    this.schedulePoll(hostId, this.pollMs);
  }

  private async start(host: HostForwards, forward: Forward): Promise<void> {
    // Something here already holds the port (a stray ssh, another program): say so without starting ssh.
    const portTaken = await this.localPortBound(forward.port);
    // Dropped during the probe (the port left the wanted set, the host was removed): no `ssh` may start,
    // because nothing would be left to stop it. Removing a host empties its map, so this covers that too.
    if (host.forwards.get(forward.port) !== forward) return;
    if (portTaken) {
      this.fail(host, forward, `Port ${forward.port} is already in use on this computer, so the host's server cannot be reached there.`);
      return;
    }
    let child: ChildProcess;
    try {
      child = this.spawnProcess(host.connection.sshPath, forwardArguments(host.connection.args, forward.port), {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
        env: childProcessEnv(),
      });
    } catch (error) {
      this.fail(host, forward, error instanceof Error ? error.message : String(error));
      return;
    }
    forward.child = child;
    forward.stopping = false;
    forward.stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      forward.stderrTail = (forward.stderrTail + text).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error) => {
      if (forward.child === child) this.ended(host, forward, child, error.message);
    });
    child.on('close', (code, signal) => {
      if (forward.child === child) this.ended(host, forward, child, signal ? `ssh was ended by ${signal}` : `ssh exited with code ${code}`);
    });
    this.watchUntilReady(host, forward, child);
  }

  /** ssh prints nothing when a forward is up, so the local port being taken is the sign. */
  private watchUntilReady(host: HostForwards, forward: Forward, child: ChildProcess): void {
    const startedAt = Date.now();
    const check = (): void => {
      forward.readyTimer = null;
      if (forward.child !== child || forward.stopping) return;
      void this.localPortBound(forward.port).then((bound) => {
        if (forward.child !== child || forward.stopping) return;
        if (bound) {
          forward.state = 'forwarding';
          delete forward.detail;
          forward.retryMs = this.retryInitialMs;
          return;
        }
        if (Date.now() - startedAt > READY_TIMEOUT_MS) {
          this.stop(forward, false);
          this.fail(host, forward, 'ssh did not open the port in time.');
          return;
        }
        forward.readyTimer = setTimeout(check, READY_PROBE_MS);
        forward.readyTimer.unref?.();
      });
    };
    forward.readyTimer = setTimeout(check, READY_PROBE_MS);
    forward.readyTimer.unref?.();
  }

  /** The child ended while this side did not ask it to. */
  private ended(host: HostForwards, forward: Forward, child: ChildProcess, how: string): void {
    if (forward.child !== child) return;
    forward.child = null;
    if (forward.readyTimer) clearTimeout(forward.readyTimer);
    forward.readyTimer = null;
    if (forward.stopping) return;
    const detail = forward.stderrTail.trim();
    this.fail(host, forward, detail || how);
  }

  /** Blocked, with the reason, and tried again after a backoff while the port is still wanted. */
  private fail(host: HostForwards, forward: Forward, detail: string): void {
    forward.state = 'blocked';
    forward.detail = detail;
    this.options.log?.(`forward of port ${forward.port} failed: ${detail}`);
    const delay = forward.retryMs;
    forward.retryMs = Math.min(forward.retryMs * 2, this.retryMaxMs);
    forward.retryTimer = setTimeout(() => {
      forward.retryTimer = null;
      forward.state = 'waiting';
      for (const [hostId, candidate] of this.hosts) if (candidate === host) this.schedulePoll(hostId, 0);
    }, delay);
    forward.retryTimer.unref?.();
  }

  private stop(forward: Forward, immediately: boolean): void {
    forward.stopping = true;
    if (forward.retryTimer) clearTimeout(forward.retryTimer);
    if (forward.readyTimer) clearTimeout(forward.readyTimer);
    forward.retryTimer = null;
    forward.readyTimer = null;
    const child = forward.child;
    forward.child = null;
    if (!child) return;
    if (this.options.stopProcess) this.options.stopProcess(child, immediately);
    else if (immediately) killChildTreeNow(child, { leadsGroup: false });
    else stopChildTree(child, { leadsGroup: false });
  }
}

/**
 * Which dev-server ports of a remote project should reach this computer (#913), kept in step with the
 * dev-port ledger. A reserved port of a project that runs on a host is wanted: the pty host's forwarder
 * (`link/port-forward.ts`) carries it once a server listens on it there.
 *
 * Main holds no forward of its own. It works out, per host, the full set of wanted ports from the ledger
 * and the project rows, and sends it when it changes (`setForwards`). The set is recomputed from the
 * tables each time, never patched from one event, because a lease leaves the ledger by several paths: a
 * task delete, a project delete and a host removal, the last two with their own SQL.
 *
 * A sync is deferred a moment so a burst of changes (a project with many tasks deleted) is one send, and it
 * is sent again after the process holding the links restarts, which loses the forwarder's memory.
 */

import type { ProjectRemote } from '../../shared/types';
import type { PortForwardStatus, RemoteHostRequest } from './protocol/messages';

export interface PortForwardPlanDeps {
  leases(): Array<{ port: number; projectId: string }>;
  projects(): Array<{ id: string; remote?: ProjectRemote | null }>;
  send(request: RemoteHostRequest): Promise<unknown>;
  log?: (line: string) => void;
  /** How long a change waits for more before it is sent. */
  debounceMs?: number;
}

export class PortForwardPlan {
  /** What each host was last sent, as text, so an unchanged set is not sent again. */
  private readonly sent = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PortForwardPlanDeps) {}

  /** Send soon. Cheap to call on every ledger change. */
  schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow();
    }, this.deps.debounceMs ?? 100);
    this.timer.unref?.();
  }

  /** The process holding the links restarted: it remembers nothing, so everything is sent again. */
  resend(): void {
    this.sent.clear();
    this.schedule();
  }

  /** A host's link was made again, which may follow one dropped with its forwards, so its set goes out again. */
  resendHost(hostId: string): void {
    this.sent.delete(hostId);
    this.schedule();
  }

  /** The wanted ports of every host, from the ledger, and whether each changed since it was sent. */
  syncNow(): Promise<void> {
    // One at a time, so two overlapping syncs cannot send an older set after a newer one.
    this.running = this.running.then(() => this.send()).catch(() => undefined);
    return this.running;
  }

  /** The host a project runs on, or null for a project on this computer. */
  hostOfProject(projectId: string): string | null {
    return this.deps.projects().find((project) => project.id === projectId)?.remote?.hostId ?? null;
  }

  /** Where each forwarded port of a host stands. Empty when the forwarder cannot be asked. */
  async statusOf(hostId: string): Promise<PortForwardStatus[]> {
    try {
      return (await this.deps.send({ op: 'listForwards', hostId })) as PortForwardStatus[];
    } catch (error) {
      this.deps.log?.(`could not read the forwarded ports of ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private wanted(): Map<string, number[]> {
    const hostOf = new Map<string, string>();
    for (const project of this.deps.projects()) if (project.remote) hostOf.set(project.id, project.remote.hostId);
    const byHost = new Map<string, number[]>();
    for (const lease of this.deps.leases()) {
      const hostId = hostOf.get(lease.projectId);
      if (hostId) byHost.set(hostId, [...(byHost.get(hostId) ?? []), lease.port]);
    }
    return byHost;
  }

  private async send(): Promise<void> {
    const wanted = this.wanted();
    // A host that had ports and has none now is told so, once.
    for (const hostId of this.sent.keys()) if (!wanted.has(hostId)) wanted.set(hostId, []);
    for (const [hostId, ports] of wanted) {
      const key = [...new Set(ports)].sort((left, right) => left - right).join(',');
      if (this.sent.get(hostId) === key) continue;
      try {
        await this.deps.send({ op: 'setForwards', hostId, ports: key === '' ? [] : key.split(',').map(Number) });
        // An emptied host is remembered as empty, not dropped, so a later resend still clears nothing twice.
        this.sent.set(hostId, key);
      } catch (error) {
        this.deps.log?.(`could not send the forwarded ports of ${hostId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

let current: PortForwardPlan | null = null;

/** Set once at startup by the remote hosting, as the launch resolver is, so a command handler needs no new dependency. */
export function setPortForwardPlan(plan: PortForwardPlan | null): void {
  current = plan;
}

export function getPortForwardPlan(): PortForwardPlan | null {
  return current;
}

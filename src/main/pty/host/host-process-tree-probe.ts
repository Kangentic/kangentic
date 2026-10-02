/**
 * The background-shell watcher's process-tree probe, answered by the pty
 * host. The host keeps the persistent PowerShell child (Windows) or runs `ps`
 * (POSIX), so neither its spawn nor its parse lands on main: the first spawn
 * alone measured 28 to 230 ms on main, and `ps` ran every watcher cycle.
 * Liveness stays a local signal-0 check, which costs nothing.
 */

import { isProcessAlive } from '../../shared/process-liveness';
import { walkDescendants, type ProcessInfo, type ProcessTreeProbe } from '../../activity-engine/background-shell/process-tree';

export class HostProcessTreeProbe implements ProcessTreeProbe {
  constructor(private readonly listFromHost: () => Promise<ProcessInfo[]>) {}

  isAlive(pid: number): boolean {
    return isProcessAlive(pid);
  }

  /** [] when the host cannot answer, which the watcher reads as "skip this
   *  cycle", as it does a probe timeout. */
  async listAllProcesses(): Promise<ProcessInfo[]> {
    try {
      return await this.listFromHost();
    } catch {
      return [];
    }
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    const all = await this.listAllProcesses();
    if (all.length === 0) return [];
    return walkDescendants(all, rootPid);
  }

  /** The host owns the probe's child and ends it at its own shutdown. */
  dispose(): void {
    // Nothing held here.
  }
}

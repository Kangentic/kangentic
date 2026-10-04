/**
 * The background-shell watcher's process-tree probe, answered by the pty
 * host (`host-process-table.ts`: Toolhelp on Windows, `ps` on POSIX), so no
 * enumeration or parse lands on main: the PowerShell probe's first spawn
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

  /** The host owns its process table and ends any child of it at its own shutdown. */
  dispose(): void {
    // Nothing held here.
  }
}

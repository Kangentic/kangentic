/**
 * The background-shell watcher's process table, as the pty host answers it
 * (`listProcesses`, read by `HostProcessTreeProbe` on main).
 *
 * Windows lists processes with Toolhelp through koffi (`listWin32Processes`,
 * the listing the task reap's reader already makes). It replaced a persistent
 * PowerShell child running `Get-CimInstance Win32_Process` on every watcher
 * cycle. Measured on 410 processes: 8 ms against 140 ms (median of 10) for the
 * warm query, with the same pids, parents and names, and the PowerShell child
 * is no longer started at all. If koffi cannot load, the table falls back to
 * that PowerShell probe for the rest of the host's life, so the watcher keeps
 * working. POSIX runs `ps` (about 10 ms) as before.
 *
 * [] means "no table this cycle", which the watcher's probe-health guard reads
 * as "skip the cycle", as it does a probe timeout.
 */

import { createProcessTreeProbe, type ProcessInfo, type ProcessTreeProbe } from '../../activity-engine/background-shell/process-tree';
import { listWin32Processes, type Win32ProcessRow } from '../process-tag/win32-reader';

export interface HostProcessTableDeps {
  platform?: NodeJS.Platform;
  listToolhelp?: () => Promise<Win32ProcessRow[]>;
  createFallbackProbe?: () => ProcessTreeProbe;
}

/** A Toolhelp row in the watcher's shape: the image name lowercased, `.exe` dropped, as the PowerShell probe parsed it. */
export function toProcessInfo(row: Win32ProcessRow): ProcessInfo {
  return { pid: row.pid, ppid: row.ppid, comm: row.image.toLowerCase().replace(/\.exe$/, '') };
}

export class HostProcessTable {
  private fallbackProbe: ProcessTreeProbe | null = null;
  private toolhelpUnavailable = false;

  constructor(private readonly deps: HostProcessTableDeps = {}) {}

  async list(): Promise<ProcessInfo[]> {
    if ((this.deps.platform ?? process.platform) === 'win32' && !this.toolhelpUnavailable) {
      try {
        const rows = await (this.deps.listToolhelp ?? listWin32Processes)();
        return rows.map(toProcessInfo);
      } catch (error) {
        this.toolhelpUnavailable = true;
        console.warn('[PTY-HOST] Toolhelp process listing failed; the watcher falls back to the PowerShell probe:', error);
      }
    }
    this.fallbackProbe ??= (this.deps.createFallbackProbe ?? createProcessTreeProbe)();
    return this.fallbackProbe.listAllProcesses();
  }

  /** Ends the fallback's PowerShell child, if one was ever started. */
  dispose(): void {
    this.fallbackProbe?.dispose();
    this.fallbackProbe = null;
  }
}

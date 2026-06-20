import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

/**
 * Shape of the long-lived PowerShell child. `stdio: ['pipe', 'pipe', 'ignore']`
 * means stdin is writable, stdout is readable, stderr is null (suppressed).
 */
type PowerShellChild = ChildProcessByStdio<Writable, Readable, null>;

/**
 * Cross-platform process-tree probe.
 *
 * `isAlive(pid)` uses POSIX signal-0 semantics, which Node.js
 * implements on Windows too (via OpenProcess). EPERM is treated as
 * alive - the process exists but we lack permission to signal it.
 *
 * `listDescendants(rootPid)` enumerates the process tree rooted at
 * `rootPid` by spawning a single OS query per call:
 *   - Windows: PowerShell's `Get-CimInstance Win32_Process` with a
 *     ParentProcessId filter, walked recursively in JS.
 *   - POSIX: `ps -A -o pid=,ppid=,comm=` + a JS-side parent-map walk.
 *
 * Spawn-shell-out is the only reliable cross-platform path. Node has
 * no built-in API for descendant enumeration. Each query runs with
 * a short timeout; on timeout or non-zero exit, returns an empty
 * descendant set (degrades gracefully to "process tree unknown",
 * which the watcher treats as "no orphan signal" and falls back to
 * the escape hatch).
 */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Lowercase basename of the executable (e.g. "bash", "node"). */
  comm: string;
}

export interface ProcessTreeProbe {
  /** Returns true if the PID is alive (or exists but we can't signal it). */
  isAlive(pid: number): boolean;
  /**
   * Returns process info for ALL processes on the system. Spawns one
   * OS query (`Get-CimInstance` / `ps -A`). Returns [] on probe
   * failure (timeout, non-zero exit, parse error).
   *
   * The watcher's per-cycle path uses this once per cycle and shares
   * the snapshot across all sessions, walking each session's subtree
   * in JS via `walkDescendants`. This collapses what would be N
   * PowerShell spawns (one per session) on Windows into a single
   * spawn per poll cycle - critical for users running 10+ tasks in
   * parallel.
   */
  listAllProcesses(): Promise<ProcessInfo[]>;
  /**
   * Convenience wrapper: returns descendants of `rootPid`. Spawns
   * `listAllProcesses` internally. Used by one-shot callers (resume
   * reconciliation) where sharing across sessions doesn't apply.
   *
   * Returns [] on probe failure.
   */
  listDescendants(rootPid: number): Promise<ProcessInfo[]>;
  /**
   * Tear down any long-lived resources the probe holds (e.g. the
   * persistent PowerShell child on Windows). Idempotent. Synchronous
   * so it slots into the `before-quit` shutdown contract.
   *
   * POSIX probe is a no-op because it spawns per-call.
   */
  dispose(): void;
}

/** Default per-spawn timeout for process enumeration. */
const PROBE_TIMEOUT_MS = 1500;

export function createProcessTreeProbe(): ProcessTreeProbe {
  if (process.platform === 'win32') {
    return new WindowsProbe();
  }
  return new PosixProbe();
}

/**
 * Windows probe with a persistent PowerShell child for the steady-state
 * polling path. Spawning `pwsh.exe` on every cycle pays ~500 ms-1 s
 * of .NET startup per call, which at the watcher's 2 s cadence pins
 * a CPU core continuously. Keeping one child alive across the session
 * collapses that to a single startup cost and ~50 ms WMI queries
 * thereafter.
 *
 * Protocol:
 *   - Parent writes `Q\n` to stdin → child runs the Win32_Process WMI
 *     query, emits CSV, then a one-line sentinel (`===KANGENTIC_PS_..`)
 *     so the parent can detect query completion in a streaming buffer.
 *   - Parent writes `EXIT\n` (or closes stdin) → child breaks its
 *     read loop and exits.
 *
 * Failure modes are handled the same way the watcher already tolerates:
 * a hung query times out, kills the child, and returns []. The child
 * lazily respawns on the next call. On ENOENT for `pwsh.exe`, the
 * spawner falls back to `powershell.exe`.
 *
 * `listDescendants(rootPid)` (used by resume reconciliation) remains
 * a thin wrapper around `listAllProcesses()` + `walkDescendants`.
 */
class WindowsProbe implements ProcessTreeProbe {
  private child: PowerShellChild | null = null;
  private sentinel = '';
  private stdoutBuffer = '';
  private pendingQuery: {
    resolve: (result: ProcessInfo[]) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private disposed = false;

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EPERM';
    }
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    const all = await this.listAllProcesses();
    if (all.length === 0) return [];
    return walkDescendants(all, rootPid);
  }

  async listAllProcesses(): Promise<ProcessInfo[]> {
    if (this.disposed) return [];
    if (this.pendingQuery !== null) {
      // Defense-in-depth: the watcher's `polling` guard serializes
      // cycles, so this should never happen in practice. Returning
      // [] preserves the existing "probe failure → skip cycle"
      // semantics rather than stomping on the in-flight query.
      return [];
    }
    if (this.child === null) {
      return this.spawnAndFirstQuery();
    }
    return this.queryExistingChild();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pendingQuery;
    this.pendingQuery = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    this.shutdownChild();
  }

  /**
   * Try pwsh.exe first; if that's not installed, fall back to
   * powershell.exe (Windows PowerShell 5.x, shipped with all
   * supported Windows installs). The first sentinel-delimited reply
   * doubles as a health check: if the child can answer one query,
   * we trust it for subsequent ones.
   */
  private async spawnAndFirstQuery(): Promise<ProcessInfo[]> {
    for (const executable of ['pwsh.exe', 'powershell.exe']) {
      const result = await this.attemptSpawn(executable);
      if (result !== null) return result;
    }
    return [];
  }

  /**
   * Spawn `executable`, kick off the first query, and commit the child
   * to instance state on success.
   *
   * Returns:
   *   - null on ENOENT (binary not found) so the caller can try the
   *     next executable
   *   - [] on any other failure (spawn error, write error, timeout,
   *     exit before sentinel)
   *   - parsed ProcessInfo[] on success
   */
  private attemptSpawn(executable: string): Promise<ProcessInfo[] | null> {
    return new Promise((resolve) => {
      const sentinel = `===KANGENTIC_PS_PROBE_END_${randomUUID()}===`;
      const script = buildReadLoopScript(sentinel);
      let child: PowerShellChild;
      try {
        child = spawn(
          executable,
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] },
        );
      } catch {
        resolve(null);
        return;
      }
      let settled = false;
      let bootstrapBuffer = '';
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* ignore */ }
        resolve([]);
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const errno = (err as NodeJS.ErrnoException).code;
        resolve(errno === 'ENOENT' ? null : []);
      });
      child.on('exit', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve([]);
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        bootstrapBuffer += chunk.toString('utf-8');
        const sentinelIndex = bootstrapBuffer.indexOf(sentinel);
        if (sentinelIndex < 0) return;
        settled = true;
        clearTimeout(timer);
        const csvBlock = bootstrapBuffer.slice(0, sentinelIndex);
        const remainder = bootstrapBuffer.slice(sentinelIndex + sentinel.length);
        this.commitChild(child, sentinel, remainder);
        resolve(_parseWindowsCsv(csvBlock));
      });
      try {
        child.stdin.write('Q\n');
      } catch {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch { /* ignore */ }
        resolve([]);
      }
    });
  }

  /**
   * Commit a freshly-spawned, health-checked child to instance state.
   * Replaces the bootstrap data handler with the long-lived one that
   * feeds `processStdoutBuffer`.
   */
  private commitChild(
    child: PowerShellChild,
    sentinel: string,
    initialBuffer: string,
  ): void {
    this.child = child;
    this.sentinel = sentinel;
    this.stdoutBuffer = initialBuffer;
    child.stdout.removeAllListeners('data');
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.disposed) return;
      this.stdoutBuffer += chunk.toString('utf-8');
      this.processStdoutBuffer();
    });
    const onExitOrError = () => this.handleChildExit();
    child.removeAllListeners('exit');
    child.removeAllListeners('error');
    child.on('exit', onExitOrError);
    child.on('error', onExitOrError);
    // Suppress unhandled-error noise from stdin pipe writes that race
    // with child exit (EPIPE / ECONNRESET).
    child.stdin.on('error', () => { /* ignore */ });
  }

  private processStdoutBuffer(): void {
    if (this.pendingQuery === null) return;
    if (this.sentinel === '') return;
    const sentinelIndex = this.stdoutBuffer.indexOf(this.sentinel);
    if (sentinelIndex < 0) return;
    const csvBlock = this.stdoutBuffer.slice(0, sentinelIndex);
    this.stdoutBuffer = this.stdoutBuffer.slice(sentinelIndex + this.sentinel.length);
    const pending = this.pendingQuery;
    this.pendingQuery = null;
    clearTimeout(pending.timer);
    pending.resolve(_parseWindowsCsv(csvBlock));
  }

  /**
   * Child exited (clean EXIT, crash, or stdin closed). Reject any
   * in-flight query with [] and clear state so the next call respawns.
   */
  private handleChildExit(): void {
    const pending = this.pendingQuery;
    this.pendingQuery = null;
    if (pending !== null) {
      clearTimeout(pending.timer);
      pending.resolve([]);
    }
    this.child = null;
    this.sentinel = '';
    this.stdoutBuffer = '';
  }

  private queryExistingChild(): Promise<ProcessInfo[]> {
    return new Promise((resolve) => {
      const child = this.child;
      if (child === null) {
        resolve([]);
        return;
      }
      const timer = setTimeout(() => {
        if (this.pendingQuery === null) return;
        this.pendingQuery = null;
        // Unresponsive child - kill it so the next call respawns.
        this.shutdownChild();
        resolve([]);
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      this.pendingQuery = { resolve, timer };
      try {
        child.stdin.write('Q\n');
      } catch {
        // Write failed (child stdin closed before exit handler fired).
        // Tear down and return [].
        const pending = this.pendingQuery;
        this.pendingQuery = null;
        if (pending !== null) clearTimeout(pending.timer);
        this.shutdownChild();
        resolve([]);
      }
    });
  }

  private shutdownChild(): void {
    const child = this.child;
    this.child = null;
    this.sentinel = '';
    this.stdoutBuffer = '';
    if (child === null) return;
    try {
      if (child.stdin.writable) {
        child.stdin.write('EXIT\n');
        child.stdin.end();
      }
    } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }
}

/**
 * Build the PowerShell read-loop script that the persistent child
 * runs. Exported with `_` prefix so unit tests can assert the
 * sentinel substitution and command vocabulary without spawning a
 * real PowerShell process.
 *
 * Why each bit matters:
 *   - `$ErrorActionPreference = 'SilentlyContinue'`: a transient
 *     WMI access-denied error on a protected process must not kill
 *     the loop. An empty CSV from one query is benign because the
 *     watcher's probe-health guard (snapshot must contain rootPid)
 *     treats it as "probe failure → skip cycle".
 *   - `[Console]::In.ReadLine()` (not `Read-Host`): Read-Host writes
 *     a prompt to stdout which would inject extraneous bytes into
 *     our parse stream. Console.In reads the raw pipe.
 *   - `if ($null -eq $cmd ...)`: ReadLine returns $null on EOF
 *     (parent closed stdin) so we exit cleanly during shutdown.
 *   - Sentinel emitted via `Write-Output` after the CSV pipeline
 *     completes; its UUID component makes collision with any CSV
 *     value impossible in practice.
 */
export function _buildReadLoopScript(sentinel: string): string {
  return buildReadLoopScript(sentinel);
}

function buildReadLoopScript(sentinel: string): string {
  return (
    `$ErrorActionPreference = 'SilentlyContinue'; `
    + `while ($true) { `
    +   `$cmd = [Console]::In.ReadLine(); `
    +   `if ($null -eq $cmd -or $cmd -eq 'EXIT') { break } `
    +   `if ($cmd -eq 'Q') { `
    +     `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Csv -NoTypeInformation; `
    +     `Write-Output '${sentinel}' `
    +   `} `
    + `}`
  );
}

class PosixProbe implements ProcessTreeProbe {
  // ps -A is fast enough (~10ms per spawn) that the per-call model
  // does not need amortizing. dispose() exists to satisfy the
  // cross-platform interface contract.
  dispose(): void { /* no-op */ }

  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'EPERM';
    }
  }

  async listDescendants(rootPid: number): Promise<ProcessInfo[]> {
    const all = await this.listAllProcesses();
    if (all.length === 0) return [];
    return walkDescendants(all, rootPid);
  }

  listAllProcesses(): Promise<ProcessInfo[]> {
    // ps -A: all processes. -o pid=,ppid=,comm=: tab-separated, no headers.
    return new Promise((resolve) => {
      const child = spawn(
        'ps',
        ['-A', '-o', 'pid=,ppid=,comm='],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve([]);
      }, PROBE_TIMEOUT_MS);
      timer.unref();
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (code !== 0) { resolve([]); return; }
        resolve(_parsePosixPs(stdout));
      });
    });
  }
}

/** A processes-grouped-by-parent-PID index, built once and walked many times. */
export type ProcessIndexByParent = Map<number, ProcessInfo[]>;

/**
 * Group every process by its parent PID. The bg-shell watcher builds this ONCE
 * per poll cycle from the shared `listAllProcesses` snapshot and reuses it for
 * every session's `walkDescendantsFromIndex` call - rebuilding it per session
 * (as a bare `walkDescendants` per session would) repeats the O(P) grouping S
 * times per cycle for no benefit, since the snapshot is identical across
 * sessions.
 */
export function indexByParent(all: ProcessInfo[]): ProcessIndexByParent {
  const byParent: ProcessIndexByParent = new Map();
  for (const info of all) {
    let bucket = byParent.get(info.ppid);
    if (!bucket) {
      bucket = [];
      byParent.set(info.ppid, bucket);
    }
    bucket.push(info);
  }
  return byParent;
}

/**
 * Collect all descendants of `rootPid` from a pre-built parent index.
 * Cycle-safe: tracks visited PIDs. See `indexByParent` for why the index is
 * built once per cycle rather than per call.
 */
export function walkDescendantsFromIndex(
  byParent: ProcessIndexByParent,
  rootPid: number,
): ProcessInfo[] {
  const result: ProcessInfo[] = [];
  const visited = new Set<number>();
  const queue: number[] = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (visited.has(parent)) continue;
    visited.add(parent);
    const children = byParent.get(parent) ?? [];
    for (const child of children) {
      if (visited.has(child.pid)) continue;
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

/**
 * Build the parent index and walk all descendants of `rootPid` in one call.
 * Used by one-shot callers (resume-time adoption, tests). The bg-shell watcher
 * does not use this on its hot path: it builds the index once per cycle via
 * `indexByParent` and calls `walkDescendantsFromIndex` per session instead.
 */
export function walkDescendants(all: ProcessInfo[], rootPid: number): ProcessInfo[] {
  return walkDescendantsFromIndex(indexByParent(all), rootPid);
}

/**
 * Parse PowerShell's CSV output for Get-CimInstance Win32_Process.
 * Format (with header):
 *   "ProcessId","ParentProcessId","Name"
 *   "1234","5678","node.exe"
 *
 * Exported with `_` prefix for direct fixture testing in
 * `tests/unit/process-tree.test.ts`. Not part of the public API.
 */
export function _parseWindowsCsv(csv: string): ProcessInfo[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) return [];
  const result: ProcessInfo[] = [];
  // Skip header (first line)
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 3) continue;
    const pid = Number.parseInt(fields[0], 10);
    const ppid = Number.parseInt(fields[1], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const comm = (fields[2] ?? '').toLowerCase().replace(/\.exe$/, '');
    result.push({ pid, ppid, comm });
  }
  return result;
}

/** Parse a single CSV line. Handles double-quoted fields with escaped quotes. */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = false; }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Parse `ps -A -o pid=,ppid=,comm=` output.
 *   1234  5678  /usr/local/bin/node
 *   2345  1234  bash
 *
 * Exported with `_` prefix for direct fixture testing in
 * `tests/unit/process-tree.test.ts`. Not part of the public API.
 */
export function _parsePosixPs(output: string): ProcessInfo[] {
  const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const result: ProcessInfo[] = [];
  for (const line of lines) {
    // Whitespace-separated; comm may contain spaces but typically doesn't
    // when emitted by ps with comm= (basename only on most platforms).
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    const commPath = match[3].trim();
    // basename
    const lastSep = Math.max(commPath.lastIndexOf('/'), commPath.lastIndexOf('\\'));
    const comm = (lastSep >= 0 ? commPath.slice(lastSep + 1) : commPath).toLowerCase();
    result.push({ pid, ppid, comm });
  }
  return result;
}

/**
 * Allow-list of basenames the bg-shell watcher treats as "this is a
 * shell, not an internal process." Claude Code's
 * `Bash(run_in_background:true)` spawns a shell wrapper (bash on
 * unix, bash/sh/cmd on Windows depending on Git Bash/WSL availability)
 * which is what we want to track. Everything else - node, npm, python,
 * tsx, etc. - is the agent CLI itself or its internal subprocesses
 * (MCP servers, package runners, test workers) which should NOT be
 * counted: they're either always present (false positives at register)
 * or grandchildren of a shell we're already counting (double-counting).
 *
 * Filter is conservative - missing a shell type causes Tier B
 * under-detection, which the 5-min escape hatch backstops. Adding a
 * non-shell entry would over-detect and prematurely synthesize
 * background_shell_end events.
 */
export const SHELL_LIKE_COMM_PATTERNS: readonly RegExp[] = [
  /^bash(?:\.exe)?$/,
  /^sh(?:\.exe)?$/,
  /^zsh(?:\.exe)?$/,
  /^fish(?:\.exe)?$/,
  /^cmd(?:\.exe)?$/,
  /^pwsh(?:\.exe)?$/,
  /^powershell(?:\.exe)?$/,
];

export function isShellLike(comm: string): boolean {
  const normalized = comm.toLowerCase();
  return SHELL_LIKE_COMM_PATTERNS.some((pat) => pat.test(normalized));
}

/**
 * Filter `descendants` down to TOPMOST shell-like processes - shells
 * whose immediate parent within the descendant set is NOT itself
 * shell-like. Used by both the bg-shell watcher (per-cycle counting)
 * and the resume reconciler (one-shot adoption).
 *
 * Rationale: `bash -c "npm test"` on Windows expands to bash -> cmd ->
 * node (npm.cmd routes through cmd.exe). Both bash and cmd match the
 * shell allowlist, but cmd is a wrapper inside bash, not a separate
 * logical bg shell. We use immediate-parent (not transitive ancestor)
 * because the agent CLI itself is sometimes launched through a shell
 * shim (pwsh -> npm-shim cmd.exe -> node[claude]). A transitive rule
 * would treat that shim cmd as a "shell-like ancestor" of every bash
 * the agent spawns and skip them all, breaking the count.
 *
 * Walking via `descendantsByPid.get(info.ppid)` returns undefined for
 * direct children of rootPid (rootPid is not in the descendant set),
 * so they always count regardless of whether rootPid itself is
 * shell-like.
 */
export function filterTopmostShellLikeDescendants(
  descendants: readonly ProcessInfo[],
  isShellLikeFn: (comm: string) => boolean = isShellLike,
): ProcessInfo[] {
  const descendantsByPid = new Map<number, ProcessInfo>();
  for (const descendant of descendants) descendantsByPid.set(descendant.pid, descendant);
  return descendants.filter((descendant) => {
    if (!isShellLikeFn(descendant.comm)) return false;
    const parent = descendantsByPid.get(descendant.ppid);
    return parent === undefined || !isShellLikeFn(parent.comm);
  });
}

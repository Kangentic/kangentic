import { app } from 'electron';

/**
 * The model workers grow with use, not only with what they hold: a fresh
 * dictation worker is 889 MB of commit after one press and reached 3.05 GB
 * over a day of them, and the embedding worker went from 444 MB at init to
 * 640 MB after a single query (#706). onnxruntime never returns that arena
 * to the OS in-process, so the only reclaim is a process exit, and the idle
 * recycle (IDLE_SHUTDOWN_MS in each client) only reaches a worker that goes
 * quiet for half an hour. A heavy user never gives it that gap.
 *
 * So a worker whose commit has passed this ceiling gets the SHORT window
 * instead: it is recycled at the next couple of minutes of quiet, which the
 * next press or query then pays for with one reload overlapped with its own
 * work (a sub-second release for dictation, a keyword-first query for
 * search). The ceiling sits above what one session's worth of use costs, so
 * a worker is never recycled for having done its job once.
 */
export const WORKER_COMMIT_CEILING_BYTES = 1.5 * 1024 * 1024 * 1024;

/** The idle window a worker over the ceiling gets. */
export const HEAVY_IDLE_SHUTDOWN_MS = 2 * 60_000;

/**
 * Private (committed) bytes of one of this app's child processes, or null
 * when it is not in Electron's process table (already exited, or a pid the
 * table does not carry). Electron reports the figure in kilobytes.
 *
 * Also null on macOS and Linux: `MemoryInfo.privateBytes` is declared
 * `@platform win32` and optional, so it arrives undefined there rather than
 * as a number. Both callers read a null as "not over the ceiling", so the
 * short window is a Windows-only escalation and every other platform keeps
 * the standard idle recycle. That is the intended shape, not a gap to close
 * with `workingSetSize`: commit is a Windows accounting concept, and the
 * low-memory warning this ceiling serves is itself gated to win32
 * (`hasVerifiedCommitReading` in diagnostics/host-memory.ts), so the
 * escalation is absent exactly where the pressure it answers cannot be read.
 */
export function readProcessCommitBytes(pid: number): number | null {
  for (const entry of app.getAppMetrics()) {
    if (entry.pid !== pid) continue;
    const privateKilobytes = entry.memory.privateBytes;
    return typeof privateKilobytes === 'number' ? privateKilobytes * 1024 : null;
  }
  return null;
}

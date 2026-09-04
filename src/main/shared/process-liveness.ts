/**
 * Liveness probe for a child process id, shared by the shutdown drain
 * (src/main/pty/shutdown/exit-callback-drain.ts) and the background-shell
 * process-tree probes.
 *
 * POSIX signal-0 semantics, which Node implements on Windows too (OpenProcess
 * plus GetExitCodeProcess, so a terminated process reads as dead even while
 * another handle keeps its pid reserved). EPERM means the process exists but
 * cannot be signalled, which counts as alive. On POSIX a zombie stays alive
 * until it is reaped, which is exactly what the shutdown drain wants: node-pty's
 * exit thread reaps the child a moment before it queues the exit callback.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

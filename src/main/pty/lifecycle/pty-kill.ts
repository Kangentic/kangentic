import type * as pty from 'node-pty';

/**
 * Kill a node-pty instance without propagating errors.
 *
 * On Windows, libuv returns EACCES from the underlying kill syscall when the
 * child PID handle is dead (e.g. Claude Code already flushed `/exit` before
 * we got here, or node-pty's conpty bridge closed the handle). On POSIX the
 * equivalent is ESRCH. The calling site has already nulled the pty reference
 * to prevent double-kill, so the session state is consistent - any throw is
 * just log noise that can abort surrounding cleanup loops like killAll() or
 * syncShutdownCleanup().
 *
 * Returns true if the kill landed on a live process, false if the process was
 * already dead. Callers that wait on the 'exit' event can use the return
 * value to skip the wait - the event already fired before we got here.
 */
export function safeKillPty(ptyRef: pty.IPty): boolean {
  try {
    ptyRef.kill();
    return true;
  } catch (error) {
    const errnoCode = (error as NodeJS.ErrnoException)?.code;
    if (errnoCode !== 'EACCES' && errnoCode !== 'ESRCH') {
      console.warn('[SESSION] pty.kill() failed:', error);
    }
    return false;
  }
}

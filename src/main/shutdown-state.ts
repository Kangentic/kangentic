/**
 * Shared shutdown state module.
 *
 * Provides a global shutdown flag that all spawn/recovery paths check
 * before creating new PTY sessions. This prevents async operations
 * (session recovery, queue promotion) from spawning processes after
 * syncShutdownCleanup() has already killed everything.
 */

let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function setShuttingDown(): void {
  shuttingDown = true;
}

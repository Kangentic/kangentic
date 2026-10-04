import { getOpenProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { isShuttingDown } from '../../shutdown-state';
import type { PtyResizeOrigin } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * A spawn's deferred write, per session id, until it runs. A later write for
 * the same session cancels it: the spawn grid it carries is older.
 */
const pendingSpawnWrites = new Map<string, NodeJS.Immediate>();

/**
 * Write a session's new PTY grid to its record (`last_pty_cols/rows`), from the
 * session manager's `pty-resize` event, so a resume after a desktop restart or a
 * pty host crash can spawn at it (SpawnSessionInput.restoredGrid). Every change
 * is written as it happens rather than once at suspend, which also covers an OS
 * kill and keeps the synchronous quit path untouched.
 *
 * - A phone's grid is skipped: the size guard owns giving it back, and an exit
 *   disarms the guard without restoring (ManagedSession.lastPtyGrid skips it too).
 * - The spawn's announcement fires inside `sessionManager.spawn()`, before the
 *   caller inserts the record, so that one write waits for `setImmediate`. Every
 *   spawn caller inserts synchronously once `spawn()` resolves, which is a
 *   microtask, so the row exists by then. A queue promotion's announcement
 *   finds its `queued` row already there and is merely deferred with the rest.
 *   A desktop or park write that lands before the deferred one runs cancels
 *   it, so the older spawn grid never overwrites a newer one.
 * - Only a project database already open is written: `getProjectDb` would
 *   silently reopen one a close or the quit just released.
 */
export function persistPtyGrid(
  context: Pick<IpcContext, 'sessionManager'>,
  sessionId: string,
  grid: { cols: number; rows: number },
  origin: PtyResizeOrigin,
): void {
  if (origin === 'mobile') return;
  if (isShuttingDown()) return;
  const projectId = context.sessionManager.getSessionProjectId(sessionId);
  if (!projectId) return;
  const write = (): void => {
    if (isShuttingDown()) return;
    try {
      const database = getOpenProjectDb(projectId);
      if (!database) return;
      new SessionRepository(database).updatePtyGrid(sessionId, grid);
    } catch {
      // Best-effort: a resume without a recorded grid spawns at the default.
    }
  };
  const pendingSpawnWrite = pendingSpawnWrites.get(sessionId);
  if (pendingSpawnWrite !== undefined) {
    clearImmediate(pendingSpawnWrite);
    pendingSpawnWrites.delete(sessionId);
  }
  if (origin !== 'spawn') {
    write();
    return;
  }
  pendingSpawnWrites.set(sessionId, setImmediate(() => {
    pendingSpawnWrites.delete(sessionId);
    write();
  }));
}

import { getOpenProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { isShuttingDown } from '../../shutdown-state';
import type { IpcContext } from '../ipc-context';

/**
 * The path last written per session, so a status tick that repeats it costs a
 * map lookup instead of a write. Dropped when the session leaves the registry.
 */
const writtenPaths = new Map<string, string>();

/**
 * Write the transcript path a session's agent reported (`SessionUsage
 * .transcriptPath`, from Claude's status line) to its record, from the session
 * manager's `usage` event, whenever it changes.
 *
 * The resume check proves a conversation's file is gone from this path. The
 * session's own folder held it in `status.json` before this column existed,
 * but a quit or a removal deletes that folder (`detachAndDelete`), which left
 * most old conversations with no evidence at all. Written as the path arrives,
 * on the first status tick, so no exit path has to remember it.
 *
 * Task sessions only: a Command Terminal or a workflow's own agent has no
 * record. Only a project database already open is written, as
 * `persistPtyGrid` does. A write that found no row (the record is inserted
 * right after the spawn resolves, before any status tick in practice) is not
 * remembered, so the next tick tries again.
 */
export function persistTranscriptPath(
  context: Pick<IpcContext, 'sessionManager'>,
  sessionId: string,
  usage: unknown,
): void {
  const transcriptPath = readTranscriptPath(usage);
  if (!transcriptPath) return;
  if (writtenPaths.get(sessionId) === transcriptPath) return;
  if (isShuttingDown()) return;
  const session = context.sessionManager.getSession?.(sessionId);
  if (session?.transient || session?.workflowId) return;
  const projectId = context.sessionManager.getSessionProjectId(sessionId);
  if (!projectId) return;
  try {
    const database = getOpenProjectDb(projectId);
    if (!database) return;
    if (new SessionRepository(database).setTranscriptPath(sessionId, transcriptPath)) {
      writtenPaths.set(sessionId, transcriptPath);
    }
  } catch {
    // Best-effort: without the path the resume check falls back to the
    // session folder, and without that it resumes as it always did.
  }
}

/** Forget a session that left the registry. */
export function forgetTranscriptPath(sessionId: string): void {
  writtenPaths.delete(sessionId);
}

function readTranscriptPath(usage: unknown): string | null {
  if (!usage || typeof usage !== 'object') return null;
  const transcriptPath = (usage as { transcriptPath?: unknown }).transcriptPath;
  return typeof transcriptPath === 'string' && transcriptPath.length > 0 ? transcriptPath : null;
}

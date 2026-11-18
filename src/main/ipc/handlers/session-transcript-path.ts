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
 * The status line is not the only report: `persistHookTranscriptPath` below
 * keeps the SessionStart hook's for a session that line never reached.
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
  const written = writeToRecord(context, sessionId, (repository) => repository.setTranscriptPath(sessionId, transcriptPath));
  if (written) writtenPaths.set(sessionId, transcriptPath);
}

/**
 * Keep the transcript path a session's SessionStart hook named, from the
 * session manager's `'transcript-path'` event, on a record that has none.
 *
 * The status line was the record's only source, and nothing makes it run
 * before a session ends. Records of sessions that never took a turn reached a
 * restart with no path (Sentry DESKTOP-2M and DESKTOP-2J, 3 of 6 tagged
 * events). A quit had deleted the folder that held the hook's own copy, so the
 * resume check had nothing the agent reported, and the resume printed "No
 * conversation found". Why the status line wrote nothing there is not
 * established: measured on Claude Code 2.1.327 on Windows it ran 46 ms after
 * this hook. The hook fires at session start and names the same file, so the
 * record no longer rests on one report.
 *
 * It only fills an empty path (`fillTranscriptPath`), so the status line stays
 * the authority, and it is kept out of `writtenPaths`: the first status tick
 * still writes its own report. The same guards as the status line's write
 * apply. A hook that fires before its record exists (an early agent, hidden
 * until its task's spawn adopts it) is not retried here: that record takes the
 * path when it is inserted (`TransitionEngine.commitSessionRecord`).
 */
export function persistHookTranscriptPath(
  context: Pick<IpcContext, 'sessionManager'>,
  sessionId: string,
  transcriptPath: string,
): void {
  if (!transcriptPath) return;
  writeToRecord(context, sessionId, (repository) => repository.fillTranscriptPath(sessionId, transcriptPath));
}

/** Forget a session that left the registry. */
export function forgetTranscriptPath(sessionId: string): void {
  writtenPaths.delete(sessionId);
}

/**
 * Run one write against a task session's record, behind the guards both
 * reports share. False when a guard held it back, when no row was written, or
 * when the write threw.
 */
function writeToRecord(
  context: Pick<IpcContext, 'sessionManager'>,
  sessionId: string,
  write: (repository: SessionRepository) => boolean,
): boolean {
  if (isShuttingDown()) return false;
  const session = context.sessionManager.getSession?.(sessionId);
  if (session?.transient || session?.workflowId) return false;
  const projectId = context.sessionManager.getSessionProjectId(sessionId);
  if (!projectId) return false;
  try {
    const database = getOpenProjectDb(projectId);
    if (!database) return false;
    return write(new SessionRepository(database));
  } catch {
    // Best-effort: without the path the resume check falls back to the
    // session folder, and without that it resumes as it always did.
    return false;
  }
}

function readTranscriptPath(usage: unknown): string | null {
  if (!usage || typeof usage !== 'object') return null;
  const transcriptPath = (usage as { transcriptPath?: unknown }).transcriptPath;
  return typeof transcriptPath === 'string' && transcriptPath.length > 0 ? transcriptPath : null;
}

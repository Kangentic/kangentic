import { carryRecapAcross, forgetRecapSession, recapKindOf } from '../../automations/turn-end/recap-turns';
import { restartSessionForSettingsChange } from '../handlers/session-reconcile';
import type { SpawnPhase } from '../../transition-engine/spawn-progress';
import type { IpcContext } from '../ipc-context';
import { getProjectRepos } from './project-repos';

/**
 * Restarts a task's session in place to apply a settings change, resuming idle
 * (`restartSessionForSettingsChange` with no prompt). A session still in its
 * return recap hands the recap's mark to the session that replaces it
 * (`carryRecapAcross`, task #1147). The replacement resumes idle and takes no
 * recap turn, so a column message waiting on the recap goes to it at once
 * instead of being dropped with the old session.
 *
 * A session with no mark costs nothing: the restart runs alone. Same no-throw
 * contract as `restartSessionForSettingsChange`.
 */
export async function restartIdleKeepingRecap(
  context: IpcContext,
  projectId: string,
  projectPath: string,
  taskId: string,
  fromSessionId: string | null,
  phase: SpawnPhase,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const restart = () => restartSessionForSettingsChange(context, projectId, projectPath, taskId, { phase });
  if (fromSessionId === null || recapKindOf(fromSessionId) === null) return restart();
  const taskSessionId = (): string | null => {
    try {
      return getProjectRepos(context, projectId).tasks.getById(taskId)?.session_id ?? null;
    } catch {
      // report-ok: the restart reads the same task row and returns its own failure as { ok: false }; a recap read as having no replacement is dropped, as before the carry
      return null;
    }
  };
  const result = await carryRecapAcross(fromSessionId, restart, taskSessionId);
  const replacementId = result.ok ? taskSessionId() : null;
  if (replacementId) forgetRecapSession(replacementId, true);
  return result;
}

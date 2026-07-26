import type { BoardProfile, Task } from '../../../shared/types';
import { findTaskProfile } from '../../transition-engine/column-strategy';
import type { IpcContext } from '../ipc-context';

/**
 * The Board Profile a task rides, read from the board config.
 *
 * One accessor for every spawn-affecting call site, so "how do I get the
 * profiles for this project" is answered once. Pair it with `applyProfileToLane`
 * at the top of a handler:
 *
 *   const lane = applyProfileToLane(rawLane, loadTaskProfile(context, task, projectPath)) ?? rawLane;
 *
 * TOTAL BY DESIGN - it never throws and never blocks a spawn. Profile resolution
 * sits on both spawn chokepoints, and every input can legitimately be missing:
 * the project may have no `kangentic.json`, the file may be mid-write, or a
 * teammate may have deleted the profile a task still points at. Every one of
 * those degrades to the synthetic "Default" profile (the columns' own settings),
 * which is the correct behavior rather than a failure.
 *
 * `projectPath` matters because spawns are not limited to the active project:
 * startup recovery resumes sessions across every open project, and resolving
 * against the wrong board would hand a task another project's ladder.
 */
export function loadTaskProfile(
  context: IpcContext,
  task: Pick<Task, 'id' | 'profile_id'>,
  projectPath?: string | null,
): BoardProfile | null {
  if (!task.profile_id) return null;

  let profiles: BoardProfile[] = [];
  try {
    profiles = context.boardConfigManager.getBoardProfiles(projectPath ?? undefined);
  } catch (error) {
    console.warn(`[task-profile] Could not read Board Profiles for task ${task.id.slice(0, 8)}:`, error);
    return null;
  }

  return findTaskProfile({ profiles, profileId: task.profile_id, taskId: task.id });
}

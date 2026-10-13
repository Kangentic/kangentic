import type { BackgroundCallSink } from '../../background-calls/record-background-call';
import type { IpcContext } from '../ipc-context';
import { getProjectRepos } from './project-repos';

/**
 * Writes a finished background call to its project's ledger.
 *
 * Checks that the project still exists at WRITE time: a summary batch or a
 * check the caller stopped waiting for can settle minutes after the project
 * was deleted, and opening a deleted project's database would create an empty
 * one again (the guard `retrieval-service.ts` keeps for the same reason).
 */
export function backgroundCallSink(context: IpcContext): BackgroundCallSink {
  return (projectId, input) => {
    let exists: boolean;
    try {
      exists = context.projectRepo.getById(projectId) != null;
    } catch {
      exists = false;
    }
    if (!exists) return;
    getProjectRepos(context, projectId).backgroundCalls.record(input);
  };
}

/**
 * The retrieval worker's transcript archive methods (`archive/transcript-archive.ts`):
 * one conversation archived at a turn's end, a suspend or an exit, and the
 * project-open pass that purges orphans and archives everything behind.
 *
 * Main asks for both whatever the Knowledge Graph indexing switch says: the
 * archive keeps a conversation readable after the agent CLI deletes its file,
 * which is not search. A long sweep carries a `jobId`, and `job.cancel` stops
 * it between conversations (a project switch), as the index sweep's does.
 */
import { agentRegistry } from '../../agent/agent-registry';
import { adoptRemoteTargets, type RemoteTargets } from '../remote-targets';
import { INDEX_WINDOW_BYTES } from '../conversation/conversation-indexer';
import { TranscriptArchive, type ArchiveOutcome } from '../archive/transcript-archive';
import { runJob } from './index-methods';
import type { WorkerContext } from './methods';

export interface ArchiveMethods {
  /** Archive the conversation one session ran, from where its last walk left off. */
  'archive.session': {
    params: { projectId: string; sessionId: string; remoteTargets: RemoteTargets };
    result: { outcome: ArchiveOutcome };
  };
  /** Purge archives no session names, then archive every conversation behind, oldest first. */
  'archive.sweep': {
    params: { projectId: string; jobId?: string; remoteTargets: RemoteTargets };
    result: { archived: number; purged: number };
  };
}

type ArchiveHandlers = {
  [Method in keyof ArchiveMethods]: (
    params: ArchiveMethods[Method]['params'],
    context: WorkerContext,
  ) => ArchiveMethods[Method]['result'] | Promise<ArchiveMethods[Method]['result']>;
};

/** The archive, one per worker context. */
const archives = new WeakMap<WorkerContext, TranscriptArchive>();

function archiveFor(context: WorkerContext): TranscriptArchive {
  let archive = archives.get(context);
  if (!archive) {
    archive = new TranscriptArchive({
      getDb: context.getDb,
      getAdapter: (sessionType) => agentRegistry.getBySessionType(sessionType),
      windowBytes: INDEX_WINDOW_BYTES,
    });
    archives.set(context, archive);
  }
  return archive;
}

export const archiveHandlers: ArchiveHandlers = {
  'archive.session': async ({ projectId, sessionId, remoteTargets }, context) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    return { outcome: await archiveFor(context).archiveSession(projectId, sessionId) };
  },

  'archive.sweep': ({ projectId, jobId, remoteTargets }, context) => runJob(jobId, (shouldContinue) => {
    adoptRemoteTargets(agentRegistry, remoteTargets);
    return archiveFor(context).sweep(projectId, shouldContinue);
  }),
};

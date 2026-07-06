import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import { resolveSessionTranscript } from '../../agent/transcript-service';
import type {
  ConversationSessionMeta,
  TranscriptGetRequest,
  TranscriptGetResponse,
} from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * IPC handlers for the human-facing conversation viewer. Read-only, so they
 * accept an explicit interaction-time projectId (a conversation hit can target
 * another project) but fall back to the ambient current project.
 *
 * The heavy lifting - session resolution, live-parse-vs-index fallback, and
 * per-span truncation - lives in the shared `resolveSessionTranscript` service,
 * which the MCP get_transcript handler will also use.
 */
export function registerTranscriptHandlers(context: IpcContext): void {
  ipcMain.handle(
    IPC.TRANSCRIPT_GET,
    async (_event, request: TranscriptGetRequest): Promise<TranscriptGetResponse> => {
      const projectId = request.projectId ?? context.currentProjectId;
      const emptyResponse: TranscriptGetResponse = {
        sessionId: request.sessionId,
        taskId: null,
        taskTitle: '(unknown task)',
        agentName: '',
        startedAt: '',
        sessionStatus: null,
        source: 'none',
        sourcePath: null,
        entries: [],
        degraded: false,
        unavailableReason: 'file_missing',
      };
      if (!projectId) return emptyResponse;

      const db = getProjectDb(projectId);
      const resolved = await resolveSessionTranscript(db, request.sessionId);
      if (!resolved) return emptyResponse;

      return {
        sessionId: resolved.record.id,
        taskId: resolved.record.task_id ?? null,
        taskTitle: resolved.taskTitle,
        agentName: resolved.agentName,
        startedAt: resolved.record.started_at,
        sessionStatus: resolved.record.status,
        source: resolved.source,
        sourcePath: resolved.sourcePath,
        entries: resolved.entries,
        degraded: resolved.degraded,
        unavailableReason: resolved.unavailableReason,
      };
    },
  );

  ipcMain.handle(
    IPC.TRANSCRIPT_LIST_SESSIONS,
    async (
      _event,
      taskId: string,
      projectId?: string | null,
    ): Promise<ConversationSessionMeta[]> => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) return [];
      const db = getProjectDb(resolvedProjectId);
      const sessions = new SessionRepository(db).listForTaskNewestFirst(taskId);
      return sessions.map((record) => ({
        sessionId: record.id,
        agentName: agentRegistry.getBySessionType(record.session_type)?.displayName ?? record.session_type,
        startedAt: record.started_at,
        exitedAt: record.exited_at,
        isolatedSwimlaneId: record.isolated_swimlane_id,
        status: record.status,
      }));
    },
  );
}

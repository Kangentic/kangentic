import { ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { agentRegistry } from '../../agent/agent-registry';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import type { ConversationSessionMeta, TranscriptGetRequest } from '../../../shared/types';
import type { IpcContext } from '../ipc-context';

/**
 * IPC handlers for the human-facing conversation viewer. Read-only, so they
 * accept an explicit interaction-time projectId (a conversation hit can target
 * another project) but fall back to the ambient current project.
 *
 * TRANSCRIPT_GET always returns a task's ENTIRE lifecycle - every session it
 * has ever accumulated, stitched into one timeline - not just the one session
 * id passed in (that id only resolves which task to show). The retrieval
 * worker parses and stitches it (`transcript.task`) and answers with JSON:
 * the whole response, an unchanged marker, or only the entries that changed
 * since the caller's revision. Main hands that string to the renderer as is,
 * so a long conversation costs main neither a parse nor a structured clone;
 * the preload parses it. The MCP get_transcript tool deliberately stays
 * per-session (an agent inspecting one specific run).
 */
export function registerTranscriptHandlers(context: IpcContext): void {
  ipcMain.handle(
    IPC.TRANSCRIPT_GET,
    async (_event, request: TranscriptGetRequest): Promise<string> => {
      const projectId = request.projectId ?? context.currentProjectId;
      if (!projectId) {
        return JSON.stringify({
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
          sessions: [],
          revision: 0,
        });
      }
      return retrievalClient.call('transcript.task', {
        projectId,
        sessionId: request.sessionId,
        knownRevision: request.knownRevision,
        remoteTargets: collectRemoteTargets(agentRegistry),
      });
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

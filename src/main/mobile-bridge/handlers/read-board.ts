import {
  parseCapabilityRequestPayload,
  type BoardTaskWire,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type ReadBoardArchivedResponsePayload,
  type ReadBoardResponsePayload,
  type SessionSummaryWire,
} from '@kangentic/protocol';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import type { IpcContext } from '../../ipc/ipc-context';
import type { Task } from '../../../shared/types';
import { isResumeOffered, pausedTaskIdsOf } from '../../../shared/session-resume-eligibility';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import type { BoardChangedEvent } from '../board-event-bus';
import type { SpawnProgressFeed } from '../spawn-progress-feed';
import { getInFlightSpawnProgress } from '../../transition-engine/spawn-progress';
import { sendEvent } from './send-event';
import { deriveProjectAccentColor } from './project-color';
import { toBacklogItemWire, toBoardColumnWire, toBoardTaskWire, toSessionSummaryWire, toWireJson } from './wire-mappers';

function subscriptionKeyFor(projectId: string): string {
  return `board:${projectId}`;
}

/** Page size when the phone names none. The repository clamps to 100 regardless. */
const ARCHIVED_PAGE_DEFAULT_LIMIT = 25;

/** Non-archived tasks per column. TaskRepository.list() already excludes archived, so every task here counts. */
function countTasksByColumnId(tasks: BoardTaskWire[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) counts[task.swimlane_id] = (counts[task.swimlane_id] ?? 0) + 1;
  return counts;
}

export async function handleReadBoard(
  request: CapabilityRequestMessage,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
  spawnProgressFeed: Pick<SpawnProgressFeed, 'onTaskSpawnProgressChanged'>,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-board', request.payload);

  if (!payload.projectId) {
    const projects = context.projectRepo.list().map((project) => ({
      id: project.id,
      name: project.name,
      color: deriveProjectAccentColor(project.id),
      // Structure the desktop sidebar already shows, so the phone's picker can
      // render the same grouping instead of one flat list (protocol 0.11.0).
      groupId: project.group_id,
      position: project.position,
    }));
    const groups = context.projectGroupRepo
      .list()
      .map((group) => ({ id: group.id, name: group.name, position: group.position }));
    const responsePayload: ReadBoardResponsePayload = { projects, groups };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
  }

  const projectId = payload.projectId;
  const subscriptionKey = subscriptionKeyFor(projectId);

  if (payload.action === 'unsubscribe') {
    subscriptions.remove(subscriptionKey);
    return { type: 'capability-response', requestId: request.requestId, ok: true };
  }

  const project = context.projectRepo.getById(projectId);
  if (!project) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${projectId}` };
  }

  const repos = getProjectRepos(context, projectId);
  // Read once per response: each call also sweeps TTL-expired labels.
  const spawnProgressByTaskId = getInFlightSpawnProgress();
  // `paused` needs each task's paused session, and `resumable` needs that and
  // the task's column. The registry is read once per response, not per task.
  // A pause, a resume, a move and an archive each already fire a board event,
  // so a phone re-reads both. `resumable` is derived from the same `paused`
  // answer, so it can never be true while `paused` is false.
  const swimlaneRows = repos.swimlanes.list();
  const laneRoleById = new Map(swimlaneRows.map((swimlane) => [swimlane.id, swimlane.role]));
  const pausedTaskIds = pausedTaskIdsOf(context.sessionManager.listSessions());
  const toTaskWire = (task: Task): BoardTaskWire => {
    const paused = pausedTaskIds.has(task.id);
    return toBoardTaskWire(task, spawnProgressByTaskId[task.id] ?? null, {
      paused,
      resumable: isResumeOffered({ hasPausedSession: paused, task, laneRole: laneRoleById.get(task.swimlane_id) }),
    });
  };

  // One-shot page of completed work. Deliberately NOT part of the snapshot
  // and NOT subscribed: a board subscription re-snapshots on every board
  // change, and archived tasks only grow, so folding them in would repeat an
  // ever-larger payload for the life of the connection.
  if (payload.action === 'archived') {
    const page = repos.tasks.listArchivedPage(payload.limit ?? ARCHIVED_PAGE_DEFAULT_LIMIT, payload.offset ?? 0);
    const sessionRepo = new SessionRepository(getProjectDb(projectId));
    const summariesByTaskId: Record<string, SessionSummaryWire> = {};
    for (const task of page.tasks) {
      const summary = sessionRepo.getSummaryForTask(task.id);
      // Sparse by design: a task archived without ever running an agent has
      // nothing to summarize, which is a normal state rather than an error.
      if (summary) summariesByTaskId[task.id] = toSessionSummaryWire(summary);
    }
    const archivedPayload: ReadBoardArchivedResponsePayload = {
      projectId,
      // A restore from Done labels the task ("Resuming session...") while
      // its row is still archived.
      archivedTasks: page.tasks.map(toTaskWire),
      archivedTotalCount: page.totalCount,
      summariesByTaskId,
    };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(archivedPayload) };
  }
  const allTasks = repos.tasks.list().map(toTaskWire);

  // A phone that names a `view` (protocol 0.9.0) gets only what it renders:
  // no backlog in either projection, and under 'sessions' only the tasks an
  // agent feed draws. A phone that names none gets the pre-0.9.0 payload
  // verbatim, backlog included.
  //
  // 'sessions' keeps a task with a spawn label in flight even while its
  // session_id is null: a first start has no session yet, and a respawn nulls
  // session_id (task-move.ts suspendLiveSessionForRespawn) for the whole gap
  // the label describes, so the card would otherwise vanish exactly while it
  // has something to say. It keeps a resumable paused task for the same
  // reason: a desktop pause nulls session_id too (applySuspendDbWrites), and
  // without it the feed could show Paused only until the row dropped out. A
  // paused task that offers no Resume (Done, say) stays out on purpose: its
  // row reads `paused: true`, but the feed has nothing to act on for it.
  const drawnOnAgentFeed = (task: BoardTaskWire): boolean =>
    task.session_id !== null || typeof task.spawn_progress === 'string' || task.resumable === true;
  const view = payload.view;
  const sessionTasksOnly = view === 'sessions';
  const backlog = view === undefined ? new BacklogRepository(getProjectDb(projectId)).list().map(toBacklogItemWire) : undefined;

  const responsePayload: ReadBoardResponsePayload = {
    projectId,
    columns: swimlaneRows.map(toBoardColumnWire),
    tasks: sessionTasksOnly ? allTasks.filter(drawnOnAgentFeed) : allTasks,
    ...(backlog !== undefined ? { backlog } : {}),
    projectColor: deriveProjectAccentColor(projectId),
    // The Layout "Ticket Numbers" setting travels with the snapshot so the
    // phone's cards match the desktop's (protocol 0.6.0 additive field).
    showTicketNumbers: context.configManager.getEffectiveConfig(project.path || undefined).showTaskNumbers ?? true,
    ...(view !== undefined ? { view } : {}),
    // Only the filtered projection needs these: a phone appending a card to a
    // column has to know the column's real length, which it cannot get from a
    // task list that dropped everything without a session on it.
    ...(sessionTasksOnly ? { taskCountsByColumnId: countTasksByColumnId(allTasks) } : {}),
  };

  const listener = (event: BoardChangedEvent): void => {
    if (event.projectId !== projectId) return;
    sendEvent(session, {
      kind: 'board',
      projectId,
      taskId: event.ids[0],
      payload: { change: event.change, ids: event.ids },
    });
  };
  const unsubscribeBoard = context.boardEvents.onBoardChanged(listener);
  // A spawn-progress label change reaches the phone as the same task-updated a
  // row change does, so it re-reads `spawn_progress` from the next snapshot.
  // The feed is throttled per task and kept off the board bus; see
  // spawn-progress-feed.ts for both reasons.
  const unsubscribeSpawnProgress = spawnProgressFeed.onTaskSpawnProgressChanged((changedProjectId, taskId) => {
    if (changedProjectId !== projectId) return;
    sendEvent(session, {
      kind: 'board',
      projectId,
      taskId,
      payload: { change: 'task-updated', ids: [taskId] },
    });
  });
  subscriptions.set(subscriptionKey, () => {
    unsubscribeBoard();
    unsubscribeSpawnProgress();
  });

  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}

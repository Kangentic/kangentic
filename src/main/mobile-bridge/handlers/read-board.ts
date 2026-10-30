import {
  parseCapabilityRequestPayload,
  type BoardTaskWire,
  type BoardTaskWorkflowWire,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type CommandTerminalWire,
  type ReadBoardArchivedResponsePayload,
  type ReadBoardResponsePayload,
  type ReadBoardSnapshotResponsePayload,
  type SessionSummaryWire,
} from '@kangentic/protocol';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import type { IpcContext } from '../../ipc/ipc-context';
import type { Task } from '../../../shared/types';
import { isPauseOffered, isResumeOffered, taskSessionStatesOf } from '../../../shared/session-resume-eligibility';
import { commandTerminalDisplayName, commandTerminalSlotNumber } from '../../../shared/command-terminal-name';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import type { BoardChangedEvent } from '../board-event-bus';
import type { SpawnProgressFeed } from '../spawn-progress-feed';
import { getInFlightSpawnProgress } from '../../transition-engine/spawn-progress';
import { sendEvent } from './send-event';
import { deriveProjectAccentColor } from './project-color';
import { resolveKnownProject } from './known-project';
import { toActivityReasonWire, toBacklogItemWire, toBoardColumnWire, toBoardTaskWire, toSessionSummaryWire, toWireJson } from './wire-mappers';
import { workflowWireFacts } from './workflow-wire';

function subscriptionKeyFor(projectId: string): string {
  return `board:${projectId}`;
}

/** Page size when the phone names none. The repository clamps to 100 regardless. */
const ARCHIVED_PAGE_DEFAULT_LIMIT = 25;

/**
 * The project's live Command Terminals, by slot. A terminal's row leaves the
 * registry when it ends (SessionManager.endCommandTerminal and the PTY-exit
 * end), so a running transient row is exactly a live terminal. A `queued` one
 * (the desktop's concurrency limit was full when it started) is listed too:
 * it already holds its slot against the cap, and `read-stream` reports its
 * status and its promotion. Activity is the snapshot's seed for a first
 * paint; the phone's per-session `read-stream` carries it live from there.
 */
function listCommandTerminalWires(context: IpcContext, projectId: string): CommandTerminalWire[] {
  const activityCache = context.sessionManager.getActivityCache();
  const terminals: CommandTerminalWire[] = [];
  for (const terminalSession of context.sessionManager.listSessions()) {
    if (!isCommandTerminalSession(terminalSession) || terminalSession.projectId !== projectId) continue;
    if (terminalSession.status !== 'running' && terminalSession.status !== 'queued') continue;
    const slotNumber = commandTerminalSlotNumber(terminalSession.commandTerminalSlot);
    if (slotNumber === null) continue;
    const reason = context.sessionManager.getActivityReason(terminalSession.id);
    terminals.push({
      sessionId: terminalSession.id,
      projectId,
      slot: slotNumber,
      name: commandTerminalDisplayName(terminalSession.commandTerminalLabel, terminalSession.commandTerminalSlot),
      named: Boolean(terminalSession.commandTerminalLabel),
      activity: {
        state: activityCache[terminalSession.id] ?? null,
        reason: reason ? toActivityReasonWire(reason) : null,
      },
    });
  }
  return terminals.sort((left, right) => left.slot - right.slot);
}

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

  const project = resolveKnownProject(context, projectId);
  if (!project) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${projectId}` };
  }

  const repos = getProjectRepos(context, projectId);
  // Read once per response: each call also sweeps TTL-expired labels.
  const spawnProgressByTaskId = getInFlightSpawnProgress();
  // `paused` needs each task's paused session, `resumable` needs that and the
  // task's column, and `pausable` needs its live session and column. The
  // registry is read once per response, not per task. A pause, a resume, a
  // move, an archive and a session's start and end each already fire a board
  // event, so a phone re-reads all three. `resumable` is derived from the same
  // `paused` answer, so it can never be true while `paused` is false, and one
  // scan yields both the paused and the live set, so `pausable` and `paused`
  // are never both true. `paused` itself is derived from `paused_session_id`,
  // the paused row's registry id, which is the id `send-user-message` holds a
  // message for. A restart re-registers that row under a new id, and its
  // `session-changed` reaches the phone as a board event like any other edge.
  const swimlaneRows = repos.swimlanes.list();
  const laneRoleById = new Map(swimlaneRows.map((swimlane) => [swimlane.id, swimlane.role]));
  const { liveTaskIds, pausedSessionIdByTaskId } = taskSessionStatesOf(context.sessionManager.listSessions());
  const toTaskWire = (task: Task, workflow: BoardTaskWorkflowWire | null): BoardTaskWire => {
    const pausedSessionId = pausedSessionIdByTaskId.get(task.id) ?? null;
    const laneRole = laneRoleById.get(task.swimlane_id);
    return toBoardTaskWire(task, spawnProgressByTaskId[task.id] ?? null, {
      pausedSessionId,
      resumable: isResumeOffered({ hasPausedSession: pausedSessionId !== null, task, laneRole }),
      pausable: isPauseOffered({ hasLiveSession: liveTaskIds.has(task.id), laneRole }),
    }, workflow);
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
    const archivedWorkflows = workflowWireFacts(context, projectId, page.tasks);
    const archivedPayload: ReadBoardArchivedResponsePayload = {
      projectId,
      // A restore from Done labels the task ("Resuming session...") while
      // its row is still archived.
      archivedTasks: page.tasks.map((task) => toTaskWire(task, archivedWorkflows.get(task.id) ?? null)),
      archivedTotalCount: page.totalCount,
      summariesByTaskId,
    };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(archivedPayload) };
  }
  const boardTasks = repos.tasks.list();
  const workflows = workflowWireFacts(context, projectId, boardTasks);
  const allTasks = boardTasks.map((task) => toTaskWire(task, workflows.get(task.id) ?? null));

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
  // paused task that offers no Resume (Done, say) stays out on purpose, though
  // its row reads `paused: true` (see `BoardTaskWire.paused`).
  const drawnOnAgentFeed = (task: BoardTaskWire): boolean =>
    task.session_id !== null || typeof task.spawn_progress === 'string' || task.resumable === true;
  const view = payload.view;
  const sessionTasksOnly = view === 'sessions';
  const backlog = view === undefined ? new BacklogRepository(getProjectDb(projectId)).list().map(toBacklogItemWire) : undefined;

  const responsePayload: ReadBoardSnapshotResponsePayload = {
    projectId,
    columns: swimlaneRows.map(toBoardColumnWire),
    tasks: sessionTasksOnly ? allTasks.filter(drawnOnAgentFeed) : allTasks,
    ...(backlog !== undefined ? { backlog } : {}),
    projectColor: deriveProjectAccentColor(projectId),
    // The Layout "Ticket Numbers" setting travels with the snapshot so the
    // phone's cards match the desktop's (protocol 0.6.0 additive field).
    showTicketNumbers: context.configManager.getEffectiveConfig(project.projectPath || undefined).showTaskNumbers ?? true,
    ...(view !== undefined ? { view } : {}),
    // Only the filtered projection needs these: a phone appending a card to a
    // column has to know the column's real length, which it cannot get from a
    // task list that dropped everything without a session on it.
    ...(sessionTasksOnly ? { taskCountsByColumnId: countTasksByColumnId(allTasks) } : {}),
    // Both projections: the Board header's Terminals button reads the full
    // one, and the Agents feed lists every project's terminals from its
    // sessions one. A command-terminals-changed board event says to re-read.
    commandTerminals: listCommandTerminalWires(context, projectId),
    // The phone keeps no grant list, so it learns here whether to offer the
    // Terminals button at all: this desktop serves the verb (it is reading
    // this field) and the device holds it.
    commandTerminalsOffered: session.capabilities.has('command-terminal'),
    // The same grant serves the verb's list-earlier and resume actions; this
    // flag is how a phone learns the desktop knows them at all.
    earlierConversationsOffered: session.capabilities.has('command-terminal'),
  };

  const listener = (event: BoardChangedEvent): void => {
    if (event.projectId !== projectId) return;
    sendEvent(session, {
      kind: 'board',
      projectId,
      // A Command Terminal change names a session, and the envelope's taskId
      // is for a task; it rides only in `ids`.
      ...(event.change === 'command-terminals-changed' ? {} : { taskId: event.ids[0] }),
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

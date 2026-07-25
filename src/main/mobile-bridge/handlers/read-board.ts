import {
  parseCapabilityRequestPayload,
  type BoardTaskWire,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type ReadBoardResponsePayload,
} from '@kangentic/protocol';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { getProjectDb } from '../../db/database';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import type { IpcContext } from '../../ipc/ipc-context';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import type { BoardChangedEvent } from '../board-event-bus';
import { sendEvent } from './send-event';
import { deriveProjectAccentColor } from './project-color';
import { toBacklogItemWire, toBoardColumnWire, toBoardTaskWire, toWireJson } from './wire-mappers';

function subscriptionKeyFor(projectId: string): string {
  return `board:${projectId}`;
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
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-board', request.payload);

  if (!payload.projectId) {
    const projects = context.projectRepo
      .list()
      .map((project) => ({ id: project.id, name: project.name, color: deriveProjectAccentColor(project.id) }));
    const responsePayload: ReadBoardResponsePayload = { projects };
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
  const allTasks = repos.tasks.list().map(toBoardTaskWire);

  // A phone that names a `view` (protocol 0.9.0) gets only what it renders:
  // no backlog in either projection, and under 'sessions' only the tasks an
  // agent feed draws. A phone that names none gets the pre-0.9.0 payload
  // verbatim, backlog included.
  const view = payload.view;
  const sessionTasksOnly = view === 'sessions';
  const backlog = view === undefined ? new BacklogRepository(getProjectDb(projectId)).list().map(toBacklogItemWire) : undefined;

  const responsePayload: ReadBoardResponsePayload = {
    projectId,
    columns: repos.swimlanes.list().map(toBoardColumnWire),
    tasks: sessionTasksOnly ? allTasks.filter((task) => task.session_id !== null) : allTasks,
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
  const unsubscribe = context.boardEvents.onBoardChanged(listener);
  subscriptions.set(subscriptionKey, unsubscribe);

  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}

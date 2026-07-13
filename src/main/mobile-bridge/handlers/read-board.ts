import {
  parseCapabilityRequestPayload,
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
import { toBacklogItemWire, toBoardColumnWire, toBoardTaskWire, toWireJson } from './wire-mappers';

function subscriptionKeyFor(projectId: string): string {
  return `board:${projectId}`;
}

export async function handleReadBoard(
  request: CapabilityRequestMessage,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-board', request.payload);

  if (!payload.projectId) {
    const projects = context.projectRepo.list().map((project) => ({ id: project.id, name: project.name }));
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
  const backlogRepo = new BacklogRepository(getProjectDb(projectId));

  const responsePayload: ReadBoardResponsePayload = {
    projectId,
    columns: repos.swimlanes.list().map(toBoardColumnWire),
    tasks: repos.tasks.list().map(toBoardTaskWire),
    backlog: backlogRepo.list().map(toBacklogItemWire),
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

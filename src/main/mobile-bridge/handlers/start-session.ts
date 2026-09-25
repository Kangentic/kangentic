import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type StartSessionResponsePayload } from '@kangentic/protocol';
import { startTaskSession } from '../../ipc/handlers/session-start';
import { resolveProjectContext } from '../../ipc/helpers/project-repos';
import type { IpcContext } from '../../ipc/ipc-context';

export async function handleStartSession(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('start-session', request.payload);
  const { projectId } = resolveProjectContext(context, payload.projectId);
  if (!projectId) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${payload.projectId}` };
  }

  // startTaskSession owns the task lock, the stale-pointer reconcile, and the
  // To Do / Done / archived gate, and routes the spawn through the same
  // chokepoint a column move uses (see session-start.ts). A refusal throws the
  // desktop's own Resume copy, and the router turns that throw into the
  // ok:false the phone shows.
  //
  // The verb answers when the start is ACCEPTED, not when the agent is up.
  // Everything slow (worktree ensure with its git fetch, branch checkout, the
  // PTY spawn, the column's enter automations) runs behind the response, for
  // the same reason move-task answers on its commit signal: the phone gives
  // every verb 10s. The successor's arrival reaches the phone as the board /
  // stream event the swap veil already settles a column move against.
  //
  // The outcome travels in the response because the two accepted shapes ask
  // different things of the phone: `starting` means wait for that event,
  // `live` means no event is coming (nothing was spawned), so a phone that
  // tapped Start from a stale screen must refresh its board and stream now.
  const result = await startTaskSession(context, projectId, payload.taskId);

  if (result.outcome === 'starting') {
    // autoSpawnForTask reports its own failures (log, Sentry counter, desktop
    // spawn-blocked notice), so this handler only keeps an unexpected
    // rejection out of the bridge's request loop. Attached in the SAME
    // synchronous turn as the call, so a rejection that lands before the next
    // tick is already handled.
    result.settled.catch((error: unknown) => {
      console.error(`[mobile-bridge] start-session ${payload.taskId.slice(0, 8)} failed after accept:`, error);
    });
  }

  const responsePayload: StartSessionResponsePayload = { ok: true, outcome: result.outcome };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}

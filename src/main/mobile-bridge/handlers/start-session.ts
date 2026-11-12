import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type StartSessionResponsePayload } from '@kangentic/protocol';
import { openTaskSession, startTaskSession } from '../../ipc/handlers/session-start';
import { resolveKnownProject } from './known-project';
import { toWireJson } from './wire-mappers';
import type { IpcContext } from '../../ipc/ipc-context';

export async function handleStartSession(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('start-session', request.payload);
  const project = resolveKnownProject(context, payload.projectId);
  if (!project) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${payload.projectId}` };
  }
  const { projectId } = project;

  // An open (protocol 0.28.0) does what opening the task on the desktop does:
  // it resumes a task the idle timeout paused, and only when that sends the
  // agent nothing. Every other task is left alone and answered `not-eligible`,
  // never an error: opening is not a request the person can fail. It answers on
  // the decision, before the git phase, for the same budget a start answers in.
  if (payload.trigger === 'open') {
    const opened = await openTaskSession(context, projectId, payload.taskId);
    if (opened.outcome === 'starting') {
      opened.settled.catch((error: unknown) => {
        console.error(`[mobile-bridge] start-session open ${payload.taskId.slice(0, 8)} failed after accept:`, error);
      });
    }
    const openPayload: StartSessionResponsePayload = { ok: true, outcome: opened.outcome };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(openPayload) };
  }

  // startTaskSession owns the task lock, the stale-pointer reconcile, and the
  // To Do / Done / archived gate. A paused task takes the desktop Resume
  // button's own path (no enter automations, no column message); a task with
  // no session or an exited one takes the chokepoint a column move uses (see
  // session-start.ts for both). A refusal throws the desktop's own Resume
  // copy, and the router turns that throw into the ok:false the phone shows.
  //
  // The verb answers when the start is ACCEPTED, not when the agent is up.
  // Everything slow (worktree ensure with its git fetch, branch checkout, the
  // PTY spawn or resume, a start's enter automations) runs behind the
  // response, for the same reason move-task answers on its commit signal: the
  // phone gives every verb 10s. The successor's arrival reaches the phone as
  // the board / stream event the swap veil already settles a column move
  // against; for a resume, also as the paused feed's session-ended naming it.
  //
  // The outcome travels in the response because the two accepted shapes ask
  // different things of the phone: `starting` means wait for that event,
  // `live` means no event is coming (nothing was spawned), so a phone that
  // tapped Start from a stale screen must refresh its board and stream now.
  const result = await startTaskSession(context, projectId, payload.taskId);

  if (result.outcome === 'starting') {
    // autoSpawnForTask reports its own failures (log, Sentry counter, desktop
    // spawn-blocked notice). A resume shows the same desktop notice, then
    // rejects with its failure (a worktree that would not set up) as the
    // desktop Resume's IPC call does. Either way this handler keeps the
    // rejection out of the bridge's request loop and logs it. Attached in the
    // SAME synchronous turn as the call, so a rejection that lands before the
    // next tick is already handled.
    result.settled.catch((error: unknown) => {
      console.error(`[mobile-bridge] start-session ${payload.taskId.slice(0, 8)} failed after accept:`, error);
    });
  }

  const responsePayload: StartSessionResponsePayload = { ok: true, outcome: result.outcome };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}

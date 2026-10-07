import { parseCapabilityRequestPayload, type CapabilityRequestMessage, type CapabilityResponseMessage, type JsonValue, type PauseSessionResponsePayload } from '@kangentic/protocol';
import { pauseTaskSession } from '../../ipc/handlers/session-pause';
import { resolveKnownProject } from './known-project';
import type { IpcContext } from '../../ipc/ipc-context';

/** The refusal a phone shows when the task it tapped Pause on has no live session. */
export const PAUSE_SESSION_NOT_LIVE_MESSAGE = 'This task has no running session to pause.';

export async function handlePauseSession(
  request: CapabilityRequestMessage,
  context: IpcContext,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('pause-session', request.payload);
  const project = resolveKnownProject(context, payload.projectId);
  if (!project) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such project: ${payload.projectId}` };
  }
  const { projectId } = project;

  // pauseTaskSession is the desktop Pause button's own path (session-pause.ts):
  // the resume cancel, the task lock, the reconcile, the DB writes recorded as
  // the user's pause, and the PTY suspend. Nothing here adds to it, so a phone
  // Pause and a desktop one cannot drift. That includes the absence of a
  // column or archive gate, which `BoardTaskWire.pausable` mirrors.
  //
  // The verb answers when the pause is ACCEPTED, not when the agent is down.
  // The DB already records the session as paused when onAccepted fires; the
  // PTY shutdown after it takes about 3s and can pass 10s (a 2s scrollback
  // scan, a 10s spawn settle), and the phone gives every verb 10s. The
  // suspend's own session-changed reaches the phone as a task-updated board
  // event, the same one a desktop Pause sends, and the snapshot the phone
  // re-reads on it carries `paused: true`.
  let accepted = false;
  const { promise: acceptedSignal, resolve: signalAccepted } = Promise.withResolvers<'accepted'>();
  const settled = pauseTaskSession(context, payload.taskId, {
    projectId,
    onAccepted: () => {
      accepted = true;
      signalAccepted('accepted');
    },
  });

  // The PTY shutdown runs behind the response. Its failure is logged and kept
  // out of the bridge's request loop, which would otherwise see an unhandled
  // rejection. Attached in the SAME synchronous turn as the call above, so a
  // rejection that lands before the next tick is already handled. A failure
  // before acceptance (the task is missing) is not logged here: the race below
  // surfaces it as the verb's own failure, and the router turns the throw into
  // the ok:false the phone shows.
  settled.catch((error: unknown) => {
    if (!accepted) return;
    console.error(`[mobile-bridge] pause-session ${payload.taskId.slice(0, 8)} failed after accept:`, error);
  });

  const first = await Promise.race([acceptedSignal, settled]);
  if (first === 'not-live') throw new Error(PAUSE_SESSION_NOT_LIVE_MESSAGE);

  const responsePayload: PauseSessionResponsePayload = { ok: true };
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: responsePayload as unknown as JsonValue };
}

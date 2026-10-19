import { UNKNOWN_SESSION_ERROR_CODE, type CapabilityRequestMessage, type CapabilityResponseMessage } from '@kangentic/protocol';
import type { Session } from '../../../shared/types';
import { isLiveSessionStatus } from '../../../shared/session-liveness';

/**
 * Refusals for a request whose session is gone. The phone reads `code`, never
 * `error`, and its error reporter drops `error` by design, so a refusal
 * without the code cannot say which one fired (Sentry MOBILE-C). `error` keeps
 * its text for phones that predate the code.
 */

/** The session id names no registry row. */
export function unknownSessionRefusal(request: CapabilityRequestMessage, sessionId: string): CapabilityResponseMessage {
  return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${sessionId}`, code: UNKNOWN_SESSION_ERROR_CODE };
}

/**
 * The row exists but has no PTY to write to. A `suspended` or `exited` row is a
 * session that ended, so it carries the unknown-session code. A `queued` row is
 * still coming, and a `running` row whose PTY a kill just nulled has not ended
 * as far as its row says, so neither tells the phone the session is gone.
 */
export function notAcceptingInputRefusal(request: CapabilityRequestMessage, session: Pick<Session, 'id' | 'status'>): CapabilityResponseMessage {
  const refusal: CapabilityResponseMessage = { type: 'capability-response', requestId: request.requestId, ok: false, error: `Session is not accepting input (not running): ${session.id}` };
  if (!isLiveSessionStatus(session.status)) {
    refusal.code = UNKNOWN_SESSION_ERROR_CODE;
  }
  return refusal;
}

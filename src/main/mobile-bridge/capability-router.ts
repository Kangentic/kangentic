import type { CapabilityRequestMessage, CapabilityResponseMessage, CapabilityVerb } from '@kangentic/protocol';
import type { BridgeSession } from './session/bridge-session';

export type CapabilityHandler = (
  request: CapabilityRequestMessage,
  session: BridgeSession,
) => Promise<CapabilityResponseMessage> | CapabilityResponseMessage;

/**
 * Deny-by-default dispatch of inbound capability-request messages,
 * checked against the SESSION's own capability set (bound at pairing time
 * and adjustable per-device afterward via the roster), never a global
 * allowlist. A verb absent from the session's set is refused before a
 * handler is even looked up.
 *
 * Phase 1 ships this router and the authorization check only. No verb
 * handler is registered here - the handlers that actually touch
 * SessionManager, repositories, DiffService, or the activity engine are
 * Phase 2 (data feeds & interactive control, per the research doc's
 * phasing). An unregistered (but authorized) verb fails closed with a
 * clear "no handler" error rather than doing nothing silently.
 */
export class CapabilityRouter {
  private readonly handlers = new Map<CapabilityVerb, CapabilityHandler>();

  register(verb: CapabilityVerb, handler: CapabilityHandler): void {
    this.handlers.set(verb, handler);
  }

  unregister(verb: CapabilityVerb): void {
    this.handlers.delete(verb);
  }

  async dispatch(request: CapabilityRequestMessage, session: BridgeSession): Promise<CapabilityResponseMessage> {
    if (!session.capabilities.has(request.verb)) {
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `Device is not authorized for verb: ${request.verb}` };
    }

    const handler = this.handlers.get(request.verb);
    if (!handler) {
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No handler registered for verb: ${request.verb}` };
    }

    try {
      return await handler(request, session);
    } catch (error) {
      return {
        type: 'capability-response',
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

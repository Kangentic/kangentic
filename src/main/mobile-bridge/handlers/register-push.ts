/**
 * register-push: a paired device hands the desktop its Expo push token
 * plus a device-generated 32-byte push-envelope key, or withdraws them.
 * The registration is keyed by the REQUESTING session's roster device id
 * (the authenticated Noise KK identity), never by anything in the
 * payload, so one device can never register or unregister on behalf of
 * another.
 */
import {
  parseCapabilityRequestPayload,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type RegisterPushResponsePayload,
} from '@kangentic/protocol';
import type { BridgeSession } from '../session/bridge-session';
import type { PushRegistrationStore } from '../push/push-registration-store';
import { toWireJson } from './wire-mappers';

const PUSH_KEY_LENGTH = 32;

function respond(requestId: string, registered: boolean): CapabilityResponseMessage {
  const responsePayload: RegisterPushResponsePayload = { registered };
  return { type: 'capability-response', requestId, ok: true, payload: toWireJson(responsePayload) };
}

export function handleRegisterPush(
  request: CapabilityRequestMessage,
  session: Pick<BridgeSession, 'deviceId'>,
  registrations: PushRegistrationStore,
): CapabilityResponseMessage {
  const payload = parseCapabilityRequestPayload('register-push', request.payload);

  if (payload.action === 'unregister') {
    registrations.remove(session.deviceId);
    return respond(request.requestId, false);
  }

  // The protocol parser already requires both fields and the 32-byte
  // decode for 'register'; these guards keep the invariant local so a
  // parser regression cannot store a malformed key.
  if (payload.expoPushToken === undefined || payload.pushKeyBase64 === undefined) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'register requires "expoPushToken" and "pushKeyBase64"' };
  }
  const pushKey = Buffer.from(payload.pushKeyBase64, 'base64url');
  if (pushKey.length !== PUSH_KEY_LENGTH) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `"pushKeyBase64" must decode to ${PUSH_KEY_LENGTH} bytes` };
  }

  registrations.upsert(session.deviceId, {
    expoPushToken: payload.expoPushToken,
    pushKeyHex: pushKey.toString('hex'),
    platform: payload.platform ?? 'android',
    registeredAt: new Date().toISOString(),
    categories: payload.categories,
  });
  return respond(request.requestId, true);
}

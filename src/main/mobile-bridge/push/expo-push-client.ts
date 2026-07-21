/**
 * Minimal Expo push sender - a single JSON POST to the Expo push API, no
 * SDK dependency. The fetch implementation is injected so tests never
 * touch the network. The ONLY real content in the message rides
 * data.blob (the sealed push envelope); title/body are static
 * placeholders, per the E2E notification-privacy design.
 *
 * The one Expo ticket error the caller must act on is
 * DeviceNotRegistered ("stop sending to this token"), surfaced as a
 * typed result so the notifier can drop the registration; everything
 * else is best-effort and reported as a plain failure.
 */

import type { WakeChannel, WakeMessage, WakeResult } from './wake-channel';

export const EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

/** One retry after this long when the POST itself fails (network error), per Expo's guidance to retry transient failures. */
const NETWORK_RETRY_DELAY_MS = 5000;

export interface ExpoPushMessage {
  /** The device's Expo push token (ExponentPushToken[...]). */
  to: string;
  /** Android notification channel id; ignored by iOS. */
  channelId: string;
  title: string;
  body: string;
  /** The sealed push envelope - the only non-placeholder content in the POST. */
  dataBlob: string;
}

export type ExpoPushSendResult =
  | { delivered: true }
  | { delivered: false; reason: 'device-not-registered' }
  | { delivered: false; reason: 'send-failed'; detail: string };

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

interface ExpoPushTicket {
  status?: string;
  message?: string;
  details?: { error?: string };
}

/** The API returns { data: ticket } for a single message and { data: ticket[] } for a batch; normalize to the first ticket. */
function extractTicket(responseJson: unknown): ExpoPushTicket | null {
  if (typeof responseJson !== 'object' || responseJson === null) return null;
  const data = (responseJson as { data?: unknown }).data;
  const ticket = Array.isArray(data) ? (data[0] as unknown) : data;
  if (typeof ticket !== 'object' || ticket === null) return null;
  return ticket as ExpoPushTicket;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function sendExpoPush(fetchImpl: FetchLike, message: ExpoPushMessage): Promise<ExpoPushSendResult> {
  const requestBody = JSON.stringify({
    to: message.to,
    title: message.title,
    body: message.body,
    data: { blob: message.dataBlob },
    priority: 'high',
    channelId: message.channelId,
    // Required for iOS: without mutable-content:1 the Notification Service
    // Extension that decrypts the envelope is never invoked. Expo maps this
    // camelCase field to the APNs header; Android ignores it.
    mutableContent: true,
  });
  const requestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: requestBody,
  };

  let response: FetchResponseLike;
  try {
    response = await fetchImpl(EXPO_PUSH_ENDPOINT, requestInit);
  } catch {
    // Network error: one retry after a pause, then give up quietly - a
    // missed notification is recoverable, a retry loop is not.
    await delay(NETWORK_RETRY_DELAY_MS);
    try {
      response = await fetchImpl(EXPO_PUSH_ENDPOINT, requestInit);
    } catch (retryError) {
      return { delivered: false, reason: 'send-failed', detail: retryError instanceof Error ? retryError.message : String(retryError) };
    }
  }

  let responseJson: unknown = null;
  try {
    responseJson = await response.json();
  } catch {
    // A non-JSON body falls through to the status/ticket checks below.
  }
  const ticket = extractTicket(responseJson);

  if (ticket?.details?.error === 'DeviceNotRegistered') {
    return { delivered: false, reason: 'device-not-registered' };
  }
  if (!response.ok) {
    return { delivered: false, reason: 'send-failed', detail: `Expo push API responded ${response.status}` };
  }
  if (ticket?.status === 'error') {
    return { delivered: false, reason: 'send-failed', detail: ticket.message ?? ticket.details?.error ?? 'Expo push ticket reported an error' };
  }
  return { delivered: true };
}

/** The default WakeChannel: Expo push, unchanged behavior, adapted to the vendor-neutral interface. */
export function createExpoWakeChannel(fetchImpl: FetchLike): WakeChannel {
  return {
    send(message: WakeMessage): Promise<WakeResult> {
      return sendExpoPush(fetchImpl, {
        to: message.token,
        channelId: message.channelId,
        title: message.title,
        body: message.body,
        dataBlob: message.blob,
      });
    },
  };
}

/**
 * Unit tests for src/main/mobile-bridge/push/expo-push-client.ts
 *
 * The client is a single injected-fetch POST: covered are the happy
 * path (including the exact request shape - notification privacy
 * depends on data.blob being the only real content), the one delayed
 * retry on a network error, and DeviceNotRegistered surfacing as a
 * typed result so the notifier can drop the registration.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { EXPO_PUSH_ENDPOINT, sendExpoPush, createExpoWakeChannel, type FetchLike } from '../../../src/main/mobile-bridge/push/expo-push-client';

const message = {
  to: 'ExponentPushToken[abc]',
  title: 'Kangentic',
  body: 'Agent needs your attention',
  dataBlob: 'sealed-blob',
};

function jsonResponse(body: unknown, ok = true, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok, status, json: () => Promise.resolve(body) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sendExpoPush', () => {
  it('POSTs the message shape Expo expects and reports delivery on an ok ticket', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { status: 'ok', id: 'ticket-1' } })) as FetchLike;

    const result = await sendExpoPush(fetchImpl, message);

    expect(result).toEqual({ delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(url).toBe(EXPO_PUSH_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      to: 'ExponentPushToken[abc]',
      title: 'Kangentic',
      body: 'Agent needs your attention',
      data: { blob: 'sealed-blob' },
      priority: 'high',
      // Required for iOS: without it the Notification Service Extension
      // that decrypts the envelope is never invoked.
      mutableContent: true,
    });
  });

  /**
   * The Android path. A message with no title, no body, and no channelId
   * is a data-only push, which is what stops expo-notifications rendering
   * its own generic notification alongside the decrypted one the app
   * posts. channelId matters here too, not just title/body: Expo attaches
   * an FCM android.notification block to ANY message carrying a channel
   * id, and that block is what made the FCM SDK draw a blank tray row
   * itself and skip the app's background handler entirely, dropping the
   * payload silently.
   *
   * toEqual, not toMatchObject: the keys must be ABSENT from the JSON,
   * not present-and-null. Expo reads a null title as a title.
   */
  it('omits title, body, and channelId entirely when the message carries none of them', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { status: 'ok' } })) as FetchLike;

    await sendExpoPush(fetchImpl, { to: message.to, dataBlob: message.dataBlob });

    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody).toEqual({
      to: 'ExponentPushToken[abc]',
      data: { blob: 'sealed-blob' },
      priority: 'high',
      mutableContent: true,
    });
    expect(Object.keys(parsedBody)).not.toContain('channelId');
  });

  it('accepts the batch-shaped { data: [ticket] } response too', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ status: 'ok', id: 'ticket-1' }] })) as FetchLike;
    expect(await sendExpoPush(fetchImpl, message)).toEqual({ delivered: true });
  });

  it('retries once after a delay on a network error, then succeeds', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce(jsonResponse({ data: { status: 'ok' } })) as unknown as FetchLike;

    const pending = sendExpoPush(fetchImpl, message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ delivered: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second network failure with a typed error', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up')) as unknown as FetchLike;

    const pending = sendExpoPush(fetchImpl, message);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ delivered: false, reason: 'send-failed', detail: 'socket hang up' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces DeviceNotRegistered as its own typed result', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } } }),
    ) as FetchLike;
    expect(await sendExpoPush(fetchImpl, message)).toEqual({ delivered: false, reason: 'device-not-registered' });
  });

  it('reports a non-ok HTTP status as send-failed', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ code: 'INTERNAL' }] }, false, 500)) as FetchLike;
    expect(await sendExpoPush(fetchImpl, message)).toEqual({ delivered: false, reason: 'send-failed', detail: 'Expo push API responded 500' });
  });

  it('reports an error ticket without DeviceNotRegistered as send-failed with the ticket message', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: { status: 'error', message: 'MessageTooBig', details: { error: 'MessageTooBig' } } }),
    ) as FetchLike;
    expect(await sendExpoPush(fetchImpl, message)).toEqual({ delivered: false, reason: 'send-failed', detail: 'MessageTooBig' });
  });
});

describe('createExpoWakeChannel', () => {
  it('adapts a WakeMessage onto the same Expo POST shape', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { status: 'ok' } })) as FetchLike;
    const wakeChannel = createExpoWakeChannel(fetchImpl);

    const result = await wakeChannel.send({
      token: 'ExponentPushToken[abc]',
      title: 'Kangentic',
      body: 'Agent needs your attention',
      blob: 'sealed-blob',
    });

    expect(result).toEqual({ delivered: true });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    const parsedBody = JSON.parse(init.body);
    expect(parsedBody).toMatchObject({
      to: 'ExponentPushToken[abc]',
      data: { blob: 'sealed-blob' },
      mutableContent: true,
    });
    // toMatchObject alone would not notice an extra key: name the guard
    // against channelId creeping back in, since that field alone is
    // enough for Expo to attach an FCM notification block and skip our
    // handler (see PushNotifier's header).
    expect(Object.keys(parsedBody)).not.toContain('channelId');
  });
});

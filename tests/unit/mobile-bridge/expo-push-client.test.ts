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
  channelId: 'needs-attention',
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
      channelId: 'needs-attention',
      // Required for iOS: without it the Notification Service Extension
      // that decrypts the envelope is never invoked.
      mutableContent: true,
    });
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
      channelId: 'needs-attention',
      title: 'Kangentic',
      body: 'Agent needs your attention',
      blob: 'sealed-blob',
    });

    expect(result).toEqual({ delivered: true });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      to: 'ExponentPushToken[abc]',
      channelId: 'needs-attention',
      data: { blob: 'sealed-blob' },
      mutableContent: true,
    });
  });
});

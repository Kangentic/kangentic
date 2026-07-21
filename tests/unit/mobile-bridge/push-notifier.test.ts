/**
 * Unit tests for src/main/mobile-bridge/push/push-notifier.ts
 *
 * Covered: the trigger mappings (permission -> input-required,
 * thinking->idle turn-complete, unintentional-exit session-failed),
 * presence suppression for established devices, per-device category
 * preference filtering, the 30s per (device, session, category)
 * cooldown, the 2s permission debounce with its cleared-meanwhile skip,
 * the envelope-only privacy property (no plaintext field value anywhere
 * in the POST body), the DeviceNotRegistered registration drop, and
 * mutableContent on the outgoing Expo message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PushNotifier, type PushNotifierOptions } from '../../../src/main/mobile-bridge/push/push-notifier';
import type { PushRegistrationStore } from '../../../src/main/mobile-bridge/push/push-registration-store';
import type { FetchLike } from '../../../src/main/mobile-bridge/push/expo-push-client';

class FakeSessionManager extends EventEmitter {
  getActivityStatsSnapshot = vi.fn((): { permissionPending: boolean; permissionAwaitedToolId: string | null } | null => ({
    permissionPending: true,
    permissionAwaitedToolId: 'tool-1',
  }));
}

// Distinctive values so the privacy assertion cannot pass by accident.
const TASK_CONTEXT = { projectId: 'proj-Zq1xK', taskId: 'task-Xw2yL', taskTitle: 'Secret Title Vy3zM' };
const REGISTRATION = {
  deviceId: 'device-1',
  expoPushToken: 'ExponentPushToken[abc]',
  pushKeyHex: 'ab'.repeat(32),
  platform: 'android' as const,
  registeredAt: '2026-07-16T00:00:00.000Z',
};

describe('PushNotifier', () => {
  let sessionManager: FakeSessionManager;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let listRegistrations: ReturnType<typeof vi.fn>;
  let removeRegistration: ReturnType<typeof vi.fn>;
  let sealSpy: ReturnType<typeof vi.fn>;
  let establishedDeviceIds: Set<string>;
  let notifier: PushNotifier;

  function buildNotifier(overrides: Partial<PushNotifierOptions> = {}): void {
    notifier = new PushNotifier({
      sessionManager: sessionManager as unknown as PushNotifierOptions['sessionManager'],
      registrationStore: { list: listRegistrations, remove: removeRegistration } as unknown as PushRegistrationStore,
      getEstablishedDeviceIds: () => establishedDeviceIds,
      resolveTaskContext: () => ({ ...TASK_CONTEXT }),
      resolveTaskContextByTaskId: () => ({ ...TASK_CONTEXT }),
      getDeviceStaticPublicKey: () => new Uint8Array(32).fill(9),
      sealEnvelope: sealSpy as unknown as PushNotifierOptions['sealEnvelope'],
      fetchImpl: fetchImpl as unknown as FetchLike,
      ...overrides,
    });
    notifier.start();
  }

  function postedBodies(): Array<Record<string, unknown>> {
    return fetchImpl.mock.calls.map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
  }

  function sealedCategories(): string[] {
    return sealSpy.mock.calls.map(([, , plaintext]) => (plaintext as { category: string }).category);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
    fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) }));
    listRegistrations = vi.fn(() => [REGISTRATION]);
    removeRegistration = vi.fn();
    sealSpy = vi.fn(() => 'sealed-blob');
    establishedDeviceIds = new Set<string>();
  });

  afterEach(() => {
    notifier.dispose();
    vi.useRealTimers();
  });

  it('a transition into permission notifies input-required after the 2s debounce', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    expect(fetchImpl).not.toHaveBeenCalled(); // debounced

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['input-required']);
    const body = postedBodies()[0];
    expect(body.channelId).toBe('needs-attention');
    expect(body.title).toBe('Kangentic');
    expect(body.body).toBe('Agent needs your attention');
    expect(body.data).toEqual({ blob: 'sealed-blob' });
    expect(body.mutableContent).toBe(true);
  });

  it('a prompt cleared within the debounce window never notifies', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    sessionManager.getActivityStatsSnapshot.mockReturnValue({ permissionPending: false, permissionAwaitedToolId: null });
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('leaving permission cancels the pending debounce outright', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).not.toHaveBeenCalled();
    // The snapshot was never even consulted - the timer died before firing.
    expect(sessionManager.getActivityStatsSnapshot).not.toHaveBeenCalled();
  });

  it('thinking -> idle notifies turn-complete immediately; idle arriving first does not', () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' }); // first-seen idle: no previous thinking
    expect(fetchImpl).not.toHaveBeenCalled();

    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['turn-complete']);
    expect(postedBodies()[0].channelId).toBe('completions');
    expect(postedBodies()[0].body).toBe('Task update');
  });

  it('plan-exit notifies plan-complete', () => {
    buildNotifier();
    sessionManager.emit('plan-exit', 'sess-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['plan-complete']);
    expect(postedBodies()[0].channelId).toBe('completions');
  });

  it('notifyTaskStalled resolves context by taskId and notifies spawn-stalled, keyed off taskId for cooldown', () => {
    buildNotifier();
    notifier.notifyTaskStalled('task-Xw2yL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['spawn-stalled']);
    expect(postedBodies()[0].channelId).toBe('stalls');

    // Same taskId again within the cooldown: suppressed.
    notifier.notifyTaskStalled('task-Xw2yL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('notifyTaskStalled seals an empty sessionId (no session exists yet)', () => {
    buildNotifier({ sealEnvelope: undefined });
    notifier.notifyTaskStalled('task-Xw2yL');
    const rawBody = (fetchImpl.mock.calls[0][1] as { body: string }).body;
    const body = JSON.parse(rawBody) as { data: { blob: string } };
    expect(typeof body.data.blob).toBe('string'); // real seal succeeded with sessionId: ''
  });

  it('an unintentional exit (or the flag-less spawn-failure emit) notifies session-failed; a deliberate stop does not', () => {
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 0, true); // deliberate stop
    expect(fetchImpl).not.toHaveBeenCalled();

    sessionManager.emit('exit', 'sess-2', 1, false); // crash
    sessionManager.emit('exit', 'sess-3', -1); // spawn failure emits no flag
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sealedCategories()).toEqual(['session-failed', 'session-failed']);
    expect(postedBodies()[0].channelId).toBe('failures');
    expect(postedBodies()[0].body).toBe('Session stopped');
  });

  it('presence suppression: an established device is never pinged', () => {
    establishedDeviceIds = new Set(['device-1']);
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sealSpy).not.toHaveBeenCalled();
  });

  it('a category the device did not opt into is filtered before sealing', () => {
    listRegistrations = vi.fn(() => [{ ...REGISTRATION, categories: ['session-failed'] }]);
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' }); // turn-complete: not in the device's list
    expect(fetchImpl).not.toHaveBeenCalled();

    sessionManager.emit('exit', 'sess-1', 1, false); // session-failed: in the device's list
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['session-failed']);
  });

  it('an undefined categories list on the registration means every category', () => {
    listRegistrations = vi.fn(() => [{ ...REGISTRATION, categories: undefined }]);
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('applies a 30s cooldown per (device, session, category)', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second turn-complete inside the cooldown

    // A DIFFERENT category for the same device+session is not throttled.
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A DIFFERENT session is not throttled either.
    sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-2', 'idle', { kind: 'idle' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Past the cooldown the same (device, session, category) fires again.
    await vi.advanceTimersByTimeAsync(30_000);
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('only data.blob carries real content: no plaintext field value appears anywhere in the POST body', () => {
    // Real sealing (no injected sealEnvelope), so this asserts the actual
    // envelope construction, not a stub.
    buildNotifier({ sealEnvelope: undefined });
    sessionManager.emit('activity', 'sess-1-Qr8pN', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1-Qr8pN', 'idle', { kind: 'idle' });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const rawBody = (fetchImpl.mock.calls[0][1] as { body: string }).body;
    for (const plaintextValue of [TASK_CONTEXT.projectId, TASK_CONTEXT.taskId, TASK_CONTEXT.taskTitle, 'sess-1-Qr8pN', 'turn-complete']) {
      expect(rawBody).not.toContain(plaintextValue);
    }
    const body = JSON.parse(rawBody) as { data: { blob: string } };
    expect(typeof body.data.blob).toBe('string');
    expect(body.data.blob.length).toBeGreaterThan(0);
  });

  it('drops the registration when Expo reports DeviceNotRegistered', async () => {
    fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }),
    }));
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    await vi.advanceTimersByTimeAsync(0); // let the async delivery settle
    expect(removeRegistration).toHaveBeenCalledWith('device-1');
  });

  it('a device without a resolvable roster public key is skipped, not crashed on', () => {
    buildNotifier({ getDeviceStaticPublicKey: () => null });
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dispose detaches listeners and kills a pending permission debounce', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    notifier.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
    expect(sessionManager.listenerCount('plan-exit')).toBe(0);
  });
});

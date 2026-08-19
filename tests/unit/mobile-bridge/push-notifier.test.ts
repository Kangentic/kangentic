/**
 * Unit tests for src/main/mobile-bridge/push/push-notifier.ts
 *
 * Covered: the trigger mappings (permission -> input-required,
 * settled thinking->idle turn-complete, unintentional-exit
 * session-failed), presence suppression for established devices,
 * per-device category preference filtering, the 30s per (device,
 * session, category) cooldown, the 2s permission debounce with its
 * cleared-meanwhile skip, the 45s idle settle window and every way it
 * gets cancelled, the platform split on the OS-visible placeholder
 * (Android data-only, iOS keeps title/body), the envelope-only privacy
 * property (no plaintext field value anywhere in the POST body), the
 * DeviceNotRegistered registration drop, and mutableContent on the
 * outgoing Expo message.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PushNotifier, type PushNotifierOptions } from '../../../src/main/mobile-bridge/push/push-notifier';
import type { PushRegistrationStore } from '../../../src/main/mobile-bridge/push/push-registration-store';
import type { FetchLike } from '../../../src/main/mobile-bridge/push/expo-push-client';

/** Both debounces re-check this at fire time, so both fields matter. */
interface FakeStatsSnapshot {
  activity: 'thinking' | 'idle' | 'permission';
  permissionPending: boolean;
  permissionAwaitedToolId: string | null;
}

class FakeSessionManager extends EventEmitter {
  getActivityStatsSnapshot = vi.fn((): FakeStatsSnapshot | null => ({
    activity: 'idle',
    permissionPending: true,
    permissionAwaitedToolId: 'tool-1',
  }));
}

/** Must match IDLE_SETTLE_MS in push-notifier.ts; held separately so shortening the window to nothing cannot keep these green. */
const EXPECTED_IDLE_SETTLE_MS = 45_000;

// Distinctive values so the privacy assertion cannot pass by accident.
const TASK_CONTEXT = { projectId: 'proj-Zq1xK', taskId: 'task-Xw2yL', taskTitle: 'Secret Title Vy3zM' };
const REGISTRATION = {
  deviceId: 'device-1',
  expoPushToken: 'ExponentPushToken[abc]',
  pushKeyHex: 'ab'.repeat(32),
  platform: 'android' as const,
  registeredAt: '2026-07-16T00:00:00.000Z',
};
const IOS_REGISTRATION = { ...REGISTRATION, deviceId: 'device-ios', platform: 'ios' as const };

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

  /**
   * A full turn plus the settle window - the only way turn-complete
   * fires now. Note it also advances past the 30s category cooldown,
   * which is why the cooldown test below drives immediate categories
   * instead: two consecutive settled turns can never land inside one
   * cooldown window.
   */
  async function settleTurn(sessionId = 'sess-1'): Promise<void> {
    sessionManager.emit('activity', sessionId, 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', sessionId, 'idle', { kind: 'idle' });
    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
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
    expect(body.data).toEqual({ blob: 'sealed-blob' });
    expect(body.mutableContent).toBe(true);
  });

  it('a prompt cleared within the debounce window never notifies', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    sessionManager.getActivityStatsSnapshot.mockReturnValue({
      activity: 'idle',
      permissionPending: false,
      permissionAwaitedToolId: null,
    });
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

  it('thinking -> idle notifies turn-complete once the session has stayed idle; idle arriving first does not', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' }); // first-seen idle: no previous thinking
    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
    expect(fetchImpl).not.toHaveBeenCalled();

    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(fetchImpl).not.toHaveBeenCalled(); // armed, not fired

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['turn-complete']);
    expect(postedBodies()[0].channelId).toBe('completions');
  });

  /**
   * The flood this window exists for. Every exchange in a conversation
   * ends in idle, so before the debounce a three-reply back-and-forth
   * was three notifications - and the 30s cooldown did not cover it,
   * because real turns sit further apart than that. Only the idle that
   * actually sticks should alert.
   */
  it('does not notify for a session that goes back to thinking inside the settle window', async () => {
    buildNotifier();

    for (let exchange = 0; exchange < 3; exchange += 1) {
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
      await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS / 3);
    }
    expect(fetchImpl).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // one, not four
  });

  /** A prompt is the clearest possible "not finished" signal, and fires on its own. */
  it('a permission prompt inside the settle window cancels the pending turn-complete', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS * 2);
    expect(sealedCategories()).toEqual(['input-required']);
  });

  it('an exit inside the settle window cancels the pending turn-complete', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('exit', 'sess-1', 0, true); // deliberate stop: notifies nothing itself

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS * 2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * The fire-time re-check, mirroring the permission debounce's. It
   * catches a session that changed without an activity emission
   * reaching us - the timer alone cannot know that.
   */
  it('re-checks the live snapshot at fire time and skips a session no longer idle', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.getActivityStatsSnapshot.mockReturnValue({
      activity: 'thinking',
      permissionPending: false,
      permissionAwaitedToolId: null,
    });

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
    expect(fetchImpl).not.toHaveBeenCalled();
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
  });

  it('presence suppression: an established device is never pinged', async () => {
    establishedDeviceIds = new Set(['device-1']);
    buildNotifier();
    await settleTurn();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sealSpy).not.toHaveBeenCalled();
  });

  it('a category the device did not opt into is filtered before sealing', async () => {
    listRegistrations = vi.fn(() => [{ ...REGISTRATION, categories: ['session-failed'] }]);
    buildNotifier();
    await settleTurn(); // turn-complete: not in the device's list
    expect(fetchImpl).not.toHaveBeenCalled();

    sessionManager.emit('exit', 'sess-1', 1, false); // session-failed: in the device's list
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['session-failed']);
  });

  it('an undefined categories list on the registration means every category', async () => {
    listRegistrations = vi.fn(() => [{ ...REGISTRATION, categories: undefined }]);
    buildNotifier();
    await settleTurn();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('an explicit empty categories list on the registration means none', async () => {
    listRegistrations = vi.fn(() => [{ ...REGISTRATION, categories: [] }]);
    buildNotifier();
    await settleTurn();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a taskId-keyed spawn-stalled cooldown never collides with a session cooldown of the same string id', () => {
    buildNotifier();
    notifier.notifyTaskStalled('task-Xw2yL');
    // A session whose id happens to equal that same string, on an
    // unrelated category: the cooldown key includes category, so the
    // taskId-subject cooldown above must not suppress this.
    sessionManager.emit('exit', 'task-Xw2yL', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sealedCategories()).toEqual(['spawn-stalled', 'session-failed']);
  });

  /**
   * Driven with session-failed rather than turn-complete, because the
   * settle window (45s) is now longer than the cooldown (30s): two
   * consecutive settled turns can never land inside one cooldown window,
   * so turn-complete could no longer demonstrate this property at all.
   */
  it('applies a 30s cooldown per (device, session, category)', async () => {
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // second session-failed inside the cooldown

    // A DIFFERENT category for the same device+session is not throttled.
    sessionManager.emit('plan-exit', 'sess-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A DIFFERENT session is not throttled either.
    sessionManager.emit('exit', 'sess-2', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    // Past the cooldown the same (device, session, category) fires again.
    await vi.advanceTimersByTimeAsync(30_000);
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('only data.blob carries real content: no plaintext field value appears anywhere in the POST body', async () => {
    // Real sealing (no injected sealEnvelope), so this asserts the actual
    // envelope construction, not a stub.
    buildNotifier({ sealEnvelope: undefined });
    await settleTurn('sess-1-Qr8pN');

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
    await settleTurn();
    await vi.advanceTimersByTimeAsync(0); // let the async delivery settle
    expect(removeRegistration).toHaveBeenCalledWith('device-1');
  });

  it('a device without a resolvable roster public key is skipped, not crashed on', async () => {
    buildNotifier({ getDeviceStaticPublicKey: () => null });
    await settleTurn();
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

  it('dispose kills a pending idle settle too', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    notifier.dispose();
    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS * 2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * THE ANDROID DUPLICATE FIX. expo-notifications presents a push with a
   * title or body ITSELF, natively, before running the background task
   * that decrypts and posts the real notification - so every alert
   * appeared twice, once as this generic placeholder and once decrypted.
   * Sending Android a data-only message suppresses the first
   * (ExpoHandlingDelegate presents a backgrounded notification only when
   * title or text is non-empty) while the task still runs.
   */
  it('sends Android a data-only message, with no OS-visible title or body', () => {
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);

    const body = postedBodies()[0];
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('body');
    // Everything that makes the message useful is still there.
    expect(body.data).toEqual({ blob: 'sealed-blob' });
    expect(body.channelId).toBe('failures');
    expect(body.priority).toBe('high');
  });

  /**
   * The other half, and the reason this is a platform branch rather than
   * dropping title/body outright: iOS has no Notification Service
   * Extension yet, so the placeholder is the ONLY visible content an iOS
   * push can carry. Stripping it globally would turn iOS from "silent
   * because unauthorized" into "silent by construction".
   */
  it('keeps the placeholder title and body for an iOS device', () => {
    listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);

    const body = postedBodies()[0];
    expect(body.title).toBe('Kangentic');
    expect(body.body).toBe('Session stopped');
    expect(body.mutableContent).toBe(true);
  });

  it('branches per device when both platforms are registered', () => {
    listRegistrations = vi.fn(() => [REGISTRATION, IOS_REGISTRATION]);
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);

    const [androidBody, iosBody] = postedBodies();
    expect(androidBody).not.toHaveProperty('title');
    expect(iosBody.title).toBe('Kangentic');
  });

  /** The placeholder is still generic on iOS - it travels through Expo, FCM and APNs. */
  it('never puts real content in the iOS placeholder', () => {
    listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
    buildNotifier({ sealEnvelope: undefined });
    sessionManager.emit('exit', 'sess-1', 1, false);

    const rawBody = (fetchImpl.mock.calls[0][1] as { body: string }).body;
    for (const plaintextValue of [TASK_CONTEXT.projectId, TASK_CONTEXT.taskId, TASK_CONTEXT.taskTitle, 'session-failed']) {
      expect(rawBody).not.toContain(plaintextValue);
    }
  });
});

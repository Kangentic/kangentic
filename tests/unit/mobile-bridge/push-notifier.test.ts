/**
 * Unit tests for src/main/mobile-bridge/push/push-notifier.ts
 *
 * Covered: the trigger mappings (permission -> input-required,
 * settled thinking->idle turn-complete, unintentional-exit
 * session-failed), presence suppression for connected devices (driven
 * through the real collectConnectedDeviceIds predicate over a fake
 * session map, not a stub Set, so a regression back to the raw
 * isEstablished flag is actually caught), per-device category
 * preference filtering, the 30s per (device, session, category)
 * cooldown, the 2s permission debounce with its cleared-meanwhile skip,
 * the 45s idle settle window and every way it gets cancelled, the
 * platform split on the OS-visible placeholder (Android data-only, iOS
 * keeps title/body), the envelope-only privacy property (no plaintext
 * field value anywhere in the POST body), the DeviceNotRegistered
 * registration drop, mutableContent on the outgoing Expo message, that a
 * non-delivered send (a thrown error or a send-failed result) is logged
 * rather than silently swallowed, that the logged detail has any Expo
 * push token redacted out of it, that the device-not-registered branch
 * returns before the generic-failure handling, and that a stale in-flight
 * failure releases only the cooldown stamp it made rather than a fresher
 * one written for the same key meanwhile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { collectConnectedDeviceIds, redactPushTokens, PushNotifier, type PushNotifierOptions } from '../../../src/main/mobile-bridge/push/push-notifier';
import type { PushRegistrationStore } from '../../../src/main/mobile-bridge/push/push-registration-store';
import type { FetchLike } from '../../../src/main/mobile-bridge/push/expo-push-client';
import type { WakeResult } from '../../../src/main/mobile-bridge/push/wake-channel';
import type { MobileDeviceConnectionState } from '../../../src/shared/types';

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

describe('redactPushTokens', () => {
  /**
   * Direct regex coverage, distinct from the indirect log-assertion tests
   * below that only ever feed the long "Exponent" form. Expo's actual
   * documented not-registered message uses the SHORT "ExpoPushToken[...]"
   * form - the `(?:nent)?` group in the regex is what makes that match at
   * all. Deleting that group would leave every indirect test green (they
   * only ever use the long form) while silently failing to redact the form
   * Expo's own docs use.
   */
  it('redacts the short ExpoPushToken[...] form, not just ExponentPushToken[...]', () => {
    expect(redactPushTokens('"ExpoPushToken[xyz]" is not a registered push notification recipient')).toBe(
      '"ExponentPushToken[redacted]" is not a registered push notification recipient',
    );
  });

  it('redacts the long ExponentPushToken[...] form', () => {
    expect(redactPushTokens('token was ExponentPushToken[abc123]')).toBe('token was ExponentPushToken[redacted]');
  });

  /**
   * The `g` flag. A thrown error's stack can quote the token it was posting
   * to more than once (e.g. once in the message, once in a nested cause).
   * Without `g`, only the first occurrence would be redacted and the second
   * would leak straight into the log.
   */
  it('redacts every occurrence in a string that quotes the token more than once', () => {
    const text = 'sending to ExponentPushToken[first] failed; retry target was ExponentPushToken[first] again';
    expect(redactPushTokens(text)).toBe('sending to ExponentPushToken[redacted] failed; retry target was ExponentPushToken[redacted] again');
  });

  it('leaves text with no token unchanged', () => {
    expect(redactPushTokens('socket reset')).toBe('socket reset');
  });
});

describe('PushNotifier', () => {
  let sessionManager: FakeSessionManager;
  let fetchImpl: ReturnType<typeof vi.fn>;
  let listRegistrations: ReturnType<typeof vi.fn>;
  let removeRegistration: ReturnType<typeof vi.fn>;
  let sealSpy: ReturnType<typeof vi.fn>;
  /**
   * Fake bridge sessions keyed by deviceId, mirroring the real
   * MobileBridgeService.sessions map's shape (just enough of it -
   * connectionState only). Passed through the real
   * collectConnectedDeviceIds predicate rather than stubbed as a plain
   * Set, so a regression back to the raw isEstablished flag is caught by
   * the tests below instead of silently passing.
   */
  let fakeSessions: Map<string, { connectionState: MobileDeviceConnectionState }>;
  let notifier: PushNotifier;

  function buildNotifier(overrides: Partial<PushNotifierOptions> = {}): void {
    notifier = new PushNotifier({
      sessionManager: sessionManager as unknown as PushNotifierOptions['sessionManager'],
      registrationStore: { list: listRegistrations, remove: removeRegistration } as unknown as PushRegistrationStore,
      getConnectedDeviceIds: () => collectConnectedDeviceIds(fakeSessions),
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
    fakeSessions = new Map();
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
    expect(body.data).toEqual({ blob: 'sealed-blob' });
    expect(body.mutableContent).toBe(true);
  });

  /**
   * The input-required placeholder copy, on iOS where it's actually sent.
   * The Android-registered test above dropped its title/body assertions
   * when the platform split landed (Android gets a data-only push, so
   * there is nothing to assert there) - which left
   * PLACEHOLDER_BODIES['input-required'] pinned nowhere: a revert of that
   * string back to something else would leave the whole suite green.
   */
  it('a transition into permission on an iOS device posts the input-required placeholder copy', async () => {
    listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    await vi.advanceTimersByTimeAsync(2000);

    expect(sealedCategories()).toEqual(['input-required']);
    const body = postedBodies()[0];
    expect(body.title).toBe('Kangentic');
    expect(body.body).toBe('Agent needs your attention');
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

  /**
   * The `statsSnapshot?.` optional chain, not just the `.activity !== 'idle'`
   * comparison, is what this pins: a session can be torn down entirely
   * between arming the settle timer and it firing, so the re-check must
   * treat "no snapshot" the same as "not idle" instead of dereferencing a
   * null. Dropping the `?.` would only blow up under this exact
   * null-snapshot condition - `vi.advanceTimersByTimeAsync` rejects if the
   * timer callback throws, so an un-guarded read fails this test rather
   * than silently passing it.
   */
  it('a null snapshot at settle fire time is treated as session-gone, not a crash', async () => {
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.getActivityStatsSnapshot.mockReturnValue(null);

    await vi.advanceTimersByTimeAsync(EXPECTED_IDLE_SETTLE_MS);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('plan-exit notifies plan-complete', () => {
    buildNotifier();
    sessionManager.emit('plan-exit', 'sess-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['plan-complete']);
  });

  it('notifyTaskStalled resolves context by taskId and notifies spawn-stalled, keyed off taskId for cooldown', () => {
    buildNotifier();
    notifier.notifyTaskStalled('task-Xw2yL');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['spawn-stalled']);

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
  });

  it('presence suppression: a connected device is never pinged', async () => {
    fakeSessions.set('device-1', { connectionState: 'connected' });
    buildNotifier();
    await settleTurn();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sealSpy).not.toHaveBeenCalled();
  });

  /**
   * The falsifying case for presence suppression. On a silent phone death nothing
   * nulls the bridge session's streams, so isEstablished stays true for
   * the whole relay keepalive sweep even though connectionState has
   * already concluded 'offline'. A device in that state must still be
   * pinged - collectConnectedDeviceIds never reads isEstablished at all,
   * only connectionState, so reverting to the raw established flag would
   * turn this red.
   */
  it('presence suppression reads connectionState, not raw isEstablished: an offline device is still pinged', async () => {
    fakeSessions.set('device-1', { connectionState: 'offline' });
    buildNotifier();
    await settleTurn();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sealedCategories()).toEqual(['turn-complete']);
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

  /**
   * The early return on result.reason === 'device-not-registered'. deliver()
   * deliberately stops there, before either the cooldown release or the
   * generic-failure console.warn a few lines below - the test above only
   * asserts removeRegistration was called, so falling through into the
   * release-and-second-warn block would still pass it.
   */
  it('the device-not-registered branch warns exactly once and never falls through to the generic-failure warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notRegisteredWakeChannel = {
      send: vi.fn(() => Promise.resolve<WakeResult>({ delivered: false, reason: 'device-not-registered' })),
    };
    buildNotifier({ wakeChannel: notRegisteredWakeChannel });
    sessionManager.emit('exit', 'sess-1', 1, false);
    await vi.advanceTimersByTimeAsync(0); // let the delivery settle

    expect(removeRegistration).toHaveBeenCalledWith('device-1');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const loggedText = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('no longer registered');
    expect(loggedText).not.toContain('failed:'); // the generic-failure line's wording, never reached

    // The early return skips releaseCooldownIfUnclaimed too, so the stamp
    // this call made is still live: an immediate retrigger of the same
    // (device, session, category) key stays suppressed by it rather than
    // by a missing registration (the fake store's list() is untouched by
    // removeRegistration and still returns it).
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(notRegisteredWakeChannel.send).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  /**
   * The blind spot the logging closes. sendExpoPush never throws for a
   * network failure or a non-2xx response - it catches internally and
   * RETURNS { delivered: false, reason: 'send-failed', detail } - so this
   * result, not the deliver() catch block, is the branch a real Expo
   * outage takes. Before the fix it fell off the end of deliver()'s if
   * with no trace anywhere.
   */
  it('logs a send-failed result instead of swallowing it, and does not drop the registration', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    buildNotifier();
    await settleTurn();
    await vi.advanceTimersByTimeAsync(0); // let the async delivery settle

    expect(warnSpy).toHaveBeenCalled();
    const loggedText = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('send-failed');
    expect(loggedText).toContain('503');
    expect(loggedText).not.toContain(REGISTRATION.expoPushToken);
    expect(loggedText).not.toContain('sealed-blob');
    expect(removeRegistration).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  /**
   * redactPushTokens on the send-failed detail. result.detail on this path
   * is Expo's own ticket message (see expo-push-client.ts's
   * ticket.status === 'error' branch) - vendor text this repo does not
   * author - and Expo does quote the device's own push token back inside
   * it, as its documented not-registered message shows. The ticket shape
   * below is a stand-in for any such message reaching this branch.
   * Logging it verbatim would put a live push capability in the desktop
   * log, which is what the notifier's header promises it never does.
   */
  it('redacts the device token out of an Expo rate-limit ticket message before logging it, keeping the diagnostic text', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const rateLimitMessage = `You are sending messages too frequently to device ${REGISTRATION.expoPushToken}. Slow down.`;
    fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { status: 'error', message: rateLimitMessage, details: { error: 'MessageRateExceeded' } } }),
    }));
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    await vi.advanceTimersByTimeAsync(0); // let the delivery settle

    expect(warnSpy).toHaveBeenCalled();
    const loggedText = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).not.toContain(REGISTRATION.expoPushToken);
    expect(loggedText).toContain('ExponentPushToken[redacted]');
    expect(loggedText).toContain('too frequently'); // the diagnostic half survives the redaction

    warnSpy.mockRestore();
  });

  it('logs a thrown wakeChannel error instead of swallowing it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwingWakeChannel = { send: vi.fn(() => Promise.reject(new Error('socket reset'))) };
    buildNotifier({ wakeChannel: throwingWakeChannel });
    sessionManager.emit('exit', 'sess-1', 1, false);
    await vi.advanceTimersByTimeAsync(0); // let the rejected promise settle

    expect(warnSpy).toHaveBeenCalled();
    const loggedText = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(loggedText).toContain('socket reset');
    expect(removeRegistration).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  /**
   * The cooldown is stamped BEFORE the send (notifyWithContext), so a
   * synchronous burst of the same category never double-sends. But a
   * genuine failure means the phone never actually saw a notification, so
   * that stamp must not cost it the whole 30s retry window: the failure
   * path releases the cooldown it set, and a later recurrence within the
   * original window still goes out.
   */
  it('a failed send releases its cooldown, so a later recurrence within 30s still notifies', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) });
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false); // fails
    await vi.advanceTimersByTimeAsync(0); // let the failed delivery release the cooldown
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Well inside the 30s window - a fresh stamp here would suppress this.
    await vi.advanceTimersByTimeAsync(5000);
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // the retry actually went out

    warnSpy.mockRestore();
  });

  /**
   * The compare-and-clear guard inside releaseCooldownIfUnclaimed. The test
   * above is fully sequential - the failing send resolves before the
   * second trigger fires - so the `=== stampedAt` comparison the guard
   * performs is never actually exercised: a bare
   * `this.cooldowns.delete(cooldownKey)` would pass it too. Here send #1
   * is left unresolved while a later trigger of the identical (device,
   * session, category) key writes a fresher stamp and succeeds; only once
   * that fresher stamp exists does send #1 resolve as a failure. Releasing
   * a stale stamp must never clear the fresh one another call already
   * wrote for the same key.
   */
  it('a stale in-flight failure releases only its own cooldown stamp, never a fresher one written meanwhile', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveFirstSend: (result: WakeResult) => void = () => {};
    const firstSendResult = new Promise<WakeResult>((resolve) => {
      resolveFirstSend = resolve;
    });
    let sendCallCount = 0;
    const sendSpy = vi.fn(() => {
      sendCallCount += 1;
      return sendCallCount === 1 ? firstSendResult : Promise.resolve<WakeResult>({ delivered: true });
    });
    buildNotifier({ wakeChannel: { send: sendSpy } });

    // Send #1: stamps the cooldown for (device-1, sess-1, session-failed) and stays in flight.
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Past the 30s cooldown the identical key notifies again: a fresher
    // stamp is written and send #2 goes out and succeeds.
    await vi.advanceTimersByTimeAsync(30_000);
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(sendSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(0); // let send #2 settle

    // Only now does send #1 resolve, as a failure.
    resolveFirstSend({ delivered: false, reason: 'send-failed', detail: 'boom' });
    await vi.advanceTimersByTimeAsync(0); // let the stale failure settle

    // Well inside the fresh stamp's own 30s window: a bare `delete` in
    // releaseCooldownIfUnclaimed would have wiped that fresh stamp above,
    // and this trigger would send a third time.
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(sendSpy).toHaveBeenCalledTimes(2);

    warnSpy.mockRestore();
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
    // fetchImpl alone is not enough: notify() opens with a disposed guard,
    // so a stale timer that fires anyway would still be swallowed there and
    // this assertion would stay green even if dispose() forgot to clear
    // idleSettleTimers. Asserting the fire-time snapshot re-check never ran
    // pins that the timer itself died, not just its downstream effect.
    expect(sessionManager.getActivityStatsSnapshot).not.toHaveBeenCalled();
  });

  /**
   * THE ANDROID DUPLICATE FIX. expo-notifications presents a push with a
   * title or body ITSELF, natively, before running the background task
   * that decrypts and posts the real notification - so every alert
   * appeared twice, once as this generic placeholder and once decrypted.
   * Sending Android a data-only message suppresses the first
   * (ExpoHandlingDelegate presents a backgrounded notification only when
   * title or text is non-empty) while the task still runs - but only if
   * the message ALSO carries no channelId: Expo attaches an FCM
   * android.notification block to any message with a channel id, title
   * or body or not, and that block makes the FCM SDK render the tray
   * item itself and skip the background task entirely, dropping the
   * decrypted notification silently.
   */
  it('sends Android a data-only message, with no OS-visible title, body, or channelId', () => {
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);

    const body = postedBodies()[0];
    expect(body).not.toHaveProperty('title');
    expect(body).not.toHaveProperty('body');
    expect(body).not.toHaveProperty('channelId');
    // Everything that makes the message useful is still there.
    expect(body.data).toEqual({ blob: 'sealed-blob' });
    expect(body.priority).toBe('high');
  });

  /**
   * The other half, and the reason this is a platform branch rather than
   * dropping title/body outright: iOS has no Notification Service
   * Extension yet, so the placeholder is the ONLY visible content an iOS
   * push can carry. Stripping it globally would turn iOS from "silent
   * because unauthorized" into "silent by construction". channelId is
   * still dropped here, mirroring the Android assertion above: the two
   * platforms differ on title/body only, so a channelId reinstated
   * inside this branch alone would otherwise leave the suite green.
   */
  it('keeps the placeholder title and body for an iOS device, but still no channelId', () => {
    listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);

    const body = postedBodies()[0];
    expect(body.title).toBe('Kangentic');
    expect(body.body).toBe('Session stopped');
    expect(body.mutableContent).toBe(true);
    expect(body).not.toHaveProperty('channelId');
  });

  /**
   * Every other iOS-placeholder test above drives session-failed via exit,
   * and every settled-turn test above registers the Android device, which
   * gets no body key at all (see the data-only test). That leaves the
   * turn-complete placeholder copy - 'Agent went idle', changed from the
   * old 'Task update' now that this category means "went quiet" rather
   * than "a turn ended" - asserted nowhere: a revert back to the old
   * string would leave the whole suite green. Driving a full settled turn
   * against an iOS-only registration closes that gap.
   */
  it('a settled turn on an iOS device posts the turn-complete placeholder copy', async () => {
    listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
    buildNotifier();
    await settleTurn();

    expect(sealedCategories()).toEqual(['turn-complete']);
    const body = postedBodies()[0];
    expect(body.title).toBe('Kangentic');
    expect(body.body).toBe('Agent went idle');
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

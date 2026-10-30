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
 * one written for the same key meanwhile. It also pins the wait kind the
 * permission push seals from its fire-time snapshot, and Notify me's
 * notifyAutomation: the row's text on an input-required with no session, sent
 * past presence, categories and the cooldown, cut to fit, and never cleared.
 *
 * The 'clears' suite covers the other direction: every resolution trigger,
 * coalescing and the payload size bound, the acceptsClears opt-in, the
 * connected-device skip, the exact Android and iOS clear shapes, the
 * notifiedAt bound, iOS piggybacking and its rate limit, and the 24h expiry.
 * It also pins the size budget of the clears a visible alert carries, the
 * flush-time guards (registration gone or no longer taking clears, no roster
 * key, a clear that cannot be sealed), what a visible send that throws, is
 * refused as unregistered, or fails as a resend does to the ledger, the
 * release of the iOS interval after a clear whose send throws, and that a
 * turn end or running session resolves only its own project's task.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { hexToBytes, openPushClear, openPushEnvelope, sealPushEnvelope, type PushClearEntry } from '@kangentic/protocol';
import {
  collectConnectedDeviceIds,
  redactPushTokens,
  PushNotifier,
  type PushNotifierOptions,
  type PushTaskPlacement,
} from '../../../src/main/mobile-bridge/push/push-notifier';
import type { PushRegistrationStore } from '../../../src/main/mobile-bridge/push/push-registration-store';
import type { FetchLike } from '../../../src/main/mobile-bridge/push/expo-push-client';
import type { WakeMessage, WakeResult } from '../../../src/main/mobile-bridge/push/wake-channel';
import type { BoardChangedEvent } from '../../../src/main/mobile-bridge/board-event-bus';
import type { MobileDeviceConnectionState } from '../../../src/shared/types';

/** Both debounces re-check this at fire time, so both fields matter; the permission one also reads the wait's kind. */
interface FakeStatsSnapshot {
  activity: 'thinking' | 'idle' | 'permission';
  permissionPending: boolean;
  permissionAwaitedToolId: string | null;
  permissionWaitKind?: 'question' | 'approval' | null;
}

class FakeSessionManager extends EventEmitter {
  getActivityStatsSnapshot = vi.fn((): FakeStatsSnapshot | null => ({
    activity: 'idle',
    permissionPending: true,
    permissionAwaitedToolId: 'tool-1',
  }));
}

/** The board-changed bus, reduced to what the notifier subscribes through. */
class FakeBoardEvents {
  readonly listeners = new Set<(event: BoardChangedEvent) => void>();

  onBoardChanged = (listener: (event: BoardChangedEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  emit(event: BoardChangedEvent): void {
    for (const listener of this.listeners) listener(event);
  }
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
  let boardEvents: FakeBoardEvents;
  let readTaskPlacement: ReturnType<typeof vi.fn>;
  let notifier: PushNotifier;

  function buildNotifier(overrides: Partial<PushNotifierOptions> = {}): void {
    notifier = new PushNotifier({
      sessionManager: sessionManager as unknown as PushNotifierOptions['sessionManager'],
      registrationStore: { list: listRegistrations, remove: removeRegistration } as unknown as PushRegistrationStore,
      boardEvents,
      isBridgeEnabled: () => true,
      getConnectedDeviceIds: () => collectConnectedDeviceIds(fakeSessions),
      resolveTaskContext: () => ({ ...TASK_CONTEXT }),
      resolveTaskContextByTaskId: () => ({ ...TASK_CONTEXT }),
      readTaskPlacement: readTaskPlacement as unknown as PushNotifierOptions['readTaskPlacement'],
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

  function sealedPlaintext(callIndex = 0): Record<string, unknown> {
    return sealSpy.mock.calls[callIndex][2] as Record<string, unknown>;
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
    boardEvents = new FakeBoardEvents();
    readTaskPlacement = vi.fn((): PushTaskPlacement | null => ({ swimlaneId: 'lane-1', archived: false, lastMoveOrigin: null }));
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

  // A running workflow task's idle is its step check's to report
  // (workflow-recovery.ts), so "Agent went idle" would ping at every nudged turn.
  it('a running workflow task\'s settled idle sends no turn-complete; its step check says when it needs the user', async () => {
    buildNotifier({ isWorkflowStepSession: () => true });
    await settleTurn();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a running workflow task that needs the user is sent as input-required, with why, keyed to the task rather than a session', async () => {
    buildNotifier({ isWorkflowStepSession: () => true });

    notifier.notifyWorkflowTask({ ...TASK_CONTEXT, detail: 'Workflow stalled: the step check could not run.' });
    await vi.advanceTimersByTimeAsync(0);

    expect(sealedCategories()).toEqual(['input-required']);
    const plaintext = sealSpy.mock.calls[0][2] as { taskId: string; sessionId: string; detail: string };
    expect(plaintext).toMatchObject({ taskId: TASK_CONTEXT.taskId, sessionId: '', detail: 'Workflow stalled: the step check could not run.' });

    // Cooled down per task: a second one inside the window is held back.
    notifier.notifyWorkflowTask({ ...TASK_CONTEXT, detail: 'Workflow stalled: again.' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sealedCategories()).toEqual(['input-required']);
    // The workflow's notice keeps the category's own title on every phone.
    expect('waitKind' in plaintext).toBe(false);
  });

  describe('the wait kind (protocol 0.26.0)', () => {
    it('seals the wait kind the snapshot holds when the permission debounce fires', async () => {
      buildNotifier();
      // Arm-time reason says nothing; the fire-time snapshot is what counts.
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      sessionManager.getActivityStatsSnapshot.mockReturnValue({
        activity: 'permission',
        permissionPending: true,
        permissionAwaitedToolId: 'tool-1',
        permissionWaitKind: 'approval',
      } as FakeStatsSnapshot);
      await vi.advanceTimersByTimeAsync(2000);
      expect(sealedPlaintext()).toMatchObject({ category: 'input-required', waitKind: 'approval' });
    });

    it('seals no wait kind when the agent did not say', async () => {
      buildNotifier();
      sessionManager.getActivityStatsSnapshot.mockReturnValue({
        activity: 'permission',
        permissionPending: true,
        permissionAwaitedToolId: 'tool-1',
        permissionWaitKind: null,
      } as FakeStatsSnapshot);
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(sealedCategories()).toEqual(['input-required']);
      expect('waitKind' in sealedPlaintext()).toBe(false);
    });
  });

  describe('Notify me (notifyAutomation)', () => {
    const ROW = { projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, taskTitle: TASK_CONTEXT.taskTitle, title: 'Cap retries in the sync client', body: 'Blocked' };

    it('seals the row\'s title and body on an input-required with no session, and the body as detail for older phones', async () => {
      buildNotifier();
      notifier.notifyAutomation(ROW);
      await vi.advanceTimersByTimeAsync(0);
      expect(sealedPlaintext()).toMatchObject({
        category: 'input-required',
        projectId: TASK_CONTEXT.projectId,
        taskId: TASK_CONTEXT.taskId,
        sessionId: '',
        taskTitle: TASK_CONTEXT.taskTitle,
        detail: 'Blocked',
        title: 'Cap retries in the sync client',
        body: 'Blocked',
      });
      expect('waitKind' in sealedPlaintext()).toBe(false);
    });

    it('reaches a device whose categories leave out input-required, and a connected one', async () => {
      listRegistrations = vi.fn(() => [
        { ...REGISTRATION, categories: ['turn-complete'] },
        { ...IOS_REGISTRATION },
      ]);
      fakeSessions.set(IOS_REGISTRATION.deviceId, { connectionState: 'connected' });
      buildNotifier();
      notifier.notifyAutomation(ROW);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('is never cooled down: two rows on the same task both notify, and neither holds back the session\'s own prompt', async () => {
      buildNotifier();
      notifier.notifyAutomation(ROW);
      notifier.notifyAutomation({ ...ROW, title: 'Second row' });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(2);

      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it('still sends nothing while the Mobile bridge switch is off', async () => {
      buildNotifier({ isBridgeEnabled: () => false });
      notifier.notifyAutomation(ROW);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('cuts a long title and shrinks a long body until the push fits Expo\'s payload limit', async () => {
      // Seal for real, so the blob length is the one a device would get.
      sealSpy = vi.fn((...callArguments: Parameters<typeof sealPushEnvelope>) => sealPushEnvelope(...callArguments));
      buildNotifier();
      const longBody = 'The reviewer asked for a rethrow of the last error. '.repeat(200);
      notifier.notifyAutomation({ ...ROW, title: 'T'.repeat(500), body: longBody });
      await vi.advanceTimersByTimeAsync(0);

      const plaintext = sealedPlaintext() as { title: string; body: string; detail: string };
      expect(Array.from(plaintext.title).length).toBeLessThanOrEqual(200);
      expect(plaintext.title.endsWith('...')).toBe(true);
      expect(plaintext.body.endsWith('...')).toBe(true);
      expect(plaintext.body.length).toBeGreaterThan(0);
      expect(plaintext.detail).toBe(plaintext.body);
      const blob = (postedBodies()[0].data as { blob: string }).blob;
      expect(blob.length).toBeLessThanOrEqual(3_000);
    });

    it('never puts the row\'s text in the iOS placeholder or anywhere else outside the sealed blob', async () => {
      // Real sealing, so the blob is what a device would get and holds the text.
      listRegistrations = vi.fn(() => [IOS_REGISTRATION]);
      buildNotifier({ sealEnvelope: undefined });
      notifier.notifyAutomation({ ...ROW, title: 'Row Title Kp4wR', body: 'Row Body Jt7sD' });
      await vi.advanceTimersByTimeAsync(0);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const rawBody = (fetchImpl.mock.calls[0][1] as { body: string }).body;
      for (const plaintextValue of ['Row Title Kp4wR', 'Row Body Jt7sD', TASK_CONTEXT.taskTitle, TASK_CONTEXT.taskId]) {
        expect(rawBody).not.toContain(plaintextValue);
      }
      const body = JSON.parse(rawBody) as { title: string; body: string };
      expect(body.title).toBe('Kangentic');
      expect(body.body).toBe('Agent needs your attention');
    });

    it('leaves a row that already fits as written', async () => {
      buildNotifier();
      notifier.notifyAutomation(ROW);
      await vi.advanceTimersByTimeAsync(0);
      expect(sealedPlaintext()).toMatchObject({ title: ROW.title, body: ROW.body });
    });
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

  it('notifyWorkflowComplete seals the workflow as the title, with no task or session, cooled down per workflow', () => {
    buildNotifier();
    notifier.notifyWorkflowComplete({ projectId: 'proj-1', workflowId: 'wf-1', title: 'Usage budgets', taskCount: 9 });
    expect(sealedCategories()).toEqual(['workflow-complete']);
    const plaintext = sealSpy.mock.calls[0][2] as { projectId: string; taskId: string; sessionId: string; taskTitle: string; detail: string };
    expect(plaintext).toMatchObject({ projectId: 'proj-1', taskId: '', sessionId: '', taskTitle: 'Usage budgets', detail: 'All 9 tasks are in Done.' });

    notifier.notifyWorkflowComplete({ projectId: 'proj-1', workflowId: 'wf-1', title: 'Usage budgets', taskCount: 9 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // Another workflow finishing in the same moment is its own push.
    notifier.notifyWorkflowComplete({ projectId: 'proj-1', workflowId: 'wf-2', title: 'Relay reconnect', taskCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((sealSpy.mock.calls[1][2] as { detail: string }).detail).toBe('Its task is in Done.');
  });

  it('sends nothing while the Mobile bridge switch is off, and reads the switch at each notification', () => {
    let bridgeEnabled = false;
    buildNotifier({ isBridgeEnabled: () => bridgeEnabled });
    notifier.notifyWorkflowComplete({ projectId: 'proj-1', workflowId: 'wf-1', title: 'Usage budgets', taskCount: 9 });
    notifier.notifyTaskStalled('task-1');
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(sealSpy).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    bridgeEnabled = true;
    notifier.notifyWorkflowComplete({ projectId: 'proj-1', workflowId: 'wf-1', title: 'Usage budgets', taskCount: 9 });
    expect(sealedCategories()).toEqual(['workflow-complete']);
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

  describe('a Command Terminal (protocol 0.20.0)', () => {
    const TERMINAL_CONTEXT = {
      projectId: 'proj-Zq1xK',
      taskId: 'made-up-uuid',
      taskTitle: 'Audit Unused Feature Flags',
      sessionKind: 'command-terminal' as const,
    };

    it('seals its name as the title and the session kind, so the tap opens the terminal', async () => {
      buildNotifier({ resolveTaskContext: () => ({ ...TERMINAL_CONTEXT }) });
      sessionManager.emit('activity', 'term-1', 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(2000);

      const sealedPlaintext = sealSpy.mock.calls[0]?.[2] as Record<string, unknown>;
      expect(sealedPlaintext).toMatchObject({
        category: 'input-required',
        sessionId: 'term-1',
        taskTitle: 'Audit Unused Feature Flags',
        sessionKind: 'command-terminal',
      });
    });

    it('a task alert carries no session kind at all', async () => {
      buildNotifier();
      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(2000);

      expect(sealSpy.mock.calls[0]?.[2]).not.toHaveProperty('sessionKind');
    });

    it('an intentional end (a Stop, or its agent exiting under C2) sends no "Session stopped"; a crash still does', () => {
      buildNotifier({ resolveTaskContext: () => ({ ...TERMINAL_CONTEXT }) });

      // Both deliberate ends reach the notifier as an intentional exit: kill()
      // marks it, and the sweep's end goes through kill() too.
      sessionManager.emit('exit', 'term-1', 0, true);
      expect(sealSpy).not.toHaveBeenCalled();

      sessionManager.emit('exit', 'term-2', 1, false);
      expect(sealedCategories()).toEqual(['session-failed']);
    });

    it('an end whose row is already gone resolves no context and sends nothing', () => {
      buildNotifier({ resolveTaskContext: () => null });

      sessionManager.emit('exit', 'term-1', 1, false);

      expect(sealSpy).not.toHaveBeenCalled();
    });
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
    expect(sessionManager.listenerCount('turn-ended')).toBe(0);
    expect(sessionManager.listenerCount('session-changed')).toBe(0);
    expect(boardEvents.listeners.size).toBe(0);
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
   * dropping title/body outright: the Notification Service Extension runs
   * only for a push that carries an alert, and the placeholder is what shows
   * when it cannot open the envelope. Stripping it would make iOS silent by
   * construction. channelId is still dropped here, mirroring the Android
   * assertion above: the two platforms differ on title/body only, so a
   * channelId reinstated inside this branch alone would otherwise leave the
   * suite green.
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

  describe('clears', () => {
    /** Must match the notifier's constants; held separately so a change to either is a decision. */
    const EXPECTED_COALESCE_MS = 5_000;
    const EXPECTED_IOS_INTERVAL_MS = 20 * 60_000;
    const PUSH_KEY = hexToBytes(REGISTRATION.pushKeyHex);
    const STATIC_KEY = new Uint8Array(32).fill(9);
    const ANDROID_CLEARS = { ...REGISTRATION, acceptsClears: true };
    const IOS_CLEARS = { ...IOS_REGISTRATION, acceptsClears: true };
    const PLACED_CONTEXT = { ...TASK_CONTEXT, swimlaneId: 'lane-1' };

    function buildClearingNotifier(overrides: Partial<PushNotifierOptions> = {}): void {
      buildNotifier({ resolveTaskContext: () => ({ ...PLACED_CONTEXT }), resolveTaskContextByTaskId: () => ({ ...PLACED_CONTEXT }), ...overrides });
    }

    function isClearBody(body: Record<string, unknown>): boolean {
      return typeof body.data === 'object' && body.data !== null && 'clear' in body.data;
    }

    function clearBodies(): Array<Record<string, unknown>> {
      return postedBodies().filter(isClearBody);
    }

    function visibleBodies(): Array<Record<string, unknown>> {
      return postedBodies().filter((body) => !isClearBody(body));
    }

    /** Opens a posted clear with the device's real keys: the entries the phone would act on. */
    function openedClears(body: Record<string, unknown>): PushClearEntry[] {
      return openPushClear(PUSH_KEY, STATIC_KEY, (body.data as { clear: string }).clear).clears;
    }

    /** The sentAt of the Nth sealed visible notification. */
    function sealedSentAt(callIndex: number): number {
      return (sealSpy.mock.calls[callIndex][2] as { sentAt: number }).sentAt;
    }

    function sealedClears(callIndex: number): PushClearEntry[] | undefined {
      return (sealSpy.mock.calls[callIndex][2] as { clears?: PushClearEntry[] }).clears;
    }

    /**
     * A WakeChannel that records every message it is handed. A test that
     * injects its own channel bypasses fetchImpl, so clearBodies() and
     * visibleBodies() would see nothing and a "no clear was sent" assertion
     * would pass by default. `respond` also gets how many visible
     * notifications have been handed over so far, this one included.
     */
    function recordingWakeChannel(respond: (message: WakeMessage, visibleSendCount: number) => Promise<WakeResult>): {
      wakeChannel: { send: (message: WakeMessage) => Promise<WakeResult> };
      sentMessages: WakeMessage[];
    } {
      const sentMessages: WakeMessage[] = [];
      let visibleSendCount = 0;
      const wakeChannel = {
        send: vi.fn((message: WakeMessage) => {
          sentMessages.push(message);
          if (message.dataKey === 'blob') visibleSendCount += 1;
          return respond(message, visibleSendCount);
        }),
      };
      return { wakeChannel, sentMessages };
    }

    /** The standalone clears among recorded messages, opened with the device's real keys. */
    function openedMessageClears(sentMessages: WakeMessage[]): PushClearEntry[][] {
      return sentMessages
        .filter((message) => message.dataKey === 'clear')
        .map((message) => openPushClear(PUSH_KEY, STATIC_KEY, message.blob).clears);
    }

    async function promptAndNotify(sessionId = 'sess-1'): Promise<void> {
      sessionManager.emit('activity', sessionId, 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(2000);
    }

    function emitRunningSession(sessionId: string, overrides: Record<string, unknown> = {}): void {
      sessionManager.emit('session-changed', sessionId, {
        id: sessionId,
        taskId: TASK_CONTEXT.taskId,
        projectId: TASK_CONTEXT.projectId,
        status: 'running',
        ...overrides,
      });
    }

    function emitTaskUpdated(taskId = TASK_CONTEXT.taskId): void {
      boardEvents.emit({ projectId: TASK_CONTEXT.projectId, change: 'task-updated', ids: [taskId] });
    }

    /** A turn the agent finished; `scope` names the task it belongs to, which defaults to TASK_CONTEXT's. */
    function emitTurnEnded(
      sessionId: string,
      turnStartedAt: number | null,
      scope: { taskId: string; projectId: string } = { taskId: TASK_CONTEXT.taskId, projectId: TASK_CONTEXT.projectId },
    ): void {
      sessionManager.emit('turn-ended', {
        sessionId,
        taskId: scope.taskId,
        projectId: scope.projectId,
        agentSessionId: null,
        isolatedSwimlaneId: null,
        turnStartedAt,
        workSerial: 1,
        transcriptAnchor: null,
      });
    }

    it('answering a prompt at the desk sends Android one data-only clear at normal priority, after the coalescing window', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      const notifiedAt = sealedSentAt(0);

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      expect(clearBodies()).toHaveLength(0); // coalescing
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      const [clearBody] = clearBodies();
      // toEqual: no title, body, channelId, mutableContent or contentAvailable key at all.
      expect(clearBody).toEqual({ to: REGISTRATION.expoPushToken, data: { clear: expect.any(String) }, priority: 'normal' });
      expect(openedClears(clearBody)).toEqual([
        { category: 'input-required', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: 'sess-1', notifiedAt },
      ]);
      // A clear is sealed like a notification: no plaintext value on the wire.
      const rawClear = JSON.stringify(clearBody);
      for (const plaintextValue of [TASK_CONTEXT.projectId, TASK_CONTEXT.taskId, 'sess-1', 'input-required']) {
        expect(rawClear).not.toContain(plaintextValue);
      }
    });

    it('sends iOS a background clear: contentAvailable, normal priority, no alert', async () => {
      listRegistrations = vi.fn(() => [IOS_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      const [clearBody] = clearBodies();
      expect(clearBody).toEqual({ to: REGISTRATION.expoPushToken, data: { clear: expect.any(String) }, priority: 'normal', contentAvailable: true });
      expect(openedClears(clearBody).map((entry) => entry.category)).toEqual(['input-required']);
    });

    it('a session leaving idle clears its turn-complete, whether it goes back to thinking or into a prompt', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await settleTurn('sess-1');
      await settleTurn('sess-2');
      expect(visibleBodies()).toHaveLength(2);
      // sess-2's prompt is answered inside its 2s debounce, so no new alert
      // goes out to carry these clears and they leave as a standalone message.
      sessionManager.getActivityStatsSnapshot.mockReturnValue({ activity: 'thinking', permissionPending: false, permissionAwaitedToolId: null });

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      sessionManager.emit('activity', 'sess-2', 'permission', { kind: 'permission' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      const cleared = clearBodies().flatMap(openedClears);
      expect(cleared.map((entry) => [entry.sessionId, entry.category])).toEqual(
        expect.arrayContaining([['sess-1', 'turn-complete'], ['sess-2', 'turn-complete']]),
      );
    });

    it('an exit clears the session\'s input-required, and the clear rides the crash alert it raises', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();

      sessionManager.emit('exit', 'sess-1', 1, false);
      expect(sealedCategories()).toEqual(['input-required', 'session-failed']);
      expect(sealedClears(1)?.map((entry) => entry.category)).toEqual(['input-required']);

      // Piggybacked and delivered, so nothing is left for a standalone clear.
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);
    });

    describe('plan-complete', () => {
      async function approvePlan(sessionId = 'sess-1'): Promise<number> {
        // The approval prompt, answered: permission, then plan-exit, then
        // the permission -> thinking edge, in that order, as the engine
        // emits them.
        sessionManager.emit('activity', sessionId, 'permission', { kind: 'permission' });
        sessionManager.emit('plan-exit', sessionId);
        sessionManager.emit('activity', sessionId, 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(0);
        return sealedSentAt(sealSpy.mock.calls.length - 1);
      }

      it('survives the thinking edge right after approval, the auto-move, and the end of the turn it was sent in', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        const notifiedAt = await approvePlan();
        expect(sealedCategories()).toEqual(['plan-complete']);

        readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-2', archived: false, lastMoveOrigin: 'auto-move' });
        emitTaskUpdated();
        emitTurnEnded('sess-1', notifiedAt - 30_000); // the planning turn, begun before the plan was approved

        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);
      });

      it('clears when a later turn ends, in the session the auto-move respawned', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        const notifiedAt = await approvePlan();

        await vi.advanceTimersByTimeAsync(10_000);
        emitTurnEnded('sess-respawned', notifiedAt + 5_000);
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        expect(clearBodies().flatMap(openedClears)).toEqual([
          { category: 'plan-complete', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: 'sess-1', notifiedAt },
        ]);
      });

      it('moves lane with the task on the auto-move, then clears on a later manual move', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await approvePlan();

        readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-2', archived: false, lastMoveOrigin: 'auto-move' });
        emitTaskUpdated();
        // Re-announced in the lane it was rebaselined to: not a move.
        emitTaskUpdated();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);

        readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-3', archived: false, lastMoveOrigin: 'renderer' });
        emitTaskUpdated();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears).map((entry) => entry.category)).toEqual(['plan-complete']);
      });

      it('a turn-ended with no known start resolves nothing', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await approvePlan();
        emitTurnEnded('sess-1', null);
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);
      });
    });

    it('a different session of the task running clears session-failed; the failed session itself, or a terminal, does not', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      sessionManager.emit('exit', 'sess-1', 1, false);
      const notifiedAt = sealedSentAt(0);

      emitRunningSession('sess-1'); // the failed session's own row, re-announced
      emitRunningSession('term-1', { transient: true }); // a Command Terminal is no session of the task
      emitRunningSession('sess-2', { status: 'queued' }); // not running yet
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);

      emitRunningSession('sess-2');
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies().flatMap(openedClears)).toEqual([
        { category: 'session-failed', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: 'sess-1', notifiedAt },
      ]);
    });

    it('a session of the task running clears spawn-stalled, whose entry names no session', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      notifier.notifyTaskStalled(TASK_CONTEXT.taskId);

      emitRunningSession('sess-1');
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      expect(clearBodies().flatMap(openedClears)).toEqual([
        { category: 'spawn-stalled', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: '', notifiedAt: sealedSentAt(0) },
      ]);
    });

    /**
     * A turn end resolves a plan-complete, and a running session resolves a
     * session-failed and a spawn-stalled, but only for the task they belong
     * to. Both comparisons are by project AND task: a task id alone is not
     * unique across projects.
     */
    it.each<[string, { taskId: string; projectId: string }]>([
      ['another task of the same project', { taskId: 'task-other', projectId: TASK_CONTEXT.projectId }],
      ['the same task id in another project', { taskId: TASK_CONTEXT.taskId, projectId: 'proj-other' }],
    ])('a turn end and a running session of %s resolve none of the task\'s notifications', async (_label, otherScope) => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      sessionManager.emit('plan-exit', 'sess-plan');
      sessionManager.emit('exit', 'sess-failed', 1, false);
      notifier.notifyTaskStalled(TASK_CONTEXT.taskId);
      await vi.advanceTimersByTimeAsync(0);
      expect(sealedCategories()).toEqual(['plan-complete', 'session-failed', 'spawn-stalled']);
      const notifiedAt = sealedSentAt(0);

      // Late enough that the time check alone would let the turn end resolve the plan-complete.
      emitTurnEnded('sess-other', notifiedAt + 5_000, otherScope);
      emitRunningSession('sess-other', otherScope);
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);

      // The same two events for the task itself do resolve all three, so the silence above is not a setup gap.
      emitTurnEnded('sess-respawned', notifiedAt + 5_000);
      emitRunningSession('sess-new');
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(
        clearBodies()
          .flatMap(openedClears)
          .map((entry) => entry.category)
          .sort(),
      ).toEqual(['plan-complete', 'session-failed', 'spawn-stalled']);
    });

    describe('board changes', () => {
      it('a task moved to another lane clears its notifications; a re-announce in the same lane does not', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await settleTurn('sess-1');
        sessionManager.emit('exit', 'sess-2', 1, false);

        emitTaskUpdated(); // still lane-1
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);

        readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-2', archived: false, lastMoveOrigin: 'renderer' });
        emitTaskUpdated();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears).map((entry) => entry.category).sort()).toEqual(['session-failed', 'turn-complete']);
      });

      it('a task archived (moved to Done) clears its notifications', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await settleTurn('sess-1');

        readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-1', archived: true, lastMoveOrigin: 'renderer' });
        emitTaskUpdated();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears).map((entry) => entry.category)).toEqual(['turn-complete']);
      });

      it('a task deleted clears its notifications, and a row gone on update reads as deleted', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await settleTurn('sess-1');
        boardEvents.emit({ projectId: TASK_CONTEXT.projectId, change: 'task-deleted', ids: [TASK_CONTEXT.taskId] });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears).map((entry) => entry.category)).toEqual(['turn-complete']);

        sessionManager.emit('exit', 'sess-2', 1, false);
        readTaskPlacement.mockReturnValue(null);
        emitTaskUpdated();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears).map((entry) => entry.category)).toEqual(['turn-complete', 'session-failed']);
      });

      it('never reads placement for a task with nothing outstanding', () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        emitTaskUpdated('some-other-task');
        emitTaskUpdated();
        expect(readTaskPlacement).not.toHaveBeenCalled();
      });

      /**
       * A Command Terminal's taskId names no task row, so its placement
       * reads as null. Treating that as "deleted" would clear the alert the
       * moment it went out; an entry with no recorded lane never takes part.
       */
      it('a Command Terminal alert, which has no lane, survives a task-updated for its id', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        const terminalContext = { projectId: TASK_CONTEXT.projectId, taskId: 'terminal-task', taskTitle: 'Audit', sessionKind: 'command-terminal' as const };
        buildClearingNotifier({ resolveTaskContext: () => ({ ...terminalContext }) });
        await promptAndNotify('term-1');

        readTaskPlacement.mockReturnValue(null);
        emitTaskUpdated('terminal-task');
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);
        expect(readTaskPlacement).not.toHaveBeenCalled();

        // Its own trigger still works, and the entry carries the kind it was sealed with.
        sessionManager.emit('activity', 'term-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies().flatMap(openedClears)).toEqual([
          expect.objectContaining({ category: 'input-required', taskId: 'terminal-task', sessionId: 'term-1', sessionKind: 'command-terminal' }),
        ]);
      });

      it('a placement read that throws never escapes into the move that announced it', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await settleTurn('sess-1');
        readTaskPlacement.mockImplementation(() => {
          throw new Error('project repos not initialized');
        });
        expect(() => emitTaskUpdated()).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
        warnSpy.mockRestore();
      });
    });

    it('coalesces resolutions inside the window into one message', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify('sess-1');
      await promptAndNotify('sess-2');

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS - 1000);
      sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(clearBodies()).toHaveLength(1);
      expect(openedClears(clearBodies()[0]).map((entry) => entry.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
    });

    describe('the 4 KB payload bound', () => {
      async function failForty(): Promise<string[]> {
        const sessionIds = Array.from({ length: 40 }, (_, index) => `session-${String(index).padStart(2, '0')}-0123456789abcdef0123`);
        for (const sessionId of sessionIds) sessionManager.emit('exit', sessionId, 1, false);
        await vi.advanceTimersByTimeAsync(0);
        emitRunningSession('session-new');
        return sessionIds;
      }

      it('Android: every message stays under 4096 bytes and all 40 entries go out, each once', async () => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        const sessionIds = await failForty();

        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS * 10);
        const bodies = fetchImpl.mock.calls.map(([, init]) => (init as { body: string }).body);
        for (const rawBody of bodies) expect(new TextEncoder().encode(rawBody).length).toBeLessThan(4096);
        const sentSessionIds = clearBodies().flatMap(openedClears).map((entry) => entry.sessionId);
        expect(clearBodies().length).toBeGreaterThan(1);
        expect(sentSessionIds.sort()).toEqual([...sessionIds].sort());
      });

      /**
       * iOS keeps entries pending after a standalone clear, so its picker
       * must take never-sent entries first. Newest-first alone would resend
       * the same newest batch every 20 minutes and never reach the rest.
       */
      it('iOS: under 4096 bytes, and every entry is sent once before any is sent again', async () => {
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier();
        const sessionIds = await failForty();

        const seen: string[] = [];
        for (let flush = 0; flush < 6 && new Set(seen).size < sessionIds.length; flush += 1) {
          await vi.advanceTimersByTimeAsync(flush === 0 ? EXPECTED_COALESCE_MS : EXPECTED_IOS_INTERVAL_MS);
          const latest = clearBodies().at(-1);
          if (!latest) continue;
          expect(new TextEncoder().encode(JSON.stringify(latest)).length).toBeLessThan(4096);
          const batch = openedClears(latest).map((entry) => entry.sessionId);
          const firstPassIncomplete = new Set(seen).size < sessionIds.length;
          const freshInBatch = batch.filter((sessionId) => !seen.includes(sessionId));
          if (firstPassIncomplete) expect(freshInBatch.length).toBeGreaterThan(0);
          seen.push(...batch);
        }
        expect(new Set(seen)).toEqual(new Set(sessionIds));
      });

      /**
       * Expo's 4096 byte cap covers the whole payload, and a visible alert
       * spends part of it on its own fields. The pick that rides it is
       * therefore measured against the alert's plaintext, not against a bare
       * clear, and what does not fit waits for a standalone clear.
       */
      it('a visible alert carries only as many pending clears as fit, and still goes out', async () => {
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        // The real seal, so the posted size is the real one; the spy still records each plaintext.
        sealSpy = vi.fn(sealPushEnvelope);
        buildClearingNotifier();
        const sessionIds = await failForty(); // all 40 are pending now, and their 5s flush is not yet due
        const alertsBefore = visibleBodies().length;

        sessionManager.emit('exit', 'session-visible', 1, false);

        const alerts = visibleBodies();
        expect(alerts).toHaveLength(alertsBefore + 1); // the alert itself still went out
        const rawAlert = (fetchImpl.mock.calls.at(-1)?.[1] as { body: string }).body;
        expect(new TextEncoder().encode(rawAlert).length).toBeLessThan(4096);
        const opened = openPushEnvelope(PUSH_KEY, STATIC_KEY, (alerts[alertsBefore].data as { blob: string }).blob);
        expect(opened.category).toBe('session-failed');
        expect(opened.sessionId).toBe('session-visible');
        const carriedSessionIds = (opened.clears ?? []).map((entry) => entry.sessionId);
        expect(carriedSessionIds.length).toBeGreaterThan(0);
        expect(carriedSessionIds.length).toBeLessThan(sessionIds.length); // a strict subset: the rest wait
        for (const carriedSessionId of carriedSessionIds) expect(sessionIds).toContain(carriedSessionId);
        expect(new Set(carriedSessionIds).size).toBe(carriedSessionIds.length);

        // The alert is delivered, so what it carried is done; the leftovers go out on their own.
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        const standaloneSessionIds = clearBodies().flatMap(openedClears).map((entry) => entry.sessionId);
        expect(standaloneSessionIds.length).toBeGreaterThan(0);
        for (const carriedSessionId of carriedSessionIds) expect(standaloneSessionIds).not.toContain(carriedSessionId);
      });
    });

    it('a device that never set acceptsClears gets no clear and no piggyback', async () => {
      listRegistrations = vi.fn(() => [REGISTRATION]);
      buildClearingNotifier();
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);

      sessionManager.emit('exit', 'sess-1', 1, false);
      expect(sealedClears(1)).toBeUndefined();
    });

    it('a device connected at the moment of resolution is skipped, and nothing is owed to it later', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();

      fakeSessions.set('device-1', { connectionState: 'connected' });
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      fakeSessions.set('device-1', { connectionState: 'offline' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);

      sessionManager.emit('exit', 'sess-2', 1, false);
      expect(sealedClears(1)).toBeUndefined();
    });

    it('a device that connects before the flush gets nothing; the app reconciles it', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      fakeSessions.set('device-1', { connectionState: 'connected' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);
    });

    it('sends nothing when the Mobile bridge switch is off at flush time', async () => {
      let bridgeEnabled = true;
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier({ isBridgeEnabled: () => bridgeEnabled });
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      bridgeEnabled = false;
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);
    });

    /**
     * Everything the flush needs is read again when its timer fires, not when
     * the clear was queued. These pin what it does when one of those reads has
     * changed in the 5s between.
     */
    describe('flush-time guards', () => {
      /**
       * A device that is gone, or re-registered without acceptsClears (an
       * older app), is owed nothing, and the ledger forgets everything it held
       * for it: restoring the registration afterwards must not revive a clear
       * for a notification the ledger already let go.
       */
      it.each<[string, Array<typeof ANDROID_CLEARS | typeof REGISTRATION>]>([
        ['is gone', []],
        ['no longer accepts clears', [REGISTRATION]],
      ])('a registration that %s at flush time gets no clear, and its entries are not revived', async (_reason, registrationsAtFlush) => {
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        await promptAndNotify('sess-1');
        await promptAndNotify('sess-2');
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' }); // sess-1 queued, sess-2 still outstanding

        listRegistrations.mockReturnValue(registrationsAtFlush);
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0);

        // The device registers again, taking clears, and sess-2's prompt is answered.
        listRegistrations.mockReturnValue([ANDROID_CLEARS]);
        sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(0); // sess-2 went with the device

        sessionManager.emit('exit', 'sess-3', 1, false);
        expect(sealedClears(2)).toBeUndefined(); // and so did the clear queued for sess-1
      });

      it('a device whose roster key is gone at flush time gets no clear', async () => {
        // An injected sealClear that does not throw: the real one may reject a null key
        // itself, which would hide a missing guard behind the seal failure path.
        const sealClear = vi.fn((): string => 'sealed-clear');
        let deviceStaticPublicKey: Uint8Array | null = STATIC_KEY;
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier({ sealClear, getDeviceStaticPublicKey: () => deviceStaticPublicKey });
        await promptAndNotify();
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });

        deviceStaticPublicKey = null;
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        expect(sealClear).not.toHaveBeenCalled();
        expect(clearBodies()).toHaveLength(0);
      });

      it('a clear that cannot be sealed sends nothing, throws out of no timer, and is not retried', async () => {
        const sealClear = vi.fn((): string => {
          throw new Error('malformed push key');
        });
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier({ sealClear });
        await promptAndNotify();
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });

        // A throw inside the flush timer would reject this advance and fail the test.
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(sealClear).toHaveBeenCalledTimes(1);
        expect(clearBodies()).toHaveLength(0);

        // The entry was dropped, not kept for the next alert or the next flush.
        sessionManager.emit('exit', 'sess-2', 1, false);
        expect(sealedClears(1)).toBeUndefined();
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS * 10);
        expect(sealClear).toHaveBeenCalledTimes(1);
        expect(clearBodies()).toHaveLength(0);
      });
    });

    /**
     * The notifiedAt bound: each clear names the newest notification it
     * covers, so a phone can keep an alert sent after it. A second prompt
     * on the same session is its own outstanding notification, cleared by
     * its own later resolution.
     */
    it('each clear carries the sentAt of the newest notification it covers', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      const firstSentAt = sealedSentAt(0);
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      await vi.advanceTimersByTimeAsync(30_000); // past the category cooldown
      await promptAndNotify();
      const secondSentAt = sealedSentAt(1);
      expect(secondSentAt).toBeGreaterThan(firstSentAt);
      expect(sealedClears(1)).toBeUndefined(); // Android's first clear was accepted, so nothing was left to ride
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      expect(clearBodies().map((body) => openedClears(body).map((entry) => entry.notifiedAt))).toEqual([[firstSentAt], [secondSentAt]]);
    });

    it('a resolution that lands while the notification is still in flight still owes its clear', async () => {
      const sentMessages: WakeMessage[] = [];
      let resolveVisibleSend: (result: WakeResult) => void = () => {};
      const wakeChannel = {
        send: vi.fn((message: WakeMessage) => {
          sentMessages.push(message);
          if (message.dataKey === 'blob') return new Promise<WakeResult>((resolve) => { resolveVisibleSend = resolve; });
          return Promise.resolve<WakeResult>({ delivered: true });
        }),
      };
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier({ wakeChannel });
      await promptAndNotify();

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' }); // answered mid-POST
      resolveVisibleSend({ delivered: true });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

      expect(sentMessages.map((message) => message.dataKey)).toEqual(['blob', 'clear']);
    });

    it('a notification that failed to send is not recorded, so its resolution sends nothing', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      await vi.advanceTimersByTimeAsync(0);

      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);
      warnSpy.mockRestore();
    });

    describe('a visible send that does not deliver', () => {
      /** The send throws instead of reporting a failed result: the other way deliver() takes a notification back. */
      it('a send that throws is forgotten too, so resolving it sends no clear', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { wakeChannel, sentMessages } = recordingWakeChannel(() => Promise.reject(new Error('socket reset')));
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier({ wakeChannel });
        await promptAndNotify();
        await vi.advanceTimersByTimeAsync(0); // let the rejection settle and take its record back
        expect(warnSpy.mock.calls.map((call) => call.join(' ')).join('\n')).toContain('socket reset');

        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        expect(sentMessages.map((message) => message.dataKey)).toEqual(['blob']);
        warnSpy.mockRestore();
      });

      /**
       * Expo's DeviceNotRegistered drops the registration and everything owed
       * to it. The fake store's list() ignores remove(), so removeRegistration
       * is wired to empty it, and the device then registers again with the
       * same id: nothing the ledger held before survives into the new one.
       */
      it('after Expo reports the device unregistered, a registration added back is owed no stale clear and rides no stale piggyback', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let registrations: Array<typeof ANDROID_CLEARS> = [ANDROID_CLEARS];
        listRegistrations = vi.fn(() => registrations);
        removeRegistration.mockImplementation(() => {
          registrations = [];
        });
        let visibleSendCount = 0;
        fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
          const isClear = (JSON.parse(init.body) as { data: Record<string, unknown> }).data.clear !== undefined;
          if (!isClear) visibleSendCount += 1;
          const unregistered = !isClear && visibleSendCount === 2; // Expo refuses the second alert
          return {
            ok: true,
            status: 200,
            json: async () => ({ data: unregistered ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' } }),
          };
        });
        buildClearingNotifier();
        await promptAndNotify('sess-0');
        sessionManager.emit('activity', 'sess-0', 'thinking', { kind: 'turn-active' }); // sess-0 is queued, its 5s flush not yet due
        await promptAndNotify('sess-1'); // the alert Expo refuses, carrying sess-0's clear
        await vi.advanceTimersByTimeAsync(0);
        expect(sealedClears(1)?.map((entry) => entry.sessionId)).toEqual(['sess-0']);
        expect(removeRegistration).toHaveBeenCalledWith('device-1');

        registrations = [ANDROID_CLEARS]; // the device registers again
        sessionManager.emit('exit', 'sess-2', 1, false);
        expect(sealedClears(2)).toBeUndefined(); // sess-0's clear was dropped with the device

        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' }); // the refused alert's prompt is answered
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS * 2);
        expect(clearBodies()).toHaveLength(0); // neither sess-0's queued clear nor sess-1's record came back
        warnSpy.mockRestore();
      });
    });

    describe('a resend that fails', () => {
      /**
       * A new send under a key replaces the record the last one left, and a
       * failure takes only the new record back. The older notification is
       * still on the phone, so it is still owed its clear, and naming it
       * must not depend on the resend having worked.
       */
      it('spawn-stalled: a failed second send leaves the first one owed its clear', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        fetchImpl = vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) })
          .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
          .mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) });
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier();
        notifier.notifyTaskStalled(TASK_CONTEXT.taskId);
        await vi.advanceTimersByTimeAsync(30_000); // delivered, then past the category cooldown
        notifier.notifyTaskStalled(TASK_CONTEXT.taskId); // the same key again; this send fails
        await vi.advanceTimersByTimeAsync(0);
        expect(sealSpy).toHaveBeenCalledTimes(2); // the resend was really attempted
        expect(sealedSentAt(1)).toBeGreaterThan(sealedSentAt(0));

        emitRunningSession('sess-1');
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        expect(clearBodies().flatMap(openedClears)).toEqual([
          { category: 'spawn-stalled', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: '', notifiedAt: sealedSentAt(0) },
        ]);
        warnSpy.mockRestore();
      });

      it('plan-complete: a send that throws leaves the first one owed the clear a later turn brings', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { wakeChannel, sentMessages } = recordingWakeChannel((message, visibleSendCount) =>
          message.dataKey === 'blob' && visibleSendCount === 2
            ? Promise.reject(new Error('socket reset'))
            : Promise.resolve<WakeResult>({ delivered: true }),
        );
        listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
        buildClearingNotifier({ wakeChannel });
        sessionManager.emit('plan-exit', 'sess-1');
        await vi.advanceTimersByTimeAsync(30_000); // delivered, then past the category cooldown
        sessionManager.emit('plan-exit', 'sess-1'); // the same key again; this send throws
        await vi.advanceTimersByTimeAsync(0);
        expect(sealSpy).toHaveBeenCalledTimes(2); // the resend was really attempted
        const firstSentAt = sealedSentAt(0);
        expect(sealedSentAt(1)).toBeGreaterThan(firstSentAt);

        // A turn that began after the first plan-complete and before the second: it ends the first only.
        emitTurnEnded('sess-1', firstSentAt + 5_000);
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        expect(openedMessageClears(sentMessages)).toEqual([
          [{ category: 'plan-complete', projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, sessionId: 'sess-1', notifiedAt: firstSentAt }],
        ]);
        warnSpy.mockRestore();
      });
    });

    describe('iOS', () => {
      it('keeps a clear pending after the background push, piggybacks it on the next alert, then lets it go', async () => {
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier();
        await promptAndNotify();
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(1);

        sessionManager.emit('exit', 'sess-2', 1, false);
        expect(sealedClears(1)?.map((entry) => [entry.sessionId, entry.category])).toEqual([['sess-1', 'input-required']]);
        await vi.advanceTimersByTimeAsync(0); // the alert is delivered

        sessionManager.emit('exit', 'sess-3', 1, false);
        expect(sealedClears(2)).toBeUndefined();
      });

      it('sends at most one background clear per 20 minutes; the next carries what gathered meanwhile', async () => {
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier();
        await promptAndNotify('sess-1');
        await promptAndNotify('sess-2');
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(1);

        // The first background clear went out at the end of the advance above, so the window runs from now.
        sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_IOS_INTERVAL_MS - 1000);
        expect(clearBodies()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1000);
        expect(clearBodies()).toHaveLength(2);
        // sess-1's entry is still pending (iOS cannot confirm it), so it rides along after the new one.
        expect(openedClears(clearBodies()[1]).map((entry) => entry.sessionId)).toEqual(['sess-2', 'sess-1']);
      });

      /**
       * A background clear Expo refused never reached Apple, so it must not
       * spend the device's 20 minutes: the next resolution goes out after
       * the ordinary coalescing window, carrying the refused entry too.
       */
      it('a background clear Expo refused does not spend the 20 minute window', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let refuseClears = true;
        fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
          const isClear = (JSON.parse(init.body) as { data: Record<string, unknown> }).data.clear !== undefined;
          return isClear && refuseClears
            ? { ok: false, status: 503, json: async () => ({}) }
            : { ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) };
        });
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier();
        await promptAndNotify('sess-1');
        await promptAndNotify('sess-2');
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(1); // refused

        refuseClears = false;
        sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(clearBodies()).toHaveLength(2);
        expect(openedClears(clearBodies()[1]).map((entry) => entry.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
        warnSpy.mockRestore();
      });

      /** The same release as above, reached through a send that throws rather than one Expo answers with a failure. */
      it('a background clear whose send throws does not spend the 20 minute window either', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        let throwOnClear = true;
        const { wakeChannel, sentMessages } = recordingWakeChannel((message) =>
          message.dataKey === 'clear' && throwOnClear
            ? Promise.reject(new Error('socket reset'))
            : Promise.resolve<WakeResult>({ delivered: true }),
        );
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier({ wakeChannel });
        await promptAndNotify('sess-1');
        await promptAndNotify('sess-2');
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
        expect(sentMessages.filter((message) => message.dataKey === 'clear')).toHaveLength(1); // threw
        await vi.advanceTimersByTimeAsync(0); // let the rejection settle and release the stamp

        throwOnClear = false;
        sessionManager.emit('activity', 'sess-2', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        const openedBatches = openedMessageClears(sentMessages);
        expect(openedBatches).toHaveLength(2); // the second went out after the ordinary window, not 20 minutes on
        expect(openedBatches[1].map((entry) => entry.sessionId).sort()).toEqual(['sess-1', 'sess-2']);
        warnSpy.mockRestore();
      });

      it('drops a pending clear after 24 hours', async () => {
        listRegistrations = vi.fn(() => [IOS_CLEARS]);
        buildClearingNotifier();
        await promptAndNotify();
        sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
        await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);

        await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
        sessionManager.emit('exit', 'sess-2', 1, false);
        expect(sealedClears(1)).toBeUndefined();
      });
    });

    it('Android: a failed clear stays pending and rides the next alert', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
        const failed = (JSON.parse(init.body) as { data: Record<string, unknown> }).data.clear !== undefined;
        return failed ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) };
      });
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();

      sessionManager.emit('exit', 'sess-2', 1, false);
      expect(sealedClears(1)?.map((entry) => entry.sessionId)).toEqual(['sess-1']);
      warnSpy.mockRestore();
    });

    it('a clear that Expo reports DeviceNotRegistered drops the registration', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
        const isClear = (JSON.parse(init.body) as { data: Record<string, unknown> }).data.clear !== undefined;
        return isClear
          ? { ok: true, status: 200, json: async () => ({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }) }
          : { ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) };
      });
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(removeRegistration).toHaveBeenCalledWith('device-1');
      warnSpy.mockRestore();
    });

    it('a Notify me push is never recorded, so the move that sent it does not clear it', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      // An exit row fires as the task leaves its lane: the move's own event follows.
      notifier.notifyAutomation({ projectId: TASK_CONTEXT.projectId, taskId: TASK_CONTEXT.taskId, taskTitle: TASK_CONTEXT.taskTitle, title: 'Left Review', body: 'Executing' });
      readTaskPlacement.mockReturnValue({ swimlaneId: 'lane-2', archived: false, lastMoveOrigin: 'renderer' });
      emitTaskUpdated();
      boardEvents.emit({ projectId: TASK_CONTEXT.projectId, change: 'task-deleted', ids: [TASK_CONTEXT.taskId] });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(visibleBodies()).toHaveLength(1);
      expect(clearBodies()).toHaveLength(0);
    });

    it('workflow-complete is never recorded, so nothing ever clears it', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      notifier.notifyWorkflowComplete({ projectId: TASK_CONTEXT.projectId, workflowId: 'wf-1', title: 'Usage budgets', taskCount: 2 });
      boardEvents.emit({ projectId: TASK_CONTEXT.projectId, change: 'task-deleted', ids: [''] });
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS);
      expect(clearBodies()).toHaveLength(0);
    });

    it('dispose kills a pending flush', async () => {
      listRegistrations = vi.fn(() => [ANDROID_CLEARS]);
      buildClearingNotifier();
      await promptAndNotify();
      sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
      notifier.dispose();
      await vi.advanceTimersByTimeAsync(EXPECTED_COALESCE_MS * 2);
      expect(clearBodies()).toHaveLength(0);
    });
  });
});

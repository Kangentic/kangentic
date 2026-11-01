/**
 * A session hidden until adopted (#955): an agent launched while its task's
 * worktree runs its setup script, which nothing but its own teardown may see
 * until the task's spawn adopts it (`SessionManager.adoptSession`).
 *
 * Pins, against a real SessionManager with registry rows seeded directly:
 *   - no listener sees its events except the raw output signals, and its exit
 *     reaches `awaitExit` alone;
 *   - it is not listed, not the task's live session, and not writable, so a
 *     held-message flush, an MCP send or a phone cannot type into it;
 *   - adopting it announces it once, after which it is an ordinary session;
 *   - every cache a renderer or phone syncs from leaves it out, while a visible
 *     session seeded the same way stays in;
 *   - the idle sweep skips it;
 *   - adoption re-announces what the hidden launch held back (activity, usage,
 *     first output), and the waits on it (`awaitAgentReady`, `awaitAltScreen`)
 *     end on the right event, not on their timeout;
 *   - its removal clears the mark.
 *
 * Modelled on session-manager-remove-emit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';

const TASK_ID = 'task-hidden';
const PROJECT_ID = 'project-hidden';
const HIDDEN_ID = 'sess-hidden';
const VISIBLE_ID = 'sess-visible';
const OTHER_ID = 'sess-other';

/** The slice of the telemetry's private callbacks the idle sweep calls (the interface is not exported). */
interface IdleSweepCallbacks {
  isIdleTimeoutExempt?: (sessionId: string) => boolean;
  onIdleTimeout: (sessionId: string) => void;
  requestSuspend: (sessionId: string) => void;
}

/**
 * Every surface that hands session ids to a reader outside main, as the ids it
 * lists. A hidden session must be absent from each, a visible one present.
 */
const ID_READERS: ReadonlyArray<readonly [string, (target: SessionManager) => string[]]> = [
  ['getUsageCache', (target) => Object.keys(target.getUsageCache())],
  ['getActivityCache', (target) => Object.keys(target.getActivityCache())],
  ['getActivityReasonsCache', (target) => Object.keys(target.getActivityReasonsCache())],
  ['getEventsCache', (target) => Object.keys(target.getEventsCache())],
  ['getFirstOutputCache', (target) => Object.keys(target.getFirstOutputCache())],
  ['getUsageCacheForProject', (target) => Object.keys(target.getUsageCacheForProject(PROJECT_ID))],
  ['getActivityCacheForProject', (target) => Object.keys(target.getActivityCacheForProject(PROJECT_ID))],
  ['getActivityReasonsCacheForProject', (target) => Object.keys(target.getActivityReasonsCacheForProject(PROJECT_ID))],
  ['getEventsCacheForProject', (target) => Object.keys(target.getEventsCacheForProject(PROJECT_ID))],
  ['listManagedSummaries', (target) => target.listManagedSummaries().map((summary) => summary.id)],
];

/**
 * Race `promise` against a short sentinel so a wait that an event should have
 * ended fails in about a second, not on vitest's 5 s timeout, and so "still
 * pending" is something a test can assert on. Real timers throughout.
 */
function settlesWithin<Value>(promise: Promise<Value>, milliseconds: number): Promise<Value | 'still pending'> {
  return Promise.race([
    promise,
    new Promise<'still pending'>((resolve) => setTimeout(() => resolve('still pending'), milliseconds)),
  ]);
}

describe('SessionManager: a session hidden until adopted', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  function seedRow(id: string, withPty: boolean): void {
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    registry.set(id, {
      id,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      pty: withPty ? ({ sealUserInput: vi.fn() } as unknown as ManagedSession['pty']) : null,
      status: 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: new Date().toISOString(),
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
  }

  function hide(id: string): void {
    (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add(id);
  }

  it('keeps its events from listeners, but its raw output signal still passes', () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const seen: string[] = [];
    for (const eventName of ['session-changed', 'activity', 'usage', 'event', 'first-output', 'exit', 'output-seen']) {
      manager.on(eventName, () => seen.push(eventName));
    }

    manager.emit('session-changed', HIDDEN_ID, {});
    manager.emit('activity', HIDDEN_ID, 'idle', null);
    manager.emit('usage', HIDDEN_ID, {});
    manager.emit('event', HIDDEN_ID, {});
    manager.emit('first-output', HIDDEN_ID);
    manager.emit('exit', HIDDEN_ID, 0, true);
    manager.emit('output-seen', HIDDEN_ID);

    expect(seen).toEqual(['output-seen']);
  });

  it('its exit still ends an awaitExit, which a discard waits on', async () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const exited = manager.awaitExit(HIDDEN_ID);

    manager.emit('exit', HIDDEN_ID, 0, true);

    await expect(exited).resolves.toBeUndefined();
  });

  it('is not listed, not the task live session, not writable, and not in the caches a renderer syncs from', () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);

    expect(manager.listSessions().map((session) => session.id)).not.toContain(HIDDEN_ID);
    expect(manager.findLiveSessionByTaskId(TASK_ID)).toBeUndefined();
    expect(manager.isWritable(HIDDEN_ID)).toBe(false);
    expect(Object.keys(manager.getActivityCache())).not.toContain(HIDDEN_ID);
    expect(Object.keys(manager.getFirstOutputCache())).not.toContain(HIDDEN_ID);
    expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(true);
  });

  it('adopting it announces it once and makes it the task session', () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const announced: string[] = [];
    manager.on('session-changed', (sessionId: string) => announced.push(sessionId));

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    expect(announced).toEqual([HIDDEN_ID]);
    expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
    expect(manager.findLiveSessionByTaskId(TASK_ID)?.id).toBe(HIDDEN_ID);
    expect(manager.isWritable(HIDDEN_ID)).toBe(true);
    expect(manager.listSessions().map((session) => session.id)).toContain(HIDDEN_ID);
  });

  it('refuses to adopt a session that is not hidden, or that has no PTY left', () => {
    seedRow('sess-visible', true);
    expect(manager.adoptSession('sess-visible')).toBe(false);

    seedRow('sess-dead', false);
    hide('sess-dead');
    expect(manager.adoptSession('sess-dead')).toBe(false);
    expect(manager.isHiddenUntilAdopted('sess-dead')).toBe(true);
  });

  it('awaitAltScreen answers from the alt-screen mirror, and false once its time is up', async () => {
    seedRow(HIDDEN_ID, true);
    const altScreen = (manager as unknown as { inAltScreen: Map<string, boolean> }).inAltScreen;

    // A screen drawn before the TUI's alternate screen (an MCP server approval) is not the input box.
    await expect(manager.awaitAltScreen(HIDDEN_ID, 0)).resolves.toBe(false);

    const waiting = manager.awaitAltScreen(HIDDEN_ID, 5_000);
    altScreen.set(HIDDEN_ID, true);
    await expect(waiting).resolves.toBe(true);
    await expect(manager.awaitAltScreen(HIDDEN_ID, 0)).resolves.toBe(true);
  });

  it('awaitAltScreen gives up at once when its caller is aborted, since the caller holds the task lock', async () => {
    seedRow(HIDDEN_ID, true);
    const controller = new AbortController();

    const waiting = manager.awaitAltScreen(HIDDEN_ID, 60_000, controller.signal);
    controller.abort();

    await expect(waiting).resolves.toBe(false);
  });

  it('awaitInputReady waits for the alternate screen only for an agent that draws its input box there', async () => {
    seedRow(HIDDEN_ID, true);
    seedRow('sess-classic', true);
    (manager as unknown as { inputInAlternateScreen: Set<string> }).inputInAlternateScreen.add(HIDDEN_ID);
    const altScreen = (manager as unknown as { inAltScreen: Map<string, boolean> }).inAltScreen;

    // Nothing tells a classic renderer's input box apart, so it is not held.
    await expect(manager.awaitInputReady('sess-classic', 0)).resolves.toBe(true);
    // A screen shown before the alternate screen is not the input box.
    await expect(manager.awaitInputReady(HIDDEN_ID, 0)).resolves.toBe(false);
    altScreen.set(HIDDEN_ID, true);
    await expect(manager.awaitInputReady(HIDDEN_ID, 0)).resolves.toBe(true);
  });

  it('awaitInputReady holds a queued session through its promotion instead of reading it as gone', async () => {
    seedRow('sess-queued', false);
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    const row = registry.get('sess-queued') as ManagedSession;
    row.status = 'queued';
    (manager as unknown as { inputInAlternateScreen: Set<string> }).inputInAlternateScreen.add('sess-queued');
    const altScreen = (manager as unknown as { inAltScreen: Map<string, boolean> }).inAltScreen;

    const waiting = manager.awaitInputReady('sess-queued', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 150));
    // Promoted: a PTY, running, then its TUI enters the alternate screen.
    row.status = 'running';
    row.pty = { sealUserInput: vi.fn() } as unknown as ManagedSession['pty'];
    altScreen.set('sess-queued', true);

    // Red: without the queued wait it resolved false at once (no PTY yet).
    await expect(waiting).resolves.toBe(true);
  });

  it('a removal tells no listener, and the exit that lands after it stays hidden, then clears the mark', async () => {
    // A killed row: its PTY is gone, its exit is still on its way.
    seedRow(HIDDEN_ID, false);
    hide(HIDDEN_ID);
    const removed: string[] = [];
    const exits: string[] = [];
    manager.on('session-removed', (sessionId: string) => removed.push(sessionId));
    manager.on('exit', (sessionId: string) => exits.push(sessionId));
    const exited = manager.awaitExit(HIDDEN_ID);

    manager.remove(HIDDEN_ID);

    expect(removed).toEqual([]);
    expect(manager.getSession(HIDDEN_ID)).toBeUndefined();
    // Red: clearing the mark in remove() sent this exit to every listener.
    expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(true);

    manager.emit('exit', HIDDEN_ID, 0, true);

    expect(exits).toEqual([]);
    await expect(exited).resolves.toBeUndefined();
    expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
  });

  it('a removal of a row that already exited clears the mark at once', () => {
    seedRow(HIDDEN_ID, false);
    hide(HIDDEN_ID);
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    (registry.get(HIDDEN_ID) as ManagedSession).status = 'exited';

    manager.remove(HIDDEN_ID);

    expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
  });

  // ---- Helpers for the cache, sweep, adoption and wait tests below ----

  function getTelemetry(): SessionTelemetry {
    return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
  }

  /** Record that the session's agent is on screen, without emitting `first-output`. */
  function markFirstOutput(id: string): void {
    const tracker = (manager as unknown as { firstOutputTracker: { markEmitted(sessionId: string): boolean } }).firstOutputTracker;
    tracker.markEmitted(id);
  }

  /** Give the session an activity, a reason, a usage entry and a cached event, through the telemetry's own API. */
  function seedTelemetry(id: string): void {
    const telemetry = getTelemetry();
    telemetry.initSession(id);
    telemetry.setSessionUsage(id, {});
    telemetry.ingestEvents(id, [{ ts: Date.now(), type: EventType.Prompt }]);
  }

  /** Every announcement adoption makes, in the order the listeners hear it. */
  function recordAnnouncements(): Array<{ eventName: string; args: unknown[] }> {
    const announcements: Array<{ eventName: string; args: unknown[] }> = [];
    for (const eventName of ['session-changed', 'activity', 'usage', 'first-output']) {
      manager.on(eventName, (...args: unknown[]) => announcements.push({ eventName, args }));
    }
    return announcements;
  }

  /** A hidden session whose launch already produced an idle activity, a usage entry and its first output. */
  function seedHiddenSessionWithTelemetry(): void {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const telemetry = getTelemetry();
    telemetry.initSession(HIDDEN_ID);
    telemetry.setSessionUsage(HIDDEN_ID, {});
    markFirstOutput(HIDDEN_ID);
  }

  // ---- Caches and listings ----

  it.each(ID_READERS)('%s leaves a hidden session out and keeps a visible one', (_surface, readIds) => {
    seedRow(VISIBLE_ID, true);
    seedRow(HIDDEN_ID, true);
    for (const id of [VISIBLE_ID, HIDDEN_ID]) {
      seedTelemetry(id);
      markFirstOutput(id);
    }

    // Both sessions are in the source of truth first, so the filter alone can
    // account for the hidden one's absence below.
    expect(readIds(manager)).toEqual(expect.arrayContaining([VISIBLE_ID, HIDDEN_ID]));

    hide(HIDDEN_ID);

    const ids = readIds(manager);
    expect(ids).toContain(VISIBLE_ID);
    expect(ids).not.toContain(HIDDEN_ID);
  });

  // ---- Idle sweep ----

  it('exempts a hidden session from the idle sweep, and leaves a visible task session subject to it', () => {
    seedRow(HIDDEN_ID, true);
    seedRow(VISIBLE_ID, true);
    hide(HIDDEN_ID);
    const callbacks = (getTelemetry() as unknown as { callbacks: IdleSweepCallbacks }).callbacks;

    // The hidden row is a plain task row (not transient), so only the hidden
    // mark can make this true: the Command Terminal arm answers false for it.
    expect(callbacks.isIdleTimeoutExempt?.(HIDDEN_ID)).toBe(true);
    expect(callbacks.isIdleTimeoutExempt?.(VISIBLE_ID)).toBe(false);
    expect(callbacks.isIdleTimeoutExempt?.('sess-unknown')).toBe(false);
  });

  it('the idle sweep reports a visible idle session and never a hidden one', () => {
    seedRow(VISIBLE_ID, true);
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const telemetry = getTelemetry();
    telemetry.initSession(VISIBLE_ID);
    telemetry.initSession(HIDDEN_ID);
    const callbacks = (telemetry as unknown as { callbacks: IdleSweepCallbacks }).callbacks;
    const reported = vi.spyOn(callbacks, 'onIdleTimeout').mockImplementation(() => undefined);
    vi.spyOn(callbacks, 'requestSuspend').mockImplementation(() => undefined);
    // Ten minutes on from the idle seed, against a one minute limit.
    const clockSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);

    try {
      telemetry.setIdleTimeout(1);
      (telemetry as unknown as { checkIdleTimeouts(): void }).checkIdleTimeouts();
    } finally {
      telemetry.setIdleTimeout(0);
      clockSpy.mockRestore();
    }

    expect(reported.mock.calls.map(([sessionId]) => sessionId)).toEqual([VISIBLE_ID]);
  });

  // ---- Adoption ----

  it('adopting a session re-announces its status, activity, usage and first output, in that order', () => {
    seedHiddenSessionWithTelemetry();
    const telemetry = getTelemetry();
    // The idle clock could not be restarted, so adoption pushes the cached activity itself.
    vi.spyOn(telemetry, 'restartIdleClock').mockReturnValue(false);
    const announcements = recordAnnouncements();

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    expect(announcements.map((announcement) => announcement.eventName)).toEqual([
      'session-changed',
      'activity',
      'usage',
      'first-output',
    ]);
    const [sessionChanged, activity, usage, firstOutput] = announcements;
    expect(sessionChanged.args[0]).toBe(HIDDEN_ID);
    expect(sessionChanged.args[1]).toMatchObject({ id: HIDDEN_ID, taskId: TASK_ID, status: 'running' });
    expect(activity.args[0]).toBe(HIDDEN_ID);
    expect(activity.args[1]).toBe('idle');
    expect(activity.args[2]).toEqual(telemetry.getActivityReason(HIDDEN_ID));
    expect(activity.args[2]).toMatchObject({ kind: 'idle' });
    expect(usage.args[0]).toBe(HIDDEN_ID);
    expect(usage.args[1]).toBe(telemetry.getUsageCache()[HIDDEN_ID]);
    expect(firstOutput.args).toEqual([HIDDEN_ID]);
  });

  it('adopting a session whose idle clock restarts adds no second activity announcement', () => {
    seedHiddenSessionWithTelemetry();
    const telemetry = getTelemetry();
    // Stubbed, so the engine pushes nothing itself: any `activity` heard below came from the fallback.
    const restartSpy = vi.spyOn(telemetry, 'restartIdleClock').mockReturnValue(true);
    const announcements = recordAnnouncements();

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    expect(restartSpy).toHaveBeenCalledWith(HIDDEN_ID);
    expect(announcements.map((announcement) => announcement.eventName)).toEqual([
      'session-changed',
      'usage',
      'first-output',
    ]);
  });

  it('adopting an idle session announces its restarted idle clock exactly once', () => {
    seedHiddenSessionWithTelemetry();
    const announcements = recordAnnouncements();

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    // The real engine pushes the restamped reason itself and reports success,
    // so the fallback must stay out of it.
    expect(announcements.map((announcement) => announcement.eventName)).toEqual([
      'session-changed',
      'activity',
      'usage',
      'first-output',
    ]);
    expect(announcements[1].args[2]).toMatchObject({ kind: 'idle' });
  });

  it('adopting a session with nothing cached announces only its status', () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const announcements = recordAnnouncements();

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    expect(announcements.map((announcement) => announcement.eventName)).toEqual(['session-changed']);
  });

  // ---- awaitAgentReady ----

  it('awaitAgentReady is true at once for an agent already on screen', async () => {
    seedRow(VISIBLE_ID, true);
    markFirstOutput(VISIBLE_ID);
    const listenersBefore = manager.listenerCount('first-output');

    await expect(settlesWithin(manager.awaitAgentReady(VISIBLE_ID, 60_000), 1_000)).resolves.toBe(true);

    expect(manager.listenerCount('first-output')).toBe(listenersBefore);
  });

  it('awaitAgentReady ends true on a later first-output of its own session, not of another', async () => {
    seedRow(VISIBLE_ID, true);
    const waiting = manager.awaitAgentReady(VISIBLE_ID, 60_000);

    manager.emit('first-output', OTHER_ID);
    await expect(settlesWithin(waiting, 25)).resolves.toBe('still pending');

    manager.emit('first-output', VISIBLE_ID);
    // True can only come from the event: the 60 s ceiling is far off, and no first output was recorded.
    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(true);
  });

  it('awaitAgentReady ends false when its own session exits, not when another does', async () => {
    seedRow(VISIBLE_ID, true);
    const waiting = manager.awaitAgentReady(VISIBLE_ID, 60_000);

    manager.emit('exit', OTHER_ID, 0, false);
    await expect(settlesWithin(waiting, 25)).resolves.toBe('still pending');

    manager.emit('exit', VISIBLE_ID, 0, false);
    // False before the 60 s ceiling can only be the exit.
    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(false);
  });

  it('awaitAgentReady ends false when a hidden session exits, which reaches it as hidden-session-exit', async () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const waiting = manager.awaitAgentReady(HIDDEN_ID, 60_000);

    // A hidden id's 'exit' is rerouted: no plain 'exit' listener hears it.
    manager.emit('exit', HIDDEN_ID, 0, true);

    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(false);
  });

  it('awaitAgentReady leaves no listener behind once it ends', async () => {
    seedRow(VISIBLE_ID, true);
    const before = {
      firstOutput: manager.listenerCount('first-output'),
      exit: manager.listenerCount('exit'),
      hiddenExit: manager.listenerCount('hidden-session-exit'),
    };

    const waiting = manager.awaitAgentReady(VISIBLE_ID, 60_000);
    manager.emit('first-output', VISIBLE_ID);
    await waiting;

    expect(manager.listenerCount('first-output')).toBe(before.firstOutput);
    expect(manager.listenerCount('exit')).toBe(before.exit);
    expect(manager.listenerCount('hidden-session-exit')).toBe(before.hiddenExit);
  });

  it('awaitAgentReady on timeout answers whether the agent came on screen meanwhile', async () => {
    seedRow(VISIBLE_ID, true);
    seedRow(OTHER_ID, true);

    const neverReady = manager.awaitAgentReady(VISIBLE_ID, 40);
    // Recorded with no event emitted, so only the timer can report it.
    const readyWithoutEvent = manager.awaitAgentReady(OTHER_ID, 40);
    markFirstOutput(OTHER_ID);

    await expect(neverReady).resolves.toBe(false);
    await expect(readyWithoutEvent).resolves.toBe(true);
  });

  it('awaitAgentReady begun while the session is hidden ends true when adoption re-announces its first output', async () => {
    seedRow(HIDDEN_ID, true);
    hide(HIDDEN_ID);
    const waiting = manager.awaitAgentReady(HIDDEN_ID, 60_000);

    // The first output lands while hidden: recorded, but its announcement is held back.
    markFirstOutput(HIDDEN_ID);
    manager.emit('first-output', HIDDEN_ID);
    await expect(settlesWithin(waiting, 25)).resolves.toBe('still pending');

    expect(manager.adoptSession(HIDDEN_ID)).toBe(true);

    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(true);
  });

  // ---- awaitAltScreen ----

  it('awaitAltScreen gives up false when its deadline passes between two polls', async () => {
    seedRow(VISIBLE_ID, true);

    // The mirror never reports the alternate screen; the 100 ms poll runs
    // at 100 and 200 ms inside the 250 ms budget, and ends it at 300 ms.
    const waiting = manager.awaitAltScreen(VISIBLE_ID, 250);

    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(false);
  });

  it('awaitAltScreen gives up false once the PTY goes away mid-wait, well before its deadline', async () => {
    seedRow(VISIBLE_ID, true);
    const registry = (manager as unknown as { registry: SessionRegistry }).registry;
    const waiting = manager.awaitAltScreen(VISIBLE_ID, 60_000);

    // Nulled after the call: a PTY missing up front would take the immediate answer instead.
    (registry.get(VISIBLE_ID) as ManagedSession).pty = null;

    await expect(settlesWithin(waiting, 1_000)).resolves.toBe(false);
  });
});

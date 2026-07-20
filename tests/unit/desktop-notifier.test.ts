/**
 * Unit tests for src/main/notifications/desktop-notifier.ts
 *
 * Covered: the idle/permission and crash triggers, the shared
 * (idle+crash) cooldown bucket keyed by sessionId, the focus/active-project
 * suppression gate (including a destroyed/missing window counting as
 * unfocused - the behavior this notifier exists to preserve), title/body
 * assembly (including the Command Terminal transient-session case), the
 * config gates, and synchronous dispose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DesktopNotifier, type DesktopNotifierOptions } from '../../src/main/notifications/desktop-notifier';
import type { NotificationConfig, NotificationInput, Session } from '../../src/shared/types';

class FakeSessionManager extends EventEmitter {
  getSession = vi.fn((_sessionId: string): Session | undefined => undefined);
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    pid: 1234,
    status: 'running',
    shell: 'bash',
    cwd: '/mock/project',
    startedAt: '2026-07-16T00:00:00.000Z',
    exitCode: null,
    ...overrides,
  } as Session;
}

function makeConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    desktop: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true },
    toasts: { onAgentIdle: true, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true, durationSeconds: 4, maxCount: 5 },
    cooldownSeconds: 10,
    ...overrides,
  };
}

describe('DesktopNotifier', () => {
  let sessionManager: FakeSessionManager;
  let config: NotificationConfig;
  let focused: boolean;
  let activeProjectId: string | undefined;
  let flashFrame: ReturnType<typeof vi.fn>;
  let showNotification: ReturnType<typeof vi.fn>;
  let resolveTaskTitle: ReturnType<typeof vi.fn>;
  let resolveProjectName: ReturnType<typeof vi.fn>;
  let notifier: DesktopNotifier;

  function buildNotifier(overrides: Partial<DesktopNotifierOptions> = {}): void {
    notifier = new DesktopNotifier({
      sessionManager: sessionManager as unknown as DesktopNotifierOptions['sessionManager'],
      getNotificationConfig: () => config,
      getActiveProjectId: () => activeProjectId,
      isWindowFocused: () => focused,
      flashFrame,
      resolveTaskTitle,
      resolveProjectName,
      showNotification,
      ...overrides,
    });
    notifier.start();
  }

  function shownInputs(): NotificationInput[] {
    return showNotification.mock.calls.map(([input]) => input as NotificationInput);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new FakeSessionManager();
    config = makeConfig();
    focused = false;
    activeProjectId = undefined;
    flashFrame = vi.fn();
    showNotification = vi.fn();
    resolveTaskTitle = vi.fn(() => 'Build the thing');
    resolveProjectName = vi.fn(() => 'My Project');
  });

  afterEach(() => {
    notifier.dispose();
    vi.useRealTimers();
  });

  it('notifies on idle when the window is unfocused', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownInputs()[0]).toEqual({ title: 'Build the thing', body: 'My Project', projectId: 'proj-1', taskId: 'task-1' });
    expect(flashFrame).toHaveBeenCalledTimes(1);
  });

  it('suppresses when the window is focused AND viewing the session project', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    focused = true;
    activeProjectId = 'proj-1';
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('notifies when focused but the session belongs to a background project', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    focused = true;
    activeProjectId = 'some-other-project';
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('a destroyed/missing window counts as unfocused, so it still notifies', () => {
    // isWindowFocused reflects `!mainWindow.isDestroyed() && mainWindow.isFocused()`
    // at the call site; a destroyed window resolves this to false regardless
    // of the stale isFocused() value. This is the behavior the move exists for.
    sessionManager.getSession.mockReturnValue(makeSession());
    focused = false; // simulates a destroyed/missing window
    activeProjectId = 'proj-1';
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('permission produces a "Needs permission" body; idle produces the bare project name', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    expect(shownInputs()[0].body).toBe('Needs permission: My Project');
  });

  it('a transient session uses the Command Terminal label and sentinel taskId', () => {
    sessionManager.getSession.mockReturnValue(makeSession({ transient: true }));
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(shownInputs()[0].title).toBe('Command Terminal');
    expect(shownInputs()[0].taskId).toBe('__command_terminal__');
    expect(resolveTaskTitle).not.toHaveBeenCalled();
  });

  it('does not notify when desktop.onAgentIdle is disabled', () => {
    config = makeConfig({ desktop: { onAgentIdle: false, onAgentCrash: true, onPlanComplete: true, onSpawnStalled: true } });
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('a "thinking" state never notifies', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'thinking', { kind: 'turn-active' });
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('notifies on a non-zero, non-intentional exit', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownInputs()[0].title).toBe('Session crashed: Build the thing');
  });

  it('suppresses a crash notification when intentional is true', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, true);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('suppresses a crash notification for a clean (exitCode 0) exit', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 0, false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('suppresses a crash notification for a transient session', () => {
    sessionManager.getSession.mockReturnValue(makeSession({ transient: true }));
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('does not notify when desktop.onAgentCrash is disabled', () => {
    config = makeConfig({ desktop: { onAgentIdle: true, onAgentCrash: false, onPlanComplete: true, onSpawnStalled: true } });
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('idle and crash share ONE cooldown bucket keyed by sessionId', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);

    // A crash for the SAME session within the cooldown is suppressed -
    // splitting this into two buckets would be a regression (see the plan's
    // rationale for moving crash alongside idle).
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('a repeat within cooldownSeconds is suppressed; past it, it fires again', async () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission' });
    expect(showNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_000);
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('a different session is not throttled by another session\'s cooldown', () => {
    sessionManager.getSession.mockImplementation((sessionId: string) => makeSession({ id: sessionId, taskId: `task-${sessionId}` }));
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('activity', 'sess-2', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('a focus-suppressed event does not consume the cooldown', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    focused = true;
    activeProjectId = 'proj-1';
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' }); // suppressed by focus gate
    expect(showNotification).not.toHaveBeenCalled();

    // No time has advanced (fake timers). If the suppressed attempt above had
    // stamped the cooldown, this call would ALSO be suppressed (0ms elapsed <
    // cooldownSeconds). It firing proves the cooldown was left untouched.
    focused = false;
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('an unknown session (already gone from the registry) is skipped', () => {
    sessionManager.getSession.mockReturnValue(undefined);
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('dispose detaches both listeners', () => {
    buildNotifier();
    notifier.dispose();
    expect(sessionManager.listenerCount('activity')).toBe(0);
    expect(sessionManager.listenerCount('exit')).toBe(0);
  });

  it('falls back to "A task" when resolveTaskTitle returns undefined for a non-transient session', () => {
    resolveTaskTitle.mockReturnValue(undefined);
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(shownInputs()[0].title).toBe('A task');
  });

  it('falls back to the first 8 characters of the sessionId when resolveTaskTitle returns undefined on crash', () => {
    const sessionId = 'abcdefgh-1234-5678-9012-abcdefabcdef';
    resolveTaskTitle.mockReturnValue(undefined);
    sessionManager.getSession.mockReturnValue(makeSession({ id: sessionId }));
    buildNotifier();
    sessionManager.emit('exit', sessionId, 1, false);
    expect(shownInputs()[0].title).toBe('Session crashed: abcdefgh');
  });

  it('an activity-handler exception does not stop later listeners on the shared emitter', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier({
      showNotification: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const laterListener = vi.fn();
    sessionManager.on('activity', laterListener);

    expect(() => {
      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    }).not.toThrow();

    // Proves the exception did not propagate through emit and abort the rest
    // of the listener chain (the session handlers registered after this
    // notifier, in a real app - see register-all.ts).
    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('an exit-handler exception does not stop later listeners on the shared emitter', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier({
      showNotification: vi.fn(() => {
        throw new Error('boom');
      }),
    });
    const laterListener = vi.fn();
    sessionManager.on('exit', laterListener);

    expect(() => {
      sessionManager.emit('exit', 'sess-1', 1, false);
    }).not.toThrow();

    expect(laterListener).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
});

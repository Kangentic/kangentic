/**
 * Unit tests for src/main/notifications/desktop-notifier.ts
 *
 * Covered: the idle/permission and crash triggers, the per-trigger
 * cooldown buckets keyed `<trigger>:<sessionId>`, the focus/active-project
 * suppression gate (including a destroyed/missing window counting as
 * unfocused - the behavior this notifier exists to preserve), title/body
 * assembly (including the Command Terminal transient-session case, and the
 * workflow a workflow task's body names), the config gates, and synchronous
 * dispose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { DesktopNotifier, workflowLabel, type DesktopNotifierOptions } from '../../src/main/notifications/desktop-notifier';
import { PTY_HOST_LOST_EXIT_CODE, PTY_HOST_LOST_NOTICE_WINDOW_MS } from '../../src/shared/pty-host';
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
  let resolveWorkflowTitle: ReturnType<typeof vi.fn>;
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
      resolveWorkflowTitle,
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
    // An ordinary task by default: no workflow to name.
    resolveWorkflowTitle = vi.fn((): string | undefined => undefined);
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
    expect(shownInputs()[0]).toEqual({ title: 'Agent went idle', body: 'Build the thing - My Project', projectId: 'proj-1', taskId: 'task-1' });
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

  // The title says what happened, the body which task and where (#452's
  // signed-off notifications board): one title per wait.
  describe('the title names the wait', () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['a finished turn', 'idle', { kind: 'idle', since: 1 }, 'Agent went idle'],
      ['a question', 'permission', { kind: 'permission', since: 1, waitKind: 'question' }, 'Agent has a question'],
      ['an approval (a tool or a plan)', 'permission', { kind: 'permission', since: 1, waitKind: 'approval' }, 'Agent needs your approval'],
      ['a wait whose agent did not report the kind', 'permission', { kind: 'permission', since: 1 }, 'Agent needs your input'],
    ];
    for (const [label, state, reason, title] of cases) {
      it(`titles ${label} "${title}", over the task title and place`, () => {
        sessionManager.getSession.mockReturnValue(makeSession());
        buildNotifier();
        sessionManager.emit('activity', 'sess-1', state, reason);
        expect(shownInputs()[0]).toEqual({ title, body: 'Build the thing - My Project', projectId: 'proj-1', taskId: 'task-1' });
      });
    }
  });

  it('a transient session names the Command Terminal and its project in the body, with the sentinel taskId', () => {
    sessionManager.getSession.mockReturnValue(makeSession({ transient: true }));
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(shownInputs()[0].title).toBe('Agent went idle');
    expect(shownInputs()[0].taskId).toBe('__command_terminal__');
    expect(resolveTaskTitle).not.toHaveBeenCalled();
    // No task, so no workflow to look up.
    expect(resolveWorkflowTitle).not.toHaveBeenCalled();
    expect(shownInputs()[0].body).toBe('Command Terminal - My Project');
  });

  it('a transient session waiting on a question titles the question', () => {
    sessionManager.getSession.mockReturnValue(makeSession({ transient: true }));
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 1, waitKind: 'question' });
    expect(shownInputs()[0]).toMatchObject({ title: 'Agent has a question', body: 'Command Terminal - My Project' });
  });

  // #732 board 16: a workflow task's idle and crash bodies name the workflow.

  it('an idle workflow task names its workflow after the project', () => {
    resolveProjectName.mockReturnValue('kangentic');
    resolveWorkflowTitle.mockReturnValue('Usage budgets');
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(shownInputs()[0]).toEqual({
      title: 'Agent went idle',
      body: 'Build the thing - kangentic: Usage budgets workflow',
      projectId: 'proj-1',
      taskId: 'task-1',
    });
    expect(resolveWorkflowTitle).toHaveBeenCalledWith('proj-1', 'task-1');
  });

  it('a workflow task waiting on an approval names the same place after its title', () => {
    resolveProjectName.mockReturnValue('kangentic');
    resolveWorkflowTitle.mockReturnValue('Usage budgets');
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 1, waitKind: 'approval' });
    expect(shownInputs()[0]).toMatchObject({
      title: 'Agent needs your approval',
      body: 'Build the thing - kangentic: Usage budgets workflow',
    });
  });

  it('a crashed workflow task names its workflow too', () => {
    resolveProjectName.mockReturnValue('kangentic');
    resolveTaskTitle.mockReturnValue('Cost roll-up per task');
    resolveWorkflowTitle.mockReturnValue('Usage budgets');
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(shownInputs()[0]).toMatchObject({
      title: 'Session crashed: Cost roll-up per task',
      body: 'kangentic: Usage budgets workflow',
    });
  });

  it('a task outside a workflow keeps the bare project name as its place on idle and crash', () => {
    config = makeConfig({ cooldownSeconds: 0 });
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(shownInputs().map((input) => input.body)).toEqual(['Build the thing - My Project', 'My Project']);
  });

  it('a workflow title that already ends in "workflow" is not given a second one', () => {
    expect(workflowLabel('Usage budgets')).toBe('Usage budgets workflow');
    expect(workflowLabel('Untitled workflow')).toBe('Untitled workflow');
    expect(workflowLabel('Release Workflow')).toBe('Release Workflow');
    // Only the whole word counts.
    expect(workflowLabel('Reworkflow')).toBe('Reworkflow workflow');
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

  it('folds the burst of exits one pty host crash produces into one notification', () => {
    sessionManager.getSession.mockImplementation((sessionId: string) => makeSession({ id: sessionId }));
    buildNotifier();
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) sessionManager.emit('exit', sessionId, -2, false);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownInputs()[0]).toMatchObject({ title: 'Terminals restarted', body: 'Running agents are resuming.' });

    // A later, separate crash notifies again once the window and cooldown pass.
    vi.advanceTimersByTime(10_000);
    sessionManager.emit('exit', 'sess-4', -2, false);
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('folds lost-session exits by the notice window itself, with no cooldown to lean on', () => {
    // The 'pty-host-lost' cooldown bucket is shared by every session, so with
    // the default 10 s cooldown it alone folds a burst. A zero cooldown leaves
    // the notice window as the only thing that can.
    config = makeConfig({ cooldownSeconds: 0 });
    sessionManager.getSession.mockImplementation((sessionId: string) => makeSession({ id: sessionId }));
    buildNotifier();

    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      sessionManager.emit('exit', sessionId, PTY_HOST_LOST_EXIT_CODE, false);
    }
    expect(showNotification).toHaveBeenCalledTimes(1);

    // Still inside the window one millisecond before it closes.
    vi.advanceTimersByTime(PTY_HOST_LOST_NOTICE_WINDOW_MS - 1);
    sessionManager.emit('exit', 'sess-4', PTY_HOST_LOST_EXIT_CODE, false);
    expect(showNotification).toHaveBeenCalledTimes(1);

    // A separate crash once the window has passed notifies again.
    vi.advanceTimersByTime(1);
    sessionManager.emit('exit', 'sess-5', PTY_HOST_LOST_EXIT_CODE, false);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(shownInputs()[1]).toMatchObject({ title: 'Terminals restarted' });
  });

  it('a lost session in the project on screen does not swallow a background project\'s notice', () => {
    // The project on screen exits first and the focus gate holds it back; a
    // background project's exit from the same crash still notifies. With the
    // window stamped before the focus gate, it depended on which exit came first.
    config = makeConfig({ cooldownSeconds: 0 });
    focused = true;
    activeProjectId = 'proj-on-screen';
    sessionManager.getSession.mockImplementation((sessionId: string) => makeSession({
      id: sessionId,
      projectId: sessionId === 'sess-on-screen' ? 'proj-on-screen' : 'proj-background',
    }));
    buildNotifier();

    sessionManager.emit('exit', 'sess-on-screen', PTY_HOST_LOST_EXIT_CODE, false);
    expect(showNotification).not.toHaveBeenCalled();
    sessionManager.emit('exit', 'sess-background', PTY_HOST_LOST_EXIT_CODE, false);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(shownInputs()[0]).toMatchObject({ title: 'Terminals restarted', projectId: 'proj-background' });
  });

  it('keeps an ordinary crash inside a host-loss window as its own notification', () => {
    config = makeConfig({ cooldownSeconds: 0 });
    sessionManager.getSession.mockImplementation((sessionId: string) => makeSession({ id: sessionId }));
    buildNotifier();

    sessionManager.emit('exit', 'sess-1', PTY_HOST_LOST_EXIT_CODE, false);
    sessionManager.emit('exit', 'sess-2', 1, false);

    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(shownInputs()[0].title).toBe('Terminals restarted');
    expect(shownInputs()[1].title).toContain('Session crashed');
  });

  it('does not notify when desktop.onAgentCrash is disabled', () => {
    config = makeConfig({ desktop: { onAgentIdle: true, onAgentCrash: false, onPlanComplete: true, onSpawnStalled: true } });
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('a crash is NOT suppressed by the same session\'s recent idle notification', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(showNotification).toHaveBeenCalledTimes(1);

    // Idle and crash used to share one bucket keyed by the bare sessionId, so
    // this crash was swallowed. An agent dying right after a turn is the
    // ordinary shape of the bug: cooldown exists to stop ONE event repeating,
    // not to let one event mask a different, more important one.
    sessionManager.emit('exit', 'sess-1', 1, false);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect(showNotification.mock.calls[1][0].title).toContain('Session crashed');
  });

  it('each trigger still throttles its OWN repeats', () => {
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('exit', 'sess-1', 1, false);
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

  it('calling start() twice attaches each listener only once', () => {
    // register-all.ts constructs this notifier once and calls start() exactly
    // once (guarded by the module-level idempotency check on registerAllIpc
    // itself), but the class carries its own `started` guard as a defensive
    // second layer. A caller mistake that invoked start() again must not
    // double-attach listeners (which would double-fire every notification).
    buildNotifier();
    notifier.start();
    expect(sessionManager.listenerCount('activity')).toBe(1);
    expect(sessionManager.listenerCount('exit')).toBe(1);
  });

  it('falls back to "A task" in the body when resolveTaskTitle returns undefined for a non-transient session', () => {
    resolveTaskTitle.mockReturnValue(undefined);
    sessionManager.getSession.mockReturnValue(makeSession());
    buildNotifier();
    sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
    expect(shownInputs()[0]).toMatchObject({ title: 'Agent went idle', body: 'A task - My Project' });
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

  // #916. The agent moved its own task, and the move ends the session once the
  // turn that made it ends (own-call-turn-wait.ts). That idle waits on nobody.
  describe('the idle that ends the turn in which the agent moved its own task', () => {
    it('raises no idle notice, but still notifies on a permission prompt in that turn', () => {
      sessionManager.getSession.mockReturnValue(makeSession());
      buildNotifier({ isSessionInOwnCall: (sessionId) => sessionId === 'sess-1' });

      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
      expect(showNotification).not.toHaveBeenCalled();

      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 1, waitKind: 'approval' });
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(shownInputs()[0].title).toBe('Agent needs your approval');
    });

    it('raises the idle notice as before once the move has settled (the control)', () => {
      sessionManager.getSession.mockReturnValue(makeSession());
      buildNotifier({ isSessionInOwnCall: () => false });

      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
      expect(showNotification).toHaveBeenCalledTimes(1);
    });
  });

  // A running workflow task's idle is its step check's to report
  // (workflow-recovery.ts): a wait on the user at once, a stall once recovery
  // runs out. The generic idle notice would fire at every nudged turn.
  describe('a running workflow task', () => {
    beforeEach(() => {
      config = makeConfig({ desktop: { ...makeConfig().desktop, onWorkflowStalled: true } });
      resolveWorkflowTitle = vi.fn(() => 'Usage budgets');
    });

    it('raises no idle notice, but still notifies on a permission prompt', () => {
      sessionManager.getSession.mockReturnValue(makeSession());
      buildNotifier({ isWorkflowStepTask: () => true });

      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
      expect(showNotification).not.toHaveBeenCalled();

      sessionManager.emit('activity', 'sess-1', 'permission', { kind: 'permission', since: 1, waitKind: 'question' });
      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(shownInputs()[0].title).toBe('Agent has a question');
    });

    it('raises the idle notice as before once the workflow is not running (the control)', () => {
      sessionManager.getSession.mockReturnValue(makeSession());
      buildNotifier({ isWorkflowStepTask: () => false });

      sessionManager.emit('activity', 'sess-1', 'idle', { kind: 'idle' });
      expect(showNotification).toHaveBeenCalledTimes(1);
    });

    it('sends a stall notice even with the window focused on the project, since it is the only one', () => {
      focused = true;
      activeProjectId = 'proj-1';
      buildNotifier({ isWorkflowStepTask: () => true });

      notifier.notifyWorkflowTask({ projectId: 'proj-1', taskId: 'task-1', kind: 'stalled', reason: 'the step check could not run.' });

      expect(showNotification).toHaveBeenCalledTimes(1);
      expect(shownInputs()[0]).toEqual({
        title: 'Build the thing',
        body: 'My Project: Usage budgets workflow. Stalled: the step check could not run.',
        projectId: 'proj-1',
        taskId: 'task-1',
      });
    });

    it('sends no stall notice with the Workflow stalled switch off', () => {
      config = makeConfig({ desktop: { ...makeConfig().desktop, onWorkflowStalled: false } });
      buildNotifier({ isWorkflowStepTask: () => true });

      notifier.notifyWorkflowTask({ projectId: 'proj-1', taskId: 'task-1', kind: 'stalled', reason: 'it could not start: git failed.' });

      expect(showNotification).not.toHaveBeenCalled();
    });

    it('sends a wait on the user like the idle notice it replaced: behind its switch and its focus gate', () => {
      buildNotifier({ isWorkflowStepTask: () => true });
      notifier.notifyWorkflowTask({ projectId: 'proj-1', taskId: 'task-1', sessionId: 'sess-1', kind: 'waiting', reason: 'It asks which layout to use.' });
      expect(shownInputs()[0].body).toBe('My Project: Usage budgets workflow. Waiting on you: It asks which layout to use.');

      // The same session's idle cooldown holds a second one back.
      notifier.notifyWorkflowTask({ projectId: 'proj-1', taskId: 'task-1', sessionId: 'sess-1', kind: 'waiting', reason: 'Again.' });
      expect(showNotification).toHaveBeenCalledTimes(1);

      // Looking at the project: no notice, as for an idle one.
      vi.advanceTimersByTime(20_000);
      focused = true;
      activeProjectId = 'proj-1';
      notifier.notifyWorkflowTask({ projectId: 'proj-1', taskId: 'task-1', sessionId: 'sess-1', kind: 'waiting', reason: 'Once more.' });
      expect(showNotification).toHaveBeenCalledTimes(1);
    });
  });
});

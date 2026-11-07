/**
 * AppBadge: the count on the app icon. What a user loses without these: a badge that
 * counts an agent nobody needs to answer, one that keeps counting after the agent
 * resumes, or a broken recount that takes a session's lifecycle writes down with it.
 *
 * Tier: Unit. It runs the real class over a fake SessionManager.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppBadge, type AppBadgeOptions } from '../../src/main/notifications/app-badge';
import { DEFAULT_CONFIG, type ActivityReason, type ActivityState, type NotificationConfig, type Session } from '../../src/shared/types';

function session(overrides: Partial<Session> & { id: string }): Session {
  return { taskId: `task-${overrides.id}`, projectId: 'project-1', status: 'running', transient: false, ...overrides } as Session;
}

const flushRecount = () => new Promise((resolve) => setImmediate(resolve));

function setup(overrides: Partial<AppBadgeOptions> = {}) {
  const emitter = new EventEmitter();
  const sessions: Session[] = [];
  const activity: Record<string, ActivityState> = {};
  const reasons: Record<string, ActivityReason> = {};
  const notifications: NotificationConfig = structuredClone(DEFAULT_CONFIG.notifications);
  const show = vi.fn();
  const badge = new AppBadge({
    sessionManager: Object.assign(emitter, {
      listSessions: () => sessions,
      getActivityCache: () => activity,
      getActivityReason: (sessionId: string) => reasons[sessionId] ?? null,
    }) as unknown as AppBadgeOptions['sessionManager'],
    getNotificationConfig: () => notifications,
    isSessionInOwnCall: () => false,
    isWorkflowStepTask: () => false,
    show,
    ...overrides,
  });
  badge.start();
  return { badge, emitter, sessions, activity, reasons, notifications, show };
}

describe('AppBadge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('counts running sessions waiting on the user, across projects', async () => {
    const { emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a' }), session({ id: 'b', projectId: 'project-2' }), session({ id: 'c' }));
    activity.a = 'idle';
    activity.b = 'permission';
    activity.c = 'thinking';

    emitter.emit('activity');
    await flushRecount();

    expect(show).toHaveBeenLastCalledWith(2);
  });

  it('leaves out a suspended session, which can keep an idle entry in the cache', async () => {
    const { emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a', status: 'suspended' }), session({ id: 'b', status: 'queued' }));
    activity.a = 'idle';
    activity.b = 'idle';

    emitter.emit('session-changed');
    await flushRecount();

    expect(show).not.toHaveBeenCalled();
  });

  it('leaves out a workflow agent, and counts a Command Terminal', async () => {
    const { emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a', workflowId: 'workflow-1' }), session({ id: 'b', transient: true }));
    activity.a = 'idle';
    activity.b = 'idle';

    emitter.emit('activity');
    await flushRecount();

    expect(show).toHaveBeenLastCalledWith(1);
  });

  it('leaves out a running workflow step between turns, but counts its permission prompt', async () => {
    const isWorkflowStepTask = vi.fn(() => true);
    const { emitter, sessions, activity, show } = setup({ isWorkflowStepTask });
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';

    emitter.emit('activity');
    await flushRecount();
    expect(show).not.toHaveBeenCalled();

    activity.a = 'permission';
    emitter.emit('activity');
    await flushRecount();
    expect(show).toHaveBeenLastCalledWith(1);
  });

  it('counts a workflow step the board stopped, the moment the stop goes out', async () => {
    const isWorkflowStepTask = vi.fn(() => true);
    const { emitter, sessions, activity, reasons, show } = setup({ isWorkflowStepTask });
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';
    emitter.emit('activity');
    await flushRecount();
    expect(show).not.toHaveBeenCalled();

    // The step check found it waiting on the user: only a person can move it now.
    reasons.a = { kind: 'idle', stopped: true } as ActivityReason;
    emitter.emit('activity-reason', 'a', 'idle');
    await flushRecount();

    expect(show).toHaveBeenLastCalledWith(1);
  });

  it('drops the stopped step once its reason says it is no longer stopped', async () => {
    const { emitter, sessions, activity, reasons, show } = setup({ isWorkflowStepTask: () => true });
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';
    reasons.a = { kind: 'idle', stopped: true } as ActivityReason;
    emitter.emit('activity');
    await flushRecount();
    expect(show).toHaveBeenLastCalledWith(1);

    reasons.a = { kind: 'idle' } as ActivityReason;
    emitter.emit('activity-reason', 'a', 'idle');
    await flushRecount();

    expect(show).toHaveBeenLastCalledWith(0);
  });

  it('skips the recount for a working session\'s reason refreshes, which a long turn sends about 180 of', async () => {
    const getNotificationConfig = vi.fn(() => structuredClone(DEFAULT_CONFIG.notifications));
    const { emitter } = setup({ getNotificationConfig });
    await flushRecount();
    getNotificationConfig.mockClear();

    for (let index = 0; index < 5; index += 1) emitter.emit('activity-reason', 'a', 'thinking');
    await flushRecount();
    expect(getNotificationConfig).not.toHaveBeenCalled();

    emitter.emit('activity-reason', 'a', 'idle');
    await flushRecount();
    expect(getNotificationConfig).toHaveBeenCalledTimes(1);
  });

  it('stops listening for reason refreshes on dispose', () => {
    const { badge, emitter } = setup();
    badge.dispose();
    expect(emitter.listenerCount('activity-reason')).toBe(0);
  });

  it('asks the board-reading workflow check only after the cheap checks', async () => {
    const isWorkflowStepTask = vi.fn(() => false);
    const { emitter, sessions, activity } = setup({ isWorkflowStepTask, isSessionInOwnCall: () => true });
    sessions.push(session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c', transient: true }));
    activity.a = 'idle';
    activity.b = 'thinking';
    activity.c = 'idle';

    emitter.emit('activity');
    await flushRecount();

    expect(isWorkflowStepTask).not.toHaveBeenCalled();
  });

  it('leaves out the end of a turn that moved its own task, as the notifier does', async () => {
    const { emitter, sessions, activity, show } = setup({ isSessionInOwnCall: () => true });
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';

    emitter.emit('activity');
    await flushRecount();

    expect(show).not.toHaveBeenCalled();
  });

  it('goes to the OS only when the number changes, and once for a burst', async () => {
    const { emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';

    for (let index = 0; index < 5; index += 1) emitter.emit('activity');
    await flushRecount();
    expect(show).toHaveBeenCalledTimes(1);

    emitter.emit('session-changed');
    await flushRecount();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each(['activity', 'exit', 'session-changed', 'session-removed', 'pty-host-lost'])('clears on %s', async (event) => {
    const { emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';
    emitter.emit('activity');
    await flushRecount();
    expect(show).toHaveBeenLastCalledWith(1);

    sessions.length = 0;
    emitter.emit(event);
    await flushRecount();
    expect(show).toHaveBeenLastCalledWith(0);
  });

  it.each(['muted', 'appBadge'] as const)('shows nothing once %s says so, the moment it is refreshed', async (key) => {
    const { badge, emitter, sessions, activity, notifications, show } = setup();
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';
    emitter.emit('activity');
    await flushRecount();

    notifications[key] = key === 'muted';
    badge.refresh();
    await flushRecount();

    expect(show).toHaveBeenLastCalledWith(0);
  });

  it('keeps a failed recount off the emit stack, so the lifecycle writes after it still run', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { emitter, sessions, activity } = setup({ isSessionInOwnCall: () => { throw new Error('broken'); } });
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';

    expect(() => emitter.emit('activity')).not.toThrow();
    await flushRecount();

    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[NOTIFICATION]'), expect.any(Error));
  });

  it('stops listening and drops a scheduled recount on dispose', async () => {
    const { badge, emitter, sessions, activity, show } = setup();
    sessions.push(session({ id: 'a' }));
    activity.a = 'idle';

    emitter.emit('activity');
    badge.dispose();
    await flushRecount();

    expect(show).not.toHaveBeenCalled();
    expect(emitter.listenerCount('activity')).toBe(0);
  });
});

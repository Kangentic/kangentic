/**
 * Unit tests for SessionRegistry.
 *
 * Covers:
 *   - getSessionAgentName: returns the stored agentName or undefined when
 *     absent/missing.
 *   - findLiveSessionByTaskId: returns running/queued Session DTOs and
 *     undefined for suspended/exited entries; proves the multi-entry
 *     invariant that a suspended placeholder cannot mask a live spawn for
 *     the same taskId regardless of insertion order.
 *   - listByTaskId: every row for a task, in insertion order (the query the
 *     spawn flow drains with, so a second stale row cannot survive a spawn).
 *   - registerSuspendedPlaceholder: idempotent per task. A live or suspended
 *     row blocks the insert; an exited row is replaced.
 */

import { describe, it, expect } from 'vitest';
import { SessionRegistry } from '../../src/main/pty/session-registry';
import type { ManagedSession } from '../../src/main/pty/session-registry';

/** Build a minimal ManagedSession with only the fields relevant to this test. */
function makeManagedSession(overrides: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: 'session-001',
    taskId: 'task-001',
    projectId: 'project-001',
    pty: null,
    status: 'running',
    shell: '/bin/bash',
    cwd: '/home/dev/project',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    transient: false,
    exitSequence: ['\x03'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// hasLiveSessionForTask
// ---------------------------------------------------------------------------

/**
 * The kill-aware liveness query the Browser-pane hand-off decides on. Observed
 * live: the UI's stop stamps `intentionalExit` and flips the renderer's session
 * to exited at once, which drops the task's PARKED window; its pane unregisters
 * while the PTY is still exiting, so a "found a running row" check handed the
 * page off to a lane for an agent that was being stopped.
 */
describe('SessionRegistry.hasLiveSessionForTask', () => {
  it('is true for a running session with no kill in flight', () => {
    const registry = new SessionRegistry();
    registry.set('sess-running', makeManagedSession({ id: 'sess-running', taskId: 'task-a', status: 'running' }));
    expect(registry.hasLiveSessionForTask('task-a')).toBe(true);
  });

  it('is true for a queued session', () => {
    const registry = new SessionRegistry();
    registry.set('sess-queued', makeManagedSession({ id: 'sess-queued', taskId: 'task-a', status: 'queued' }));
    expect(registry.hasLiveSessionForTask('task-a')).toBe(true);
  });

  it('is FALSE for a running session whose kill is already in flight', () => {
    const registry = new SessionRegistry();
    registry.set('sess-dying', makeManagedSession({
      id: 'sess-dying',
      taskId: 'task-a',
      status: 'running',
      intentionalExit: true,
    }));
    expect(registry.hasLiveSessionForTask('task-a')).toBe(false);
    // The DTO query still reports the row, which is exactly why the hand-off
    // must not decide on it.
    expect(registry.findLiveSessionByTaskId('task-a')).toBeDefined();
  });

  it('is false for suspended, exited, or absent sessions', () => {
    const registry = new SessionRegistry();
    registry.set('sess-suspended', makeManagedSession({ id: 'sess-suspended', taskId: 'task-a', status: 'suspended' }));
    registry.set('sess-exited', makeManagedSession({ id: 'sess-exited', taskId: 'task-b', status: 'exited' }));
    expect(registry.hasLiveSessionForTask('task-a')).toBe(false);
    expect(registry.hasLiveSessionForTask('task-b')).toBe(false);
    expect(registry.hasLiveSessionForTask('task-nowhere')).toBe(false);
  });

  it('ignores a dying row when a fresh live spawn shares the taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-old', makeManagedSession({ id: 'sess-old', taskId: 'task-a', status: 'running', intentionalExit: true }));
    registry.set('sess-new', makeManagedSession({ id: 'sess-new', taskId: 'task-a', status: 'running' }));
    expect(registry.hasLiveSessionForTask('task-a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findLiveSessionByTaskId
// ---------------------------------------------------------------------------

describe('SessionRegistry.findLiveSessionByTaskId', () => {
  it('returns undefined when the registry is empty', () => {
    const registry = new SessionRegistry();
    expect(registry.findLiveSessionByTaskId('task-x')).toBeUndefined();
  });

  it('returns undefined when only a suspended entry exists for the taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-suspended', makeManagedSession({
      id: 'sess-suspended',
      taskId: 'task-paused',
      status: 'suspended',
    }));
    expect(registry.findLiveSessionByTaskId('task-paused')).toBeUndefined();
  });

  it('returns undefined when only an exited entry exists for the taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-exited', makeManagedSession({
      id: 'sess-exited',
      taskId: 'task-done',
      status: 'exited',
    }));
    expect(registry.findLiveSessionByTaskId('task-done')).toBeUndefined();
  });

  it('returns a Session DTO when a single running entry exists', () => {
    const registry = new SessionRegistry();
    registry.set('sess-running', makeManagedSession({
      id: 'sess-running',
      taskId: 'task-active',
      status: 'running',
    }));

    const result = registry.findLiveSessionByTaskId('task-active');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-running');
    expect(result!.taskId).toBe('task-active');
    expect(result!.status).toBe('running');
  });

  it('returns a Session DTO when a single queued entry exists', () => {
    const registry = new SessionRegistry();
    registry.set('sess-queued', makeManagedSession({
      id: 'sess-queued',
      taskId: 'task-waiting',
      status: 'queued',
    }));

    const result = registry.findLiveSessionByTaskId('task-waiting');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-queued');
    expect(result!.status).toBe('queued');
  });

  it('returned Session DTO does not have a pty field (it is a projected DTO, not a ManagedSession)', () => {
    const registry = new SessionRegistry();
    registry.set('sess-dto', makeManagedSession({
      id: 'sess-dto',
      taskId: 'task-dto',
      status: 'running',
      pty: null,
    }));

    const result = registry.findLiveSessionByTaskId('task-dto');

    expect(result).toBeDefined();
    // Session DTO must not expose the internal pty handle field
    expect('pty' in result!).toBe(false);
  });

  it('multi-entry invariant: suspended-first then running - returns the running one', () => {
    // This is the core bug shape the production fix is designed to prevent.
    // An idle-timeout suspend registers a suspended placeholder while the
    // fresh spawn is already in the registry. findLiveSessionByTaskId must
    // return the running entry regardless of insertion order.
    const registry = new SessionRegistry();

    // Insert the suspended placeholder first, then the live running spawn.
    registry.set('sess-stale', makeManagedSession({
      id: 'sess-stale',
      taskId: 'task-dual',
      status: 'suspended',
    }));
    registry.set('sess-live', makeManagedSession({
      id: 'sess-live',
      taskId: 'task-dual',
      status: 'running',
    }));

    const result = registry.findLiveSessionByTaskId('task-dual');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-live');
    expect(result!.status).toBe('running');
  });

  it('multi-entry invariant: running-first then suspended - returns the running one', () => {
    // Same invariant, opposite insertion order. Proves the filter on
    // status is what guards the result, not the Map iteration order.
    const registry = new SessionRegistry();

    // Insert the live running spawn first, then the suspended placeholder.
    registry.set('sess-live', makeManagedSession({
      id: 'sess-live',
      taskId: 'task-reverse',
      status: 'running',
    }));
    registry.set('sess-stale', makeManagedSession({
      id: 'sess-stale',
      taskId: 'task-reverse',
      status: 'suspended',
    }));

    const result = registry.findLiveSessionByTaskId('task-reverse');

    expect(result).toBeDefined();
    expect(result!.id).toBe('sess-live');
    expect(result!.status).toBe('running');
  });

  it('does not return entries belonging to a different taskId', () => {
    const registry = new SessionRegistry();
    registry.set('sess-other', makeManagedSession({
      id: 'sess-other',
      taskId: 'task-other',
      status: 'running',
    }));

    expect(registry.findLiveSessionByTaskId('task-unrelated')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listByTaskId
// ---------------------------------------------------------------------------

describe('SessionRegistry.listByTaskId', () => {
  it('returns every row for the task in insertion order, and nothing else', () => {
    const registry = new SessionRegistry();
    registry.set('sess-1', makeManagedSession({ id: 'sess-1', taskId: 'task-a', status: 'suspended' }));
    registry.set('sess-other', makeManagedSession({ id: 'sess-other', taskId: 'task-b' }));
    registry.set('sess-2', makeManagedSession({ id: 'sess-2', taskId: 'task-a', status: 'running' }));

    expect(registry.listByTaskId('task-a').map((row) => row.id)).toEqual(['sess-1', 'sess-2']);
    expect(registry.listByTaskId('task-nowhere')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// registerSuspendedPlaceholder
// ---------------------------------------------------------------------------

/**
 * The registry holds one row per task. Recovery registers a placeholder for a
 * paused task on every cold project open, and it can run more than once per
 * process (an explicit open during startup activation), so the placeholder
 * must be idempotent: the observed leak was two placeholders for one task, of
 * which the eventual spawn drained only one, and the survivor was listed
 * ahead of the live PTY.
 */
describe('SessionRegistry.registerSuspendedPlaceholder', () => {
  const input = { taskId: 'task-paused', projectId: 'project-001', cwd: '/home/dev/project' };

  it('inserts one suspended row for a task with no registry row', () => {
    const registry = new SessionRegistry();

    const placeholder = registry.registerSuspendedPlaceholder(input);

    expect(placeholder).not.toBeNull();
    expect(placeholder!.status).toBe('suspended');
    expect(placeholder!.taskId).toBe('task-paused');
    expect(registry.listByTaskId('task-paused').map((row) => row.id)).toEqual([placeholder!.id]);
  });

  it('is idempotent: a second call for the same task inserts nothing and returns null', () => {
    const registry = new SessionRegistry();

    const first = registry.registerSuspendedPlaceholder(input);
    const second = registry.registerSuspendedPlaceholder(input);

    expect(second).toBeNull();
    expect(registry.listByTaskId('task-paused').map((row) => row.id)).toEqual([first!.id]);
  });

  it.each(['running', 'queued'] as const)('never displaces a %s row', (status) => {
    const registry = new SessionRegistry();
    registry.set('sess-live', makeManagedSession({ id: 'sess-live', taskId: 'task-paused', status }));

    expect(registry.registerSuspendedPlaceholder(input)).toBeNull();
    expect(registry.listByTaskId('task-paused').map((row) => row.id)).toEqual(['sess-live']);
  });

  it('leaves a row suspended in place alone: it already offers Resume', () => {
    const registry = new SessionRegistry();
    registry.set('sess-parked', makeManagedSession({ id: 'sess-parked', taskId: 'task-paused', status: 'suspended' }));

    expect(registry.registerSuspendedPlaceholder(input)).toBeNull();
    expect(registry.listByTaskId('task-paused').map((row) => row.id)).toEqual(['sess-parked']);
  });

  it('replaces an exited row, which offers no Resume control', () => {
    // An agent crash leaves an exited row; a later recovery pass upgrades the
    // DB record to suspended and registers the placeholder. Keeping the
    // exited row would strand a task the DB says is resumable.
    const registry = new SessionRegistry();
    registry.set('sess-crashed', makeManagedSession({ id: 'sess-crashed', taskId: 'task-paused', status: 'exited', exitCode: 1 }));

    const placeholder = registry.registerSuspendedPlaceholder(input);

    expect(placeholder).not.toBeNull();
    const rows = registry.listByTaskId('task-paused');
    expect(rows.map((row) => row.id)).toEqual([placeholder!.id]);
    expect(rows[0].status).toBe('suspended');
    expect(registry.has('sess-crashed')).toBe(false);
  });

  it('does not half-evict an exited row when a live row shares the task', () => {
    const registry = new SessionRegistry();
    registry.set('sess-crashed', makeManagedSession({ id: 'sess-crashed', taskId: 'task-paused', status: 'exited' }));
    registry.set('sess-live', makeManagedSession({ id: 'sess-live', taskId: 'task-paused', status: 'running' }));

    expect(registry.registerSuspendedPlaceholder(input)).toBeNull();
    expect(registry.listByTaskId('task-paused').map((row) => row.id)).toEqual(['sess-crashed', 'sess-live']);
  });
});

// ---------------------------------------------------------------------------
// getSessionAgentName
// ---------------------------------------------------------------------------

describe('SessionRegistry.getSessionAgentName', () => {
  it('returns the stored agentName when the session exists and agentName is set', () => {
    const registry = new SessionRegistry();
    const session = makeManagedSession({ id: 'session-a', agentName: 'claude' });
    registry.set('session-a', session);

    expect(registry.getSessionAgentName('session-a')).toBe('claude');
  });

  it('returns undefined when the session id is not in the registry', () => {
    const registry = new SessionRegistry();
    // Nothing registered under this id.
    expect(registry.getSessionAgentName('session-missing')).toBeUndefined();
  });

  it('returns undefined when the session exists but agentName was not set', () => {
    const registry = new SessionRegistry();
    // Omitting agentName entirely so the field is undefined on the object.
    const session = makeManagedSession({ id: 'session-b' });
    delete (session as Partial<ManagedSession>).agentName;
    registry.set('session-b', session);

    expect(registry.getSessionAgentName('session-b')).toBeUndefined();
  });
});

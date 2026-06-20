/**
 * Unit tests for SessionManager's batch ActivityReason cache surfaces:
 *   - getActivityReasonsCache() (unscoped, all sessions)
 *   - getActivityReasonsCacheForProject(projectId) (project-scoped)
 *
 * The unscoped variant delegates to telemetry; the project-scoped variant
 * uses the same `filterCacheByProject` helper as the parallel
 * `getActivityCacheForProject`. Tests verify filtering correctness AND
 * the wiring sanity (the right cache is passed to filterCacheByProject -
 * a copy-paste bug could pass the activity-state cache here).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', () => ({
  adaptCommandForShell: (command: string) => command,
  isUncPath: (p: string) => /^[\\/]{2}[^\\/]/.test(p),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { SessionTelemetry } from '../../src/main/activity-engine/session-telemetry';
import { EventType } from '../../src/shared/types';

/** Type-cast helper to reach the private telemetry field for test setup. */
function getTelemetry(manager: SessionManager): SessionTelemetry {
  return (manager as unknown as { telemetry: SessionTelemetry }).telemetry;
}

describe('SessionManager.getActivityReasonsCache (unscoped)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('returns {} when no sessions are registered', () => {
    expect(manager.getActivityReasonsCache()).toEqual({});
  });

  it('includes every registered session keyed by sessionId', () => {
    const sessionA = manager.registerSuspendedPlaceholder({
      taskId: 't-a', projectId: 'p1', cwd: '/mock',
    });
    const sessionB = manager.registerSuspendedPlaceholder({
      taskId: 't-b', projectId: 'p1', cwd: '/mock',
    });

    const telemetry = getTelemetry(manager);
    telemetry.initSession(sessionA.id);
    telemetry.initSession(sessionB.id);

    const cache = manager.getActivityReasonsCache();
    expect(Object.keys(cache).sort()).toEqual([sessionA.id, sessionB.id].sort());
    expect(cache[sessionA.id].kind).toBe('idle');
    expect(cache[sessionB.id].kind).toBe('idle');
  });

  it('reflects engine state changes (turn-active after Prompt event)', () => {
    const session = manager.registerSuspendedPlaceholder({
      taskId: 't-1', projectId: 'p1', cwd: '/mock',
    });
    const telemetry = getTelemetry(manager);
    telemetry.initSession(session.id);
    telemetry.ingestEvents(session.id, [{ ts: Date.now(), type: EventType.Prompt }]);

    const cache = manager.getActivityReasonsCache();
    expect(cache[session.id].kind).toBe('turn-active');
  });
});

describe('SessionManager.getActivityReasonsCacheForProject (project-scoped)', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
  });

  it('returns {} when the project has no matching sessions', () => {
    manager.registerSuspendedPlaceholder({
      taskId: 't-a', projectId: 'p-other', cwd: '/mock',
    });
    expect(manager.getActivityReasonsCacheForProject('p-target')).toEqual({});
  });

  it('filters out sessions that belong to a different project', () => {
    const target = manager.registerSuspendedPlaceholder({
      taskId: 't-target', projectId: 'p-target', cwd: '/mock',
    });
    const other = manager.registerSuspendedPlaceholder({
      taskId: 't-other', projectId: 'p-other', cwd: '/mock',
    });
    const telemetry = getTelemetry(manager);
    telemetry.initSession(target.id);
    telemetry.initSession(other.id);

    const cache = manager.getActivityReasonsCacheForProject('p-target');
    expect(Object.keys(cache)).toEqual([target.id]);
    expect(cache[other.id]).toBeUndefined();
  });

  it('wiring sanity: passes the activity-reasons cache (NOT the activity-state cache) through filterCacheByProject', () => {
    // Register a session and initialize engine state. The reason is an
    // ActivityReason object (kind:'idle'), while the activity STATE cache
    // (parallel API) returns 'idle' as a plain string. If the wrong cache
    // were passed by mistake, the assertion below would observe a string
    // instead of an object.
    const session = manager.registerSuspendedPlaceholder({
      taskId: 't-1', projectId: 'p1', cwd: '/mock',
    });
    const telemetry = getTelemetry(manager);
    telemetry.initSession(session.id);

    const cache = manager.getActivityReasonsCacheForProject('p1');
    const value = cache[session.id];
    expect(typeof value).toBe('object');
    expect(value).not.toBeNull();
    expect(value.kind).toBe('idle');
  });
});

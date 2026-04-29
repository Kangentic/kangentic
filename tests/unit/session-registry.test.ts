/**
 * Unit tests for SessionRegistry.getSessionAgentName.
 *
 * The `agentName` field was added to ManagedSession on this branch so that
 * analytics events can include the agent name without relying on minification-
 * sensitive constructor names. These tests pin the accessor behavior:
 *
 *   - Returns the stored `agentName` string when the session exists and the
 *     field was set at spawn time.
 *   - Returns `undefined` when the session id is not in the registry
 *     (unknown session or already deleted).
 *   - Returns `undefined` when the session exists but `agentName` was not
 *     set (e.g. legacy spawn path or tests that don't populate the field).
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

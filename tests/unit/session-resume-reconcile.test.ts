/**
 * Tests for the SESSION_RESUME stale-reference reconciliation predicate.
 *
 * The renderer reads two sources of truth - the in-memory SessionRegistry
 * (status) and the DB-backed `task.session_id` field. They normally agree,
 * but internal suspend paths (idle-timeout, auto-spawn placeholder safety
 * nets) can leave the DB pointing at a registry session that's already
 * suspended or gone. SESSION_RESUME used to throw on any non-null
 * `task.session_id`, which made the divergence unrecoverable without the
 * "Reset session" safety net.
 *
 * The fix narrows the precondition: a non-null `task.session_id` only
 * blocks resume when the registry actually still has a live (running /
 * queued) session for it. Otherwise the reference is stale and resume
 * proceeds after clearing it.
 *
 * This test pins the predicate behavior so the contract can't regress
 * into the old strict check that produced unrecoverable states.
 */

import { describe, it, expect } from 'vitest';
import { isLiveSession, decideSuspendDbAction } from '../../src/main/pty/session-registry';
import type { Session, SessionRecord, SessionRecordStatus } from '../../src/shared/types';

// Build a Session DTO in the shape the registry projects via toSession().
// pid/exitCode are irrelevant to the predicate; we set neutral values so the
// fixture doesn't accidentally imply they're meaningful.
function makeSession(status: Session['status']): Session {
  return {
    id: 'session-1',
    taskId: 'task-1',
    projectId: 'project-1',
    pid: null,
    status,
    shell: '/bin/bash',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
  };
}

describe('isLiveSession', () => {
  it('returns true for running sessions (would collide with new spawn)', () => {
    expect(isLiveSession(makeSession('running'))).toBe(true);
  });

  it('returns true for queued sessions (slot reserved, would collide)', () => {
    expect(isLiveSession(makeSession('queued'))).toBe(true);
  });

  it('returns false for suspended sessions (stale reference, safe to clear)', () => {
    // The idle-timeout regression: registry was set to suspended but
    // task.session_id was never cleared. Resume must reconcile, not throw.
    expect(isLiveSession(makeSession('suspended'))).toBe(false);
  });

  it('returns false for exited sessions (PTY gone, safe to clear)', () => {
    expect(isLiveSession(makeSession('exited'))).toBe(false);
  });

  it('returns false when the session is missing from the registry', () => {
    // Auto-spawn placeholder safety-net case: registry never had the entry,
    // but task.session_id still pointed at an old id from a previous run.
    expect(isLiveSession(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// decideSuspendDbAction
//
// SESSION_SUSPEND, the idle-timeout listener, and any future suspend path
// share this branching on the latest session record. Encapsulating it in a
// pure helper lets the decision be pinned without standing up the IPC
// context, lock queue, or repositories.
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<SessionRecord> & { status: SessionRecordStatus }): SessionRecord {
  return {
    id: 'record-1',
    task_id: 'task-1',
    session_type: 'agent',
    agent_session_id: 'agent-1',
    command: 'claude',
    cwd: '/tmp',
    permission_mode: null,
    prompt: null,
    status: overrides.status,
    exit_code: null,
    started_at: new Date().toISOString(),
    suspended_at: null,
    exited_at: null,
    suspended_by: null,
    total_cost_usd: null,
    total_input_tokens: null,
    total_output_tokens: null,
    model_id: null,
    model_display_name: null,
    total_duration_ms: null,
    ...overrides,
  };
}

describe('decideSuspendDbAction', () => {
  it('suspends a running record with an agent session id', () => {
    expect(decideSuspendDbAction(makeRecord({ status: 'running' }))).toBe('suspend');
  });

  it('suspends an exited record with an agent session id (preserves --resume target)', () => {
    // Natural Claude CLI exit before idle-timeout fires: record is already
    // 'exited' but still has an agent_session_id. The next resume should be
    // able to use --resume, so we mark it suspended (not exited again).
    expect(decideSuspendDbAction(makeRecord({ status: 'exited' }))).toBe('suspend');
  });

  it('exits a queued record (never started, --resume would fail)', () => {
    // A queued session never wrote agent_session_id. Marking it suspended
    // would mislead the next resume into a doomed --resume attempt; mark
    // exited instead so it gets retired and a fresh spawn happens.
    const record = makeRecord({ status: 'queued', agent_session_id: null });
    expect(decideSuspendDbAction(record)).toBe('exit-queued');
  });

  it('no-ops when there is no agent session id (running but pre-capture)', () => {
    // Defensive: if the record is running but agent_session_id hasn't been
    // captured yet, we cannot mark it suspended (the resume key is missing).
    // No-op preserves the running record; the PTY teardown is unaffected
    // because the registry status was already flipped synchronously.
    const record = makeRecord({ status: 'running', agent_session_id: null });
    expect(decideSuspendDbAction(record)).toBe('noop');
  });

  it('no-ops when the record is already suspended', () => {
    expect(decideSuspendDbAction(makeRecord({ status: 'suspended' }))).toBe('noop');
  });

  it('no-ops when no session record exists for the task', () => {
    expect(decideSuspendDbAction(undefined)).toBe('noop');
  });
});

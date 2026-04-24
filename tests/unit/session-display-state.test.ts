/**
 * Unit tests for getTaskProgress - the pure function that derives
 * the discriminated-union display state from raw session, usage,
 * activity, and spawn progress data. Covers all state kinds plus edge cases.
 */
import { describe, it, expect } from 'vitest';
import { getTaskProgress } from '../../src/renderer/utils/task-progress';
import type { Session, SessionUsage, ActivityState } from '../../src/shared/types';

/** Minimal session factory - only fields that matter for the function. */
function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    taskId: 'task-1',
    projectId: 'proj-1',
    pid: 123,
    status: 'running',
    shell: 'bash',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: false,
    ...overrides,
  };
}

const MOCK_USAGE: SessionUsage = {
  contextWindow: {
    usedPercentage: 42,
    usedTokens: 1500,
    cacheTokens: 0,
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    contextWindowSize: 200000,
  },
  cost: { totalCostUsd: 0.05, totalDurationMs: 10000 },
  model: { id: 'claude-sonnet', displayName: 'Claude Sonnet' },
};

describe('getTaskProgress', () => {
  it('returns { kind: "none" } when no session and no spawn progress', () => {
    expect(getTaskProgress({})).toEqual({ kind: 'none' });
  });

  it('returns { kind: "preparing" } when spawn progress is set and no session', () => {
    expect(getTaskProgress({ spawnProgressLabel: 'Fetching latest...' }))
      .toEqual({ kind: 'preparing', label: 'Fetching latest...' });
  });

  it('returns { kind: "preparing" } with dynamic label from main process', () => {
    expect(getTaskProgress({ spawnProgressLabel: 'Creating worktree...' }))
      .toEqual({ kind: 'preparing', label: 'Creating worktree...' });
  });

  it('ignores spawn progress once session exists', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, spawnProgressLabel: 'Fetching latest...' });
    expect(result.kind).toBe('running');
  });

  it('returns { kind: "exited" } with explicit exitCode', () => {
    const session = makeSession({ status: 'exited', exitCode: 1 });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'exited', exitCode: 1 });
  });

  it('returns { kind: "exited", exitCode: 0 } when exitCode is null', () => {
    const session = makeSession({ status: 'exited', exitCode: null });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'exited', exitCode: 0 });
  });

  it('returns { kind: "suspended" }', () => {
    const session = makeSession({ status: 'suspended' });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'suspended' });
  });

  it('returns { kind: "queued" }', () => {
    const session = makeSession({ status: 'queued' });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'queued' });
  });

  it('defaults activity to "idle" when running with no activity signal', () => {
    const session = makeSession({ status: 'running' });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'running', activity: 'idle', usage: null });
  });

  it('defaults activity to "idle" when session is resuming (no usage)', () => {
    const session = makeSession({ status: 'running', resuming: true });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'running', activity: 'idle', usage: null });
  });

  it('returns { kind: "running" } when running with activity but no usage', () => {
    const session = makeSession({ status: 'running' });
    expect(getTaskProgress({ session, activity: 'idle' as ActivityState }))
      .toEqual({ kind: 'running', activity: 'idle', usage: null });
  });

  it('returns { kind: "running" } when running with usage', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE, activity: 'thinking' as ActivityState });
    expect(result).toEqual({ kind: 'running', activity: 'thinking', usage: MOCK_USAGE });
  });

  it('defaults activity to "idle" when activity is undefined', () => {
    // Regression: the old implementation defaulted to 'thinking' here,
    // which caused TaskCard to render a permanent spinner for any
    // session whose activity entry was missing from the main-side cache
    // (orphaned DB rows, HMR recovery gaps, listener reattach races).
    // A running session is always either thinking or idle; when we have
    // no signal, 'idle' is the safer default because a real thinking
    // session emits events quickly and self-corrects.
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE });
    expect(result).toEqual({ kind: 'running', activity: 'idle', usage: MOCK_USAGE });
  });

  it('preserves activity "idle" when explicitly set', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE, activity: 'idle' as ActivityState });
    expect(result).toEqual({ kind: 'running', activity: 'idle', usage: MOCK_USAGE });
  });
});

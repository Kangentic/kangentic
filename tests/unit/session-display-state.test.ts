/**
 * Unit tests for getTaskProgress -- the pure function that derives
 * the discriminated-union display state from raw session, usage,
 * activity, and spawn progress data. Covers all state kinds plus edge cases.
 */
import { describe, it, expect } from 'vitest';
import { getTaskProgress } from '../../src/renderer/utils/task-progress';
import type { Session, SessionUsage, ActivityState } from '../../src/shared/types';

/** Minimal session factory -- only fields that matter for the function. */
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
    expect(result.kind).toBe('initializing');
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

  it('returns { kind: "initializing" } with default label when running with no usage', () => {
    const session = makeSession({ status: 'running' });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'initializing', label: 'Starting agent...' });
  });

  it('returns "Resuming..." label when session is resuming', () => {
    const session = makeSession({ status: 'running', resuming: true });
    expect(getTaskProgress({ session }))
      .toEqual({ kind: 'initializing', label: 'Resuming...' });
  });

  it('returns "Running command..." label when pending command label is set', () => {
    const session = makeSession({ status: 'running' });
    expect(getTaskProgress({ session, pendingCommandLabel: '/code-review' }))
      .toEqual({ kind: 'initializing', label: 'Running command...' });
  });

  it('pending command label takes priority over resuming', () => {
    const session = makeSession({ status: 'running', resuming: true });
    expect(getTaskProgress({ session, pendingCommandLabel: '/test' }))
      .toEqual({ kind: 'initializing', label: 'Running command...' });
  });

  it('returns { kind: "initializing" } when running with activity but no usage', () => {
    const session = makeSession({ status: 'running' });
    expect(getTaskProgress({ session, activity: 'idle' as ActivityState }))
      .toEqual({ kind: 'initializing', label: 'Starting agent...' });
  });

  it('returns { kind: "running" } when running with usage', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE, activity: 'thinking' as ActivityState });
    expect(result).toEqual({ kind: 'running', activity: 'thinking', usage: MOCK_USAGE });
  });

  it('defaults activity to "thinking" when activity is undefined', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE });
    expect(result).toEqual({ kind: 'running', activity: 'thinking', usage: MOCK_USAGE });
  });

  it('preserves activity "idle" when explicitly set', () => {
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, usage: MOCK_USAGE, activity: 'idle' as ActivityState });
    expect(result).toEqual({ kind: 'running', activity: 'idle', usage: MOCK_USAGE });
  });
});

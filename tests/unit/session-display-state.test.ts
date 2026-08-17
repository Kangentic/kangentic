/**
 * Unit tests for getTaskProgress - the pure function that derives
 * the discriminated-union display state from raw session, usage,
 * activity, and spawn progress data. Covers all state kinds plus edge cases.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getTaskProgress,
  taskDetailSurfaceFor,
  isActiveKind,
  hasSessionLifecycle,
} from '../../src/renderer/utils/task-progress';
import type { Session, SessionUsage, ActivityState, SessionDisplayState } from '../../src/shared/types';

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

  it('ignores spawn progress once a LIVE session exists', () => {
    // A running session owns its own display; a stale label must never mask a
    // live agent.
    const session = makeSession({ status: 'running' });
    const result = getTaskProgress({ session, spawnProgressLabel: 'Fetching latest...' });
    expect(result.kind).toBe('running');
  });

  it('ignores spawn progress for a queued session', () => {
    const session = makeSession({ status: 'queued' });
    expect(getTaskProgress({ session, spawnProgressLabel: 'Creating worktree...' }).kind).toBe('queued');
  });

  // Restoring a task from Done deliberately preserves its suspended record for
  // the resume, so the old `!session` test threw the label away and the card sat
  // on "Paused" behind a manual "Resume session" button for the whole
  // worktree-recreate and CLI-boot window, while the engine was already
  // restoring the conversation. An in-flight spawn label is strictly newer
  // information than a record suspended earlier.
  it('prefers spawn progress over a SUSPENDED session (restore-from-Done is not "Paused")', () => {
    const session = makeSession({ status: 'suspended' });
    expect(getTaskProgress({ session, spawnProgressLabel: 'Creating worktree...' }))
      .toEqual({ kind: 'preparing', label: 'Creating worktree...' });
  });

  it('still reports suspended when no spawn is in flight', () => {
    const session = makeSession({ status: 'suspended' });
    expect(getTaskProgress({ session }).kind).toBe('suspended');
    expect(getTaskProgress({ session, spawnProgressLabel: null }).kind).toBe('suspended');
  });

  it('ignores spawn progress for an exited session', () => {
    // An exited session is terminal, not a restore in flight.
    const session = makeSession({ status: 'exited', exitCode: 0 });
    expect(getTaskProgress({ session, spawnProgressLabel: 'Creating worktree...' }).kind).toBe('exited');
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

describe('display-kind classifiers are total', () => {
  // The tables are `satisfies Record<SessionDisplayState['kind'], ...>`, so a new
  // kind fails `npm run typecheck` before it can reach here (verified by adding
  // a probe kind to the union: both tables error with the missing key named).
  // These cases pin the ANSWERS, which the compiler cannot check.
  const ALL_KINDS: SessionDisplayState['kind'][] = [
    'none', 'preparing', 'initializing', 'queued', 'running', 'suspended', 'exited',
  ];

  it('assigns every kind a task-detail surface', () => {
    for (const kind of ALL_KINDS) {
      expect(taskDetailSurfaceFor(kind)).toBeTruthy();
    }
  });

  it('routes only real terminal states to the terminal', () => {
    // 'preparing' is the load-bearing exclusion: during a restore the outgoing
    // session's id is still on the row, so a 'terminal' answer here paints a
    // dead shell over an agent that is being restored.
    expect(taskDetailSurfaceFor('running')).toBe('terminal');
    expect(taskDetailSurfaceFor('initializing')).toBe('terminal');
    expect(taskDetailSurfaceFor('preparing')).toBe('launch-overlay');
    expect(taskDetailSurfaceFor('queued')).toBe('queued-placeholder');
    expect(taskDetailSurfaceFor('suspended')).toBe('resume-prompt');
    expect(taskDetailSurfaceFor('none')).toBe('inert');
  });

  it('keeps a finished agent on the terminal, so its scrollback stays readable', () => {
    // Converting the old denylist (`kind !== 'queued' && kind !== 'suspended'`)
    // to this table must not narrow it beyond the one intended exclusion above.
    // 'exited' passed that gate, and the task detail is the ONLY surface that
    // shows it: the bottom panel tabs `status === 'running'` only
    // (panel-sessions.ts). Mapping it to 'inert' drops the user on "No active
    // session" and takes the record of why the agent stopped with it.
    expect(taskDetailSurfaceFor('exited')).toBe('terminal');
  });

  it('classifies the lifecycle phases the toggle reads', () => {
    expect(ALL_KINDS.filter(isActiveKind))
      .toEqual(['preparing', 'initializing', 'queued', 'running']);
    // Everything except the two terminal states has a session to talk about.
    expect(ALL_KINDS.filter(hasSessionLifecycle))
      .toEqual(['preparing', 'initializing', 'queued', 'running', 'suspended']);
  });
});

describe('every slow restore path reports spawn progress', () => {
  // The predicate above can only show "Resuming" if main actually sends a
  // label. Restoring from Done shipped without one: task-move.ts threaded
  // `onProgress` into its git helpers while task-archive.ts called the same
  // helpers with no options at all, so a restore was silent for its whole
  // worktree-recreate window and the card stayed on "Paused". Nothing but this
  // check couples the two halves, since the omission is an absent argument.
  const repoRoot = path.resolve(__dirname, '../..');
  const SLOW_GIT_HELPERS = ['ensureTaskWorktree', 'ensureTaskBranchCheckout'];

  it.each([
    ['src/main/ipc/handlers/task-archive.ts'],
    ['src/main/ipc/handlers/task-move.ts'],
  ])('%s passes onProgress to every slow git helper it awaits', (relativePath) => {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
    for (const helper of SLOW_GIT_HELPERS) {
      const calls = source.match(new RegExp(`await ${helper}\\([^;]*?\\);`, 'gs')) ?? [];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain('onProgress');
      }
    }
    // And the label is always retired, or a task that never reaches a live
    // session sits on "preparing" until the 120s TTL sweeps it.
    expect(source).toContain('clearSpawnProgress(');
  });
});

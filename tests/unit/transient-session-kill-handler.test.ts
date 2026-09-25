/**
 * Unit test for the SESSION_KILL_TRANSIENT handler wiring
 * (src/main/ipc/handlers/transient-sessions.ts).
 *
 * A Command Terminal has no task row and no DB persistence, so its lifecycle
 * lives entirely in this handler: kill the PTY, then reap the on-disk session
 * directory. That reap raced the process teardown (see pty-teardown-grace.md):
 * a young session's kill() waits out its exit-sequence grace before the real
 * force-kill lands, so deleting the directory synchronously right after kill()
 * could delete it out from under a still-exiting Claude, which then wrote its
 * SessionEnd hook output into a directory that no longer existed.
 *
 * The fix is the same kill -> capture awaitExit -> remove ordering already
 * pinned for the task-session teardown paths (project-relocate.test.ts,
 * project-open-lifecycle.test.ts, mcp-project-context.test.ts): awaitExit must
 * be captured BEFORE remove() deletes the registry row, because awaitExit
 * resolves at once for a row that is already gone. The directory delete itself
 * must wait on that captured promise, not run inline.
 *
 * Mocking pattern follows tests/unit/transient-session-set-label-handler.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const capturedHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      capturedHandlers.set(channel, handler);
    }),
  },
}));

const mockRmSync = vi.fn();

vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    rmSync: (...args: unknown[]) => mockRmSync(...args),
  },
}));

vi.mock('uuid', () => ({ v4: vi.fn(() => 'mock-transient-task-id') }));

vi.mock('simple-git', () => ({
  default: vi.fn(() => ({
    revparse: vi.fn(async () => 'main\n'),
    checkout: vi.fn(async () => undefined),
    merge: vi.fn(async () => undefined),
  })),
}));

vi.mock('../../src/main/git/fetch-throttle', () => ({
  fetchIfStale: vi.fn(async () => 'origin/main'),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/usage', () => ({
  trackFeatureUsed: vi.fn(),
}));

vi.mock('../../src/shared/git-utils', () => ({
  resolveProjectRoot: vi.fn((projectPath: string) => projectPath),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import { registerTransientSessionHandlers } from '../../src/main/ipc/handlers/transient-sessions';
import { IPC } from '../../src/shared/ipc-channels';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockSession {
  cwd: string;
  taskId: string;
  transient?: boolean;
}

interface MockContext {
  sessionManager: {
    getSession: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
    awaitExit: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

function createMockContext(session: MockSession | undefined, timeline: string[]): MockContext {
  return {
    sessionManager: {
      getSession: vi.fn(() => session),
      kill: vi.fn((sessionId: string) => { timeline.push(`kill:${sessionId}`); }),
      awaitExit: vi.fn((sessionId: string) => {
        timeline.push(`awaitExit:${sessionId}`);
        return Promise.resolve();
      }),
      remove: vi.fn((sessionId: string) => { timeline.push(`remove:${sessionId}`); }),
    },
  };
}

function getCapturedHandler(): (...args: unknown[]) => unknown {
  const handler = capturedHandlers.get(IPC.SESSION_KILL_TRANSIENT);
  if (!handler) throw new Error(`Handler for ${IPC.SESSION_KILL_TRANSIENT} was not registered`);
  return handler;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('SESSION_KILL_TRANSIENT handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedHandlers.clear();
  });

  it('registers a handler for the channel', () => {
    registerTransientSessionHandlers(createMockContext(undefined, []) as never);
    expect(capturedHandlers.has(IPC.SESSION_KILL_TRANSIENT)).toBe(true);
  });

  it('kills, captures awaitExit, and removes the session synchronously in that order', () => {
    // Red without this: a handler that calls remove() before capturing
    // awaitExit would still pass a test that only checks each mock was
    // called, since awaitExit(sessionId) called AFTER remove() looks
    // identical from the outside but resolves at once (the registry row is
    // already gone) instead of waiting for the real process exit.
    const timeline: string[] = [];
    const session: MockSession = { cwd: path.join('mock-root', 'project'), taskId: 'task-77', transient: true };
    const context = createMockContext(session, timeline);
    registerTransientSessionHandlers(context as never);

    getCapturedHandler()(null, 'sess-1');

    expect(timeline).toEqual(['kill:sess-1', 'awaitExit:sess-1', 'remove:sess-1']);
  });

  it('deletes the transient session directory only after the captured exit resolves, not at kill time', async () => {
    // Red without this: deleting the directory synchronously right after
    // kill() (the pre-fix shape) races a young session's exit-sequence grace,
    // and a still-exiting Claude's SessionEnd hook then writes into a
    // directory that no longer exists.
    const timeline: string[] = [];
    const projectRoot = path.join('mock-root', 'project');
    const session: MockSession = { cwd: projectRoot, taskId: 'task-77', transient: true };
    const context = createMockContext(session, timeline);
    const exitDeferred = createDeferred();
    context.sessionManager.awaitExit.mockImplementation((sessionId: string) => {
      timeline.push(`awaitExit:${sessionId}`);
      return exitDeferred.promise;
    });
    registerTransientSessionHandlers(context as never);

    getCapturedHandler()(null, 'sess-1');

    expect(timeline).toEqual(['kill:sess-1', 'awaitExit:sess-1', 'remove:sess-1']);
    expect(mockRmSync).not.toHaveBeenCalled();

    // Give any wrongly-inline delete a chance to have already happened before
    // asserting it did not; a couple of microtask ticks is enough for a
    // `.then()` chained directly off a resolved-at-call-time promise.
    await Promise.resolve();
    await Promise.resolve();
    expect(mockRmSync).not.toHaveBeenCalled();

    exitDeferred.resolve();
    await vi.waitFor(() => {
      expect(mockRmSync).toHaveBeenCalled();
    });

    expect(mockRmSync).toHaveBeenCalledTimes(1);
    expect(mockRmSync).toHaveBeenCalledWith(
      path.join(projectRoot, '.kangentic', 'sessions', 'task-77'),
      { recursive: true, force: true },
    );
  });

  it('does not touch the filesystem for a non-transient session, even after the exit resolves', async () => {
    const timeline: string[] = [];
    const session: MockSession = { cwd: path.join('mock-root', 'project'), taskId: 'task-77', transient: false };
    const context = createMockContext(session, timeline);
    registerTransientSessionHandlers(context as never);

    getCapturedHandler()(null, 'sess-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(mockRmSync).not.toHaveBeenCalled();
  });

  it('does not throw when the session is already gone (getSession returns undefined)', () => {
    const context = createMockContext(undefined, []);
    registerTransientSessionHandlers(context as never);

    expect(() => getCapturedHandler()(null, 'sess-missing')).not.toThrow();
    expect(mockRmSync).not.toHaveBeenCalled();
  });
});

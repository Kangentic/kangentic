/**
 * Tests that syncShutdownCleanup wires a UsageHistoryRepository instance into
 * the captureSessionMetrics call during the per-session shutdown loop.
 *
 * The shutdown path (src/main/shutdown.ts lines 70-80) constructs
 * UsageHistoryRepository from the project DB and forwards it through
 * captureSessionMetrics. A regression here (e.g. passing undefined or reverting
 * to the old 5-arg captureSessionMetrics signature) would silently drop
 * in-flight session metrics from the history on every clean app close.
 *
 * captureSessionMetrics is mocked so we can inspect its call arguments.
 * UsageHistoryRepository is also mocked (better-sqlite3 cannot load under
 * vitest); the mock records every constructed instance so the test can
 * assert the right one reached captureSessionMetrics as arg[2].
 *
 * SessionRepository.getLatestForTask is configured via a module-level fn ref
 * so each test can control what record the shutdown loop sees for the session.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import type { Session } from '../../src/shared/types';
import type { PtyKillReport } from '../../src/main/pty/shutdown/session-shutdown';

// ---------------------------------------------------------------------------
// Hoisted mocks (must appear before any import of the modules they mock)
// ---------------------------------------------------------------------------

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
  closeAll: vi.fn(),
}));

// getLatestForTask is configured per-test via the exported fn reference.
const mockGetLatestForTask = vi.fn(() => null as null | {
  id: string;
  status: string;
  agent_session_id: string | null;
  session_type: string | null;
  started_at: string;
});

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = mockGetLatestForTask;
    compareAndUpdateStatus = vi.fn(() => true);
    updateMetrics = vi.fn();
    updateStatus = vi.fn();
  },
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    update = vi.fn();
  },
}));

// Track instances created by the UsageHistoryRepository constructor so tests
// can verify the same instance was forwarded to captureSessionMetrics.
const createdHistoryInstances: object[] = [];

vi.mock('../../src/main/db/repositories/usage-history-repository', () => ({
  UsageHistoryRepository: class {
    constructor() {
      createdHistoryInstances.push(this);
    }
    recordSessionUsage = vi.fn();
    updateGitStats = vi.fn();
  },
}));

const mockCaptureSessionMetrics = vi.fn();
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({
  captureSessionMetrics: (...args: unknown[]) => mockCaptureSessionMetrics(...args),
  refineTranscriptTokens: vi.fn(),
  refineTranscriptToolCounts: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

// Mocked so the "destroyAllLanes was called" assertion below is observing a
// spy rather than the real lane manager (which would be a silent no-op here
// since no lane was ever opened - electron resolves to a path string outside
// a real Electron process, so the module loads but nothing in it can be
// asserted on without this mock).
vi.mock('../../src/main/browser/browser-lane-manager', () => ({
  destroyAllLanes: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks)
// ---------------------------------------------------------------------------

import { syncShutdownCleanup } from '../../src/main/shutdown';
import { destroyAllLanes } from '../../src/main/browser/browser-lane-manager';
import { closeAll } from '../../src/main/db/database';

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

function buildRunningSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'pty-abc',
    taskId: 'task-111',
    projectId: 'proj-1',
    status: 'running',
    command: 'claude',
    cwd: '/mock/project',
    ...overrides,
  } as Session;
}

function buildMockDependencies(
  sessions: Session[],
  ptyKillReport: PtyKillReport = { pids: [], killedCount: 0 },
) {
  // Stable diffWatcher stub so a test can assert closeAll() ran during cleanup.
  const diffWatcher = { closeAll: vi.fn() };
  return {
    getSessionManager: vi.fn(() => ({
      listSessions: vi.fn(() => sessions),
      killAll: vi.fn(() => ptyKillReport),
      dispose: vi.fn(),
      cancelAll: vi.fn(),
      getUsageCache: vi.fn(() => ({})),
      getToolCallCount: vi.fn(() => 0),
    })),
    getBoardConfigManager: vi.fn(() => ({
      detach: vi.fn(),
    })),
    getDiffWatcher: vi.fn(() => diffWatcher),
    getTerminalSubmitScheduler: vi.fn(() => ({
      cancelAll: vi.fn(),
    })),
    getCurrentProjectId: vi.fn(() => null),
    deleteProjectFromIndex: vi.fn(),
    stopUpdaterTimers: vi.fn(),
    stopAnnouncementTimers: vi.fn(),
    clearPendingTimers: vi.fn(),
    isEphemeral: false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('syncShutdownCleanup history wire-up', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createdHistoryInstances.length = 0;
  });

  it('constructs a UsageHistoryRepository and passes it as the third argument to captureSessionMetrics', () => {
    mockGetLatestForTask.mockReturnValue({
      id: 'record-001',
      status: 'running',
      agent_session_id: 'agent-aaa',
      session_type: 'claude_agent',
      started_at: '2026-01-01T10:00:00Z',
    });

    const session = buildRunningSession();
    const dependencies = buildMockDependencies([session]);

    syncShutdownCleanup(dependencies);

    // captureSessionMetrics must have been called once (for the one running session).
    expect(mockCaptureSessionMetrics).toHaveBeenCalledTimes(1);

    // Arg index 2 (zero-indexed) is the usageHistoryRepo parameter.
    const callArgs = mockCaptureSessionMetrics.mock.calls[0] as unknown[];
    const passedHistory = callArgs[2];

    // A UsageHistoryRepository instance must have been constructed and forwarded.
    expect(createdHistoryInstances).toHaveLength(1);
    expect(passedHistory).toBe(createdHistoryInstances[0]);
  });

  it('does NOT call captureSessionMetrics when no sessions are running', () => {
    const dependencies = buildMockDependencies([]);
    syncShutdownCleanup(dependencies);
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });

  it('closes the diff watchers so recursive fs.watch handles do not keep the process alive past quit', () => {
    const dependencies = buildMockDependencies([]);
    syncShutdownCleanup(dependencies);
    // getDiffWatcher returns the same stub on every call, so reading it here
    // gives the instance the cleanup path acted on.
    expect(dependencies.getDiffWatcher().closeAll).toHaveBeenCalledTimes(1);
  });

  it('stops the announcement poll timers so the 4-hour interval cannot fire during shutdown', () => {
    const dependencies = buildMockDependencies([]);
    syncShutdownCleanup(dependencies);
    expect(dependencies.stopAnnouncementTimers).toHaveBeenCalledTimes(1);
  });

  it('returns the kill report killAll produced, so the before-quit drain has something to wait on', () => {
    // Sentry DESKTOP-C: the drain that follows this cleanup holds the quit
    // until these children are gone. Swallowing killAll's return value here
    // would silently disarm it and leave every quit racing node-pty's exit
    // callback against Node teardown again.
    const dependencies = buildMockDependencies([], { pids: [4242, 4343], killedCount: 2 });
    expect(syncShutdownCleanup(dependencies)).toEqual({ pids: [4242, 4343], killedCount: 2 });
  });

  it('returns a zero report when there was nothing to kill', () => {
    const dependencies = buildMockDependencies([]);
    expect(syncShutdownCleanup(dependencies)).toEqual({ pids: [], killedCount: 0 });
  });

  /**
   * The mechanical guard for runCleanupStep. The behavioural test below proves
   * the wrapper works on ONE step; this proves nobody added an unwrapped
   * twelfth. A bare call before the kill puts every PTY back at risk: its throw
   * lands in the function's outer catch, killAll never runs, node-pty's
   * ThreadSafeFunction finalizer joins the thread waiting on the child, and
   * Electron's teardown hangs until the 6s hard failsafe force-exits with 1.
   */
  it('routes every pre-kill cleanup step through runCleanupStep', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/main/shutdown.ts'),
      'utf-8',
    );

    // A line-based regex scan only catches a bare call that opens and closes
    // on one line. It misses a multi-line call (the closing line starts with
    // `)` or an argument, not an identifier) and a declaration-initializer
    // call (`const thing = dependencies.getThing();` starts with `const `,
    // not an identifier followed by `(`). Parsing the real AST makes the scan
    // shape-proof instead of line-proof: it classifies statements by kind, so
    // line breaks and indentation cannot hide a call from it.
    const sourceFile = ts.createSourceFile(
      'shutdown.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
    );

    const cleanupFunction = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === 'syncShutdownCleanup',
    );
    expect(cleanupFunction, 'syncShutdownCleanup must exist').toBeDefined();
    expect(cleanupFunction?.body, 'syncShutdownCleanup must have a function body').toBeDefined();

    interface BareCallFinding {
      line: number;
      statementText: string;
    }

    // The one bare call the pre-kill region allows. It is not a cleanup step:
    // a throw here leaves no manager to kill PTYs with either way, so
    // wrapping it would only move the same outcome behind a log line (see the
    // comment above the call site in shutdown.ts). Allowed by its exact
    // declared name rather than by allowing every declaration - allowing all
    // declarations would let a second `const other = dependencies.getY();`
    // back in unwrapped, which is exactly the hole this guard exists to close.
    const allowedBareDeclarationName = 'sessionManager';

    const bareCalls: BareCallFinding[] = [];

    function recordBareCall(statement: ts.Statement): void {
      const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
      bareCalls.push({
        line: line + 1,
        statementText: statement.getText(sourceFile).split('\n')[0].trim(),
      });
    }

    /**
     * Walks a statement list depth-first, following into try blocks and if
     * branches so a step nested one level deeper than the function body is
     * still scanned, without descending into an already-wrapped
     * runCleanupStep callback - that would rescan content this guard has
     * already approved via its wrapper.
     *
     * Returns true once it reaches the statement that performs the PTY kill,
     * so the caller stops scanning there: everything from that point on is
     * the kill itself and the steps that follow it, which are out of scope
     * for this guard.
     */
    function scanForBareCallsBeforeKill(statements: readonly ts.Statement[]): boolean {
      for (const statement of statements) {
        if (ts.isTryStatement(statement)) {
          if (scanForBareCallsBeforeKill(statement.tryBlock.statements)) return true;
          continue;
        }
        if (ts.isIfStatement(statement)) {
          if (
            ts.isBlock(statement.thenStatement) &&
            scanForBareCallsBeforeKill(statement.thenStatement.statements)
          ) {
            return true;
          }
          if (
            statement.elseStatement &&
            ts.isBlock(statement.elseStatement) &&
            scanForBareCallsBeforeKill(statement.elseStatement.statements)
          ) {
            return true;
          }
          continue;
        }

        // Checked before classification, and only for a leaf statement (a
        // container's own text would already include everything nested
        // inside it, including a kill call several statements deeper).
        if (statement.getText(sourceFile).includes('sessionManager.killAll()')) {
          return true;
        }

        if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
          const calleeText = statement.expression.expression.getText(sourceFile);
          const isAllowedCall = calleeText === 'runCleanupStep' || calleeText.startsWith('console.');
          if (!isAllowedCall) {
            recordBareCall(statement);
          }
          continue;
        }

        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (!declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
            const isAllowedDeclaration =
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === allowedBareDeclarationName;
            if (!isAllowedDeclaration) {
              recordBareCall(statement);
            }
          }
          continue;
        }
      }
      return false;
    }

    const killStatementFound = scanForBareCallsBeforeKill(cleanupFunction!.body!.statements);
    expect(
      killStatementFound,
      'the PTY kill must still be a direct call, so this scan has a pre-kill region to check',
    ).toBe(true);

    expect(
      bareCalls,
      'every cleanup step before the PTY kill must be wrapped in runCleanupStep(name, fn); an ' +
        'unwrapped call that throws aborts the whole try and leaves every PTY alive. Offending ' +
        `statements: ${bareCalls.map((finding) => `line ${finding.line}: ${finding.statementText}`).join('; ')}`,
    ).toEqual([]);
  });

  it('passes the kills it cannot probe through, not just the pids', () => {
    // A shutdown.ts that still returned number[], or that rebuilt the report as
    // { pids, killedCount: pids.length }, drops these three kills on the floor
    // and the before-quit handler skips the drain for the whole shutdown.
    const dependencies = buildMockDependencies([], { pids: [], killedCount: 3 });
    expect(syncShutdownCleanup(dependencies)).toEqual({ pids: [], killedCount: 3 });
  });

  /**
   * Red-green for runCleanupStep. The PTY kill is the load-bearing step: an
   * unkilled PTY hangs Electron's teardown until the 6s hard failsafe, because
   * node-pty's ThreadSafeFunction finalizer joins the thread waiting on the
   * child. Before the wrapper, a throw from ANY earlier handle-closer landed in
   * the function's outer catch and left every PTY alive.
   */
  it('still kills the PTYs when an earlier cleanup step throws', () => {
    const dependencies = buildMockDependencies([], { pids: [4242], killedCount: 1 });
    const sessionManager = dependencies.getSessionManager();
    dependencies.getSessionManager.mockReturnValue(sessionManager);
    dependencies.getDiffWatcher.mockImplementation(() => {
      throw new Error('watcher already torn down');
    });

    expect(syncShutdownCleanup(dependencies)).toEqual({ pids: [4242], killedCount: 1 });
    expect(sessionManager.killAll).toHaveBeenCalledTimes(1);
  });

  /**
   * The four steps at the very top of syncShutdownCleanup (clearPendingTimers,
   * stopUpdaterTimers, stopAnnouncementTimers, stopMetricsSnapshotTimer) used to
   * run with NO try/catch around them at all - not even the outer one that
   * guards everything else in this function. A throw from any of them
   * propagated straight out of syncShutdownCleanup, through performShutdown()
   * in src/main/index.ts (which only assigns this function's return value and
   * has no try/catch of its own), and into whichever caller invoked
   * performShutdown(): the before-quit handler's `dependencies.performShutdown()`
   * call has no try/catch either (see before-quit-drain-wiring.test.ts). That
   * escape would have skipped the PTY kill, the drain, and the re-quit
   * entirely, surfacing as an uncaught exception during Electron's own quit
   * sequence instead of a logged, contained failure.
   *
   * Reverting one of these four calls to a bare `dependencies.clearPendingTimers();`
   * is already caught by the AST scan below (it walks every top-level statement
   * in the function, not only the ones inside the try block). What the scan
   * cannot see is `runCleanupStep('clearPendingTimers', dependencies.clearPendingTimers())` -
   * eager invocation passed as the argument expression, which still textually
   * calls `runCleanupStep` and passes the scan, but runs the real work OUTSIDE
   * the try/catch runCleanupStep provides. Only a throwing mock, driven through
   * the real function, can catch that class of regression.
   */
  it('does not let a step before the try block escape uncaught and skip the PTY kill entirely', () => {
    const dependencies = buildMockDependencies([], { pids: [4242], killedCount: 1 });
    dependencies.clearPendingTimers.mockImplementation(() => {
      throw new Error('timer already cleared');
    });

    let report: PtyKillReport | undefined;
    expect(() => {
      report = syncShutdownCleanup(dependencies);
    }).not.toThrow();
    expect(report).toEqual({ pids: [4242], killedCount: 1 });
  });

  /**
   * Sentry DESKTOP-9: the global index DB can be read-only. Pre-diff,
   * `deleteProjectFromIndex` and `closeAll()` were adjacent statements inside
   * the one big try block (see the diff for src/main/shutdown.ts), so a throw
   * from the former jumped straight to the outer catch and `closeAll()` was
   * never reached - leaking the open SQLite handles that keep the libuv loop
   * alive past a clean quit, until the 6s hard failsafe force-exits with code
   * 1. docs/session-lifecycle.md's "Steps 7 and 8 are wrapped too" note names
   * exactly this case. No existing test asserts the database `closeAll()`
   * (imported from db/database) is ever called at all.
   */
  it('still closes database connections when deleting an ephemeral project from the index throws (Sentry DESKTOP-9: a read-only global index DB)', () => {
    const dependencies = buildMockDependencies([], { pids: [], killedCount: 0 });
    dependencies.isEphemeral = true;
    dependencies.getCurrentProjectId.mockReturnValue('proj-ephemeral');
    dependencies.deleteProjectFromIndex.mockImplementation(() => {
      throw new Error('SQLITE_READONLY: attempt to write a readonly database');
    });

    expect(() => syncShutdownCleanup(dependencies)).not.toThrow();
    expect(closeAll).toHaveBeenCalledTimes(1);
  });

  it('does NOT call captureSessionMetrics for queued sessions (never spawned - nothing to capture)', () => {
    mockGetLatestForTask.mockReturnValue({
      id: 'record-002',
      status: 'queued',
      agent_session_id: null,
      session_type: null,
      started_at: '2026-01-01T10:00:00Z',
    });

    // SessionManager.listSessions returns the session with status 'queued'.
    const session = buildRunningSession({ status: 'queued' });
    const dependencies = buildMockDependencies([session]);

    syncShutdownCleanup(dependencies);

    // Queued sessions are marked exited but never go through captureSessionMetrics.
    expect(mockCaptureSessionMetrics).not.toHaveBeenCalled();
  });
});

describe('syncShutdownCleanup lane cleanup wiring (red-green)', () => {
  // This describe is a sibling of 'syncShutdownCleanup history wire-up' above,
  // so it does not inherit that block's beforeEach - clear the spy explicitly
  // or an earlier test's syncShutdownCleanup call inflates this count.
  beforeEach(() => {
    vi.mocked(destroyAllLanes).mockClear();
  });

  // Pins that shutdown.ts still calls destroyAllLanes(). Nothing else in the
  // suite exercises this call site: browser-lane-manager.test.ts proves
  // destroyAllLanes ITSELF tears down every lane window, but nothing asserted
  // that syncShutdownCleanup actually reaches for it - deleting the call
  // (src/main/shutdown.ts) would leak every offscreen lane window on quit and
  // every existing test here would stay green.
  it('destroys every offscreen browser lane exactly once during shutdown', () => {
    const dependencies = buildMockDependencies([]);

    syncShutdownCleanup(dependencies);

    expect(destroyAllLanes).toHaveBeenCalledTimes(1);
  });
});

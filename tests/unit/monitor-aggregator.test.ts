/**
 * Unit tests for `buildMonitorSnapshot` in
 * src/main/monitor/monitor-aggregator.ts (the cross-project Agent Monitor
 * aggregator).
 *
 * Pattern mirrors task-archive-handler.test.ts: the modules
 * monitor-aggregator.ts imports at runtime (db/database, the session
 * repository, and the getProjectRepos helper) are replaced with lightweight
 * fakes so the only real code under test is monitor-aggregator.ts itself -
 * no Electron, no real SQLite, no filesystem.
 *
 * Covers:
 *   - a project whose DB cannot be resolved is excluded (not thrown), and
 *     resolveProject's failure is cached: a broken project is resolved
 *     exactly once even when several of its sessions are listed
 *   - a Command Terminal (transient) session produces a row and SKIPS the
 *     task lookup entirely; the row's non-nullable fields are populated with
 *     the exact synthetic values the source assigns for a taskless session
 *   - a non-transient session whose task row is gone (deleted while the
 *     session lives) is dropped, not defaulted
 *   - the recently-finished window: an exited session older than
 *     RECENTLY_FINISHED_WINDOW_MS is dropped, one inside the window
 *     survives, and an exited session with a NULL exitedAt is kept
 *     (undateable, so it is not silently hidden)
 *   - the recently-finished cap: exited rows beyond RECENTLY_FINISHED_CAP are
 *     trimmed oldest-first, every live (non-exited) row survives regardless
 *     of count, and a null-exitedAt exited row sorts as newest so it is not
 *     the one culled
 *   - generatedAt is a UTC ISO 8601 timestamp captured at call time
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ActivityReason,
  ActivityState,
  MonitorSessionRow,
  Project,
  SessionEvent,
  SessionStatus,
  SessionUsage,
  Task,
} from '../../src/shared/types';
import type { ManagedSessionSummary } from '../../src/main/pty/session-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

// ---------------------------------------------------------------------------
// Hoisted mocks
//
// monitor-aggregator.ts's only runtime imports are getProjectDb,
// SessionRepository, and getProjectRepos - everything else it touches
// (IpcContext, MonitorSessionRow, ...) is a type-only import. Mocking these
// three modules is therefore sufficient; getProjectRepos's own real
// transitive imports (task-repository, swimlane-repository, ...) never load
// because the whole module is replaced.
//
// Variables referenced inside a vi.mock factory must be named with a
// leading "mock" - Vitest's hoisting transform only special-cases that
// prefix when it moves vi.mock calls above the file's other top-level code.
// ---------------------------------------------------------------------------

const mockGetProjectDb = vi.fn();
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (...args: unknown[]) => mockGetProjectDb(...args),
}));

interface FakeSessionRecord {
  exited_at: string | null;
  applied_model: string | null;
  applied_effort: string | null;
  permission_mode: string | null;
}

const mockSessionRecordsByKey = new Map<string, FakeSessionRecord>();

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    private readonly projectId: string;
    constructor(db: { projectId: string }) {
      this.projectId = db.projectId;
    }
    findByAnyId(sessionId: string): FakeSessionRecord | undefined {
      return mockSessionRecordsByKey.get(`${this.projectId}:${sessionId}`);
    }
  },
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
}));

// ---------------------------------------------------------------------------
// Import under test (after all mocks are registered)
// ---------------------------------------------------------------------------

import {
  buildMonitorSnapshot,
  RECENTLY_FINISHED_CAP,
  RECENTLY_FINISHED_WINDOW_MS,
} from '../../src/main/monitor/monitor-aggregator';

// ---------------------------------------------------------------------------
// Fixture registries (populated per test, read by the mocked implementations
// above) and the FakeProjectRepos shape getProjectRepos resolves to.
// ---------------------------------------------------------------------------

interface FakeProjectRepos {
  tasks: { getById: (id: string) => Task | undefined };
  swimlanes: { list: () => Array<{ id: string; name: string }> };
  actions: object;
  attachments: object;
}

const projectRowsById = new Map<string, Project>();
const projectReposById = new Map<string, FakeProjectRepos>();

mockGetProjectDb.mockImplementation((projectId: string) => ({ projectId }));
mockGetProjectRepos.mockImplementation((_context: unknown, projectId: string) => {
  const repos = projectReposById.get(projectId);
  if (!repos) {
    // Mirrors the real failure mode this simulates: the project row exists
    // but its DB cannot be opened (moved on disk, corrupt).
    throw new Error(`[test] simulated DB-open failure for project ${projectId}`);
  }
  return repos;
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/mock/projects/${id}`,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    display_id: 1,
    title: `Task ${id}`,
    description: '',
    swimlane_id: 'swimlane-todo',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    profile_id: null,
    run_mode: 'column_settings',
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeManagedSummary(overrides: {
  id: string;
  projectId: string;
  taskId: string;
  status?: SessionStatus;
  startedAt?: string;
  exitCode?: number | null;
  agentName?: string | null;
  isolatedSwimlaneId?: string | null;
  transient?: boolean;
}): ManagedSessionSummary {
  return {
    id: overrides.id,
    projectId: overrides.projectId,
    taskId: overrides.taskId,
    status: overrides.status ?? 'running',
    startedAt: overrides.startedAt ?? '2026-01-01T00:00:00.000Z',
    exitCode: overrides.exitCode ?? null,
    agentName: overrides.agentName ?? 'claude',
    isolatedSwimlaneId: overrides.isolatedSwimlaneId ?? null,
    transient: overrides.transient ?? false,
  };
}

/** Registers a project row AND its repos, i.e. a project whose DB opens fine. */
function registerHealthyProject(
  projectId: string,
  options: { tasksById?: Map<string, Task>; swimlanes?: Array<{ id: string; name: string }> } = {},
): { tasksGetById: ReturnType<typeof vi.fn>; swimlanesList: ReturnType<typeof vi.fn> } {
  const tasksById = options.tasksById ?? new Map<string, Task>();
  const swimlanes = options.swimlanes ?? [];
  const tasksGetById = vi.fn((id: string) => tasksById.get(id));
  const swimlanesList = vi.fn(() => swimlanes);

  projectRowsById.set(projectId, makeProject(projectId));
  projectReposById.set(projectId, {
    tasks: { getById: tasksGetById },
    swimlanes: { list: swimlanesList },
    actions: {},
    attachments: {},
  });

  return { tasksGetById, swimlanesList };
}

/** Registers only the project ROW - its repos are deliberately absent, so
 *  getProjectRepos (mocked above) throws for it, simulating a corrupt/moved DB. */
function registerBrokenProject(projectId: string): void {
  projectRowsById.set(projectId, makeProject(projectId));
}

function registerSessionRecord(projectId: string, sessionId: string, record: FakeSessionRecord): void {
  mockSessionRecordsByKey.set(`${projectId}:${sessionId}`, record);
}

function makeContext(summaries: ManagedSessionSummary[]): IpcContext {
  return {
    projectRepo: {
      getById: vi.fn((id: string) => projectRowsById.get(id)),
    },
    sessionManager: {
      listManagedSummaries: vi.fn(() => summaries),
      getActivityCache: vi.fn((): Record<string, ActivityState> => ({})),
      getActivityReasonsCache: vi.fn((): Record<string, ActivityReason> => ({})),
      getEventsCache: vi.fn((): Record<string, SessionEvent[]> => ({})),
      getUsageCache: vi.fn((): Record<string, SessionUsage> => ({})),
    },
  } as unknown as IpcContext;
}

/** Every field MonitorSessionRow declares as non-nullable must never come out
 *  `undefined` - `null` is a legitimate value for the nullable fields, but a
 *  bare `undefined` on ANY field means a lookup fell through with no default. */
function expectNoUndefinedFields(row: MonitorSessionRow): void {
  for (const [fieldName, value] of Object.entries(row)) {
    expect(value, `field "${fieldName}" must not be undefined`).not.toBeUndefined();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildMonitorSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRowsById.clear();
    projectReposById.clear();
    mockSessionRecordsByKey.clear();
    mockGetProjectDb.mockImplementation((projectId: string) => ({ projectId }));
    mockGetProjectRepos.mockImplementation((_context: unknown, projectId: string) => {
      const repos = projectReposById.get(projectId);
      if (!repos) {
        throw new Error(`[test] simulated DB-open failure for project ${projectId}`);
      }
      return repos;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('excludes a project whose DB cannot be resolved without throwing, and resolves the failure only once across several of its sessions', () => {
    registerHealthyProject('project-healthy', {
      tasksById: new Map([['task-healthy-1', makeTask('task-healthy-1')]]),
    });
    registerBrokenProject('project-broken');

    const summaries = [
      makeManagedSummary({ id: 'session-healthy-1', projectId: 'project-healthy', taskId: 'task-healthy-1' }),
      makeManagedSummary({ id: 'session-broken-1', projectId: 'project-broken', taskId: 'task-broken-1' }),
      makeManagedSummary({ id: 'session-broken-2', projectId: 'project-broken', taskId: 'task-broken-2' }),
      makeManagedSummary({ id: 'session-broken-3', projectId: 'project-broken', taskId: 'task-broken-3' }),
    ];
    const context = makeContext(summaries);

    let snapshot: ReturnType<typeof buildMonitorSnapshot> | undefined;
    expect(() => {
      snapshot = buildMonitorSnapshot(context);
    }).not.toThrow();

    // Only the healthy project's session survives.
    expect(snapshot!.rows).toHaveLength(1);
    expect(snapshot!.rows[0].sessionId).toBe('session-healthy-1');
    expect(snapshot!.rows[0].projectId).toBe('project-healthy');

    // resolveProject must have been invoked for the broken project exactly
    // once, even though 3 of its sessions were listed - a retry-per-session
    // implementation would hammer a broken DB on every call.
    const brokenProjectCalls = mockGetProjectRepos.mock.calls.filter(
      (call) => call[1] === 'project-broken',
    );
    expect(brokenProjectCalls).toHaveLength(1);

    // The failure is logged, not swallowed silently mid-loop.
    expect(console.error).toHaveBeenCalled();
  });

  it('produces a row for a Command Terminal (transient) session and skips the task lookup entirely', () => {
    const { tasksGetById } = registerHealthyProject('project-a');

    const summaries = [
      makeManagedSummary({
        id: 'session-ct-1',
        projectId: 'project-a',
        taskId: 'command-terminal:project-a:slot-1',
        transient: true,
        status: 'running',
      }),
    ];
    const context = makeContext(summaries);

    const snapshot = buildMonitorSnapshot(context);

    expect(tasksGetById).not.toHaveBeenCalled();

    expect(snapshot.rows).toHaveLength(1);
    const row = snapshot.rows[0];
    expectNoUndefinedFields(row);

    expect(row.isCommandTerminal).toBe(true);
    expect(row.taskId).toBe('command-terminal:project-a:slot-1');
    // Exact synthetic values monitor-aggregator.ts assigns when `task` is
    // undefined (task?.x ?? <default>), read from the source rather than
    // assumed:
    expect(row.taskTitle).toBe('Command Terminal');
    expect(row.taskDescription).toBeNull();
    expect(row.displayId).toBeNull();
    expect(row.columnName).toBe('');
    expect(row.labels).toEqual([]);
    expect(row.prUrl).toBeNull();
    expect(row.prNumber).toBeNull();
    expect(row.prState).toBeNull();
  });

  it('drops a non-transient session whose task row is gone (deleted while the session lives)', () => {
    registerHealthyProject('project-a', {
      tasksById: new Map(), // no task rows at all - getById always returns undefined
    });

    const summaries = [
      makeManagedSummary({
        id: 'session-orphaned',
        projectId: 'project-a',
        taskId: 'task-deleted',
        transient: false,
        status: 'running',
      }),
    ];
    const context = makeContext(summaries);

    const snapshot = buildMonitorSnapshot(context);

    expect(snapshot.rows).toHaveLength(0);
  });

  it('recently-finished window: drops an exited session older than the window, keeps one inside the window, and keeps an undateable (null exitedAt) exited session', () => {
    registerHealthyProject('project-a', {
      tasksById: new Map([
        ['task-old', makeTask('task-old')],
        ['task-recent', makeTask('task-recent')],
        ['task-undateable', makeTask('task-undateable')],
      ]),
    });

    const now = Date.now();
    const oldExitedAt = new Date(now - RECENTLY_FINISHED_WINDOW_MS - 5 * 60 * 1000).toISOString();
    const recentExitedAt = new Date(now - RECENTLY_FINISHED_WINDOW_MS + 5 * 60 * 1000).toISOString();

    registerSessionRecord('project-a', 'session-old', {
      exited_at: oldExitedAt,
      applied_model: null,
      applied_effort: null,
      permission_mode: null,
    });
    registerSessionRecord('project-a', 'session-recent', {
      exited_at: recentExitedAt,
      applied_model: null,
      applied_effort: null,
      permission_mode: null,
    });
    // session-undateable deliberately has NO session record registered, so
    // findByAnyId returns undefined and exitedAt resolves to null - the
    // "cannot date it" case the window filter must keep rather than hide.

    const summaries = [
      makeManagedSummary({ id: 'session-old', projectId: 'project-a', taskId: 'task-old', status: 'exited' }),
      makeManagedSummary({ id: 'session-recent', projectId: 'project-a', taskId: 'task-recent', status: 'exited' }),
      makeManagedSummary({ id: 'session-undateable', projectId: 'project-a', taskId: 'task-undateable', status: 'exited' }),
    ];
    const context = makeContext(summaries);

    const snapshot = buildMonitorSnapshot(context);
    const sessionIds = snapshot.rows.map((row) => row.sessionId);

    expect(sessionIds).not.toContain('session-old');
    expect(sessionIds).toContain('session-recent');
    expect(sessionIds).toContain('session-undateable');
    expect(snapshot.rows).toHaveLength(2);

    const undateableRow = snapshot.rows.find((row) => row.sessionId === 'session-undateable');
    expect(undateableRow?.exitedAt).toBeNull();
  });

  it('recently-finished cap: trims exited rows past the cap by oldest exitedAt, keeps every live row regardless of count, and treats a null exitedAt as newest', () => {
    const tasksById = new Map<string, Task>();
    const liveSessionCount = 3;
    // One exited entry has no session record (null exitedAt); the rest are
    // dated, spaced 5s apart so all comfortably sit inside the
    // recently-finished window and only capRecentlyFinished's own trim can
    // be responsible for any exclusion. Together with the null-exitedAt row
    // this totals CAP + 1 exited rows, one over the cap, so exactly one
    // (the single oldest) must be culled.
    const datedExitedCount = RECENTLY_FINISHED_CAP;

    const summaries: ManagedSessionSummary[] = [];

    for (let index = 0; index < liveSessionCount; index++) {
      const taskId = `task-live-${index}`;
      tasksById.set(taskId, makeTask(taskId));
      summaries.push(
        makeManagedSummary({ id: `session-live-${index}`, projectId: 'project-a', taskId, status: 'running' }),
      );
    }

    const nullExitedTaskId = 'task-exited-null';
    tasksById.set(nullExitedTaskId, makeTask(nullExitedTaskId));
    summaries.push(
      makeManagedSummary({ id: 'session-exited-null', projectId: 'project-a', taskId: nullExitedTaskId, status: 'exited' }),
    );
    // No session record registered for session-exited-null -> exitedAt is
    // null -> capRecentlyFinished must sort it as the NEWEST entry.

    const now = Date.now();
    for (let index = 1; index <= datedExitedCount; index++) {
      const sessionId = `session-exited-${index}`;
      const taskId = `task-exited-${index}`;
      tasksById.set(taskId, makeTask(taskId));
      summaries.push(
        makeManagedSummary({ id: sessionId, projectId: 'project-a', taskId, status: 'exited' }),
      );
      // Larger index = further in the past = older.
      registerSessionRecord('project-a', sessionId, {
        exited_at: new Date(now - index * 5000).toISOString(),
        applied_model: null,
        applied_effort: null,
        permission_mode: null,
      });
    }

    registerHealthyProject('project-a', { tasksById });
    const context = makeContext(summaries);

    const snapshot = buildMonitorSnapshot(context);
    const sessionIds = new Set(snapshot.rows.map((row) => row.sessionId));

    // Every live row survives no matter how many exited rows compete for the cap.
    for (let index = 0; index < liveSessionCount; index++) {
      expect(sessionIds.has(`session-live-${index}`)).toBe(true);
    }

    // The undateable (null exitedAt) exited row is treated as newest, so it
    // always survives the trim.
    expect(sessionIds.has('session-exited-null')).toBe(true);

    // Exactly RECENTLY_FINISHED_CAP exited rows survive in total.
    const survivingExitedCount = snapshot.rows.filter((row) => row.status === 'exited').length;
    expect(survivingExitedCount).toBe(RECENTLY_FINISHED_CAP);

    // The single oldest dated entry (largest index) is the one dropped: with
    // datedExitedCount = CAP dated rows plus 1 null-exitedAt row (which never
    // competes for the "oldest" slot, since it sorts as newest), that is
    // exactly CAP + 1 exited rows total, one over the cap.
    expect(sessionIds.has(`session-exited-${datedExitedCount}`)).toBe(false);
    // The freshest dated row always survives.
    expect(sessionIds.has('session-exited-1')).toBe(true);
  });

  it('generatedAt is a UTC ISO 8601 timestamp captured at call time', () => {
    registerHealthyProject('project-a');
    const context = makeContext([]);

    const before = Date.now();
    const snapshot = buildMonitorSnapshot(context);
    const after = Date.now();

    expect(snapshot.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const generatedAtMs = Date.parse(snapshot.generatedAt);
    expect(generatedAtMs).toBeGreaterThanOrEqual(before);
    expect(generatedAtMs).toBeLessThanOrEqual(after);
  });
});

/**
 * What a user loses without this file: the Agent Monitor cannot show a task's
 * priority on its card, list row or table, because the row would carry no
 * priority or the wrong one. It pins `MonitorSessionRow.priority` in
 * `buildMonitorSnapshot`: a task session carries its task's priority, and a
 * Command Terminal (which has no task) reads 0.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ActivityReason,
  ActivityState,
  Project,
  SessionEvent,
  SessionUsage,
  Task,
} from '../../src/shared/types';
import type { ManagedSessionSummary } from '../../src/main/pty/session-registry';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { MonitorSnapshotSources } from '../../src/main/monitor/monitor-snapshot-sources';
import type { StepColumn } from '../../src/shared/workflow-route';

const mockGetProjectDb = vi.fn();
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: (...args: unknown[]) => mockGetProjectDb(...args),
}));

vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    findByAnyId(): undefined {
      return undefined;
    }
  },
}));

const mockGetProjectRepos = vi.fn();
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
}));

import { buildMonitorSnapshot } from '../../src/main/monitor/monitor-aggregator';

const PROJECT_ID = 'project-a';

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
    pr_merge_readiness: null,
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

function makeSummary(overrides: Partial<ManagedSessionSummary> & Pick<ManagedSessionSummary, 'id' | 'taskId'>): ManagedSessionSummary {
  return {
    startBlockedReason: null,
    projectId: PROJECT_ID,
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    exitCode: null,
    agentName: 'claude',
    isolatedSwimlaneId: null,
    transient: false,
    commandTerminalSlot: null,
    commandTerminalBranch: null,
    commandTerminalLabel: null,
    ...overrides,
  };
}

function makeContext(summaries: ManagedSessionSummary[]): IpcContext {
  const project = { id: PROJECT_ID, name: 'Project A', path: '/mock/projects/a' } as Project;
  return {
    projectRepo: { getById: vi.fn(() => project) },
    sessionManager: {
      listManagedSummaries: vi.fn(() => summaries),
      getActivityCache: vi.fn((): Record<string, ActivityState> => ({})),
      getActivityReasonsCache: vi.fn((): Record<string, ActivityReason> => ({})),
      getEventsCache: vi.fn((): Record<string, SessionEvent[]> => ({})),
      getUsageCache: vi.fn((): Record<string, SessionUsage> => ({})),
      getOutputPeek: vi.fn((): string[] => []),
    },
  } as unknown as IpcContext;
}

function makeSources(): MonitorSnapshotSources {
  return {
    browserTaskIds: () => new Set<string>(),
    readWorkflow: vi.fn(() => null),
  };
}

function registerProject(tasksById: Map<string, Task>): void {
  const swimlanes: StepColumn[] = [];
  mockGetProjectRepos.mockImplementation(() => ({
    tasks: { getById: (id: string) => tasksById.get(id) },
    swimlanes: { list: () => swimlanes },
    actions: {},
    attachments: {},
  }));
}

describe('buildMonitorSnapshot - priority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetProjectDb.mockImplementation((projectId: string) => ({ projectId }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('carries the task\'s priority onto its row', async () => {
    registerProject(new Map([['task-a', makeTask('task-a', { priority: 3 })]]));
    const context = makeContext([makeSummary({ id: 'session-a', taskId: 'task-a' })]);

    const snapshot = await buildMonitorSnapshot(context, makeSources());

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].priority).toBe(3);
  });

  it('keeps each task\'s own priority when several sessions share a snapshot', async () => {
    registerProject(new Map([
      ['task-low', makeTask('task-low', { priority: 1 })],
      ['task-high', makeTask('task-high', { priority: 4 })],
    ]));
    const context = makeContext([
      makeSummary({ id: 'session-low', taskId: 'task-low' }),
      makeSummary({ id: 'session-high', taskId: 'task-high' }),
    ]);

    const snapshot = await buildMonitorSnapshot(context, makeSources());

    const rowsBySession = new Map(snapshot.rows.map((row) => [row.sessionId, row]));
    expect(rowsBySession.get('session-low')?.priority).toBe(1);
    expect(rowsBySession.get('session-high')?.priority).toBe(4);
  });

  it('reads 0 for a Command Terminal row, which has no task', async () => {
    registerProject(new Map());
    const context = makeContext([
      makeSummary({
        id: 'session-ct',
        taskId: 'command-terminal:project-a:slot-1',
        transient: true,
        commandTerminalSlot: 'slot-1',
      }),
    ]);

    const snapshot = await buildMonitorSnapshot(context, makeSources());

    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0].priority).toBe(0);
  });
});

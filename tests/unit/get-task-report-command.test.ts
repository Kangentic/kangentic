/**
 * `get_task_report` (`src/main/agent/commands/task-report-commands.ts`): the
 * completed task view's report as the phone and agents read it.
 *
 * The reports are built by the REAL assembler (`assembleTaskReport`) from
 * rows, so the route and span are what the desktop view shows for the same
 * moves and sessions. The two context reads are stubs, and the task
 * repository is mocked at the module edge. Every result is also run through
 * the protocol's own `parseTaskReportWire`, so the desktop mapper and the
 * phone's guard are held to one shape.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { parseTaskReportWire, type JsonValue, type TaskReportWire } from '@kangentic/protocol';
import { assembleTaskReport, type TaskReportInput } from '../../src/main/ipc/helpers/task-report-assemble';
import type { TaskReportSessionRecord } from '../../src/main/db/repositories/session-repository';
import type { CommandContext } from '../../src/main/agent/commands/types';
import type { GitTaskChangesFile, GitTaskChangesResult, Swimlane, Task, TaskMoveRecord, TaskReport } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  getById: vi.fn<(id: string) => unknown>(),
  getByDisplayId: vi.fn<(displayId: number) => unknown>(),
}));

vi.mock('../../src/main/db/repositories/task-repository', () => ({
  TaskRepository: class {
    getById = hoisted.getById;
    getByDisplayId = hoisted.getByDisplayId;
  },
}));

// Imported AFTER the mock is defined.
import {
  handleGetTaskReport,
  TASK_REPORT_MAX_COMMITS,
  TASK_REPORT_MAX_FILES,
  TASK_REPORT_MAX_VISITS,
} from '../../src/main/agent/commands/task-report-commands';

const TASK_UUID = '6f1c2a90-0000-4000-8000-000000000001';
const DISPLAY_ID = 42;
const MINUTE = 60_000;
const T0 = Date.parse('2026-10-20T09:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * MINUTE).toISOString();

function lane(id: string, name: string, position: number, role: Swimlane['role'] = null): Swimlane {
  return { id, name, position, role, color: '#888888', icon: role === null ? 'code' : null } as unknown as Swimlane;
}

const SWIMLANES: Swimlane[] = [
  lane('todo', 'To Do', 0, 'todo'),
  lane('planning', 'Planning', 1),
  lane('executing', 'Executing', 2),
  lane('review', 'Code Review', 3),
  lane('done', 'Done', 4, 'done'),
];

function move(index: number, to: string, minutes: number): TaskMoveRecord {
  return { id: `move-${index}`, task_id: TASK_UUID, from_swimlane_id: null, to_swimlane_id: to, origin: 'user', reason: null, at: at(minutes) } as unknown as TaskMoveRecord;
}

function session(id: string, startedMinutes: number, suspendedMinutes: number): TaskReportSessionRecord {
  return {
    id, session_type: 'claude', isolated_swimlane_id: null, agent_session_id: 'conversation-a', permission_mode: 'plan',
    started_at: at(startedMinutes), suspended_at: at(suspendedMinutes), exited_at: null, exit_code: null,
    total_cost_usd: 1.2, total_input_tokens: 100, total_output_tokens: 10, total_duration_ms: 30 * MINUTE,
    model_id: 'claude-opus-5-5', model_display_name: 'Opus 5.5', applied_effort: 'high',
    tool_call_count: 4, compaction_count: 0, tool_breakdown: null,
  };
}

function report(overrides: Partial<TaskReportInput>): TaskReport {
  return assembleTaskReport({
    sessions: [],
    swimlanes: SWIMLANES,
    moves: [],
    summary: null,
    automationRuns: [],
    conditionsByAutomationId: new Map(),
    backgroundCalls: [],
    ledger: null,
    knowledge: null,
    summaryState: { kind: 'pending' },
    nowMs: T0 + 1_000 * MINUTE,
    ...overrides,
  });
}

function file(path: string, insertions: number, deletions: number, extra: Partial<GitTaskChangesFile> = {}): GitTaskChangesFile {
  return { path, status: 'M', insertions, deletions, binary: false, ...extra };
}

function changes(overrides: Partial<GitTaskChangesResult>): GitTaskChangesResult {
  return {
    range: null,
    commits: [],
    truncated: false,
    files: [],
    totals: null,
    emptyReason: null,
    branchName: 'feature/report',
    baseBranch: 'main',
    projectPath: '/mock/project',
    webProviderName: null,
    ...overrides,
  };
}

const ARCHIVED_TASK = { id: TASK_UUID, display_id: DISPLAY_ID, archived_at: at(130) } as unknown as Task;

interface StubReads {
  readTaskReport: Mock<NonNullable<CommandContext['readTaskReport']>>;
  readTaskChanges: Mock<NonNullable<CommandContext['readTaskChanges']>>;
}

function stubContext(taskReport: TaskReport, taskChanges: GitTaskChangesResult | Error): { context: CommandContext; reads: StubReads } {
  const reads: StubReads = {
    readTaskReport: vi.fn<NonNullable<CommandContext['readTaskReport']>>(async () => taskReport),
    readTaskChanges: vi.fn<NonNullable<CommandContext['readTaskChanges']>>(async () => {
      if (taskChanges instanceof Error) throw taskChanges;
      return taskChanges;
    }),
  };
  const context = { projectId: 'project-1', getProjectDb: () => ({}), ...reads } as unknown as CommandContext;
  return { context, reads };
}

/** The wire result, after checking it survives JSON and the phone's guard unchanged. */
function wireOf(data: unknown): TaskReportWire {
  const wire = data as TaskReportWire;
  expect(parseTaskReportWire(JSON.parse(JSON.stringify(wire)) as JsonValue)).toEqual(wire);
  return wire;
}

beforeEach(() => {
  hoisted.getById.mockReset();
  hoisted.getByDisplayId.mockReset();
  hoisted.getById.mockImplementation((id: string) => (id === TASK_UUID ? ARCHIVED_TASK : undefined));
  hoisted.getByDisplayId.mockImplementation((displayId: number) => (displayId === DISPLAY_ID ? ARCHIVED_TASK : undefined));
});

describe('get_task_report', () => {
  it('reports an archived task\'s route, span, commits, files and summary', async () => {
    const taskReport = report({
      moves: [move(0, 'todo', 0), move(1, 'planning', 4), move(2, 'executing', 24), move(3, 'review', 83), move(4, 'done', 123)],
      sessions: [session('record-1', 5, 80)],
      knowledge: {
        summary: null,
        commits: [
          { sha: 'b'.repeat(40), subject: 'Add the report read', committedAt: at(100) },
          { sha: 'a'.repeat(40), subject: 'Map the route', committedAt: at(60) },
        ],
        commitCount: 2,
        changedFiles: ['src/report.ts'],
        changedFileCount: 1,
      },
      summaryState: { kind: 'written', text: 'Gave the phone the completed report.' },
    });
    const taskChanges = changes({
      range: { base: 'c'.repeat(40), head: 'b'.repeat(40) },
      files: [
        file('src/report.ts', 120, 4),
        file('src/new-name.ts', 10, 2, { status: 'R', oldPath: 'src/old-name.ts' }),
        file('assets/logo.png', 0, 0, { status: 'A', binary: true }),
      ],
      totals: { insertions: 130, deletions: 6, filesChanged: 3 },
    });
    const { context, reads } = stubContext(taskReport, taskChanges);

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    expect(response.success).toBe(true);
    const wire = wireOf(response.data);
    expect(wire.taskId).toBe(TASK_UUID);
    // The earlier of the first working move (4) and the first session (5); the move into Done.
    expect(wire.startedAt).toBe(at(4));
    expect(wire.endedAt).toBe(at(123));
    expect(wire.route).toEqual([
      { swimlaneId: 'planning', name: 'Planning', color: '#888888', icon: 'code', role: null, totalMs: 20 * MINUTE, visits: [{ startedAt: at(4), durationMs: 20 * MINUTE }], visitCount: 1 },
      { swimlaneId: 'executing', name: 'Executing', color: '#888888', icon: 'code', role: null, totalMs: 59 * MINUTE, visits: [{ startedAt: at(24), durationMs: 59 * MINUTE }], visitCount: 1 },
      { swimlaneId: 'review', name: 'Code Review', color: '#888888', icon: 'code', role: null, totalMs: 40 * MINUTE, visits: [{ startedAt: at(83), durationMs: 40 * MINUTE }], visitCount: 1 },
    ]);
    expect(wire.commits).toEqual([
      { sha: 'b'.repeat(40), subject: 'Add the report read', committedAt: at(100) },
      { sha: 'a'.repeat(40), subject: 'Map the route', committedAt: at(60) },
    ]);
    expect(wire.commitCount).toBe(2);
    expect(wire.changes).toEqual({
      files: [
        { path: 'src/report.ts', status: 'M', insertions: 120, deletions: 4, binary: false },
        { path: 'src/new-name.ts', status: 'R', insertions: 10, deletions: 2, oldPath: 'src/old-name.ts', binary: false },
        { path: 'assets/logo.png', status: 'A', insertions: 0, deletions: 0, binary: true },
      ],
      fileCount: 3,
      totals: { insertions: 130, deletions: 6, filesChanged: 3 },
      emptyReason: null,
    });
    expect(wire.changesError).toBeNull();
    expect(wire.summaryState).toEqual({ kind: 'written', text: 'Gave the phone the completed report.' });

    // No message: MCP's callHandler sends `data` as JSON text, so a second copy would be thrown away.
    expect(response.message).toBeUndefined();
    // The phone's read lists more commits than the view's card and skips the ledger.
    expect(reads.readTaskReport).toHaveBeenCalledWith(TASK_UUID, { commitLimit: TASK_REPORT_MAX_COMMITS, includeLedger: false });
    expect(reads.readTaskChanges).toHaveBeenCalledWith(TASK_UUID);
  });

  it('reports a task with no sessions from its moves alone', async () => {
    const taskReport = report({
      moves: [move(0, 'todo', 0), move(1, 'executing', 10), move(2, 'done', 70)],
      sessions: [],
      knowledge: null,
      summaryState: { kind: 'indexing-off' },
    });
    const { context } = stubContext(taskReport, changes({ emptyReason: 'indexing-off' }));

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    expect(response.success).toBe(true);
    const wire = wireOf(response.data);
    expect(wire.startedAt).toBe(at(10));
    expect(wire.endedAt).toBe(at(70));
    expect(wire.route).toEqual([
      expect.objectContaining({ swimlaneId: 'executing', totalMs: 60 * MINUTE, visitCount: 1 }),
    ]);
    // An index that is off has no commits to give: null, not an empty list.
    expect(wire.commits).toBeNull();
    expect(wire.commitCount).toBeNull();
    expect(wire.changes).toEqual({ files: [], fileCount: 0, totals: null, emptyReason: 'indexing-off' });
    expect(wire.summaryState).toEqual({ kind: 'indexing-off' });
  });

  it('caps files, commits and stays, and counts them all', async () => {
    // 60 stays in Planning and 60 in Executing, five minutes each.
    const bouncingMoves = [move(0, 'todo', 0)];
    for (let index = 0; index < 120; index++) {
      bouncingMoves.push(move(index + 1, index % 2 === 0 ? 'planning' : 'executing', 1 + index * 5));
    }
    bouncingMoves.push(move(121, 'done', 1 + 120 * 5));
    const commits = Array.from({ length: 150 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      subject: `Commit ${index}`,
      committedAt: at(600 - index),
    }));
    const files = Array.from({ length: 260 }, (_, index) => file(`src/file-${index}.ts`, 300 - index, 0));
    const taskReport = report({
      moves: bouncingMoves,
      knowledge: { summary: null, commits, commitCount: 240, changedFiles: [], changedFileCount: 0 },
    });
    const { context } = stubContext(taskReport, changes({ files }));

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    const wire = wireOf(response.data);
    for (const column of wire.route) {
      expect(column.visits).toHaveLength(TASK_REPORT_MAX_VISITS);
      expect(column.visitCount).toBe(60);
      // The total is every stay's, not just the ones listed.
      expect(column.totalMs).toBe(60 * 5 * MINUTE);
      expect(column.visits[0].startedAt < column.visits[1].startedAt).toBe(true);
    }
    expect(wire.commits).toHaveLength(TASK_REPORT_MAX_COMMITS);
    expect(wire.commits?.[0].subject).toBe('Commit 0');
    expect(wire.commitCount).toBe(240);
    expect(wire.changes?.files).toHaveLength(TASK_REPORT_MAX_FILES);
    expect(wire.changes?.files[0].path).toBe('src/file-0.ts');
    expect(wire.changes?.fileCount).toBe(260);
  });

  it('leaves totals out when no single range holds the change', async () => {
    const { context } = stubContext(report({}), changes({
      range: null,
      files: [file('src/a.ts', 5, 1)],
      totals: { insertions: 5, deletions: 1, filesChanged: 1 },
    }));

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    expect(wireOf(response.data).changes?.totals).toBeNull();
  });

  it('keeps the report when git cannot be read, and says why', async () => {
    const taskReport = report({ moves: [move(0, 'todo', 0), move(1, 'executing', 10), move(2, 'done', 70)] });
    const { context } = stubContext(taskReport, new Error('The Knowledge Graph index is restarting, so the task\'s commits could not be read'));

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    expect(response.success).toBe(true);
    const wire = wireOf(response.data);
    expect(wire.changes).toBeNull();
    expect(wire.changesError).toBe('The Knowledge Graph index is restarting, so the task\'s commits could not be read');
    expect(wire.route).toHaveLength(1);
    expect(wire.endedAt).toBe(at(70));
  });

  it('resolves a display id, as a string or a number, to the UUID both reads get', async () => {
    for (const taskId of [String(DISPLAY_ID), DISPLAY_ID]) {
      const { context, reads } = stubContext(report({}), changes({}));

      const response = await handleGetTaskReport({ taskId }, context);

      expect(response.success).toBe(true);
      expect(wireOf(response.data).taskId).toBe(TASK_UUID);
      expect(reads.readTaskReport).toHaveBeenCalledWith(TASK_UUID, expect.anything());
      expect(reads.readTaskChanges).toHaveBeenCalledWith(TASK_UUID);
    }
  });

  it('refuses an unknown task without reading anything', async () => {
    const { context, reads } = stubContext(report({}), changes({}));

    const response = await handleGetTaskReport({ taskId: 'no-such-task' }, context);

    expect(response).toEqual({ success: false, error: 'Task "no-such-task" not found' });
    expect(reads.readTaskReport).not.toHaveBeenCalled();
    expect(reads.readTaskChanges).not.toHaveBeenCalled();
  });

  it('refuses a call with no taskId', async () => {
    const { context } = stubContext(report({}), changes({}));

    expect(await handleGetTaskReport({}, context)).toEqual({ success: false, error: 'taskId is required' });
  });

  it('refuses plainly when the context cannot read a report', async () => {
    const context = { projectId: 'project-1', getProjectDb: () => ({}) } as unknown as CommandContext;

    const response = await handleGetTaskReport({ taskId: TASK_UUID }, context);

    expect(response.success).toBe(false);
    expect(response.error).toBe('The task report cannot be read here');
  });
});

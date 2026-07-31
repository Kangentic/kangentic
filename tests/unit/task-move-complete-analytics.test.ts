/**
 * Unit tests for the `task_complete` analytics payload in handleTaskMove
 * (src/main/ipc/handlers/task-move.ts, the `toLane.role === 'done'` block).
 *
 * `task_complete` reads its numeric metrics from `sessionRepo.getSummaryForTask`
 * (a LIFETIME aggregate SUMmed across every session row for the task), not
 * `getLatestForTask` (the single most-recent row). A task worked across a
 * suspend/resume cycle (multiple session rows) must report cumulative totals,
 * not just the final leg's numbers - reverting to `getLatestForTask` would
 * silently under-report cost/duration/tokens/tool-calls for any task with more
 * than one session row. `model` is a separate field, still sourced from
 * `getLatestForTask().model_id` (the most recent run's CLI model id).
 *
 * Harness modeled on task-move-isolation-switch.test.ts: the SessionRepository
 * mock exposes both `getLatestForTask` and `getSummaryForTask` as independently
 * configurable vi.fn()s via a `vi.hoisted` state object. Each test moves a task
 * with no active PTY and no worktree to a done-role lane, so Phase 1 handles
 * the entire move synchronously and returns null (no Phase 2/3 spawn work to
 * mock). `usage-history-repository` is intentionally left unmocked (matches
 * task-move-shutdown.test.ts): its constructor only stores a `db` reference,
 * and the git-stats best-effort call it's used from is wrapped in try/catch
 * in task-move.ts, so a real instance touching the `{}` mock db is safe.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';

const hoisted = vi.hoisted(() => ({
  latestRecord: null as Record<string, unknown> | null,
  summary: null as Record<string, unknown> | null,
}));

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

vi.mock('simple-git', () => ({
  simpleGit: vi.fn(() => ({
    diffSummary: vi.fn(async () => ({ insertions: 0, deletions: 0, changed: 0 })),
  })),
  default: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({
  SessionRepository: class {
    getLatestForTask = vi.fn(() => hoisted.latestRecord);
    getSummaryForTask = vi.fn(() => hoisted.summary);
    updateGitStats = vi.fn();
    updateAppliedSettings = vi.fn();
  },
}));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({ SwimlaneRepository: class {} }));
vi.mock('../../src/main/db/repositories/action-repository', () => ({ ActionRepository: class {} }));
vi.mock('../../src/main/db/repositories/attachment-repository', () => ({ AttachmentRepository: class {} }));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    static scheduleBackgroundPrune = vi.fn();
  },
}));

const mockTrackEvent = vi.fn();
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: (...args: unknown[]) => mockTrackEvent(...args) }));

vi.mock('../../src/main/transition-engine/session-lifecycle', () => ({
  markRecordExited: vi.fn(),
  markRecordSuspended: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/transition-engine/injection-plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/transition-engine/injection-plan')>()),
  prepareInjectionPlan: vi.fn(() => null),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => undefined) },
}));

vi.mock('../../src/main/ipc/handlers/backlog', () => ({ abortBacklogPromotion: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/session-metrics', () => ({ captureSessionMetrics: vi.fn(), refineTranscriptTokens: vi.fn(), refineTranscriptToolCounts: vi.fn() }));

vi.mock('../../src/main/agent/shared', () => ({
  interpolateTemplate: vi.fn((template: string) => template),
  resolveBridgeScript: vi.fn(() => '/mock/bridge.js'),
  execVersion: vi.fn(async () => '1.0.0'),
}));

const mockGetProjectRepos = vi.fn();
const mockEnsureTaskWorktree = vi.fn(async () => null);
const mockEnsureTaskBranchCheckout = vi.fn(async () => {});
const mockSpawnAgent = vi.fn(async () => {});
const mockCreateTransitionEngine = vi.fn(() => ({}));

vi.mock('../../src/main/ipc/helpers/index', () => ({
  getProjectRepos: (...args: unknown[]) => mockGetProjectRepos(...args),
  ensureTaskWorktree: (...args: unknown[]) => mockEnsureTaskWorktree(...args),
  ensureTaskBranchCheckout: (...args: unknown[]) => mockEnsureTaskBranchCheckout(...args),
  spawnAgent: (...args: unknown[]) => mockSpawnAgent(...args),
  createTransitionEngine: (...args: unknown[]) => mockCreateTransitionEngine(...args),
  cleanupTaskResources: vi.fn(async () => {}),
  deleteTaskWorktree: vi.fn(async () => true),
  autoSpawnForTask: vi.fn(async () => {}),
}));
vi.mock('../../src/main/pr/pr-linking', () => ({
  autoLinkPRForTask: vi.fn(),
}));

import { handleTaskMove } from '../../src/main/ipc/handlers/task-move';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-complete-001',
    display_id: 1,
    title: 'My Task',
    description: '',
    swimlane_id: 'lane-doing',
    position: 0,
    agent: 'claude',
    session_id: null,
    worktree_path: null,
    branch_name: 'my-task',
    pr_number: null,
    pr_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(id: string, overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id,
    name: `Lane ${id}`,
    role: null,
    position: 0,
    color: '#888',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeContext(taskRepo: unknown, swimlaneRepo: unknown) {
  const sessionManager = {
    removeByTaskId: vi.fn(),
    killByTaskId: vi.fn(),
    listSessions: vi.fn(() => []),
    suspend: vi.fn(async () => {}),
  };
  const context = {
    currentProjectId: 'proj-test',
    currentProjectPath: '/mock/project',
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager,
    configManager: { getEffectiveConfig: vi.fn(() => ({ git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => null) },
    terminalSubmitScheduler: { cancel: vi.fn(), scheduleKeystrokes: vi.fn() },
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', default_agent: 'claude' })) },
  };
  mockGetProjectRepos.mockReturnValue({
    tasks: taskRepo,
    swimlanes: swimlaneRepo,
    actions: { getTransitionsFor: vi.fn(() => []) },
    attachments: { deleteByTaskId: vi.fn() },
  });
  return context;
}

const DOING_LANE_ID = 'lane-doing';
const DONE_LANE_ID = 'lane-done';

function makeTaskRepo(task: Task) {
  return {
    getById: vi.fn(() => ({ ...task })),
    move: vi.fn(),
    update: vi.fn(),
    list: vi.fn(() => [{ ...task }]),
    archive: vi.fn(),
  };
}

function makeSwimlaneRepo(lanes: Swimlane[]) {
  const laneMap = new Map(lanes.map((lane) => [lane.id, lane]));
  return {
    getById: vi.fn((id: string) => laneMap.get(id) ?? null),
    list: vi.fn(() => Array.from(laneMap.values())),
  };
}

async function moveTaskToDone(task: Task): Promise<void> {
  const doingLane = makeSwimlane(DOING_LANE_ID, { role: null });
  const doneLane = makeSwimlane(DONE_LANE_ID, { role: 'done' });
  const swimlaneRepo = makeSwimlaneRepo([doingLane, doneLane]);
  const taskRepo = makeTaskRepo(task);
  const context = makeContext(taskRepo, swimlaneRepo);

  await handleTaskMove(context as never, {
    taskId: task.id,
    targetSwimlaneId: DONE_LANE_ID,
    targetPosition: 0,
  });
}

function getTaskCompleteProps(): Record<string, string | number | boolean> {
  const call = mockTrackEvent.mock.calls.find((args) => args[0] === 'task_complete');
  if (!call) throw new Error('task_complete was never tracked');
  return call[1] as Record<string, string | number | boolean>;
}

describe('handleTaskMove task_complete analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.latestRecord = null;
    hoisted.summary = null;
  });

  it('KEY: reports SUMMED lifetime totals across multiple session legs, not just the latest leg', async () => {
    // getSummaryForTask aggregates SUM(cost) / SUM(duration) / SUM(tool_calls) /
    // SUM(tokens) across every session row for the task. Simulate a task that
    // was worked across three suspend/resume legs: no single leg comes close
    // to these totals, so if the code regresses to getLatestForTask (a single
    // row), the reported numbers would be a small fraction of these.
    hoisted.summary = {
      totalCostUsd: 0.6, // e.g. three legs: 0.15 + 0.2 + 0.25
      totalInputTokens: 1200, // e.g. 400 + 350 + 450
      totalOutputTokens: 800, // e.g. 250 + 300 + 250
      durationMs: 900_000, // e.g. 300_000 + 450_000 + 150_000 (900s total)
      toolCallCount: 10, // e.g. 3 + 5 + 2
    };

    const task = makeTask({ swimlane_id: DOING_LANE_ID, session_id: null, worktree_path: null });
    await moveTaskToDone(task);

    const props = getTaskCompleteProps();
    expect(props.costUsd).toBe(0.6);
    expect(props.durationSeconds).toBe(900);
    expect(props.inputTokens).toBe(1200);
    expect(props.outputTokens).toBe(800);
    expect(props.toolCalls).toBe(10);
  });

  it('omits all five numeric props when getSummaryForTask returns null, but still attaches model and agent', async () => {
    hoisted.latestRecord = { id: 'rec-1', model_id: 'claude-opus-4-8', agent_session_id: null, status: 'suspended', session_type: 'claude_agent' } as unknown as SessionRecord;
    hoisted.summary = null;

    const task = makeTask({ swimlane_id: DOING_LANE_ID, session_id: null, worktree_path: null, agent: 'claude' });
    await moveTaskToDone(task);

    const props = getTaskCompleteProps();
    expect(props).not.toHaveProperty('durationSeconds');
    expect(props).not.toHaveProperty('costUsd');
    expect(props).not.toHaveProperty('inputTokens');
    expect(props).not.toHaveProperty('outputTokens');
    expect(props).not.toHaveProperty('toolCalls');
    expect(props.model).toBe('claude-opus-4-8');
    expect(props.agent).toBe('claude');
  });

  it('collapses a [1m] context-window model id to its base id', async () => {
    hoisted.latestRecord = { id: 'rec-1', model_id: 'claude-opus-4-8[1m]', agent_session_id: null, status: 'suspended', session_type: 'claude_agent' } as unknown as SessionRecord;
    hoisted.summary = null;

    const task = makeTask({ swimlane_id: DOING_LANE_ID, session_id: null, worktree_path: null, agent: 'claude' });
    await moveTaskToDone(task);

    const props = getTaskCompleteProps();
    expect(props.model).toBe('claude-opus-4-8');
  });

  it('rounds costUsd from the summary to 4 decimal places', async () => {
    hoisted.summary = {
      totalCostUsd: 0.123456,
      totalInputTokens: 10,
      totalOutputTokens: 5,
      durationMs: 1000,
      toolCallCount: 1,
    };

    const task = makeTask({ swimlane_id: DOING_LANE_ID, session_id: null, worktree_path: null });
    await moveTaskToDone(task);

    const props = getTaskCompleteProps();
    expect(props.costUsd).toBe(0.1235);
  });
});

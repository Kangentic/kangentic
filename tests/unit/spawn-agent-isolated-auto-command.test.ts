/**
 * Regression tests for auto_command injection through the real spawnAgent
 * fallback (src/main/ipc/helpers/agent-spawn.ts).
 *
 * The protected critical path: a column's auto_command MUST reach the agent.
 *
 * Two bugs these pin, both found live in /preview:
 *
 *  1. spawnAgent decided resume-vs-fresh with a TASK-LEVEL resume check
 *     (getLatestForTask) while executeSpawnAgent decides it ISOLATION-SCOPED.
 *     Dragging a task with a suspended MAIN session into an ISOLATED column made
 *     the task-level check see the main session as "resumable", so the spawn
 *     mis-routed the auto_command and dropped it. Fixed by scoping spawnAgent's
 *     resume check to the destination isolation.
 *
 *  2. A fresh isolated session has no task prompt (skipPromptTemplate), so it
 *     sits idle, never emits a 'thinking' event, and the keystroke scheduler
 *     waits out its full 30s fallback before the auto_command appears - reading
 *     as "the command never ran". Fixed by delivering the auto_command as the
 *     session's INITIAL PROMPT when there is no task prompt to run (resume, or
 *     fresh + skipPromptTemplate), keeping the keystroke only for a fresh spawn
 *     whose prompt slot is taken by the task description.
 *
 * resumePrompt is the 4th arg of resumeSuspendedSession; asserting it carries
 * the command (vs. a scheduleKeystrokes call) tells us which delivery path ran.
 * These cover the {main, isolated} x {fresh-promptless, fresh-with-task-prompt,
 * resume} matrix.
 *
 * The real spawnAgent is exercised end to end; only the engine, repos, and
 * context are injected mocks, plus resolveTargetAgent (force isHandoff=false to
 * reach the normal fallback) and agentRegistry (supply the destination
 * sessionType). resolveIsolatedSwimlaneId, isResumeEligible, interpolateTaskTemplate,
 * and resolveTaskTemplateVars run for real - they are the logic under test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

// These mocks are only exercised by the handoff-branch describe block below.
// They are harmless for the normal-path tests (those tests never enter hasHandoffContext).
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  emitSpawnProgress: vi.fn(),
  emitSpawnWaiting: vi.fn(),
  clearSpawnProgress: vi.fn(),
  createProgressCallback: vi.fn(() => vi.fn()),
  getInFlightSpawnProgress: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => ({})),
}));

vi.mock('../../src/main/db/repositories/handoff-repository', () => ({
  HandoffRepository: class {
    insert = vi.fn(() => ({ id: 'handoff-rec-1' }));
    updateToSession = vi.fn();
  },
}));

vi.mock('../../src/main/agent/handoff/session-history-reference', () => ({
  buildSessionHistoryReference: vi.fn(() => '[handoff context: mock]'),
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import { resolveTargetAgent } from '../../src/main/transition-engine/agent-resolver';
import { agentRegistry } from '../../src/main/agent/agent-registry';

const TASK_ID = 'task-aaa00001';
const EXEC_LANE_ID = 'lane-exec';
const ISOLATED_LANE_ID = 'lane-review-isolated';
const FRESH_PTY_SESSION_ID = 'pty-fresh-1';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: EXEC_LANE_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/my-task',
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

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'rec-1',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-sid-1',
    pty_session_id: null,
    status: 'suspended',
    suspended_by: 'system',
    permission_mode: null,
    started_at: '2026-01-01T00:00:00.000Z',
    exited_at: null,
    exit_code: null,
    duration_ms: null,
    cost_usd: null,
    input_tokens: null,
    output_tokens: null,
    model: null,
    effort: null,
    ...overrides,
  } as SessionRecord;
}

/**
 * Build the injected dependencies. `manualPauseRecord` feeds getLatestForTask
 * (drives only the manual-pause guard + handoff probe). `resumeRecord` feeds the
 * isolation-scoped getLatestForTaskByTypeAndIsolation (drives the fix). getById
 * returns no-session first (so the fallback runs) then a freshly-spawned session.
 *
 * `projectId` is only set by handoff-branch tests; when undefined, `projectRepo`
 * is never accessed by spawnAgent (it gates on `options.projectId`).
 */
function makeDeps(args: {
  manualPauseRecord: SessionRecord | null;
  resumeRecord: SessionRecord | undefined;
  /** Extra task fields applied to the getById returns the auto_command interpolation reads. */
  taskFields?: Partial<Task>;
  /**
   * Optional attachments repo mock, forwarded to spawnAgent's `attachments`
   * option exactly like a real getProjectRepos() call site would. Omitted by
   * default so existing tests are unaffected ({{attachments}} resolves []).
   */
  attachments?: { getPathsForTask: ReturnType<typeof vi.fn> };
}) {
  const getById = vi.fn();
  getById
    .mockReturnValueOnce(makeTask({ session_id: null, ...args.taskFields }))
    .mockReturnValue(makeTask({ session_id: FRESH_PTY_SESSION_ID, ...args.taskFields }));

  const tasks = { getById };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.manualPauseRecord),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => args.resumeRecord),
  };
  const engine = {
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const scheduleKeystrokes = vi.fn();
  // mainWindow and projectRepo are only accessed when options.projectId is set
  // (handoff path). They are present here so the same `context` shape works for
  // both normal-path and handoff-path tests without requiring a cast.
  const context = {
    terminalSubmitScheduler: { scheduleKeystrokes },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    projectRepo: { getById: vi.fn(() => null) },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({
        agent: { permissionMode: 'acceptEdits' },
        git: { defaultBaseBranch: 'main' },
      })),
    },
    // resolveDefaultBaseBranch (git-stats-capture.ts) reads this for the
    // team-shared board default; undefined falls through to the git config
    // default above, matching resolveAutoCommandVars in agent-spawn.ts.
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
  };

  return { tasks, sessionRepo, engine, scheduleKeystrokes, context, attachments: args.attachments };
}

async function runSpawn(
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  skipPromptTemplate = false,
  suppressAutoCommand = false,
  projectId?: string,
) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask({ swimlane_id: toLane.id, session_id: null }),
    fromSwimlaneId: EXEC_LANE_ID,
    toLane,
    skipPromptTemplate,
    suppressAutoCommand,
    projectId,
    attachments: deps.attachments as never,
  });
}

/** The resumePrompt is the 4th positional arg of resumeSuspendedSession. */
function resumePromptArg(engine: ReturnType<typeof makeDeps>['engine']): unknown {
  return engine.resumeSuspendedSession.mock.calls[0]?.[3];
}

describe('spawnAgent auto_command injection (isolation-scoped resume check)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ISOLATED + fresh, no task prompt: runs the auto_command as the INITIAL PROMPT (immediate), even with a suspended MAIN session present', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    // A suspended MAIN session is present (just suspended by the column switch);
    // a task-level resume check would falsely treat it as resumable here.
    const deps = makeDeps({
      manualPauseRecord: makeRecord({ id: 'rec-main', isolated_swimlane_id: null, status: 'suspended', suspended_by: 'system' }),
      resumeRecord: undefined, // no prior ISOLATED session -> genuinely fresh
    });

    // skipPromptTemplate=true: entered from a non-To-Do column, so the isolated
    // session gets no task prompt - the auto_command becomes its first prompt.
    await runSpawn(isolatedLane, deps, true);

    // The isolation-scoped lookup decided this destination (NOT getLatestForTask).
    expect(deps.sessionRepo.getLatestForTaskByTypeAndIsolation)
      .toHaveBeenCalledWith(TASK_ID, 'claude_agent', ISOLATED_LANE_ID);
    // Delivered as the initial prompt - no 30s keystroke fallback.
    expect(resumePromptArg(deps.engine)).toBe('/code-review');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('ISOLATED + fresh: a {{baseBranch}} placeholder in the auto_command interpolates the task base branch into the initial prompt', async () => {
    // The isolated Code Review column ships `/code-review {{baseBranch}}` so the
    // review is scoped against the branch the task actually forked from, not a
    // guessed default. Verifies resolveTaskTemplateVars + interpolateTaskTemplate
    // wire task.base_branch through to the delivered command.
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review {{baseBranch}}',
    });
    const deps = makeDeps({
      manualPauseRecord: null,
      resumeRecord: undefined,
      taskFields: { base_branch: 'develop' },
    });

    await runSpawn(isolatedLane, deps, true);

    expect(resumePromptArg(deps.engine)).toBe('/code-review develop');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('ISOLATED + fresh: a null task.base_branch falls back to the effective project default, not empty (regression: base_branch is a per-task OVERRIDE, not the resolved value)', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review {{baseBranch}}',
    });
    const deps = makeDeps({
      manualPauseRecord: null,
      resumeRecord: undefined,
      taskFields: { base_branch: null },
    });

    await runSpawn(isolatedLane, deps, true);

    // Not '/code-review' (empty) and not '/code-review ' (trailing space) -
    // the default from configManager.getEffectiveConfig().git.defaultBaseBranch.
    expect(resumePromptArg(deps.engine)).toBe('/code-review main');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('ISOLATED + fresh: a {{attachments}} placeholder interpolates the paths from options.attachments.getPathsForTask (regression: attachments plumbing must reach resolveTaskTemplateVars)', async () => {
    // Verifies the AttachmentRepository option added to AgentSpawnOptions
    // actually threads through spawnAgent -> resolveAutoCommandVars ->
    // resolveTaskTemplateVars -> interpolateTaskTemplate, and is not silently
    // dropped (which would leave {{attachments}} resolving to []).
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review {{attachments}}',
    });
    const getPathsForTask = vi.fn(() => ['/mock/a.png', '/mock/b.png']);
    const deps = makeDeps({
      manualPauseRecord: null,
      resumeRecord: undefined,
      attachments: { getPathsForTask },
    });

    await runSpawn(isolatedLane, deps, true);

    // getPathsForTask resolves attachmentPaths ({{attachments}} joins them on
    // newlines, see TASK_TEMPLATE_RESOLVERS.attachments in
    // task-template-resolvers.ts), called with the task's own id.
    expect(getPathsForTask).toHaveBeenCalledWith(TASK_ID);
    expect(resumePromptArg(deps.engine)).toBe('/code-review \n/mock/a.png\n/mock/b.png');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('ISOLATED + fresh from To Do (task prompt present): auto_command follows the task prompt as a keystroke', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    const deps = makeDeps({ manualPauseRecord: null, resumeRecord: undefined });

    // skipPromptTemplate=false: the task description owns the prompt slot, so the
    // auto_command must be injected afterward as a keystroke.
    await runSpawn(isolatedLane, deps, false);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID, FRESH_PTY_SESSION_ID, ['/code-review'], { freshlySpawned: true },
    );
  });

  it('ISOLATED + resume: re-entering the isolated column resumes with the auto_command as the resume prompt, no keystroke', async () => {
    const isolatedLane = makeSwimlane(ISOLATED_LANE_ID, {
      session_target: 'isolated',
      auto_command: '/code-review',
    });
    const isolatedRecord = makeRecord({ id: 'rec-iso', isolated_swimlane_id: ISOLATED_LANE_ID, agent_session_id: 'agent-iso' });
    const deps = makeDeps({ manualPauseRecord: isolatedRecord, resumeRecord: isolatedRecord });

    await runSpawn(isolatedLane, deps, true);

    expect(resumePromptArg(deps.engine)).toBe('/code-review');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('MAIN + resume: a resumable main session receives the auto_command as the resume prompt (unchanged)', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/standup' });
    const mainRecord = makeRecord({ id: 'rec-main', isolated_swimlane_id: null, agent_session_id: 'agent-main' });
    const deps = makeDeps({ manualPauseRecord: mainRecord, resumeRecord: mainRecord });

    await runSpawn(normalLane, deps, true);

    // Destination isolation is null (main) - the scoped lookup is asked for it.
    expect(deps.sessionRepo.getLatestForTaskByTypeAndIsolation)
      .toHaveBeenCalledWith(TASK_ID, 'claude_agent', null);
    expect(resumePromptArg(deps.engine)).toBe('/standup');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('MAIN + fresh from To Do: auto_command injected as a keystroke after the task prompt (unchanged)', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/standup' });
    const deps = makeDeps({ manualPauseRecord: null, resumeRecord: undefined });

    await runSpawn(normalLane, deps, false);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID, FRESH_PTY_SESSION_ID, ['/standup'], { freshlySpawned: true },
    );
  });
});

/**
 * Recovery move out of Done: spawnAgent is called with suppressAutoCommand=true
 * (handleTaskMove sets it when fromLane.role === 'done'). The destination
 * column's auto_command must NOT be delivered, by either path, so the restored
 * session resumes idle. A non-archived Done-out move (MCP move_task, legacy
 * rows) reaches this fallback; the drag-out-of-Done path is covered separately
 * in task-archive-handler.test.ts.
 */
describe('spawnAgent auto_command suppression on recovery move out of Done', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resume-eligible destination: resumes with NO prompt and schedules no keystroke', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/merge-back' });
    const mainRecord = makeRecord({ id: 'rec-main', isolated_swimlane_id: null, agent_session_id: 'agent-main' });
    const deps = makeDeps({ manualPauseRecord: mainRecord, resumeRecord: mainRecord });

    // skipPromptTemplate=true (any non-To-Do source, which Done always is) +
    // suppressAutoCommand=true.
    await runSpawn(normalLane, deps, true, true);

    // The session still resumes (config/overrides apply), but with no prompt.
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('fresh-spawn outcome: no keystroke scheduled, session sits idle', async () => {
    const normalLane = makeSwimlane(EXEC_LANE_ID, { session_target: 'main', auto_command: '/merge-back' });
    // No resumable session -> the fallback spawns fresh. skipPromptTemplate=true
    // means the fresh session is promptless, and suppression keeps it that way.
    const deps = makeDeps({ manualPauseRecord: null, resumeRecord: undefined });

    await runSpawn(normalLane, deps, true, true);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });
});

/**
 * Recovery move out of Done with the HANDOFF branch active.
 *
 * Scenario: a task's agent_override differs from the destination column's
 * agent (e.g. Done -> a Codex column), so resolveTargetAgent returns
 * isHandoff=true. The destination column also has handoff_context=true and
 * an auto_command. suppressAutoCommand must silence the auto_command at the
 * gated check on line 279 of agent-spawn.ts:
 *
 *   if (!options.suppressAutoCommand && toLane.auto_command?.trim()) {
 *     ...scheduleKeystrokes(...)
 *   }
 *
 * The existing recovery tests (describe block above) force isHandoff=false to
 * reach the normal fallback; these tests specifically exercise the handoff branch
 * (hasHandoffContext=true) to close the untested gap.
 *
 * Mock requirements to reach hasHandoffContext=true:
 *   - resolveTargetAgent returns isHandoff=true (overridden per-test via mockReturnValueOnce)
 *   - toLane.handoff_context !== false (set to true)
 *   - options.projectId is defined (passed to runSpawn)
 *   - sessionRepo.getLatestForTask returns non-null (manualPauseRecord set)
 * tasks.getById must return a task WITH session_id so the post-spawn gate
 * (currentTask?.session_id) is truthy and scheduleKeystrokes is reached.
 */
describe('spawnAgent auto_command suppression on recovery move out of Done (handoff branch)', () => {
  const PROJECT_ID = 'proj-handoff-test';

  beforeEach(() => {
    vi.clearAllMocks();
    // Point the default agentRegistry.get to null so locateSessionHistoryFile is
    // never called (the source-adapter branch gates on the returned object being
    // truthy). Without this, the mock returns { sessionType: 'claude_agent' }
    // which lacks locateSessionHistoryFile and would throw inside the try/catch,
    // continuing cleanly but logging a spurious error. Returning null is cleaner.
    vi.mocked(agentRegistry.get).mockReturnValue(null as never);
  });

  it('handoff branch + suppressAutoCommand=true: scheduleKeystrokes is NOT called', async () => {
    // This is the required gap assertion: handoff path taken, suppression active,
    // scheduleKeystrokes must be silent. Without the !options.suppressAutoCommand
    // guard on line 279 of agent-spawn.ts, this test fails.
    const codexLane = makeSwimlane('lane-codex', {
      session_target: 'main',
      auto_command: '/merge-back',
      handoff_context: true,
      agent_override: 'codex',
    });
    // manualPauseRecord non-null satisfies hasHandoffContext's getLatestForTask check.
    // taskFields: { session_id: FRESH_PTY_SESSION_ID } ensures the post-spawn
    // tasks.getById call returns a session-owning task (reaching the gate).
    const priorRecord = makeRecord({ id: 'rec-claude', isolated_swimlane_id: null, agent_session_id: 'claude-session-1' });
    const deps = makeDeps({
      manualPauseRecord: priorRecord,
      resumeRecord: undefined,
      taskFields: { session_id: FRESH_PTY_SESSION_ID },
    });

    // Override the module-level mock for this single call: isHandoff=true forces
    // the handoff branch. The default returns false, so existing tests are unaffected.
    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'codex', isHandoff: true });

    await runSpawn(codexLane, deps, true, true, PROJECT_ID);

    // The handoff spawn ran (resumeSuspendedSession was called with the target agent).
    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    // The auto_command must NOT have been injected.
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('handoff branch + suppressAutoCommand=false: scheduleKeystrokes IS called (positive companion)', async () => {
    // Positive companion: same handoff setup but without suppression, confirming
    // the gate works in both directions. Guards against accidentally removing it
    // and having the suppression test pass vacuously.
    const codexLane = makeSwimlane('lane-codex', {
      session_target: 'main',
      auto_command: '/merge-back',
      handoff_context: true,
      agent_override: 'codex',
    });
    const priorRecord = makeRecord({ id: 'rec-claude', isolated_swimlane_id: null, agent_session_id: 'claude-session-1' });
    const deps = makeDeps({
      manualPauseRecord: priorRecord,
      resumeRecord: undefined,
      taskFields: { session_id: FRESH_PTY_SESSION_ID },
    });

    vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'codex', isHandoff: true });

    // suppressAutoCommand=false (default): the auto_command must be scheduled.
    await runSpawn(codexLane, deps, true, false, PROJECT_ID);

    expect(deps.engine.resumeSuspendedSession).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledTimes(1);
    expect(deps.scheduleKeystrokes).toHaveBeenCalledWith(
      TASK_ID, FRESH_PTY_SESSION_ID, ['/merge-back'], { freshlySpawned: true },
    );
  });
});

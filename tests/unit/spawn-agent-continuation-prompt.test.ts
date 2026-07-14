/**
 * Tests for continuationPrompt delivery through the real spawnAgent fallback
 * (src/main/ipc/helpers/agent-spawn.ts).
 *
 * The plan-exit auto-move respawns a session whose permission mode changed
 * (Planning -> Executing). The ExitPlanMode approval dialog dies with the
 * suspended PTY, so the listener passes a continuation prompt ("Your plan was
 * approved...") that must be delivered as the resumed session's next message.
 * Contract under test:
 *
 *   - The destination column's auto_command always wins over the continuation
 *     (it is the user's explicit per-column automation).
 *   - The continuation is RESUME-ONLY: a fresh spawn has no prior plan
 *     conversation for "proceed" to refer to.
 *   - Without a continuation (user drag), a resumed session with no
 *     auto_command resumes idle - pins the pre-existing respawn behavior.
 *
 * Harness mirrors spawn-agent-isolated-auto-command.test.ts: the real
 * spawnAgent runs end to end with injected engine/repos/context mocks, and
 * the resumePrompt is the 4th positional arg of resumeSuspendedSession.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';

const TASK_ID = 'task-aaa00001';
const EXECUTING_LANE_ID = 'lane-executing';
const FRESH_PTY_SESSION_ID = 'pty-fresh-1';
const CONTINUATION = 'Proceed with implementing the approved plan.';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 1,
    title: 'My Task',
    description: 'Do the thing',
    swimlane_id: EXECUTING_LANE_ID,
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
    id: 'rec-main',
    task_id: TASK_ID,
    session_type: 'claude_agent',
    isolated_swimlane_id: null,
    agent_session_id: 'agent-sid-1',
    pty_session_id: null,
    status: 'suspended',
    suspended_by: 'system',
    permission_mode: 'plan',
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

function makeDeps(args: { resumeRecord: SessionRecord | undefined }) {
  const getById = vi.fn();
  getById
    .mockReturnValueOnce(makeTask({ session_id: null }))
    .mockReturnValue(makeTask({ session_id: FRESH_PTY_SESSION_ID }));

  const tasks = { getById };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => args.resumeRecord ?? null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => args.resumeRecord),
  };
  const engine = {
    executeTransition: vi.fn(async () => {}),
    resumeSuspendedSession: vi.fn(async () => {}),
  };
  const scheduleKeystrokes = vi.fn();
  const context = {
    terminalSubmitScheduler: { scheduleKeystrokes },
    configManager: { getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits' } })) },
  };

  return { tasks, sessionRepo, engine, scheduleKeystrokes, context };
}

async function runSpawn(
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  continuationPrompt: string | undefined,
) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask({ swimlane_id: toLane.id, session_id: null }),
    fromSwimlaneId: 'lane-planning',
    toLane,
    // Plan-exit moves originate from a non-To-Do column, so the task
    // template is always skipped on this path.
    skipPromptTemplate: true,
    continuationPrompt,
  });
}

/** The resumePrompt is the 4th positional arg of resumeSuspendedSession. */
function resumePromptArg(engine: ReturnType<typeof makeDeps>['engine']): unknown {
  return engine.resumeSuspendedSession.mock.calls[0]?.[3];
}

describe('spawnAgent continuationPrompt delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resume with no auto_command: the continuation becomes the resume prompt', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: makeRecord() });

    await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBe(CONTINUATION);
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('auto_command wins over the continuation', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/implement' });
    const deps = makeDeps({ resumeRecord: makeRecord() });

    await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBe('/implement');
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('fresh spawn: the continuation is NOT delivered (no prior conversation to continue)', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: undefined });

    await runSpawn(executingLane, deps, CONTINUATION);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('no continuation (user drag): a resumed session with no auto_command resumes idle', async () => {
    const executingLane = makeSwimlane(EXECUTING_LANE_ID);
    const deps = makeDeps({ resumeRecord: makeRecord() });

    await runSpawn(executingLane, deps, undefined);

    expect(resumePromptArg(deps.engine)).toBeUndefined();
    expect(deps.scheduleKeystrokes).not.toHaveBeenCalled();
  });

  it('per-task auto_command (MCP autoCommand param) wins over the lane auto_command', async () => {
    // effectiveAutoCommand = currentTask.auto_command ?? toLane.auto_command:
    // the task-level value, set only via kangentic_create_task's MCP-only
    // autoCommand param, must win for this task. Ported from the TASK_CREATE
    // handler tests when creates were consolidated onto spawnAgent - this is
    // where the precedence now lives for every entry point. Red-green:
    // reverting agent-spawn.ts to plain `toLane.auto_command` delivers
    // '/lane-command' here and fails.
    const executingLane = makeSwimlane(EXECUTING_LANE_ID, { auto_command: '/lane-command' });
    const deps = makeDeps({ resumeRecord: makeRecord() });
    deps.tasks.getById.mockReset();
    deps.tasks.getById
      .mockReturnValueOnce(makeTask({ session_id: null, auto_command: '/task-command' }))
      .mockReturnValue(makeTask({ session_id: FRESH_PTY_SESSION_ID, auto_command: '/task-command' }));

    await runSpawn(executingLane, deps, undefined);

    expect(resumePromptArg(deps.engine)).toBe('/task-command');
  });
});

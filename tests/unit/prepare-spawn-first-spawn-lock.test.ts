/**
 * Tests for the shared spawn preamble inside prepareAgentSpawn
 * (src/main/transition-engine/session-startup/prepare-spawn.ts).
 *
 * prepareAgentSpawn is the STARTUP spawn chokepoint (crash recovery and the
 * auto-spawn reconcile). Before this wiring, a never-spawned task whose true
 * first spawn happened at startup (placed in an auto_spawn lane manually, or
 * recovered after the app closed before spawning) skipped the first-spawn
 * Advanced-override lock entirely, permanently missing the lock window: the
 * startup spawn sets task.agent, so no later spawn is ever "first" again.
 *
 * The REAL prepareAgentSpawn runs end to end (agent registry and node:fs
 * mocked), so these tests pin the full contract:
 *   1. first spawn + one override -> tasks.update locks all four fields AND
 *      the built command already carries the locked model/effort/permission
 *   2. hasSessionRecord: true (the recovery-resume path) -> lock no-ops
 *   3. no overrides -> task untouched, inheritance chain flows to the command
 *   4. a lane forcing 'plan' beats the locked task permission at spawn time
 *      while the LOCKED value (the task's own) is what gets persisted
 *      (resolveEffectivePermissionMode wiring)
 *
 * Red-green: removing the runSpawnPreamble call from prepareAgentSpawn (or
 * reverting to the bare resolveTargetAgent it replaced) fails tests 1 and 4.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig, Swimlane, Task } from '../../src/shared/types';

const buildCommandMock = vi.fn(() => 'codex --mock-run');

const adapter = {
  name: 'codex',
  displayName: 'Codex',
  sessionType: 'codex_agent',
  supportsCallerSessionId: false,
  detect: vi.fn(async () => ({ found: true, path: '/mock/bin/codex', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: buildCommandMock,
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn((agentName: string) => (agentName === 'codex' || agentName === 'claude' ? { ...adapterRef, name: agentName } : undefined)),
  },
}));

// prepareAgentSpawn creates the on-disk session directory; keep it virtual.
vi.mock('node:fs', () => ({
  default: {
    mkdirSync: vi.fn(),
  },
}));

// Referenced from the vi.mock factory above (hoisted), so declared via
// module scope after the mock declarations run.
const adapterRef = adapter;

import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

const TASK_ID = 'task-startup-lock-001';
const LANE_ID = 'lane-review';

/**
 * `run_mode` defaults to what the repository would have derived for the given
 * pins (`applyProfileExclusivity`: any pin implies override mode), so a fixture
 * is always a row the repository could actually have written.
 */
function makeTask(overrides: Partial<Task> = {}): Task {
  const merged = {
    id: TASK_ID,
    display_id: 1,
    title: 'Startup task',
    description: 'Recover me',
    swimlane_id: LANE_ID,
    position: 0,
    agent: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    permission_mode: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
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
  } as Task;
  const pinsAnyField = merged.agent_override !== null || merged.model_override !== null
    || merged.effort_override !== null || merged.permission_mode !== null;
  return { run_mode: pinsAnyField ? 'agent_override' : 'column_settings', ...merged } as Task;
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: LANE_ID,
    name: 'Review',
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
  } as Swimlane;
}

function makeEffectiveConfig(): AppConfig {
  return {
    agent: {
      permissionMode: 'acceptEdits',
      cliPaths: {},
    },
    mcpServer: { enabled: false },
  } as unknown as AppConfig;
}

async function runPrepare(args: {
  task: Task;
  swimlane: Swimlane | null;
  hasSessionRecord: boolean;
  tasksUpdate: ReturnType<typeof vi.fn>;
}) {
  return prepareAgentSpawn({
    task: args.task,
    swimlane: args.swimlane,
    cwd: '/mock/project',
    projectId: 'proj-123',
    projectPath: '/mock/project',
    effectiveConfig: makeEffectiveConfig(),
    projectDefaultAgent: 'claude',
    projectDefaultModel: 'claude-opus-4-8',
    projectDefaultEffort: 'xhigh',
    resolvedShell: 'powershell',
    mcpServerHandle: null,
    resume: null,
    hasSessionRecord: args.hasSessionRecord,
    tasks: { update: args.tasksUpdate },
  });
}

function builtCommandOptions(): { model?: string; effort?: string; permissionMode?: string } {
  expect(buildCommandMock).toHaveBeenCalledTimes(1);
  return buildCommandMock.mock.calls[0][0] as { model?: string; effort?: string; permissionMode?: string };
}

describe('prepareAgentSpawn first-spawn override lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('locks all four fields on a first-ever startup spawn and builds the command from the locked values', async () => {
    const task = makeTask({ model_override: 'fable-5' });
    const lane = makeSwimlane({ agent_override: 'codex', effort_override: 'low' });
    const tasksUpdate = vi.fn();

    const result = await runPrepare({ task, swimlane: lane, hasSessionRecord: false, tasksUpdate });

    expect(tasksUpdate).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'codex',
      model_override: 'fable-5',
      effort_override: 'low',
      permission_mode: 'acceptEdits',
    });
    // The just-locked agent is the agent the spawn actually prepares.
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.agent).toBe('codex');
    // The built command carries the locked model/effort/permission - not a
    // re-resolution against anything else.
    const commandOptions = builtCommandOptions();
    expect(commandOptions.model).toBe('fable-5');
    expect(commandOptions.effort).toBe('low');
    expect(commandOptions.permissionMode).toBe('acceptEdits');
  });

  it('no-ops when a session record exists (the recovery-resume path)', async () => {
    const task = makeTask({ model_override: 'fable-5' });
    const tasksUpdate = vi.fn();

    const result = await runPrepare({
      task,
      swimlane: makeSwimlane(),
      hasSessionRecord: true,
      tasksUpdate,
    });

    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('locks a task in override mode with nothing pinned, on the startup path too', async () => {
    // The startup chokepoint has to gate on the same persisted mode as the
    // board one: override mode pins nothing until this lock runs, so a
    // "does the task carry a pin" check would skip it here as well.
    const task = makeTask({ run_mode: 'agent_override' });
    const lane = makeSwimlane({ agent_override: 'codex', effort_override: 'low' });
    const tasksUpdate = vi.fn();

    const result = await runPrepare({ task, swimlane: lane, hasSessionRecord: false, tasksUpdate });

    expect(tasksUpdate).toHaveBeenCalledWith({
      id: TASK_ID,
      agent_override: 'codex',
      model_override: 'claude-opus-4-8',
      effort_override: 'low',
      permission_mode: 'acceptEdits',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.agent).toBe('codex');
  });

  it('leaves a column-settings task untouched and flows the inheritance chain into the command', async () => {
    const task = makeTask();
    const tasksUpdate = vi.fn();

    const result = await runPrepare({
      task,
      swimlane: makeSwimlane({ effort_override: 'low' }),
      hasSessionRecord: false,
      tasksUpdate,
    });

    expect(tasksUpdate).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.agent).toBe('claude');
    const commandOptions = builtCommandOptions();
    // task (null) -> lane -> project default, live per spawn (no lock).
    expect(commandOptions.model).toBe('claude-opus-4-8');
    expect(commandOptions.effort).toBe('low');
    expect(commandOptions.permissionMode).toBe('acceptEdits');
  });

  it("a lane forcing 'plan' wins at spawn time while the LOCKED permission stays the task's own", async () => {
    const task = makeTask({ permission_mode: 'acceptEdits' });
    const planLane = makeSwimlane({ permission_mode: 'plan' });
    const tasksUpdate = vi.fn();

    await runPrepare({ task, swimlane: planLane, hasSessionRecord: false, tasksUpdate });

    // The lock persists the task's own pin (the dialog's contract)...
    expect(tasksUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: TASK_ID, permission_mode: 'acceptEdits' }),
    );
    // ...but the spawn runs under 'plan': the lane's plan is a safety
    // guarantee that beats any task pin (resolveEffectivePermissionMode).
    expect(builtCommandOptions().permissionMode).toBe('plan');
  });
});

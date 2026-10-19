/**
 * How a plan session is launched for Kangentic's plan approval: whether bypass
 * is made available at launch, and what each spawn chokepoint records for the
 * plan approval writer.
 *
 * Claude applies an approval's `setMode` to bypassPermissions only when the
 * session was launched with bypass available, so a plan session whose next plan
 * Kangentic would approve into bypass has to be launched that way
 * (`planSpawnNeedsBypass`). Both chokepoints ask it, hand the answer to
 * `adapter.buildCommand` as `bypassAvailable`, and record `{ sessionDir,
 * bypassAvailable }` for the writer AFTER the command is built: a command that
 * never builds must leave no record, and the record must exist before the PTY
 * spawns, because the writer reads it when the session first appears.
 *
 * Both chokepoints run for real here: the board path through
 * `TransitionEngine.runLegacySpawnAgent` and the startup path through
 * `prepareAgentSpawn`, with stub adapters and no disk.
 *
 * Red-green: hardcoding `bypassAvailable` to false in either file fails its
 * wiring tests; moving `notePlanApprovalSpawn` above `adapter.buildCommand`
 * fails its ordering tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { AppConfig, PermissionMode, Swimlane, Task } from '../../src/shared/types';

interface StubAdapter {
  name: string;
  displayName: string;
  sessionType: string;
  supportsCallerSessionId: boolean;
  supportsPlanAutoApproval?: boolean;
  defaultPermission: string;
  launchOptions: undefined;
  detect: ReturnType<typeof vi.fn>;
  ensureTrust: ReturnType<typeof vi.fn>;
  buildCommand: ReturnType<typeof vi.fn>;
  buildEnv: undefined;
  getExitSequence: ReturnType<typeof vi.fn>;
  removeHooks: ReturnType<typeof vi.fn>;
  runtime: undefined;
  locateSessionHistoryFile: ReturnType<typeof vi.fn>;
  proveConversationGone: undefined;
}

const registry = vi.hoisted(() => ({ current: null as unknown }));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn(() => registry.current),
    getOrThrow: vi.fn(() => registry.current),
    list: vi.fn(() => ['claude']),
  },
}));

// Pass-through: this file is about the plan approval record, not the shim head.
vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

vi.mock('../../src/main/transition-engine/resume-cwd-migration', () => ({
  migrateResumeCwdIfRenamed: vi.fn(async () => {}),
}));

// Both chokepoints create the session directory with `import fs from 'node:fs'`.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const mocked = { ...original, mkdirSync: vi.fn() };
  return { ...mocked, default: mocked };
});

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    constructor(_projectPath: string) {}
    async withLock<T>(job: () => Promise<T> | T): Promise<T> {
      return job();
    }
    ensureWorktree = vi.fn();
  },
}));

import {
  forgetPlanApprovalSpawn,
  notePlanApprovalSpawn,
  planApprovalModeForSpawn,
  planSpawnNeedsBypass,
  setPlanApprovalModeResolver,
  spawnedSessionFor,
} from '../../src/main/plan-approval/plan-approval-spawns';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { prepareAgentSpawn } from '../../src/main/transition-engine/session-startup/prepare-spawn';

const PROJECT_ID = 'proj-1';
const TASK_ID = 'task-abc-1';

/** Session ids the tests recorded, so each test can forget them. */
const recordedSessionIds = new Set<string>();

function makeAdapter(supportsPlanAutoApproval: boolean | undefined): StubAdapter {
  return {
    name: 'claude',
    displayName: 'Claude',
    sessionType: 'claude_agent',
    supportsCallerSessionId: true,
    supportsPlanAutoApproval,
    defaultPermission: 'default',
    launchOptions: undefined,
    detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
    ensureTrust: vi.fn(async () => {}),
    buildCommand: vi.fn(() => 'claude --mock-run'),
    buildEnv: undefined,
    getExitSequence: vi.fn(() => ['\x03']),
    removeHooks: vi.fn(),
    runtime: undefined,
    locateSessionHistoryFile: vi.fn(async () => null),
    proveConversationGone: undefined,
  };
}

beforeEach(() => {
  setPlanApprovalModeResolver(null);
  registry.current = null;
  recordedSessionIds.clear();
});

afterEach(() => {
  setPlanApprovalModeResolver(null);
  for (const sessionId of recordedSessionIds) forgetPlanApprovalSpawn(sessionId);
});

describe('planSpawnNeedsBypass', () => {
  const planSpawn = { permissionMode: 'plan' as PermissionMode | null | undefined, agentApprovesPlans: true, projectId: PROJECT_ID, taskId: TASK_ID };

  it('is true for a plan session on an agent that approves plans whose approval continues in bypass', () => {
    const resolver = vi.fn(() => 'bypassPermissions' as PermissionMode);
    setPlanApprovalModeResolver(resolver);

    expect(planSpawnNeedsBypass(planSpawn)).toBe(true);
    // The question is about this task on this board.
    expect(resolver).toHaveBeenCalledWith(PROJECT_ID, TASK_ID);
  });

  it('is false for a session that does not run in plan mode, whatever the approval would continue in', () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');

    for (const permissionMode of ['default', 'acceptEdits', 'bypassPermissions', 'auto', null, undefined] as const) {
      expect(planSpawnNeedsBypass({ ...planSpawn, permissionMode })).toBe(false);
    }
  });

  it('is false on an agent whose plans Kangentic cannot approve', () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');

    expect(planSpawnNeedsBypass({ ...planSpawn, agentApprovesPlans: false })).toBe(false);
  });

  it('is false when the approval continues in any mode but bypass, or is not approved at all', () => {
    for (const continuing of ['default', 'acceptEdits', 'auto', null] as const) {
      setPlanApprovalModeResolver(() => continuing);
      expect(planSpawnNeedsBypass(planSpawn)).toBe(false);
    }
  });

  it('is false, and does not throw, while no resolver is registered', () => {
    setPlanApprovalModeResolver(null);

    expect(planSpawnNeedsBypass(planSpawn)).toBe(false);
    expect(planApprovalModeForSpawn(PROJECT_ID, TASK_ID)).toBeNull();
  });

  it('is false, and does not throw, when the resolver throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setPlanApprovalModeResolver(() => {
        throw new Error('board unreadable');
      });

      expect(planSpawnNeedsBypass(planSpawn)).toBe(false);
      expect(planApprovalModeForSpawn(PROJECT_ID, TASK_ID)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the board spawn chokepoint (TransitionEngine)', () => {
  const PROJECT_PATH = '/some/project';

  function makeEngine(adapter: StubAdapter) {
    registry.current = adapter;
    const spawnTimeRecords: Array<ReturnType<typeof spawnedSessionFor>> = [];
    const spawn = vi.fn(async (options: { id: string }) => {
      recordedSessionIds.add(options.id);
      spawnTimeRecords.push(spawnedSessionFor(options.id));
      return { id: options.id, status: 'running' };
    });
    const sessionManager = { spawn, getShell: vi.fn(async () => 'bash') };
    const sessionRepo = {
      getLatestForTask: vi.fn(() => null),
      getLatestForTaskByTypeAndIsolation: vi.fn(() => null),
      insert: vi.fn(),
      update: vi.fn(),
      updateAppliedSettings: vi.fn(),
      compareAndUpdateStatus: vi.fn(() => true),
      updateAgentSessionId: vi.fn(),
      listForTaskNewestFirst: vi.fn(() => []),
    };
    const taskRepo = {
      update: vi.fn(),
      recordWorktree: vi.fn(),
      getById: vi.fn(() => undefined),
      recoverLegacyWorktreeFolder: vi.fn(() => null),
      setWorktreeSkipReason: vi.fn(),
    };
    const getConfig = vi.fn(() => ({
      permissionMode: 'default',
      projectPath: PROJECT_PATH,
      projectId: PROJECT_ID,
      projectName: 'Mock project',
      gitConfig: { worktreesEnabled: false, defaultBaseBranch: 'main', autoCleanup: false, copyFiles: [] },
      mcpServerEnabled: false,
      mcpServerUrl: undefined,
      mcpServerToken: undefined,
      defaultAgent: 'claude',
      cliPathOverrides: {},
      executionServers: {},
      execution: {},
      launchOptions: {},
    }));
    type EngineArgs = ConstructorParameters<typeof TransitionEngine>;
    const engine = new TransitionEngine(
      sessionManager as unknown as EngineArgs[0],
      { submitKeystrokes: vi.fn() } as unknown as EngineArgs[1],
      taskRepo as unknown as EngineArgs[2],
      getConfig as unknown as EngineArgs[3],
      sessionRepo as unknown as EngineArgs[4],
      { getPathsForTask: vi.fn(() => []) } as unknown as EngineArgs[5],
    );
    const runSpawn = (permissionOverride: PermissionMode | null, task: Record<string, unknown> = {}) => engine.runLegacySpawnAgent(
      { promptTemplate: '{{task_xml}}{{attachments}}' } as unknown as Parameters<typeof engine.runLegacySpawnAgent>[0],
      {
        id: TASK_ID,
        title: 'Fix login flow',
        description: 'Check OAuth.',
        session_id: null,
        worktree_path: null,
        branch_name: null,
        pr_url: null,
        pr_number: null,
        agent: null,
        ...task,
      } as unknown as Parameters<typeof engine.runLegacySpawnAgent>[1],
      permissionOverride,
    );
    return { runSpawn, spawn, spawnTimeRecords };
  }

  /** The id the engine gave this spawn, as the builder was handed it. */
  function builtSessionId(adapter: StubAdapter): string {
    const options = adapter.buildCommand.mock.calls[0][0] as { ptySessionId: string };
    return options.ptySessionId;
  }

  it('launches a plan session with bypass available when its approval would continue in bypass, and records that', async () => {
    const resolver = vi.fn(() => 'bypassPermissions' as PermissionMode);
    setPlanApprovalModeResolver(resolver);
    const adapter = makeAdapter(true);
    const { runSpawn, spawnTimeRecords } = makeEngine(adapter);

    await runSpawn('plan');

    expect(adapter.buildCommand).toHaveBeenCalledTimes(1);
    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'plan', bypassAvailable: true });
    expect(resolver).toHaveBeenCalledWith(PROJECT_ID, TASK_ID);
    const sessionId = builtSessionId(adapter);
    const expectedRecord = {
      sessionDir: path.join(PROJECT_PATH, '.kangentic', 'sessions', sessionId),
      bypassAvailable: true,
    };
    expect(spawnedSessionFor(sessionId)).toEqual(expectedRecord);
    // Already there when the PTY spawns, the moment the writer first reads it.
    expect(spawnTimeRecords).toEqual([expectedRecord]);
  });

  it('launches without bypass, and records that, for an agent that cannot approve plans', async () => {
    const resolver = vi.fn(() => 'bypassPermissions' as PermissionMode);
    setPlanApprovalModeResolver(resolver);
    const adapter = makeAdapter(undefined);
    const { runSpawn } = makeEngine(adapter);

    await runSpawn('plan');

    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'plan', bypassAvailable: false });
    expect(spawnedSessionFor(builtSessionId(adapter))).toMatchObject({ bypassAvailable: false });
  });

  it('launches without bypass when the session does not run in plan mode', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);
    const { runSpawn } = makeEngine(adapter);

    await runSpawn('acceptEdits');

    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits', bypassAvailable: false });
    expect(spawnedSessionFor(builtSessionId(adapter))).toMatchObject({ bypassAvailable: false });
  });

  it('launches without bypass when the approval would continue in another mode', async () => {
    setPlanApprovalModeResolver(() => 'acceptEdits');
    const adapter = makeAdapter(true);
    const { runSpawn } = makeEngine(adapter);

    await runSpawn('plan');

    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ bypassAvailable: false });
  });

  it('records the spawn only after the command is built', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);
    let recordWhileBuilding: ReturnType<typeof spawnedSessionFor> = { sessionDir: 'unset', bypassAvailable: false };
    adapter.buildCommand.mockImplementation((options: { ptySessionId: string }) => {
      recordedSessionIds.add(options.ptySessionId);
      recordWhileBuilding = spawnedSessionFor(options.ptySessionId);
      return 'claude --mock-run';
    });
    const { runSpawn } = makeEngine(adapter);

    await runSpawn('plan');

    expect(recordWhileBuilding).toBeUndefined();
    expect(spawnedSessionFor(builtSessionId(adapter))).toBeDefined();
  });

  it('leaves no record for a command that fails to build', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);
    const buildFailure = new Error('cannot write hooks');
    adapter.buildCommand.mockImplementation((options: { ptySessionId: string }) => {
      recordedSessionIds.add(options.ptySessionId);
      throw buildFailure;
    });
    const { runSpawn, spawn } = makeEngine(adapter);

    await expect(runSpawn('plan')).rejects.toBe(buildFailure);

    expect(spawn).not.toHaveBeenCalled();
    expect(spawnedSessionFor(builtSessionId(adapter))).toBeUndefined();
  });
});

describe('the startup spawn chokepoint (prepareAgentSpawn)', () => {
  const PROJECT_PATH = '/mock/project';

  function makeTask(): Task {
    return {
      id: TASK_ID,
      display_id: 1,
      title: 'Startup task',
      description: 'Recover me',
      swimlane_id: 'lane-planning',
      position: 0,
      agent: 'claude',
      agent_override: null,
      model_override: null,
      effort_override: null,
      permission_mode: null,
      run_mode: 'column_settings',
      session_id: null,
      worktree_path: null,
      branch_name: null,
      labels: [],
      archived_at: null,
    } as unknown as Task;
  }

  function makePlanningLane(permissionMode: PermissionMode | null): Swimlane {
    return {
      id: 'lane-planning',
      name: 'Planning',
      role: null,
      position: 1,
      permission_mode: permissionMode,
      auto_spawn: true,
      plan_exit_target_id: null,
      agent_override: null,
      model_override: null,
      effort_override: null,
      handoff_context: false,
      session_target: 'main',
      session_spawn_strategy: 'create_or_resume',
    } as unknown as Swimlane;
  }

  async function runPrepare(adapter: StubAdapter, laneMode: PermissionMode | null) {
    registry.current = adapter;
    return prepareAgentSpawn({
      task: makeTask(),
      swimlane: makePlanningLane(laneMode),
      cwd: PROJECT_PATH,
      projectId: PROJECT_ID,
      projectPath: PROJECT_PATH,
      effectiveConfig: {
        agent: { permissionMode: 'acceptEdits', cliPaths: {} },
        mcpServer: { enabled: false },
      } as unknown as AppConfig,
      projectDefaultAgent: 'claude',
      projectDefaultModel: null,
      projectDefaultEffort: null,
      resolvedShell: 'bash',
      mcpServerHandle: null,
      resume: null,
      hasSessionRecord: true,
      tasks: { update: vi.fn() },
    });
  }

  function builtSessionId(adapter: StubAdapter): string {
    const options = adapter.buildCommand.mock.calls[0][0] as { ptySessionId: string };
    recordedSessionIds.add(options.ptySessionId);
    return options.ptySessionId;
  }

  it('launches a plan session with bypass available when its approval would continue in bypass, and records that', async () => {
    const resolver = vi.fn(() => 'bypassPermissions' as PermissionMode);
    setPlanApprovalModeResolver(resolver);
    const adapter = makeAdapter(true);

    const result = await runPrepare(adapter, 'plan');

    expect(result.ok).toBe(true);
    expect(adapter.buildCommand).toHaveBeenCalledTimes(1);
    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'plan', bypassAvailable: true });
    expect(resolver).toHaveBeenCalledWith(PROJECT_ID, TASK_ID);
    const sessionId = builtSessionId(adapter);
    if (!result.ok) throw new Error('prepare refused');
    expect(result.data.sessionRecordId).toBe(sessionId);
    expect(spawnedSessionFor(sessionId)).toEqual({
      sessionDir: path.join(PROJECT_PATH, '.kangentic', 'sessions', sessionId),
      bypassAvailable: true,
    });
  });

  it('launches without bypass, and records that, for an agent that cannot approve plans', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(undefined);

    await runPrepare(adapter, 'plan');

    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'plan', bypassAvailable: false });
    expect(spawnedSessionFor(builtSessionId(adapter))).toMatchObject({ bypassAvailable: false });
  });

  it('launches without bypass when the session does not run in plan mode', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);

    await runPrepare(adapter, null);

    expect(adapter.buildCommand.mock.calls[0][0]).toMatchObject({ permissionMode: 'acceptEdits', bypassAvailable: false });
    expect(spawnedSessionFor(builtSessionId(adapter))).toMatchObject({ bypassAvailable: false });
  });

  it('records the spawn only after the command is built', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);
    let recordWhileBuilding: ReturnType<typeof spawnedSessionFor> = { sessionDir: 'unset', bypassAvailable: false };
    adapter.buildCommand.mockImplementation((options: { ptySessionId: string }) => {
      recordedSessionIds.add(options.ptySessionId);
      recordWhileBuilding = spawnedSessionFor(options.ptySessionId);
      return 'claude --mock-run';
    });

    await runPrepare(adapter, 'plan');

    expect(recordWhileBuilding).toBeUndefined();
    expect(spawnedSessionFor(builtSessionId(adapter))).toBeDefined();
  });

  it('leaves no record for a command that fails to build', async () => {
    setPlanApprovalModeResolver(() => 'bypassPermissions');
    const adapter = makeAdapter(true);
    const buildFailure = new Error('cannot write hooks');
    adapter.buildCommand.mockImplementation((options: { ptySessionId: string }) => {
      recordedSessionIds.add(options.ptySessionId);
      throw buildFailure;
    });

    await expect(runPrepare(adapter, 'plan')).rejects.toBe(buildFailure);

    expect(spawnedSessionFor(builtSessionId(adapter))).toBeUndefined();
  });
});

describe('the spawn record', () => {
  it('is readable until forgotten, and forgetting one session leaves another', () => {
    notePlanApprovalSpawn('session-a', { sessionDir: 'a', bypassAvailable: true });
    notePlanApprovalSpawn('session-b', { sessionDir: 'b', bypassAvailable: false });
    recordedSessionIds.add('session-a');
    recordedSessionIds.add('session-b');

    forgetPlanApprovalSpawn('session-a');

    expect(spawnedSessionFor('session-a')).toBeUndefined();
    expect(spawnedSessionFor('session-b')).toEqual({ sessionDir: 'b', bypassAvailable: false });
  });
});

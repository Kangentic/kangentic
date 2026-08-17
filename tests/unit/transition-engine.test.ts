/**
 * Unit tests for TransitionEngine raw/sanitized description split.
 *
 * History: prior to this fix, both `task_xml` and the `{{description}}`
 * template var received the sanitized (newline-stripped) description. This
 * meant multi-line markdown in task descriptions was collapsed to a single
 * line before the XML envelope was built, which garbled structured content
 * like acceptance criteria and bullet lists.
 *
 * The fix (this branch):
 *   - `task_xml`        uses raw `task.description` (multi-line preserved)
 *   - `{{description}}` uses `sanitizeForPty(task.description)` (newlines stripped)
 *
 * These tests pin that contract by inspecting:
 *   1. `executeAction` (spawn_agent case) via `executeTransition`
 *   2. `resumeSuspendedSession`
 *
 * Strategy: mock everything the engine touches except the logic under test
 * (buildTaskXml + sanitizeForPty). We capture the `prompt` field written
 * to the session repo and the command built by the adapter mock to verify
 * what was interpolated.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
import { sanitizeForPty } from '../../src/shared/paths';
import { migrateResumeCwdIfRenamed } from '../../src/main/transition-engine/resume-cwd-migration';
import { OpenCodeCommandBuilder, type OpenCodeCommandOptions } from '../../src/main/agent/adapters/opencode';
import { CodexCommandBuilder, type CodexCommandOptions } from '../../src/main/agent/adapters/codex';
import type { AgentExecutionServer, AgentProjectExecution, AgentLaunchOptionInfo, SessionUsage } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// Minimal mock factories
// ---------------------------------------------------------------------------

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-abc-1',
    title: 'Fix login flow',
    description: 'Step 1: check OAuth.\n\nStep 2: refresh token.',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    agent: null,
    ...overrides,
  };
}

function makeAction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'action-1',
    type: 'spawn_agent',
    config_json: JSON.stringify({
      promptTemplate: '{{task_xml}}{{attachments}}',
    }),
    ...overrides,
  };
}

function makeSessionRepo() {
  const insertedRecords: unknown[] = [];
  return {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => null),
    insert: vi.fn((record: unknown) => { insertedRecords.push(record); }),
    update: vi.fn(),
    updateAppliedSettings: vi.fn(),
    // Needed by retireRecord() which fires in the resume path when
    // intent.retireRecordId is non-null (existing tests never reach it
    // because they always produce a fresh spawn with retireRecordId=null).
    compareAndUpdateStatus: vi.fn(() => true),
    // Persist target for reconcileResumeAgentSessionId's swap (only reached
    // when mockAdapter.runtime.statusFile is set - the reconcile describe
    // below). Every other test's mockAdapter has no runtime, so the reconcile
    // returns before ever calling this.
    updateAgentSessionId: vi.fn(),
    // The conversation lineage isResumeConversationAbsent walks on a resume:
    // every record sharing the resumed agent_session_id, newest first. Empty
    // here, so the guard falls back to the retiring record alone and finds no
    // report, which is its "unknown, resume as before" path.
    listForTaskNewestFirst: vi.fn(() => []),
    insertedRecords,
  };
}

interface StoredWorktreeFields {
  worktree_path: string;
  branch_name: string;
  worktree_folder: string;
}

function makeTaskRepo() {
  // Models the one thing executeCreateWorktree depends on beyond a bare spy: a
  // write followed by a read-back. The engine refreshes the in-memory task from
  // getById after recordWorktree, because executeTransition hands the SAME task
  // object to every later action in the chain.
  const storedTasks = new Map<string, StoredWorktreeFields>();
  return {
    update: vi.fn(),
    recordWorktree: vi.fn(
      (taskId: string, worktreePath: string, branchName: string, worktreeFolder: string) => {
        storedTasks.set(taskId, {
          worktree_path: worktreePath,
          branch_name: branchName,
          worktree_folder: worktreeFolder,
        });
      },
    ),
    getById: vi.fn((taskId: string) => storedTasks.get(taskId)),
    // No legacy folder to recover: these tasks were never created under the old
    // `<slug>-<shortId>` scheme, so they take their display_id.
    recoverLegacyWorktreeFolder: vi.fn(() => null),
  };
}

function makeActionRepo(action: ReturnType<typeof makeAction>) {
  return {
    getTransitionsFor: vi.fn(() => [{ action_id: action.id }]),
    getById: vi.fn(() => action),
  };
}

function makeAttachmentRepo() {
  return {
    getPathsForTask: vi.fn(() => []),
  };
}

/**
 * Capture the command string built by the adapter so we can inspect the
 * quoted prompt that would be passed to the shell.
 */
function makeSessionManager() {
  const spawnedSessions: Array<{ command: string; prompt?: string }> = [];
  return {
    spawn: vi.fn(async (options: { command: string }) => {
      spawnedSessions.push({ command: options.command });
      return { id: 'pty-session-1', status: 'running' };
    }),
    getShell: vi.fn(async () => 'bash'),
    spawnedSessions,
  };
}

/**
 * The PTY-refactor commit (4721400) added `TerminalSubmit` as the 2nd
 * constructor argument. The spawn / resume paths exercised by these tests
 * never hit `submitKeystrokes`, so a no-op stub is sufficient.
 */
function makeTerminalSubmit() {
  return {
    submitKeystrokes: vi.fn(),
  };
}

/**
 * Stub adapter that:
 * - Claims to be found
 * - buildCommand returns its prompt option unchanged (for inspection)
 * - No filesystem side effects
 */
const mockAdapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  defaultPermission: 'default',
  // Undefined by default, matching every adapter but Codex (see
  // AgentAdapter.launchOptions). The launch-option wiring describe below
  // sets this per-test and restores it to undefined afterward so later
  // describe blocks in this file are unaffected.
  launchOptions: undefined as readonly AgentLaunchOptionInfo[] | undefined,
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn((options: { prompt?: string }) => {
    // Return a string that embeds the prompt so we can inspect it from outside
    return `claude ${options.prompt ?? ''}`;
  }),
  buildEnv: undefined,
  getExitSequence: vi.fn(() => ['\x03']),
  removeHooks: vi.fn(),
  // Undefined by default (matching every existing test in this file, none of
  // which spawn through the resume-time reconcile branch's swap path): the
  // "TransitionEngine - resume-time agent-session-id reconcile wiring"
  // describe below is the only one that sets this, and resets it to
  // undefined in its afterEach so it never leaks into other describes.
  runtime: undefined as { statusFile?: { parseStatus: (raw: string) => SessionUsage | null } } | undefined,
  locateSessionHistoryFile: vi.fn(async (_agentSessionId: string, _cwd: string): Promise<string | null> => null),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(() => mockAdapter),
    list: vi.fn(() => ['claude']),
  },
}));

// Mocked so executeSpawnAgent's unconditional migrateResumeCwdIfRenamed call
// does not touch the real filesystem. Existing tests never reach the migration
// body (canResume is always false there); this mock makes it transparent.
vi.mock('../../src/main/transition-engine/resume-cwd-migration', () => ({
  migrateResumeCwdIfRenamed: vi.fn(async () => {}),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  // The source under test uses `import fs from 'node:fs'` (default import).
  // Without an explicit `default` field, Vitest's factory leaves the default
  // export pointing at the real module, so `fs.mkdirSync` runs unmocked and
  // creates real directories under cwd. This was silent on Windows (where
  // `/some/project` resolves under the current drive and is writable) but
  // failed with EACCES on Linux CI.
  const mocked = {
    ...original,
    mkdirSync: vi.fn(),
    // Allow other fs calls to pass through for tmp operations
  };
  return { ...mocked, default: mocked };
});

// Mock WorktreeManager so the create_worktree action path can be exercised
// without touching git. withLock just runs the job inline; ensureWorktree is a
// shared spy whose third (options) argument carries the signal + onProgress we
// assert the action path threads through.
const worktreeManagerMock = vi.hoisted(() => ({
  ensureWorktree: vi.fn(),
}));

vi.mock('../../src/main/git/worktree-manager', () => ({
  WorktreeManager: class {
    constructor(_projectPath: string) {}
    async withLock<T>(job: () => Promise<T> | T): Promise<T> {
      return job();
    }
    ensureWorktree = worktreeManagerMock.ensureWorktree;
  },
}));

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

function makeEngine(options: {
  sessionManager?: ReturnType<typeof makeSessionManager>;
  sessionRepo?: ReturnType<typeof makeSessionRepo>;
  action?: ReturnType<typeof makeAction>;
  /** Global + per-project remote-execution config, keyed by agent name. Defaults
   * to empty maps (local execution for every agent), matching every existing
   * caller of makeEngine. */
  executionServers?: Record<string, AgentExecutionServer>;
  execution?: Record<string, AgentProjectExecution>;
  /** Global, agent-keyed boolean launch-option toggles. Defaults to an empty
   * map (no stored overrides), matching every existing caller of makeEngine. */
  launchOptions?: Record<string, Record<string, boolean>>;
  /** Override the default no-op terminalSubmit stub (e.g. send_command tests
   * need submitKeystrokes to return a real Promise so its internal `.catch`
   * doesn't throw). */
  terminalSubmit?: ReturnType<typeof makeTerminalSubmit>;
  /** Project-scoped MCP server URL (mirrors TransitionEngineConfig.mcpServerUrl).
   * Defaults to undefined, matching every existing caller of makeEngine. */
  mcpServerUrl?: string;
  /** appConfig.projectPath override. Defaults to the fake '/some/project' path
   * every existing caller relies on. The reconcile-wiring describe below
   * overrides this to a real mkdtemp dir so reconcileResumeAgentSessionId's
   * unmocked fs.readFileSync can read a real status.json. */
  projectPath?: string;
}) {
  const sessionManager = options.sessionManager ?? makeSessionManager();
  const sessionRepo = options.sessionRepo ?? makeSessionRepo();
  const action = options.action ?? makeAction();
  const actionRepo = makeActionRepo(action);
  const taskRepo = makeTaskRepo();
  const attachmentRepo = makeAttachmentRepo();

  const getConfig = vi.fn(() => ({
    permissionMode: 'default',
    projectPath: options.projectPath ?? '/some/project',
    projectId: 'proj-1',
    gitConfig: {
      worktreesEnabled: false,
      defaultBaseBranch: 'main',
      autoCleanup: false,
      copyFiles: [],
    },
    mcpServerEnabled: false,
    mcpServerUrl: options.mcpServerUrl,
    mcpServerToken: undefined,
    defaultAgent: 'claude',
    cliPathOverrides: {},
    executionServers: options.executionServers ?? {},
    execution: options.execution ?? {},
    launchOptions: options.launchOptions ?? {},
  }));

  const terminalSubmit = options.terminalSubmit ?? makeTerminalSubmit();
  type EngineArgs = ConstructorParameters<typeof TransitionEngine>;
  const engine = new TransitionEngine(
    sessionManager as unknown as EngineArgs[0],
    terminalSubmit as unknown as EngineArgs[1],
    actionRepo as unknown as EngineArgs[2],
    taskRepo as unknown as EngineArgs[3],
    getConfig as unknown as EngineArgs[4],
    sessionRepo as unknown as EngineArgs[5],
    attachmentRepo as unknown as EngineArgs[6],
  );

  return { engine, sessionManager, sessionRepo, taskRepo, actionRepo, terminalSubmit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransitionEngine - raw/sanitized description split', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset buildCommand to default implementation
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  it('executeAction (spawn_agent): task_xml contains raw multi-line description', async () => {
    const rawDescription = 'Step 1: check OAuth.\n\nStep 2: refresh token.';
    const task = makeTask({ description: rawDescription });

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    const { engine } = makeEngine({});
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedPrompt).toBeDefined();
    // The raw newlines must survive into the XML envelope
    expect(capturedPrompt).toContain('Step 1: check OAuth.\n\nStep 2: refresh token.');
    // Verify the full XML shape
    const expectedXml = buildTaskXml({ title: 'Fix login flow', description: rawDescription });
    expect(capturedPrompt).toContain(expectedXml);
  });

  it('executeAction (spawn_agent): {{description}} template var uses sanitized (newline-stripped) text', async () => {
    const rawDescription = 'Step 1: check OAuth.\n\nStep 2: refresh token.';
    const task = makeTask({ description: rawDescription });
    const sanitized = sanitizeForPty(rawDescription);

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    // Use a custom action that uses the legacy {{description}} template var
    const legacyAction = makeAction({
      config_json: JSON.stringify({
        promptTemplate: '{{title}}{{description}}',
      }),
    });

    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionManager, sessionRepo, action: legacyAction });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedPrompt).toBeDefined();
    // The sanitized var should not contain raw newlines
    expect(capturedPrompt).not.toContain('\n');
    // But should still contain the text content
    expect(capturedPrompt).toContain('Fix login flow');
    // sanitized description is prefixed with ': ' when non-empty
    expect(capturedPrompt).toContain(`: ${sanitized}`);
  });

  it('resumeSuspendedSession: task_xml contains raw multi-line description', async () => {
    const rawDescription = 'Acceptance criteria:\n- Must handle 404\n- Must retry 3x';
    const task = makeTask({ description: rawDescription });

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    const { engine } = makeEngine({});
    await engine.resumeSuspendedSession(task as Parameters<typeof engine.resumeSuspendedSession>[0]);

    expect(capturedPrompt).toBeDefined();
    // Raw newlines preserved in the XML body
    expect(capturedPrompt).toContain('Acceptance criteria:\n- Must handle 404\n- Must retry 3x');
    const expectedXml = buildTaskXml({ title: 'Fix login flow', description: rawDescription });
    expect(capturedPrompt).toContain(expectedXml);
  });

  it('resumeSuspendedSession: empty description omits <description> entirely', async () => {
    const task = makeTask({ description: '' });

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    const { engine } = makeEngine({});
    await engine.resumeSuspendedSession(task as Parameters<typeof engine.resumeSuspendedSession>[0]);

    expect(capturedPrompt).toBeDefined();
    // buildTaskXml omits <description> entirely when empty - no self-closing tag
    expect(capturedPrompt).not.toContain('<description');
    expect(capturedPrompt).toContain('<title>Fix login flow</title>');
  });

  it('resumeSuspendedSession: whitespace-only description omits <description> entirely', async () => {
    const task = makeTask({ description: '   \n\t  ' });

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    const { engine } = makeEngine({});
    await engine.resumeSuspendedSession(task as Parameters<typeof engine.resumeSuspendedSession>[0]);

    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).not.toContain('<description');
  });

  it('session repo receives the raw-description prompt', async () => {
    const rawDescription = 'Line one.\n\nLine two.';
    const task = makeTask({ description: rawDescription });
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { prompt?: string };
    expect(inserted.prompt).toBeDefined();
    // The prompt stored in the DB should contain the XML with raw newlines
    expect(inserted.prompt).toContain(rawDescription);
  });

  it('executeTransition (spawn_agent) calls updateAppliedSettings with the resolved spawn overrides', async () => {
    // Gap 4: after every spawn, the session record must have applied_model /
    // applied_effort written so prepareInjectionPlan can diff against the true
    // running value on a subsequent column move. When no spawnOverrides are
    // provided, the call uses null (agent default / no --model / --effort flag).
    const task = makeTask();
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    // The session must have been inserted first, then the applied settings written.
    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    expect(sessionRepo.updateAppliedSettings).toHaveBeenCalledTimes(1);
    expect(sessionRepo.updateAppliedSettings).toHaveBeenCalledWith(
      expect.any(String), // ptySessionId (a UUID generated inside executeSpawnAgent)
      { model: null, effort: null },
    );
    // The session ID written to updateAppliedSettings must match the inserted record.
    const insertedId = (sessionRepo.insert.mock.calls[0][0] as { id: string }).id;
    const [appliedSessionId] = sessionRepo.updateAppliedSettings.mock.calls[0] as [string, unknown];
    expect(appliedSessionId).toBe(insertedId);
  });
});

describe('TransitionEngine - permission_mode resolution precedence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  it('task.permission_mode wins over a differing NON-plan permissionOverride (swimlane) argument', async () => {
    // Resolution order in executeSpawnAgent is task -> swimlane override ->
    // global default, EXCEPT a swimlane forcing 'plan' (see next test).
    // 'acceptEdits' here is an ordinary column default, not a safety lock,
    // so the task-level pin still wins.
    const task = makeTask({ permission_mode: 'plan' });
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
      'acceptEdits', // permissionOverride from the destination swimlane
    );

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('plan');
  });

  it('a swimlane forcing plan mode ALWAYS wins, regardless of a differing task.permission_mode', async () => {
    // Plan mode is a genuine safety guarantee (never let a task's
    // Auto-Classifier/Accept-Edits pin bypass a deliberate read-only phase),
    // so it wins even over an explicit, differing task-level pin.
    const task = makeTask({ permission_mode: 'auto' });
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
      'plan', // permissionOverride from the destination swimlane
    );

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('plan');
  });

  it('falls through to permissionOverride when the task has no permission_mode pin', async () => {
    const task = makeTask({ permission_mode: null });
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
      'acceptEdits',
    );

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('acceptEdits');
  });

  it('falls through to task.permission_mode when the swimlane has no permission_mode set', async () => {
    // The column left permission_mode null (no permissionOverride argument),
    // so the task's own pin is still a valid fallback tier.
    const task = makeTask({ permission_mode: 'auto' });
    const sessionRepo = makeSessionRepo();

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
      null,
    );

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('auto');
  });
});

describe('TransitionEngine - create_worktree action threads signal + progress', () => {
  type EnsureWorktreeOptions = { signal?: AbortSignal; onProgress?: (phase: string) => void };

  beforeEach(() => {
    vi.clearAllMocks();
    worktreeManagerMock.ensureWorktree.mockResolvedValue({
      worktreePath: '/some/project/.kangentic/worktrees/460',
      branchName: 'kangentic/fix-login-flow',
      worktreeFolder: '460',
    });
  });

  it('forwards the abort signal and onProgress callback into ensureWorktree', async () => {
    const task = makeTask({ worktree_path: null });
    const action = makeAction({ type: 'create_worktree', config_json: JSON.stringify({}) });
    const { engine, taskRepo } = makeEngine({ action });

    const controller = new AbortController();
    const onProgress = vi.fn();

    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
      undefined,
      undefined,
      controller.signal,
      undefined,
      undefined,
      onProgress,
    );

    expect(worktreeManagerMock.ensureWorktree).toHaveBeenCalledTimes(1);
    const [, , options] = worktreeManagerMock.ensureWorktree.mock.calls[0] as [unknown, unknown, EnsureWorktreeOptions];
    expect(options.signal).toBe(controller.signal);
    expect(options.onProgress).toBe(onProgress);

    // Success path persists path, branch, and the write-once folder name
    // together, in one transaction.
    expect(taskRepo.recordWorktree).toHaveBeenCalledWith(
      task.id,
      '/some/project/.kangentic/worktrees/460',
      'kangentic/fix-login-flow',
      '460',
    );

    // And the IN-MEMORY task is refreshed from the row, not just the DB.
    // executeTransition passes this same object to every later action, so a
    // `create_worktree` followed by `spawn_agent` would otherwise compute its
    // cwd from a null worktree_path and run the agent in the main checkout.
    expect(task.worktree_path).toBe('/some/project/.kangentic/worktrees/460');
    expect(task.worktree_folder).toBe('460');
  });

  it('passes undefined signal/progress when the caller supplies none', async () => {
    const task = makeTask({ worktree_path: null });
    const action = makeAction({ type: 'create_worktree', config_json: JSON.stringify({}) });
    const { engine } = makeEngine({ action });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(worktreeManagerMock.ensureWorktree).toHaveBeenCalledTimes(1);
    const [, , options] = worktreeManagerMock.ensureWorktree.mock.calls[0] as [unknown, unknown, EnsureWorktreeOptions];
    expect(options.signal).toBeUndefined();
    expect(options.onProgress).toBeUndefined();
  });
});

describe('TransitionEngine - migrateResumeCwdIfRenamed wiring', () => {
  // Each test in this describe needs a clean mock slate. The describe above also
  // calls vi.clearAllMocks() in its beforeEach, but that only covers tests inside
  // that describe. Without clearing here, migrateResumeCwdIfRenamed call counts
  // from describe 1's spawn_agent tests would leak into these assertions.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  it('calls migrateResumeCwdIfRenamed with oldCwd=intent.resumeFromCwd and newCwd=resolved cwd on a resume spawn', async () => {
    // Arrange: a session record whose cwd differs from the task's current worktree
    // path, simulating a post-rename resume scenario.
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: 'session-record-1',
      agent_session_id: 'agent-sess-uuid',
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: '/old/worktree/path',
    });

    // task.worktree_path becomes `cwd` inside executeSpawnAgent via:
    //   const cwd = task.worktree_path || appConfig.projectPath || process.cwd();
    const task = makeTask({ worktree_path: '/new/worktree/path' });

    const { engine } = makeEngine({ sessionRepo });
    await engine.executeTransition(
      task as Parameters<typeof engine.executeTransition>[0],
      'todo',
      'doing',
    );

    // The migration must be called exactly once, threaded with:
    //   oldCwd = intent.resumeFromCwd = match.cwd  (the session's original worktree cwd)
    //   newCwd = cwd = task.worktree_path           (the renamed worktree the agent is spawned into)
    //   canResume = true                            (resume-eligible record found)
    //   agentSessionId = match.agent_session_id     (forwarded from the intent)
    //
    // Red: deleting the migrateResumeCwdIfRenamed call block from executeSpawnAgent
    //      causes this to fail (called 0 times instead of 1).
    // Red: swapping oldCwd/newCwd causes the objectContaining check to fail.
    expect(migrateResumeCwdIfRenamed).toHaveBeenCalledOnce();
    expect(migrateResumeCwdIfRenamed).toHaveBeenCalledWith(
      expect.objectContaining({
        oldCwd: '/old/worktree/path',
        newCwd: '/new/worktree/path',
        canResume: true,
        agentSessionId: 'agent-sess-uuid',
      }),
    );
  });
});

describe('TransitionEngine - resume-time agent-session-id reconcile wiring (executeSpawnAgent chokepoint)', () => {
  // Coverage hole (issue #481 review): executeSpawnAgent's resume branch
  // computes `agentSessionId` by awaiting `reconcileResumeAgentSessionId`
  // (resume-id-reconcile.ts), not by using `intent.agentSessionId` directly.
  // The helper's own logic is fully unit-tested in resume-id-reconcile.test.ts;
  // what was untested is the WIRING at THIS call site - that the reconciled id
  // (not the stale DB-stored id) is what actually reaches the built command,
  // sessionManager.spawn, and the inserted session record.
  //
  // Unlike every other describe in this file, mockAdapter needs a real
  // `runtime.statusFile` + a `locateSessionHistoryFile` that resolves so the
  // reconcile takes its swap branch. Both are reset to their file-level
  // defaults in afterEach so they never leak into other describes.
  //
  // This describe also uses a REAL mkdtemp projectPath (via the makeEngine
  // `projectPath` override) instead of the file's usual fake '/some/project':
  // the file's node:fs mock stubs mkdirSync only and passes readFileSync
  // through to the real filesystem, so reconcileResumeAgentSessionId's
  // `fs.readFileSync(statusOutputPath)` needs a real file to read.
  const RECORD_ID = 'session-record-reconcile-1';
  const STORED_ID = 'stored-agent-session-id-aaaa';
  const FORKED_ID = 'forked-agent-session-id-bbbb';

  let projectPath: string;

  /** Writes a real status.json for the retiring record. Uses fs.promises.mkdir
   * (unmocked in this file's node:fs factory) rather than the file-mocked
   * fs.mkdirSync, which is a no-op here. */
  async function writeStatusFile(reportedSessionId: string): Promise<void> {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({ session_id: reportedSessionId }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-reconcile-'));
    mockAdapter.runtime = {
      statusFile: {
        parseStatus: (raw: string): SessionUsage | null => {
          try {
            const parsed = JSON.parse(raw) as { session_id?: string };
            return { sessionId: parsed.session_id } as SessionUsage;
          } catch {
            return null;
          }
        },
      },
    };
    mockAdapter.locateSessionHistoryFile.mockResolvedValue('/found/transcript.jsonl');
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    mockAdapter.runtime = undefined;
    mockAdapter.locateSessionHistoryFile.mockReset();
    mockAdapter.locateSessionHistoryFile.mockImplementation(async () => null);
  });

  it('resumes the id reported by the retiring record status.json, not the stale DB-stored id', async () => {
    await writeStatusFile(FORKED_ID);

    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: STORED_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: path.join(projectPath, 'worktree'),
    });

    let capturedSessionId: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { sessionId?: string; prompt?: string }) => {
      capturedSessionId = options.sessionId;
      return `claude ${options.prompt ?? ''}`;
    });

    // worktree_path is a DIFFERENT real directory than projectPath (deliberately
    // - see the comment above expect(capturedSessionId) below): the local
    // `cwd` variable at this call site (task.worktree_path || appConfig.projectPath
    // || process.cwd()) resolves to this worktree dir, which never gets a
    // status.json written under it. Only `appConfig.projectPath` (our mkdtemp
    // root) does, via writeStatusFile above.
    const worktreeDir = path.join(projectPath, 'a-different-worktree');
    const task = makeTask({ worktree_path: worktreeDir });
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine({ sessionManager, sessionRepo, projectPath });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    // Red: deleting the `await reconcileResumeAgentSessionId({...})` call in
    // executeSpawnAgent (falling back to `intent.agentSessionId` directly)
    // makes every one of these STORED_ID instead of FORKED_ID.
    //
    // Red (narrower): changing the call site's `projectPath: appConfig.projectPath
    // || cwd` to `projectPath: cwd` also makes this STORED_ID - the reconcile
    // would then look for status.json under `worktreeDir` (no file there,
    // since worktree_path deliberately differs from projectPath above) instead
    // of under `appConfig.projectPath` where writeStatusFile actually wrote it,
    // hit the missing-file path, and silently keep the stale stored id.
    expect(capturedSessionId).toBe(FORKED_ID);

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnOptions = sessionManager.spawn.mock.calls[0][0] as unknown as { agentSessionId?: string };
    expect(spawnOptions.agentSessionId).toBe(FORKED_ID);

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { agent_session_id?: string };
    expect(inserted.agent_session_id).toBe(FORKED_ID);

    // The swap is persisted so a LATER resume agrees.
    expect(sessionRepo.updateAgentSessionId).toHaveBeenCalledWith(RECORD_ID, FORKED_ID);

    // The locate probe uses `intent.resumeFromCwd` (the RETIRING record's own
    // cwd, i.e. `match.cwd` above), never the new spawn's `cwd` (worktreeDir).
    expect(mockAdapter.locateSessionHistoryFile).toHaveBeenCalledWith(FORKED_ID, path.join(projectPath, 'worktree'));

    // The reconcile must run BEFORE migrateResumeCwdIfRenamed (see the
    // "Runs BEFORE migrateResumeCwdIfRenamed below so the cwd migration keys
    // on the id actually being resumed" comment in executeSpawnAgent): the
    // migration call must already see the reconciled id, not the stale one.
    // Red: moving the reconcile assignment to AFTER the migrateResumeCwdIfRenamed
    // call (without deleting it) leaves capturedSessionId/spawn/insert all
    // correct but this assertion fails, since migrateResumeCwdIfRenamed would
    // still have been called with the stale STORED_ID.
    expect(migrateResumeCwdIfRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ agentSessionId: FORKED_ID }),
    );
  });

  it('keeps the stale DB-stored id when the reported id has no locatable transcript', async () => {
    // Sibling of the swap test above: proves the wiring does not swap
    // unconditionally, only when the reconcile's own positive check passes.
    await writeStatusFile(FORKED_ID);
    mockAdapter.locateSessionHistoryFile.mockResolvedValue(null);

    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: STORED_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: path.join(projectPath, 'worktree'),
    });

    let capturedSessionId: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { sessionId?: string; prompt?: string }) => {
      capturedSessionId = options.sessionId;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask({ worktree_path: null });
    const { engine } = makeEngine({ sessionRepo, projectPath });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedSessionId).toBe(STORED_ID);
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
  });
});

describe('TransitionEngine - remote execution wiring (executeSpawnAgent chokepoint)', () => {
  // Coverage hole: resolveExecutionTarget is called at this chokepoint
  // (transition-engine.ts) and threaded into commandOptions.executionTarget, but
  // no prior test spawned through it with a remote-configured agent. Deleting
  // that wiring (either the resolveExecutionTarget call or the executionTarget
  // property on commandOptions) would silently fall back to a local spawn while
  // every other test here kept passing, because they all leave
  // executionServers/execution empty.
  //
  // mockAdapter.buildCommand is swapped for the REAL OpenCodeCommandBuilder so
  // the assertion exercises production attach-command logic, not a hand-rolled
  // stub of "did executionTarget arrive". The agent name in this describe is
  // still 'claude' (mockAdapter.name, appConfig.defaultAgent) - that identity is
  // irrelevant to resolveExecutionTarget, which is agent-name-parameterized, not
  // OpenCode-specific.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('threads resolveExecutionTarget into commandOptions.executionTarget, producing an attach command with the server URL', async () => {
    const openCodeCommandBuilder = new OpenCodeCommandBuilder();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) =>
      openCodeCommandBuilder.buildOpenCodeCommand(options as unknown as OpenCodeCommandOptions),
    );

    const task = makeTask();
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine({
      sessionManager,
      executionServers: {
        claude: { url: 'http://10.0.0.9:5100', auth: { kind: 'none' } },
      },
      execution: {
        claude: { mode: 'remote', workingDirectory: '/srv/remote-project' },
      },
    });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(sessionManager.spawnedSessions).toHaveLength(1);
    const command = sessionManager.spawnedSessions[0].command;
    // Red: commenting out `executionTarget,` in executeSpawnAgent's
    // commandOptions (transition-engine.ts) makes buildOpenCodeCommand take the
    // local branch instead, and this command would be the plain binary path
    // with no 'attach' token and no server URL.
    expect(command).toContain('attach');
    expect(command).toContain('http://10.0.0.9:5100');
  });

  it('does not thread an executionTarget when the agent is not configured for remote mode', async () => {
    // Plain capture stub, not the real OpenCodeCommandBuilder: this test only
    // needs to see what commandOptions carried, not exercise the real
    // attach-vs-local branch (which would otherwise hit buildHooks's real
    // filesystem side effect against the hardcoded /some/project cwd).
    let capturedExecutionTarget: unknown;
    mockAdapter.buildCommand.mockImplementation((options: { executionTarget?: unknown; prompt?: string }) => {
      capturedExecutionTarget = options.executionTarget;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask();
    // executionServers/execution both default to {} (local execution).
    const { engine } = makeEngine({});

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedExecutionTarget).toBeUndefined();
  });
});

describe('TransitionEngine - launch-option wiring (executeSpawnAgent chokepoint)', () => {
  // Coverage hole: resolveLaunchOptions is called at this chokepoint
  // (transition-engine.ts) and threaded into commandOptions.launchOptions, but
  // no prior test spawned through it with an adapter that declares launch
  // options. Deleting that wiring (either the resolveLaunchOptions call or the
  // launchOptions property on commandOptions) would silently drop the toggle
  // while every other test here kept passing, because they all use
  // mockAdapter with launchOptions left undefined (no adapter but Codex
  // declares any).
  //
  // mockAdapter.buildCommand is swapped for the REAL CodexCommandBuilder so
  // the assertion exercises production --disable-apps flag logic, not a
  // hand-rolled stub of "did launchOptions arrive". mockAdapter.launchOptions
  // is set to Codex's real declared option per-test and restored to
  // undefined afterward so it does not leak into other describe blocks in
  // this file.
  const codexLaunchOptions: readonly AgentLaunchOptionInfo[] = [{
    id: 'disableApps',
    label: 'Disable ChatGPT Apps',
    description: "Skips the optional ChatGPT Apps connector.",
    default: false,
  }];

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  afterEach(() => {
    mockAdapter.launchOptions = undefined;
  });

  it('threads resolveLaunchOptions into commandOptions.launchOptions, producing a --disable apps flag', async () => {
    mockAdapter.launchOptions = codexLaunchOptions;
    const codexCommandBuilder = new CodexCommandBuilder();
    mockAdapter.buildCommand.mockImplementation((options: { agentPath: string; prompt?: string }) => {
      const { agentPath, ...rest } = options;
      return codexCommandBuilder.buildCodexCommand({ codexPath: agentPath, ...rest } as CodexCommandOptions);
    });

    const task = makeTask();
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine({
      sessionManager,
      launchOptions: {
        claude: { disableApps: true },
      },
    });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(sessionManager.spawnedSessions).toHaveLength(1);
    const command = sessionManager.spawnedSessions[0].command;
    // Red: commenting out `const launchOptions = resolveLaunchOptions(...)` or
    // the `launchOptions,` key on executeSpawnAgent's commandOptions
    // (transition-engine.ts) makes buildCodexCommand never see the flag, so
    // this command would omit `--disable apps` entirely.
    expect(command).toContain('--disable apps');
  });

  it('does not thread a launchOptions value when the adapter declares no launch options', async () => {
    // mockAdapter.launchOptions stays undefined (default, mirrors every
    // adapter but Codex), even though a stored override IS configured -
    // resolveLaunchOptions must key off the ADAPTER's declared options, not
    // the presence of stored config.
    let capturedLaunchOptions: unknown;
    mockAdapter.buildCommand.mockImplementation((options: { launchOptions?: unknown; prompt?: string }) => {
      capturedLaunchOptions = options.launchOptions;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask();
    const { engine } = makeEngine({
      launchOptions: {
        claude: { disableApps: true },
      },
    });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedLaunchOptions).toBeUndefined();
  });
});

describe('TransitionEngine - executeAction builds ONE shared templateVars for every action type', () => {
  // Coverage hole: executeAction resolves templateVars = resolveTaskTemplateVars(...) once and
  // feeds spawn_agent, send_command, run_script, AND webhook from that single object (see
  // .claude/rules/task-template-vars-parity.md, rule #7: "only the interpolation MECHANICS are
  // scoped, not the resolved VALUES"). Every existing test above only drives spawn_agent, so a
  // regression on the OTHER three consumers (e.g. reverting {{baseBranch}} back to the old
  // `task.base_branch || ''` behavior) fails nothing. This pins send_command specifically:
  // task.base_branch is null, so {{baseBranch}} must resolve to the effective project default
  // ('main', from getConfig().gitConfig.defaultBaseBranch) rather than an empty string.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    // run_script/webhook tests below stub the global fetch; unstub
    // unconditionally so a stub never leaks into an unrelated test file run
    // in the same worker.
    vi.unstubAllGlobals();
  });

  it('send_command: a null task.base_branch interpolates {{baseBranch}} to the effective project default, not empty', async () => {
    const task = makeTask({ base_branch: null, session_id: 'sess-abc12345' });
    const action = makeAction({
      type: 'send_command',
      config_json: JSON.stringify({ command: '/review {{baseBranch}}' }),
    });
    // submitKeystrokes must return a real Promise: executeSendCommand chains
    // `.catch(...)` onto its return value, which throws synchronously against
    // the file's default no-op `vi.fn()` stub (returns undefined).
    const terminalSubmit = { submitKeystrokes: vi.fn(async () => {}) };

    const { engine } = makeEngine({ action, terminalSubmit });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    // Red: reverting executeAction's templateVars to `{ baseBranch: task.base_branch || '' }`
    // (the pre-refactor shape) makes this '/review' (empty, collapsed by sanitizeForPty),
    // never '/review main'.
    expect(terminalSubmit.submitKeystrokes).toHaveBeenCalledTimes(1);
    expect(terminalSubmit.submitKeystrokes).toHaveBeenCalledWith(
      'sess-abc12345',
      ['/review main'],
      { sendCtrlC: true, source: `send_command:${task.id.slice(0, 8)}` },
    );
  });

  it('run_script: a null task.base_branch interpolates {{baseBranch}} to the effective project default, not empty', async () => {
    // Guards the OTHER two consumers the comment above flags: run_script and
    // webhook (this test + the next) both read the SAME executeAction-built
    // templateVars as send_command, but a call-site-specific regression (e.g.
    // someone passing a different/empty vars object into just this one
    // switch-case line) would fail nothing without a dedicated assertion here.
    const task = makeTask({ base_branch: null });
    const action = makeAction({
      type: 'run_script',
      config_json: JSON.stringify({ script: 'deploy.sh {{baseBranch}}' }),
    });
    const sessionManager = makeSessionManager();

    const { engine } = makeEngine({ action, sessionManager });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    // Red: reverting executeAction's templateVars to the pre-refactor
    // `{ baseBranch: task.base_branch || '' }` shape makes this 'deploy.sh '
    // (empty), never 'deploy.sh main'.
    expect(sessionManager.spawnedSessions).toHaveLength(1);
    expect(sessionManager.spawnedSessions[0].command).toBe('deploy.sh main');
  });

  it('webhook: a null task.base_branch interpolates {{baseBranch}} into both url and body, not empty', async () => {
    const task = makeTask({ base_branch: null });
    const action = makeAction({
      type: 'webhook',
      config_json: JSON.stringify({
        url: 'https://example.test/notify?branch={{baseBranch}}',
        body: JSON.stringify({ branch: '{{baseBranch}}' }),
      }),
    });
    const fetchMock = vi.fn(async () => new Response(''));
    vi.stubGlobal('fetch', fetchMock);

    const { engine } = makeEngine({ action });
    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    // Red: reverting executeAction's templateVars to the pre-refactor shape
    // makes both of these resolve with an empty branch, never 'main'.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/notify?branch=main');
    expect(init.body).toBe(JSON.stringify({ branch: 'main' }));
  });
});

describe('TransitionEngine - MCP caller-session URL stamping (executeSpawnAgent chokepoint)', () => {
  // Coverage hole: executeSpawnAgent wraps mcpServerUrl in
  // `appendCallerSession(appConfig.mcpServerUrl, ptySessionId)` so the MCP
  // server can identify which session is calling (see caller-url.ts). Every
  // existing test in this file leaves mcpServerUrl undefined (the makeEngine
  // default), so appendCallerSession(undefined, id) returns undefined either
  // way and a regression to `appConfig.mcpServerUrl` (dropping the
  // appendCallerSession wrapper) would fail nothing above. ptySessionId is a
  // real crypto.randomUUID() generated inside executeSpawnAgent (this file
  // does not mock node:crypto), so it is read back from the inserted session
  // record rather than predicted.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  it('stamps the spawned ptySessionId as the third URL segment when mcpServerUrl is configured', async () => {
    let capturedOptions: { mcpServerUrl?: string } | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { mcpServerUrl?: string; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask();
    const sessionRepo = makeSessionRepo();
    const { engine } = makeEngine({ sessionRepo, mcpServerUrl: 'http://127.0.0.1:1234/mcp/proj-1' });

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const insertedId = (sessionRepo.insert.mock.calls[0][0] as { id: string }).id;
    expect(insertedId).toBeTruthy();
    // Red: reverting executeSpawnAgent's
    // `mcpServerUrl: appendCallerSession(appConfig.mcpServerUrl, ptySessionId)`
    // back to `appConfig.mcpServerUrl` makes this
    // 'http://127.0.0.1:1234/mcp/proj-1' - no session segment.
    expect(capturedOptions?.mcpServerUrl).toBe(`http://127.0.0.1:1234/mcp/proj-1/${insertedId}`);
  });

  it('leaves mcpServerUrl undefined when the project has no configured MCP server URL', async () => {
    let capturedOptions: { mcpServerUrl?: string } | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { mcpServerUrl?: string; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask();
    const { engine } = makeEngine({});

    await engine.executeTransition(task as Parameters<typeof engine.executeTransition>[0], 'todo', 'doing');

    expect(capturedOptions?.mcpServerUrl).toBeUndefined();
  });
});

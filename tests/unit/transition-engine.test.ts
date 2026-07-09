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
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
import { sanitizeForPty } from '../../src/shared/paths';
import { migrateResumeCwdIfRenamed } from '../../src/main/transition-engine/resume-cwd-migration';

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
    insertedRecords,
  };
}

function makeTaskRepo() {
  return {
    update: vi.fn(),
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
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn((options: { prompt?: string }) => {
    // Return a string that embeds the prompt so we can inspect it from outside
    return `claude ${options.prompt ?? ''}`;
  }),
  buildEnv: undefined,
  getExitSequence: vi.fn(() => ['\x03']),
  removeHooks: vi.fn(),
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
}) {
  const sessionManager = options.sessionManager ?? makeSessionManager();
  const sessionRepo = options.sessionRepo ?? makeSessionRepo();
  const action = options.action ?? makeAction();
  const actionRepo = makeActionRepo(action);
  const taskRepo = makeTaskRepo();
  const attachmentRepo = makeAttachmentRepo();

  const getConfig = vi.fn(() => ({
    permissionMode: 'default',
    projectPath: '/some/project',
    projectId: 'proj-1',
    gitConfig: {
      worktreesEnabled: false,
      defaultBaseBranch: 'main',
      autoCleanup: false,
      copyFiles: [],
    },
    mcpServerEnabled: false,
    mcpServerUrl: undefined,
    mcpServerToken: undefined,
    defaultAgent: 'claude',
    cliPathOverrides: {},
  }));

  const terminalSubmit = makeTerminalSubmit();
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

  return { engine, sessionManager, sessionRepo, taskRepo, actionRepo };
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

  it('task.permission_mode wins over the passed permissionOverride (swimlane) argument', async () => {
    // Resolution order in executeSpawnAgent is task -> swimlane override -> global
    // default. The `permissionOverride` argument here is the caller-resolved
    // swimlane permission_mode; a task-level pin must win over it.
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
});

describe('TransitionEngine - create_worktree action threads signal + progress', () => {
  type EnsureWorktreeOptions = { signal?: AbortSignal; onProgress?: (phase: string) => void };

  beforeEach(() => {
    vi.clearAllMocks();
    worktreeManagerMock.ensureWorktree.mockResolvedValue({
      worktreePath: '/some/project/.kangentic/worktrees/fix-login-flow-task-abc',
      branchName: 'kangentic/fix-login-flow',
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

    // Success path persists the new worktree path + branch back onto the task.
    expect(taskRepo.update).toHaveBeenCalledWith({
      id: task.id,
      worktree_path: '/some/project/.kangentic/worktrees/fix-login-flow-task-abc',
      branch_name: 'kangentic/fix-login-flow',
    });
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

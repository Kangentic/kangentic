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
import { RESUME_PROMPT_COMMAND_LINE_CAP } from '../../src/main/transition-engine/resume-prompt-delivery';
import { buildTaskXml } from '../../src/main/agent/shared/prompt-xml';
import { sanitizeForPty } from '../../src/shared/paths';
import { migrateResumeCwdIfRenamed } from '../../src/main/transition-engine/resume-cwd-migration';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { proveClaudeConversationGone } from '../../src/main/agent/adapters/claude/conversation-gone';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { ConversationExpiredNotice } from '../../src/shared/types';
import { OpenCodeCommandBuilder, type OpenCodeCommandOptions } from '../../src/main/agent/adapters/opencode';
import { CodexCommandBuilder, type CodexCommandOptions } from '../../src/main/agent/adapters/codex';
import { AgentCliNotFoundError, agentCliNotFoundMessage } from '../../src/main/agent/shared/agent-cli-not-found';
import type { AgentExecutionServer, AgentProjectExecution, AgentLaunchOptionInfo, SessionStartReport, SessionUsage } from '../../src/shared/types';
import { claudeSessionStartLine } from './helpers/claude-session-start';

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
    // The conversation lineage assessResumeConversation walks on a resume:
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
    setWorktreeSkipReason: vi.fn(),
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
    markIdleAuthoritative: vi.fn(),
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
  // Undefined by default, as on an adapter whose CLI does not run from WSL; the
  // WSL describe at the end of the file sets it and resets it.
  supportsWslCli: undefined as boolean | undefined,
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
  runtime: undefined as {
    statusFile?: {
      parseStatus: (raw: string) => SessionUsage | null;
      parseSessionStart?: (hookContext: string) => SessionStartReport | null;
    };
  } | undefined,
  // Undefined by default, as on every adapter that has no background session of
  // its own to stop. The reconcile describe's background-session test sets a
  // spy and resets it in afterEach.
  stopBackgroundSession: undefined as AgentAdapter['stopBackgroundSession'],
  locateSessionHistoryFile: vi.fn(async (_agentSessionId: string, _cwd: string): Promise<string | null> => null),
  // Undefined by default, so no resume is ever proven expired; the
  // expired-conversation describe below sets Claude's real proof and resets it.
  proveConversationGone: undefined as AgentAdapter['proveConversationGone'],
  // Claude's: a resume carries its prompt on the command line. The
  // resume-prompt-delivery describe below sets 'typed' and resets it.
  resumePromptDelivery: 'command-line' as AgentAdapter['resumePromptDelivery'],
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

// Pass-through by default so every describe in this file runs the engine
// unchanged (their stub adapter detects '/usr/bin/claude' under 'bash', which
// the real helper leaves alone on any OS anyway); the shim-launch wiring
// describe at the end of the file swaps in a result per test.
const resolveShimLaunchMock = vi.hoisted(() =>
  vi.fn(async (input: { agentPath: string; shell: string | undefined; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
);

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: resolveShimLaunchMock,
}));

// The real target resolution, run as on Windows with a distro's facts already
// read, so the WSL describe at the end of the file runs on any OS without
// calling wsl.exe. The stub adapter declares no WSL support, so every other
// describe resolves no target, as before.
const WSL_DISTRO_FACTS = vi.hoisted(() => ({
  distro: 'Ubuntu',
  homeLinux: '/home/dev',
  homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
  uncRoot: '\\\\wsl.localhost\\Ubuntu',
  interactivePath: '/home/dev/.local/bin:/usr/bin',
  env: {},
  networkingMode: 'nat' as const,
}));

vi.mock('../../src/main/agent/shared/cli-target', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/shared/cli-target')>();
  return {
    ...original,
    resolveCliTarget: (cliPath: string | null | undefined, adapterSupportsWsl: boolean) =>
      original.resolveCliTarget(cliPath, adapterSupportsWsl, { platform: 'win32', resolveFacts: async () => WSL_DISTRO_FACTS }),
  };
});

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
  /** The engine's injected services (the expired-conversation describe passes a notice sink). */
  services?: ConstructorParameters<typeof TransitionEngine>[8];
}) {
  const sessionManager = options.sessionManager ?? makeSessionManager();
  const sessionRepo = options.sessionRepo ?? makeSessionRepo();
  const action = options.action ?? makeAction();
  const taskRepo = makeTaskRepo();
  const attachmentRepo = makeAttachmentRepo();

  const getConfig = vi.fn(() => ({
    permissionMode: 'default',
    projectPath: options.projectPath ?? '/some/project',
    projectId: 'proj-1',
    projectName: 'Mock project',
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
    taskRepo as unknown as EngineArgs[2],
    getConfig as unknown as EngineArgs[3],
    sessionRepo as unknown as EngineArgs[4],
    attachmentRepo as unknown as EngineArgs[5],
    undefined,
    undefined,
    options.services,
  );

  /**
   * Drive the spawn the way the legacy `spawn_agent` automation does.
   *
   * These tests exercise `executeSpawnAgent`, which used to be reachable only
   * through a transitions lookup. That lookup is gone (automations belong to a
   * column now), so they call the chokepoint the legacy adapter calls instead.
   * The behavior under test is unchanged; only the way in is.
   */
  const runSpawn = (
    task: unknown,
    permissionOverride?: Parameters<typeof engine.runLegacySpawnAgent>[2],
    signal?: AbortSignal,
    agentOverride?: string,
  ): ReturnType<typeof engine.runLegacySpawnAgent> => engine.runLegacySpawnAgent(
    JSON.parse(action.config_json) as Parameters<typeof engine.runLegacySpawnAgent>[0],
    task as Parameters<typeof engine.runLegacySpawnAgent>[1],
    permissionOverride,
    signal,
    agentOverride,
  );

  return { engine, runSpawn, sessionManager, sessionRepo, taskRepo, terminalSubmit };
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

  it('executeAction (spawn_agent): hands the builder the task id as taskProcessTag', async () => {
    const task = makeTask();
    let capturedTag: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string; taskProcessTag?: string }) => {
      capturedTag = options.taskProcessTag;
      return `claude ${options.prompt ?? ''}`;
    });

    const { runSpawn } = makeEngine({});
    await runSpawn(task);

    expect(capturedTag).toBe(task.id);
  });

  // A folder-shared adapter holds the file it writes under `ptySessionId`, the
  // id the session layer releases with, so the builder and the spawn must agree.
  it('executeAction (spawn_agent): hands the builder the same ptySessionId the spawn uses', async () => {
    const task = makeTask();
    let capturedSessionId: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string; ptySessionId?: string }) => {
      capturedSessionId = options.ptySessionId;
      return `claude ${options.prompt ?? ''}`;
    });

    const { runSpawn, sessionManager } = makeEngine({});
    await runSpawn(task);

    expect(capturedSessionId).toBeDefined();
    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ id: capturedSessionId }));
    expect(mockAdapter.removeHooks).not.toHaveBeenCalled();
  });

  // An abort between the build and the spawn leaves a built command no session
  // will release, so the engine releases its hold.
  //
  // Red-green: drop the catch's releaseCommandHold in transition-engine.ts and
  // removeHooks is never called.
  it('executeAction (spawn_agent): an abort after the build releases the command\'s hold', async () => {
    const task = makeTask();
    let capturedSessionId: string | undefined;
    let capturedCwd: string | undefined;
    const controller = new AbortController();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string; ptySessionId?: string; cwd: string }) => {
      capturedSessionId = options.ptySessionId;
      capturedCwd = options.cwd;
      // The abort lands between the build and the spawn.
      controller.abort();
      return `claude ${options.prompt ?? ''}`;
    });

    const { runSpawn, sessionManager } = makeEngine({});
    await expect(runSpawn(task, undefined, controller.signal)).rejects.toThrow();

    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(mockAdapter.removeHooks).toHaveBeenCalledWith(capturedCwd, capturedSessionId);
  });

  // A buildEnv failure is the other thing that can stop a built command short
  // of spawn(), so it releases the hold the build took too.
  //
  // Red-green: take buildEnv out of the try (or drop the catch's
  // releaseCommandHold) in transition-engine.ts and removeHooks is never called.
  it('executeAction (spawn_agent): a buildEnv failure releases the command\'s hold and never spawns', async () => {
    const task = makeTask();
    let capturedSessionId: string | undefined;
    let capturedCwd: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string; ptySessionId?: string; cwd: string }) => {
      capturedSessionId = options.ptySessionId;
      capturedCwd = options.cwd;
      return `claude ${options.prompt ?? ''}`;
    });
    const adapterWithEnv = mockAdapter as unknown as { buildEnv?: () => Record<string, string> | null };
    const envFailure = new Error('buildEnv failed');
    adapterWithEnv.buildEnv = vi.fn(() => {
      throw envFailure;
    });

    try {
      const { runSpawn, sessionManager } = makeEngine({});
      await expect(runSpawn(task)).rejects.toBe(envFailure);

      expect(capturedSessionId).toBeDefined();
      expect(sessionManager.spawn).not.toHaveBeenCalled();
      expect(mockAdapter.removeHooks).toHaveBeenCalledTimes(1);
      expect(mockAdapter.removeHooks).toHaveBeenCalledWith(capturedCwd, capturedSessionId);
    } finally {
      // Back to the file-wide default (no buildEnv), so no later test sees it.
      adapterWithEnv.buildEnv = undefined;
    }
  });

  // From the spawn() call on, the session layer owns the hold: it releases a
  // spawn that never ran, and keeps it for a PTY that started (so the folder's
  // file is never stripped under a running agent). The engine releasing too
  // would strip it under exactly that agent.
  //
  // Red-green: move sessionManager.spawn back inside the try that releases and
  // removeHooks is called with the spawn's own id.
  it('executeAction (spawn_agent): a sessionManager.spawn rejection does not release the hold from the engine', async () => {
    const task = makeTask();
    const spawnFailure = new Error('pty host unreachable');
    const { runSpawn, sessionManager } = makeEngine({});
    sessionManager.spawn.mockRejectedValueOnce(spawnFailure);

    await expect(runSpawn(task)).rejects.toBe(spawnFailure);

    // Precondition: the build ran and the engine did reach the spawn, so the
    // assertion below is about the spawn's failure and not an earlier return.
    expect(mockAdapter.buildCommand).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(mockAdapter.removeHooks).not.toHaveBeenCalled();
  });

  it('executeAction (spawn_agent): task_xml contains raw multi-line description', async () => {
    const rawDescription = 'Step 1: check OAuth.\n\nStep 2: refresh token.';
    const task = makeTask({ description: rawDescription });

    let capturedPrompt: string | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      capturedPrompt = options.prompt;
      return `claude ${options.prompt ?? ''}`;
    });

    const { runSpawn } = makeEngine({});
    await runSpawn(task);

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

    const { runSpawn } = makeEngine({ sessionManager, sessionRepo, action: legacyAction });
    await runSpawn(task);

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

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task);

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

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task);

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

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task, 'acceptEdits');

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

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task, 'plan');

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('plan');
  });

  it('falls through to permissionOverride when the task has no permission_mode pin', async () => {
    const task = makeTask({ permission_mode: null });
    const sessionRepo = makeSessionRepo();

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task, 'acceptEdits');

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('acceptEdits');
  });

  it('falls through to task.permission_mode when the swimlane has no permission_mode set', async () => {
    // The column left permission_mode null (no permissionOverride argument),
    // so the task's own pin is still a valid fallback tier.
    const task = makeTask({ permission_mode: 'auto' });
    const sessionRepo = makeSessionRepo();

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task, null);

    expect(sessionRepo.insert).toHaveBeenCalledTimes(1);
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string };
    expect(inserted.permission_mode).toBe('auto');
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

    const { runSpawn } = makeEngine({ sessionRepo });
    await runSpawn(task);

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

describe('TransitionEngine - recorded grid on a resume (executeSpawnAgent chokepoint)', () => {
  // A Resume or a move after a desktop restart has no in-memory predecessor
  // with a grid, so the spawn takes the one recorded on the record it retires.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`);
  });

  function resumableRecord(grid: { last_pty_cols: number | null; last_pty_rows: number | null }) {
    return {
      id: 'session-record-grid',
      agent_session_id: 'agent-sess-uuid',
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: '/some/project',
      ...grid,
    };
  }

  it('hands the retired record grid to the spawn', async () => {
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord({ last_pty_cols: 210, last_pty_rows: 48 }));

    const { runSpawn, sessionManager } = makeEngine({ sessionRepo });
    await runSpawn(makeTask());

    expect(sessionManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ restoredGrid: { cols: 210, rows: 48 } }),
    );
  });

  it('passes no grid when the retired record has none', async () => {
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord({ last_pty_cols: null, last_pty_rows: null }));

    const { runSpawn, sessionManager } = makeEngine({ sessionRepo });
    await runSpawn(makeTask());

    expect(sessionManager.spawn.mock.calls[0][0]).not.toHaveProperty('restoredGrid');
  });
});

describe('TransitionEngine - the spawn carries the permission mode its record gets', () => {
  // The spawn analytics event fires inside spawn(), before this record is
  // inserted, so it reads the mode off the session. The two must agree.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`);
  });

  it('hands spawn() the same resolved mode it writes to the record', async () => {
    const sessionRepo = makeSessionRepo();
    const { runSpawn, sessionManager } = makeEngine({ sessionRepo });
    await runSpawn(makeTask());

    const spawned = sessionManager.spawn.mock.calls[0][0] as unknown as { permissionMode?: string | null };
    const inserted = sessionRepo.insert.mock.calls[0][0] as { permission_mode?: string | null };
    expect(spawned.permissionMode).toBeTruthy();
    expect(spawned.permissionMode).toBe(inserted.permission_mode);
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
    mockAdapter.stopBackgroundSession = undefined;
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
    const { runSpawn } = makeEngine({ sessionManager, sessionRepo, projectPath });

    await runSpawn(task);

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
    // cwd, i.e. `match.cwd` above), never the new spawn's `cwd` (worktreeDir),
    // on this machine (no CLI target).
    expect(mockAdapter.locateSessionHistoryFile).toHaveBeenCalledWith(FORKED_ID, path.join(projectPath, 'worktree'), null, null);

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
    const { runSpawn } = makeEngine({ sessionRepo, projectPath });

    await runSpawn(task);

    expect(capturedSessionId).toBe(STORED_ID);
    expect(sessionRepo.updateAgentSessionId).not.toHaveBeenCalled();
  });

  it('hands the background-session stop the CLI path this spawn detected, for a conversation the record saw move into one', async () => {
    // The record's events file holds a background-session SessionStart (source
    // `fork`) naming the stored id: the conversation moved into the CLI's own
    // background session, which outlives the task's PTY. Written with
    // fs.promises.mkdir for the same reason as writeStatusFile above.
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${claudeSessionStartLine(STORED_ID, 'fork', 1)}\n`);

    mockAdapter.runtime = {
      statusFile: {
        parseStatus: ClaudeStatusParser.parseStatus,
        parseSessionStart: ClaudeStatusParser.parseSessionStart,
      },
    };
    const stopBackgroundSession = vi.fn(async (_options: { agentSessionId: string; cliPath: string }) => true);
    mockAdapter.stopBackgroundSession = stopBackgroundSession;

    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: STORED_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: path.join(projectPath, 'worktree'),
    });
    const { runSpawn } = makeEngine({ sessionRepo, projectPath });

    await runSpawn(makeTask({ worktree_path: null }));

    // Red: deleting `cliPath: detection.path` from executeSpawnAgent's
    // reconcileResumeAgentSessionId call makes the reconcile skip the stop
    // (`if (cliPath)`), so the resume starts a second process on the
    // conversation and this spy is never called. '/usr/bin/claude' is the path
    // the file-level mockAdapter's `detect` reports.
    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession).toHaveBeenCalledWith({ agentSessionId: STORED_ID, cliPath: '/usr/bin/claude' });
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
    const { runSpawn } = makeEngine({
      sessionManager,
      executionServers: {
        claude: { url: 'http://10.0.0.9:5100', auth: { kind: 'none' } },
      },
      execution: {
        claude: { mode: 'remote', workingDirectory: '/srv/remote-project' },
      },
    });

    await runSpawn(task);

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
    const { runSpawn } = makeEngine({});

    await runSpawn(task);

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
    const { runSpawn } = makeEngine({
      sessionManager,
      launchOptions: {
        claude: { disableApps: true },
      },
    });

    await runSpawn(task);

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
    const { runSpawn } = makeEngine({
      launchOptions: {
        claude: { disableApps: true },
      },
    });

    await runSpawn(task);

    expect(capturedLaunchOptions).toBeUndefined();
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
    const { runSpawn } = makeEngine({ sessionRepo, mcpServerUrl: 'http://127.0.0.1:1234/mcp/proj-1' });

    await runSpawn(task);

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
    const { runSpawn } = makeEngine({});

    await runSpawn(task);

    expect(capturedOptions?.mcpServerUrl).toBeUndefined();
  });
});

describe('TransitionEngine - resume downgraded to fresh when the conversation was never persisted (executeSpawnAgent chokepoint)', () => {
  // Coverage hole (review): executeSpawnAgent's downgrade path RE-RESOLVES the
  // spawn intent (`resolveSpawnIntent({ ...spawnIntentOptions, forceFresh: true })`)
  // when assessResumeConversation answers `never-started` for a resumable
  // match, rather than flipping a `canResume` boolean on the
  // already-resolved resume intent. resolveSpawnIntent's own forceFresh
  // contract is unit-pinned in spawn-intent.test.ts; what is untested here is
  // the WIRING - that a real resumable record whose status.json proves a
  // zero-turn conversation actually produces a built command carrying the
  // interpolated promptTemplate, not the resume branch's resumePrompt
  // (undefined for an ordinary task spawn). A boolean-flip regression leaves
  // `intent` unchanged (still resume-mode, prompt = resumePrompt = undefined),
  // so the downgraded spawn would boot with no task prompt at all - exactly
  // the zero-turn conversation the guard exists to prevent.
  //
  // Uses a REAL mkdtemp projectPath (like the reconcile-wiring describe above)
  // because assessResumeConversation reads a real status.json from disk; this
  // file's node:fs mock stubs mkdirSync only, so fs.promises.mkdir +
  // fs.writeFileSync below reach the real filesystem.
  const RECORD_ID = 'poisoned-record-1';
  const AGENT_SESSION_ID = 'agent-uuid-poisoned';

  let projectPath: string;

  /** The exact reported state a session that ended before its first turn
   * leaves behind: a named transcript_path that was never written, and zero
   * cost/token usage. Mirrors resume-conversation-guard.test.ts's identical
   * fixture, which pins that this shape makes assessResumeConversation
   * resolve `never-started`. Takes the record id so the lineage-walk test below can
   * write it under an OLDER record than the one being retired. */
  async function writeEmptyStatusFile(recordId: string): Promise<void> {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', recordId);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: path.join(projectPath, 'history', `${AGENT_SESSION_ID}.jsonl`),
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      cost: { total_cost_usd: 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 200000,
        current_usage: null,
        used_percentage: null,
      },
    }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-downgrade-'));
    mockAdapter.runtime = { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } };
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    mockAdapter.runtime = undefined;
  });

  it('spawns fresh with the interpolated prompt, not resumePrompt, when the resumable record never persisted a conversation', async () => {
    await writeEmptyStatusFile(RECORD_ID);

    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: AGENT_SESSION_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
    });

    let capturedOptions: { resume?: boolean; sessionId?: string; prompt?: string } | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; sessionId?: string; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });

    // worktree_path: null so `cwd` (task.worktree_path || appConfig.projectPath
    // || process.cwd()) resolves to the same mkdtemp root writeEmptyStatusFile
    // wrote under, matching makeTask's own default.
    const task = makeTask({ worktree_path: null });
    const sessionManager = makeSessionManager();
    const { runSpawn } = makeEngine({ sessionManager, sessionRepo, projectPath });

    await runSpawn(task);

    // Red: reverting executeSpawnAgent's
    // `intent = resolveSpawnIntent({ ...spawnIntentOptions, forceFresh: true })`
    // to a `canResume = false` boolean flip on the STALE resume intent (intent
    // left unchanged) makes this undefined (intent.prompt = resumePrompt,
    // never passed to this spawn) instead of the interpolated task_xml prompt.
    expect(capturedOptions?.resume).toBe(false);
    expect(capturedOptions?.prompt).toContain('Fix login flow');

    expect(sessionManager.spawnedSessions).toHaveLength(1);

    // The poisoned record is still retired even though the spawn goes fresh
    // (forceFresh's retireRecordId carries the same match.id forward). The
    // stamping CAS covers the not-yet-exited statuses; an already-exited row
    // is confirmed by a second, stamp-free CAS (see retireRecord).
    expect(sessionRepo.compareAndUpdateStatus).toHaveBeenCalledWith(
      RECORD_ID,
      ['suspended', 'orphaned'],
      'exited',
      expect.objectContaining({ exited_at: expect.any(String) }),
    );

    expect(sessionRepo.insertedRecords).toHaveLength(1);
    const inserted = sessionRepo.insertedRecords[0] as { agent_session_id?: string | null; prompt?: string | null };
    // Fresh spawns generate their own PTY session id (Claude
    // supportsCallerSessionId), never the stale DB-stored AGENT_SESSION_ID.
    expect(inserted.agent_session_id).not.toBe(AGENT_SESSION_ID);
    expect(inserted.prompt).toContain('Fix login flow');
  });

  it('walks the conversation lineage: finds the downgrade proof on an OLDER record when the retiring record wrote no status file', async () => {
    // A failed resume is self-perpetuating (see resume-conversation-guard.ts's
    // "heals an already-poisoned lineage" case): the CLI dies before its
    // status line runs, so the RETIRING record has no status.json, and the
    // proof of emptiness can only be found on an older record of the same
    // conversation. `conversationRecordIds` in executeSpawnAgent spreads
    // `listForTaskNewestFirst(...)` (filtered to the resumed agent_session_id)
    // onto `intent.retireRecordId` for exactly this reason.
    const OLDER_RECORD_ID = 'poisoned-record-older';
    await writeEmptyStatusFile(OLDER_RECORD_ID);
    // The retiring (latest) record's session dir exists but holds no
    // status.json - exactly what a failed resume leaves behind.
    await fs.promises.mkdir(path.join(projectPath, '.kangentic', 'sessions', RECORD_ID), { recursive: true });

    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: AGENT_SESSION_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
    });
    // Newest first, including a record from an UNRELATED conversation (a
    // different agent_session_id) that must be filtered out, not walked.
    sessionRepo.listForTaskNewestFirst.mockReturnValue([
      { id: RECORD_ID, agent_session_id: AGENT_SESSION_ID },
      { id: OLDER_RECORD_ID, agent_session_id: AGENT_SESSION_ID },
      { id: 'unrelated-record', agent_session_id: 'a-different-conversation-id' },
    ]);

    let capturedOptions: { resume?: boolean; prompt?: string } | undefined;
    mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });

    const task = makeTask({ worktree_path: null });
    const { runSpawn } = makeEngine({ sessionRepo, projectPath });

    await runSpawn(task);

    // Red: dropping the `...listForTaskNewestFirst(...).filter(...).map(...)`
    // spread (passing only `[intent.retireRecordId]`) leaves RECORD_ID as the
    // only candidate. It has no status.json, so the guard finds no evidence
    // and returns false (unknown -> resume as before), making this true
    // instead - the task would stay stuck resuming a dead conversation
    // forever.
    expect(capturedOptions?.resume).toBe(false);
    expect(capturedOptions?.prompt).toContain('Fix login flow');
  });

  describe('the message the downgraded resume carried (unsentPrompt)', () => {
    // `runSpawn` above carries no resumePrompt, so it cannot tell whether the
    // downgrade left a carried message out. These call the resume entry point
    // with one, the way a column move with a Send message row does.
    function resumableMainSessionRepo() {
      const sessionRepo = makeSessionRepo();
      sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
        id: RECORD_ID,
        agent_session_id: AGENT_SESSION_ID,
        session_type: 'claude_agent',
        status: 'suspended',
        cwd: projectPath,
      });
      return sessionRepo;
    }

    it('reports the message unsent when the downgrade spawns fresh with the template: the prompt is the task, not the message', async () => {
      await writeEmptyStatusFile(RECORD_ID);
      let capturedOptions: { resume?: boolean; prompt?: string } | undefined;
      mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; prompt?: string }) => {
        capturedOptions = options;
        return `claude ${options.prompt ?? ''}`;
      });
      const { engine } = makeEngine({ sessionRepo: resumableMainSessionRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask({ worktree_path: null }) as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, false, '/code-review', undefined, 'claude',
      );

      // Not recap-only: a conversation that never started has nothing to recap,
      // so the downgrade is a plain fresh spawn and the message is still owed.
      expect(outcome).toEqual({ startOver: 'never-started', recapOnly: false, unsentPrompt: '/code-review' });
      expect(capturedOptions?.resume).toBe(false);
      expect(capturedOptions?.prompt).toContain('Fix login flow');
      expect(capturedOptions?.prompt).not.toContain('/code-review');
    });

    it('reports nothing unsent when the spawn has no template: the message is the fresh prompt', async () => {
      await writeEmptyStatusFile(RECORD_ID);
      let capturedOptions: { resume?: boolean; prompt?: string } | undefined;
      mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; prompt?: string }) => {
        capturedOptions = options;
        return `claude ${options.prompt ?? ''}`;
      });
      const { engine } = makeEngine({ sessionRepo: resumableMainSessionRepo(), projectPath });

      const outcome = await engine.resumeSuspendedSession(
        makeTask({ worktree_path: null }) as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, true, '/code-review', undefined, 'claude',
      );

      expect(outcome).toEqual({ startOver: 'never-started', recapOnly: false, unsentPrompt: null });
      expect(capturedOptions?.prompt).toBe('/code-review');
    });
  });
});

describe('TransitionEngine - a resume prompt that does not ride the command line (unsentPrompt)', () => {
  // Codex, Copilot, Grok, OpenCode and Cursor once dropped the prompt from a
  // resume command while the engine reported it sent, so the caller skipped
  // its typed fallback and the column's message never arrived. The engine now
  // decides whether a resume prompt rides, keeps one that does not off the
  // command line, and names it in `unsentPrompt` for the caller to type.
  const RECORD_ID = 'resumable-record-1';
  const AGENT_SESSION_ID = 'agent-uuid-resumable';
  let projectPath: string;
  let capturedOptions: { resume?: boolean; prompt?: string } | undefined;

  function resumableRepo() {
    const sessionRepo = makeSessionRepo();
    // No status.json is written, so the never-started guard finds no evidence
    // and the record resumes as before.
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: RECORD_ID,
      agent_session_id: AGENT_SESSION_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
    });
    return sessionRepo;
  }

  let sessionManager: ReturnType<typeof makeSessionManager>;

  async function resumeWith(resumePrompt: string | undefined, handoffPromptPrefix?: string) {
    sessionManager = makeSessionManager();
    const { engine } = makeEngine({ sessionManager, sessionRepo: resumableRepo(), projectPath });
    return engine.resumeSuspendedSession(
      makeTask({ worktree_path: null }) as Parameters<typeof engine.resumeSuspendedSession>[0],
      null, true, resumePrompt, undefined, 'claude', handoffPromptPrefix,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-resume-prompt-'));
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    mockAdapter.resumePromptDelivery = 'command-line';
    resolveShimLaunchMock.mockImplementation(async (input) => ({
      agentPath: input.agentPath,
      prompt: input.prompt,
      strategy: 'unchanged' as const,
    }));
  });

  it('carries the prompt on the command line when the adapter\'s resume takes one', async () => {
    const outcome = await resumeWith('/code-review');

    expect(capturedOptions?.resume).toBe(true);
    expect(capturedOptions?.prompt).toBe('/code-review');
    expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: null });
    // The prompt starts a real turn, so the session is not asserted idle.
    expect(sessionManager.markIdleAuthoritative).not.toHaveBeenCalled();
  });

  it('asserts idle on a resume whose prompt it kept off, so the typed delivery is not held back', async () => {
    mockAdapter.resumePromptDelivery = 'typed';

    await resumeWith('Review the diff');

    expect(sessionManager.markIdleAuthoritative).toHaveBeenCalledWith('pty-session-1');
  });

  it('reports the prompt unsent, and keeps it off the command line, when the adapter types it instead', async () => {
    mockAdapter.resumePromptDelivery = 'typed';

    const outcome = await resumeWith('Address the review findings, then push a fix.');

    // Red before the fix: the builder was handed the prompt and the outcome
    // said nothing was owed, so the message was lost on these CLIs.
    expect(capturedOptions?.resume).toBe(true);
    expect(capturedOptions?.prompt).toBeUndefined();
    expect(outcome.unsentPrompt).toBe('Address the review findings, then push a fix.');
  });

  it('names the handoff pointer unsent too, ahead of the carried message', async () => {
    mockAdapter.resumePromptDelivery = 'typed';

    const outcome = await resumeWith('Review the diff', 'The previous agent\'s history is at /mock/history.jsonl');

    expect(capturedOptions?.prompt).toBeUndefined();
    expect(outcome.unsentPrompt).toBe('The previous agent\'s history is at /mock/history.jsonl\n\nReview the diff');
  });

  it('keeps a multi-line prompt off a launch that would flatten it, so its lines arrive whole', async () => {
    resolveShimLaunchMock.mockImplementation(async (input) => ({
      agentPath: input.agentPath,
      prompt: input.prompt?.replace(/\n+/g, ' '),
      strategy: 'flattened-prompt' as const,
    }));

    const outcome = await resumeWith('Address the review findings.\n\n1. Lower the cap.\n\n2. Rethrow the last error.');

    expect(capturedOptions?.prompt).toBeUndefined();
    expect(outcome.unsentPrompt).toBe('Address the review findings.\n\n1. Lower the cap.\n\n2. Rethrow the last error.');
  });

  it('still carries a one-line prompt on a flattening launch, which loses nothing', async () => {
    resolveShimLaunchMock.mockImplementation(async (input) => ({
      agentPath: input.agentPath,
      prompt: input.prompt,
      strategy: 'flattened-prompt' as const,
    }));

    const outcome = await resumeWith('/code-review');

    expect(capturedOptions?.prompt).toBe('/code-review');
    expect(outcome.unsentPrompt).toBeNull();
  });

  it('keeps a prompt over the command-line cap off the command line', async () => {
    const longPrompt = 'x'.repeat(RESUME_PROMPT_COMMAND_LINE_CAP + 1);

    const outcome = await resumeWith(longPrompt);

    expect(capturedOptions?.prompt).toBeUndefined();
    expect(outcome.unsentPrompt).toBe(longPrompt);
  });

  it('reports nothing unsent for a resume with no prompt at all', async () => {
    mockAdapter.resumePromptDelivery = 'typed';

    const outcome = await resumeWith(undefined);

    expect(capturedOptions?.prompt).toBeUndefined();
    expect(outcome.unsentPrompt).toBeNull();
  });
});

describe('TransitionEngine - a resume whose conversation the agent deleted starts fresh from a recap (executeSpawnAgent chokepoint)', () => {
  // Claude Code deletes transcripts older than `cleanupPeriodDays`. A resume of
  // one printed "No conversation found" and left a bare shell. Now the check
  // proves the file gone before the spawn, and the same spawn starts fresh.
  // Uses a REAL mkdtemp root: the check reads a real status.json, and Claude's
  // proof stats and lists a real projects folder (this file mocks only
  // fs.mkdirSync, so fs.promises reaches the disk).
  const RECORD_ID = 'expired-record-1';
  const AGENT_SESSION_ID = 'aaaaaaaa-1111-4222-8333-444444444444';
  const LAST_ACTIVE_AT = '2026-08-16T14:00:00.000Z';

  let projectPath: string;
  let projectsRoot: string;
  let capturedOptions: { resume?: boolean; sessionId?: string; prompt?: string } | undefined;

  async function writeStatusWithTurns(): Promise<void> {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    await fs.promises.mkdir(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: path.join(projectsRoot, '-gone-project', `${AGENT_SESSION_ID}.jsonl`),
      model: { id: 'claude-opus-4-8', display_name: 'Opus 4.8' },
      cost: { total_cost_usd: 1.25, total_duration_ms: 90000, total_api_duration_ms: 60000 },
      context_window: {
        total_input_tokens: 52000,
        total_output_tokens: 3100,
        context_window_size: 200000,
        current_usage: { input_tokens: 52000, output_tokens: 3100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        used_percentage: 27,
      },
    }));
  }

  function resumableRepo(isolatedSwimlaneId: string | null = null) {
    const sessionRepo = makeSessionRepo();
    const record = {
      id: RECORD_ID,
      agent_session_id: AGENT_SESSION_ID,
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
      isolated_swimlane_id: isolatedSwimlaneId,
      started_at: '2026-08-16T13:00:00.000Z',
      suspended_at: LAST_ACTIVE_AT,
      exited_at: null,
    };
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(record as never);
    sessionRepo.listForTaskNewestFirst.mockReturnValue([record] as never);
    return sessionRepo;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOptions = undefined;
    mockAdapter.buildCommand.mockImplementation((options: { resume?: boolean; sessionId?: string; prompt?: string }) => {
      capturedOptions = options;
      return `claude ${options.prompt ?? ''}`;
    });
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-expired-'));
    projectsRoot = path.join(projectPath, 'claude-projects');
    await fs.promises.mkdir(projectsRoot, { recursive: true });
    mockAdapter.runtime = { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } };
    mockAdapter.proveConversationGone = proveClaudeConversationGone;
    await writeStatusWithTurns();
  });

  afterEach(() => {
    fs.rmSync(projectPath, { recursive: true, force: true });
    mockAdapter.runtime = undefined;
    mockAdapter.proveConversationGone = undefined;
  });

  it('main session: the recap is the whole prompt, the carried message is dropped, and the notice fires once the session exists', async () => {
    const sessionRepo = resumableRepo();
    const notices: ConversationExpiredNotice[] = [];
    const { engine, sessionManager } = makeEngine({
      sessionRepo, projectPath, services: { onConversationExpired: (notice) => notices.push(notice) },
    });
    const task = makeTask({ worktree_path: null });

    const outcome = await engine.resumeSuspendedSession(
      task as Parameters<typeof engine.resumeSuspendedSession>[0], null, false, '/code-review', undefined, 'claude',
    );

    // recapOnly: the recap IS the prompt and the message is withheld on purpose,
    // so it is not "unsent" in the sense `unsentPrompt` reports.
    expect(outcome).toEqual({ startOver: 'expired', recapOnly: true, unsentPrompt: null });
    expect(capturedOptions?.resume).toBe(false);
    expect(capturedOptions?.sessionId).not.toBe(AGENT_SESSION_ID);
    expect(capturedOptions?.prompt).toContain('deleted it after its retention period');
    expect(capturedOptions?.prompt).toContain('Fix login flow');
    expect(capturedOptions?.prompt).toContain('then wait');
    expect(capturedOptions?.prompt).not.toContain('/code-review');
    expect(sessionManager.spawnedSessions).toHaveLength(1);
    // The old record is retired and kept, never deleted.
    expect(sessionRepo.compareAndUpdateStatus).toHaveBeenCalledWith(
      RECORD_ID, ['suspended', 'orphaned'], 'exited', expect.objectContaining({ exited_at: expect.any(String) }),
    );
    const inserted = sessionRepo.insertedRecords[0] as { prompt?: string | null };
    expect(inserted.prompt).toContain('deleted it after its retention period');
    expect(notices).toEqual([{
      projectId: 'proj-1',
      taskId: 'task-abc-1',
      taskTitle: 'Fix login flow',
      lastActiveAt: LAST_ACTIVE_AT,
    }]);
  });

  it('main session with no task template: the carried command still never becomes the prompt', async () => {
    // A fresh intent with no template falls back to `resumePrompt` as its
    // prompt (spawn-intent.ts). The recap replaces it outright.
    const { engine } = makeEngine({ sessionRepo: resumableRepo(), projectPath });
    const task = makeTask({ worktree_path: null });

    await engine.resumeSuspendedSession(
      task as Parameters<typeof engine.resumeSuspendedSession>[0], null, true, '/code-review', undefined, 'claude',
    );

    expect(capturedOptions?.prompt).toContain('deleted it after its retention period');
    expect(capturedOptions?.prompt).not.toContain('/code-review');
  });

  it('isolated track: a normal fresh pass, with the recap as context and the column message kept', async () => {
    const notices: ConversationExpiredNotice[] = [];
    const { engine } = makeEngine({
      sessionRepo: resumableRepo('lane-review'), projectPath, services: { onConversationExpired: (notice) => notices.push(notice) },
    });
    const task = makeTask({ worktree_path: null });

    const outcome = await engine.resumeSuspendedSession(
      task as Parameters<typeof engine.resumeSuspendedSession>[0], null, true, '/code-review', undefined, 'claude',
      undefined, { isolatedSwimlaneId: 'lane-review' },
    );

    // skipPromptTemplate is true, so the message IS the fresh prompt (it is the
    // last thing in it): nothing was left out for the caller to deliver.
    expect(outcome).toEqual({ startOver: 'expired', recapOnly: false, unsentPrompt: null });
    expect(capturedOptions?.resume).toBe(false);
    expect(capturedOptions?.prompt).toContain('for context');
    expect(capturedOptions?.prompt).not.toContain('then wait');
    expect(capturedOptions?.prompt?.endsWith('/code-review')).toBe(true);
    expect(notices).toHaveLength(1);
  });

  it('sends no notice when the spawn itself fails', async () => {
    const sessionManager = makeSessionManager();
    sessionManager.spawn.mockRejectedValueOnce(new Error('pty host down'));
    const notices: ConversationExpiredNotice[] = [];
    const { engine } = makeEngine({
      sessionManager, sessionRepo: resumableRepo(), projectPath, services: { onConversationExpired: (notice) => notices.push(notice) },
    });
    const task = makeTask({ worktree_path: null });

    await expect(engine.resumeSuspendedSession(
      task as Parameters<typeof engine.resumeSuspendedSession>[0], null, false, undefined, undefined, 'claude',
    )).rejects.toThrow('pty host down');
    expect(notices).toEqual([]);
  });

  it('resumes as before when another project folder still holds the file', async () => {
    const elsewhere = path.join(projectsRoot, '-renamed-project', `${AGENT_SESSION_ID}.jsonl`);
    await fs.promises.mkdir(path.dirname(elsewhere), { recursive: true });
    fs.writeFileSync(elsewhere, '{"type":"user"}\n');
    const notices: ConversationExpiredNotice[] = [];
    const { engine } = makeEngine({
      sessionRepo: resumableRepo(), projectPath, services: { onConversationExpired: (notice) => notices.push(notice) },
    });
    const task = makeTask({ worktree_path: null });

    const outcome = await engine.resumeSuspendedSession(
      task as Parameters<typeof engine.resumeSuspendedSession>[0], null, false, '/code-review', undefined, 'claude',
    );

    // A resume that went ahead carries the message as its own prompt.
    expect(outcome).toEqual({ startOver: null, recapOnly: false, unsentPrompt: null });
    expect(capturedOptions?.resume).toBe(true);
    expect(capturedOptions?.sessionId).toBe(AGENT_SESSION_ID);
    expect(capturedOptions?.prompt).toBe('/code-review');
    expect(notices).toEqual([]);
  });
});

describe('TransitionEngine - where an isolated pass began, and who resumed a session (executeSpawnAgent chokepoint)', () => {
  // Task #952. An isolated column's pass records the HEAD of the checkout it
  // starts in (`SessionRecord.start_head_sha`), read through the injected
  // `readStartHead` BEFORE the spawn because the agent may commit within its
  // first seconds. A main session records none, and a read that fails never
  // fails the spawn. `spawnOverrides.resumedBy` (the workflow's memory resume
  // passes 'memory') rides the spawn only when it really resumes.
  //
  // Red-green: calling readStartHead for a main session fails the first
  // main-session test; dropping its try/catch fails the throw test; forwarding
  // resumedBy on a fresh spawn fails the fresh-spawn test, and dropping the
  // forward fails the resume test.
  const AGENT_SESSION_ID = 'agent-sess-uuid';
  const START_HEAD = '0123456789abcdef0123456789abcdef01234567';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`);
  });

  /** A suspended record the spawn resumes, or no record at all for a fresh spawn. */
  function repoWithResumableRecord(resumable: boolean) {
    const sessionRepo = makeSessionRepo();
    if (resumable) {
      const record = {
        id: 'session-record-resume',
        agent_session_id: AGENT_SESSION_ID,
        session_type: 'claude_agent',
        status: 'suspended',
        cwd: '/some/project',
        isolated_swimlane_id: null,
      };
      sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(record as never);
      sessionRepo.listForTaskNewestFirst.mockReturnValue([record] as never);
    }
    return sessionRepo;
  }

  type SpawnedArguments = { cwd: string; resuming?: boolean; resumedBy?: string };

  describe('start_head_sha', () => {
    it('reads the HEAD of the checkout an isolated pass starts in, before the spawn, and records it', async () => {
      const readStartHead = vi.fn(async (_cwd: string) => START_HEAD);
      const { engine, sessionManager, sessionRepo } = makeEngine({ services: { readStartHead } });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, true, '/code-review', undefined, 'claude', undefined, { isolatedSwimlaneId: 'lane-review' },
      );

      const spawned = sessionManager.spawn.mock.calls[0][0] as unknown as SpawnedArguments;
      expect(readStartHead).toHaveBeenCalledTimes(1);
      expect(readStartHead).toHaveBeenCalledWith(spawned.cwd);
      // Before the spawn: the agent may commit within its first seconds.
      expect(readStartHead.mock.invocationCallOrder[0]).toBeLessThan(sessionManager.spawn.mock.invocationCallOrder[0]);
      expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        isolated_swimlane_id: 'lane-review',
        start_head_sha: START_HEAD,
      }));
    });

    it('reads nothing for the main session, and records no start HEAD', async () => {
      const readStartHead = vi.fn(async (_cwd: string) => START_HEAD);
      const { engine, sessionRepo } = makeEngine({ services: { readStartHead } });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, true, '/code-review', undefined, 'claude',
      );

      expect(readStartHead).not.toHaveBeenCalled();
      expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        isolated_swimlane_id: null,
        start_head_sha: null,
      }));
    });

    it('records no start HEAD, and still spawns, when the read throws', async () => {
      const readStartHead = vi.fn(async (_cwd: string): Promise<string | null> => { throw new Error('not a git checkout'); });
      const { engine, sessionManager, sessionRepo } = makeEngine({ services: { readStartHead } });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, true, '/code-review', undefined, 'claude', undefined, { isolatedSwimlaneId: 'lane-review' },
      );

      expect(readStartHead).toHaveBeenCalledTimes(1);
      expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
      expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
        isolated_swimlane_id: 'lane-review',
        start_head_sha: null,
      }));
    });

    it('records no start HEAD when the checkout has none to report', async () => {
      const readStartHead = vi.fn(async (_cwd: string): Promise<string | null> => null);
      const { engine, sessionRepo } = makeEngine({ services: { readStartHead } });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, true, '/code-review', undefined, 'claude', undefined, { isolatedSwimlaneId: 'lane-review' },
      );

      expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ start_head_sha: null }));
    });
  });

  describe('resumedBy', () => {
    it('is forwarded to the spawn when the session resumes', async () => {
      const { engine, sessionManager } = makeEngine({ sessionRepo: repoWithResumableRecord(true) });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, false, undefined, undefined, 'claude', undefined, { resumedBy: 'memory' },
      );

      const spawned = sessionManager.spawn.mock.calls[0][0] as unknown as SpawnedArguments;
      // The control: this really is a resume.
      expect(spawned.resuming).toBe(true);
      expect(spawned.resumedBy).toBe('memory');
    });

    it('is left off a fresh spawn, which resumes nobody', async () => {
      const { engine, sessionManager } = makeEngine({ sessionRepo: repoWithResumableRecord(false) });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, false, undefined, undefined, 'claude', undefined, { resumedBy: 'memory' },
      );

      const spawned = sessionManager.spawn.mock.calls[0][0] as unknown as SpawnedArguments;
      expect(spawned.resuming).toBe(false);
      expect(spawned).not.toHaveProperty('resumedBy');
    });

    it('is left off a resume nobody else asked for (a person resumes by default)', async () => {
      const { engine, sessionManager } = makeEngine({ sessionRepo: repoWithResumableRecord(true) });

      await engine.resumeSuspendedSession(
        makeTask() as Parameters<typeof engine.resumeSuspendedSession>[0],
        null, false, undefined, undefined, 'claude',
      );

      const spawned = sessionManager.spawn.mock.calls[0][0] as unknown as SpawnedArguments;
      expect(spawned.resuming).toBe(true);
      expect(spawned).not.toHaveProperty('resumedBy');
    });
  });
});

describe('TransitionEngine - executeSpawnAgent throws a typed error when the agent CLI is missing (DESKTOP-5)', () => {
  // Coverage hole (audit): executeSpawnAgent's detect-failure branch changed
  // from a plain `Error` to `AgentCliNotFoundError` so reportHandledError
  // (which keys its Sentry exclusion off `instanceof UserConfigurationError`)
  // stops treating a missing CLI as a reportable defect. Nothing in this file
  // exercised the detect-failure branch at all (mockAdapter.detect is
  // `found: true` everywhere else), and spawn-agent-lock-overrides.test.ts
  // covers only the ipc/helpers/agent-spawn.ts catch site with the ENGINE
  // mocked out - never this real throw. The type is what matters, not the
  // wording (see the sibling transient-session pin), so this asserts
  // `instanceof AgentCliNotFoundError`, not just a matching message.
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.detect.mockImplementation(async () => ({ found: false, path: null, version: null }));
  });

  afterEach(() => {
    // mockAdapter is shared module state; every other describe in this file
    // assumes `found: true`. Restore it so this block cannot leak forward.
    mockAdapter.detect.mockImplementation(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
  });

  it('executeAction (spawn_agent): rejects with AgentCliNotFoundError and never spawns', async () => {
    const task = makeTask();
    const sessionManager = makeSessionManager();
    const { runSpawn } = makeEngine({ sessionManager });

    await expect(
      runSpawn(task),
    ).rejects.toThrow(AgentCliNotFoundError);

    // Detection gates the spawn rather than running alongside it.
    expect(sessionManager.spawnedSessions).toHaveLength(0);
  });

  it('carries the shared, non-doubled "CLI not found" message', async () => {
    const task = makeTask();
    const { runSpawn } = makeEngine({});

    await expect(
      runSpawn(task),
    ).rejects.toThrow(agentCliNotFoundMessage(mockAdapter.displayName));
  });
});

describe('TransitionEngine - Windows .cmd shim launch resolution wiring (executeSpawnAgent chokepoint)', () => {
  // resolveShimLaunch (src/main/agent/shared/shim-launch.ts) must run at this
  // chokepoint after ensureTrust, receive the detected path, the PTY shell,
  // and the interpolated prompt, and its result (BOTH fields) must be what
  // buildCommand sees. A chokepoint that took only agentPath from it and kept
  // the intent's prompt would still truncate through a .cmd on the flatten
  // fallback (#353). The session row, on the other hand, keeps the ORIGINAL
  // prompt: flattening is a delivery detail, not what the user wrote.
  const CMD_HEAD = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.CMD';
  const PS1_SIBLING = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\codex.ps1';
  const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.detect.mockImplementation(async () => ({ found: true, path: CMD_HEAD, version: '1.0.0' }));
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => {
      return `claude ${options.prompt ?? ''}`;
    });
  });

  afterEach(() => {
    // mockAdapter is shared module state; restore the path every other
    // describe in this file assumes.
    mockAdapter.detect.mockImplementation(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' }));
  });

  it('hands the detected path, the session shell, and the interpolated prompt to resolveShimLaunch, after ensureTrust and before buildCommand', async () => {
    const task = makeTask();
    const sessionManager = makeSessionManager();
    sessionManager.getShell.mockResolvedValue(PWSH);
    const { runSpawn } = makeEngine({ sessionManager });

    await runSpawn(task);

    expect(resolveShimLaunchMock).toHaveBeenCalledTimes(1);
    expect(resolveShimLaunchMock).toHaveBeenCalledWith({
      agentPath: CMD_HEAD,
      shell: PWSH,
      prompt: expect.stringContaining('<task>'),
    });
    const ensureTrustOrder = mockAdapter.ensureTrust.mock.invocationCallOrder[0];
    const resolveOrder = resolveShimLaunchMock.mock.invocationCallOrder[0];
    const buildOrder = mockAdapter.buildCommand.mock.invocationCallOrder[0];
    expect(ensureTrustOrder).toBeLessThan(resolveOrder);
    expect(resolveOrder).toBeLessThan(buildOrder);
  });

  it('builds the command from the resolved head AND the resolved prompt, while the session row keeps the original prompt', async () => {
    resolveShimLaunchMock.mockResolvedValueOnce({
      agentPath: PS1_SIBLING,
      prompt: 'RESOLVED-PROMPT',
      strategy: 'flattened-prompt',
    });
    const task = makeTask();
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    const { runSpawn } = makeEngine({ sessionManager, sessionRepo });

    await runSpawn(task);

    // Red: a chokepoint keeping `agentPath: detection.path` or `prompt` (the
    // intent's) instead of the helper's fields fails one of these.
    expect(mockAdapter.buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agentPath: PS1_SIBLING, prompt: 'RESOLVED-PROMPT' }),
    );
    expect(sessionRepo.insertedRecords).toHaveLength(1);
    const inserted = sessionRepo.insertedRecords[0] as { prompt: string | null };
    expect(inserted.prompt).toContain('<task>');
    expect(inserted.prompt).not.toBe('RESOLVED-PROMPT');
  });

  it('produces a real Codex command whose head is the .ps1 sibling', async () => {
    const task = makeTask();
    resolveShimLaunchMock.mockResolvedValueOnce({
      agentPath: PS1_SIBLING,
      prompt: buildTaskXml({ title: task.title, description: task.description }),
      strategy: 'ps1-sibling',
    });
    const codexCommandBuilder = new CodexCommandBuilder();
    mockAdapter.buildCommand.mockImplementation((options: { agentPath: string; prompt?: string }) => {
      const { agentPath, ...rest } = options;
      return codexCommandBuilder.buildCodexCommand({ codexPath: agentPath, ...rest } as CodexCommandOptions);
    });
    const sessionManager = makeSessionManager();
    sessionManager.getShell.mockResolvedValue(PWSH);
    const { runSpawn } = makeEngine({ sessionManager });

    await runSpawn(task);

    expect(sessionManager.spawnedSessions).toHaveLength(1);
    const command = sessionManager.spawnedSessions[0].command;
    expect(command.startsWith(`"${PS1_SIBLING}"`)).toBe(true);
    expect(command).not.toContain('codex.CMD');
    // The multi-line prompt still rides the PowerShell backtick-n contract.
    expect(command).toContain('`n');
  });
});

describe('TransitionEngine - a CLI installed in a WSL distro', () => {
  // A CLI configured by its \\wsl.localhost path is resolved to a target once
  // per spawn. The command is built for, and the PTY runs in, that distro's
  // shell, and the row records the distro for the readers and the reap.
  //
  // Red-green: building with `getShell()` alone fails the first case's shell
  // assertions; dropping `cliTarget` from the command options, the spawn input
  // or the row fails the matching assertion; resolving a target for an adapter
  // that does not declare WSL support fails the second case.
  const WSL_CLI_PATH = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\claude';

  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.detect.mockResolvedValue({ found: true, path: WSL_CLI_PATH, version: '2.1.311' });
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`);
  });

  afterEach(() => {
    mockAdapter.supportsWslCli = undefined;
    mockAdapter.detect.mockResolvedValue({ found: true, path: '/usr/bin/claude', version: '1.0.0' });
  });

  it('builds and spawns in the distro shell, hands the builder the target, and records the distro', async () => {
    mockAdapter.supportsWslCli = true;
    const { runSpawn, sessionManager, sessionRepo } = makeEngine({});

    await runSpawn(makeTask());

    expect(sessionManager.getShell).not.toHaveBeenCalled();
    expect(resolveShimLaunchMock).toHaveBeenCalledWith(expect.objectContaining({ shell: 'wsl -d Ubuntu' }));
    expect(mockAdapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({
      shell: 'wsl -d Ubuntu',
      cliTarget: { kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/claude', facts: WSL_DISTRO_FACTS },
    }));
    // The spawn and the row keep the homes a reader needs after the session, and the CLI's path.
    const stored = {
      kind: 'wsl',
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
      env: {},
      linuxCliPath: '/home/dev/.local/bin/claude',
    };
    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({
      shell: 'wsl -d Ubuntu',
      cliTarget: stored,
    }));
    expect(JSON.parse(sessionRepo.insertedRecords[0].cli_target ?? 'null')).toEqual(stored);
  });

  it('keeps the configured shell and no target for an adapter that does not run from WSL', async () => {
    const { runSpawn, sessionManager, sessionRepo } = makeEngine({});

    await runSpawn(makeTask());

    expect(mockAdapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ shell: 'bash', cliTarget: null }));
    expect(sessionManager.spawn).toHaveBeenCalledWith(expect.objectContaining({ shell: 'bash', cliTarget: null }));
    expect(sessionRepo.insertedRecords[0]).toEqual(expect.objectContaining({ cli_target: null }));
  });
});

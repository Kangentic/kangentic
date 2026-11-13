/**
 * A spawned session's opening prompt is recorded as Kangentic's own text (#1078).
 *
 * A resumed session starts idle, so its first turn is anchored and the prompt it was resumed with
 * sits in that turn's transcript as a user message. If the engine stopped recording it, a column
 * message that names the sign-off phrase (the Design contract does) would read as the user's own
 * words and a card would leave Design at its first turn end, before anyone signed it off.
 *
 * Drives the real `TransitionEngine` spawn chokepoint (`commitSessionRecord`) with the same stubs
 * `transition-engine-expired-recap.test.ts` uses. Only the typed-message ledger is mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ledger = vi.hoisted(() => ({
  recordKangenticTypedInProject: vi.fn(),
}));
vi.mock('../../src/main/automations/turn-end/typed-message-ledger', () => ({
  recordKangenticTypedInProject: ledger.recordKangenticTypedInProject,
}));

import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';

const PROJECT_ID = 'proj-typed-record';

function makeTask() {
  return {
    id: 'task-typed-1',
    title: 'Design the thing',
    description: 'Sketch it.',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_url: null,
    pr_number: null,
    agent: null,
  };
}

function makeSessionRepo() {
  return {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => null),
    insert: vi.fn(),
    update: vi.fn(),
    updateAppliedSettings: vi.fn(),
    compareAndUpdateStatus: vi.fn(() => true),
    updateAgentSessionId: vi.fn(),
    listForTaskNewestFirst: vi.fn(() => []),
  };
}

function makeTaskRepo() {
  return {
    update: vi.fn(),
    recordWorktree: vi.fn(),
    getById: vi.fn(() => undefined),
    recoverLegacyWorktreeFolder: vi.fn(() => null),
    setWorktreeSkipReason: vi.fn(),
  };
}

function makeSessionManager() {
  return {
    spawn: vi.fn(async (options: { id: string; command: string }) => ({ id: options.id, status: 'running' })),
    getShell: vi.fn(async () => 'bash'),
    markIdleAuthoritative: vi.fn(),
  };
}

const mockAdapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  defaultPermission: 'default',
  launchOptions: undefined,
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`),
  buildEnv: undefined,
  getExitSequence: vi.fn(() => ['\x03']),
  removeHooks: vi.fn(),
  runtime: undefined,
  locateSessionHistoryFile: vi.fn(async (): Promise<string | null> => null),
  proveConversationGone: undefined,
  resumePromptDelivery: 'command-line',
  freshPromptDelivery: undefined,
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    getOrThrow: vi.fn(() => mockAdapter),
    list: vi.fn(() => ['claude']),
  },
}));

vi.mock('../../src/main/transition-engine/resume-cwd-migration', () => ({
  migrateResumeCwdIfRenamed: vi.fn(async () => {}),
}));

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

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

type EngineArgs = ConstructorParameters<typeof TransitionEngine>;
type SpawnTask = Parameters<TransitionEngine['resumeSuspendedSession']>[0];

describe('TransitionEngine records the opening prompt as Kangentic\'s own text', () => {
  let projectPath: string;

  function makeEngine() {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    const getConfig = vi.fn(() => ({
      permissionMode: 'default',
      projectPath,
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
    const engine = new TransitionEngine(
      sessionManager as unknown as EngineArgs[0],
      { submitKeystrokes: vi.fn() } as unknown as EngineArgs[1],
      makeTaskRepo() as unknown as EngineArgs[2],
      getConfig as unknown as EngineArgs[3],
      sessionRepo as unknown as EngineArgs[4],
      { getPathsForTask: vi.fn(() => []) } as unknown as EngineArgs[5],
      undefined,
      undefined,
      undefined,
    );
    return { engine, sessionManager, sessionRepo };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockAdapter.buildCommand.mockImplementation((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`);
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-te-typed-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('records the prompt under the project id and the id of the session it spawned', async () => {
    const { engine, sessionManager, sessionRepo } = makeEngine();

    await engine.resumeSuspendedSession(makeTask() as unknown as SpawnTask, null, false, '/design-contract signed off', undefined, 'claude');

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const spawnedSessionId = sessionManager.spawn.mock.calls[0][0].id;
    // A fresh spawn's opening prompt is the task block, which the command line carries.
    const openingPrompt = String(sessionManager.spawn.mock.calls[0][0].command).replace(/^claude /, '');
    expect(openingPrompt).toContain('<title>Design the thing</title>');
    expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ id: spawnedSessionId, prompt: openingPrompt }));
    expect(ledger.recordKangenticTypedInProject).toHaveBeenCalledTimes(1);
    expect(ledger.recordKangenticTypedInProject).toHaveBeenCalledWith(PROJECT_ID, spawnedSessionId, openingPrompt);
  });

  it('records nothing for a spawn that carries no prompt', async () => {
    // A plain resume of a suspended conversation, with no message to send.
    const { engine, sessionManager, sessionRepo } = makeEngine();
    const record = {
      id: 'suspended-record-1',
      agent_session_id: 'aaaaaaaa-1111-4222-8333-444444444444',
      session_type: 'claude_agent',
      status: 'suspended',
      cwd: projectPath,
      isolated_swimlane_id: null,
      started_at: '2026-08-16T13:00:00.000Z',
      suspended_at: '2026-08-16T14:00:00.000Z',
      exited_at: null,
    };
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(record as never);
    sessionRepo.listForTaskNewestFirst.mockReturnValue([record] as never);

    await engine.resumeSuspendedSession(makeTask() as unknown as SpawnTask, null, false, null, undefined, 'claude');

    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ prompt: null }));
    expect(ledger.recordKangenticTypedInProject).not.toHaveBeenCalled();
  });
});

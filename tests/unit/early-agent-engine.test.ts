/**
 * The engine half of starting a task's agent while its new worktree runs its
 * setup script (#955): `TransitionEngine.launchEarlyAgent` starts the agent
 * hidden and with no prompt, and the task's spawn adopts it in place of a
 * fresh launch, handing the prompt back to be typed in
 * (`SpawnOutcome.typedOpening`). An adoption that finds the launch changed, or
 * the agent gone, discards it and launches as before.
 *
 * Everything the engine touches is a stub; the assertions read what reached
 * `sessionManager.spawn`, the adapter's `buildCommand`, and the two repos.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TransitionEngine } from '../../src/main/transition-engine/transition-engine';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';
import { assessResumeConversation } from '../../src/main/transition-engine/resume-conversation-guard';

const mockAdapter = {
  name: 'claude',
  displayName: 'Claude',
  sessionType: 'claude_agent',
  supportsCallerSessionId: true,
  defaultPermission: 'default',
  resumePromptDelivery: 'command-line',
  firstPromptMayBeTyped: vi.fn(() => true) as ReturnType<typeof vi.fn> | undefined,
  detect: vi.fn(async () => ({ found: true, path: '/usr/bin/claude', version: '1.0.0' })),
  ensureTrust: vi.fn(async () => {}),
  buildCommand: vi.fn((options: { prompt?: string }) => `claude ${options.prompt ?? ''}`.trim()),
  getExitSequence: vi.fn(() => ['\x03']),
};

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: {
    get: vi.fn(() => mockAdapter),
    getOrThrow: vi.fn(() => mockAdapter),
    list: vi.fn(() => ['claude']),
  },
}));

vi.mock('../../src/main/agent/shared/shim-launch', () => ({
  resolveShimLaunch: vi.fn(async (input: { agentPath: string; prompt: string | undefined }) => ({
    agentPath: input.agentPath,
    prompt: input.prompt,
    strategy: 'unchanged' as const,
  })),
}));

// Passes through to the real check; one test makes it answer 'never-started'.
vi.mock('../../src/main/transition-engine/resume-conversation-guard', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/transition-engine/resume-conversation-guard')>();
  return { ...original, assessResumeConversation: vi.fn(original.assessResumeConversation) };
});

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const mocked = { ...original, mkdirSync: vi.fn() };
  return { ...mocked, default: mocked };
});

interface SpawnInput {
  id: string;
  command: string;
  cwd: string;
  hiddenUntilAdopted?: boolean;
  seedIdle?: boolean;
  resuming?: boolean;
}

function makeSessionManager() {
  const hidden = new Set<string>();
  const spawned: SpawnInput[] = [];
  return {
    spawned,
    hidden,
    spawn: vi.fn(async (input: SpawnInput) => {
      spawned.push(input);
      if (input.hiddenUntilAdopted) hidden.add(input.id);
      return { id: input.id, status: 'running' };
    }),
    getShell: vi.fn(async () => 'bash'),
    getFreeAgentSlots: vi.fn(() => 4),
    hasSessionForTask: vi.fn(() => false),
    isHiddenUntilAdopted: vi.fn((sessionId: string) => hidden.has(sessionId)),
    adoptSession: vi.fn((sessionId: string) => hidden.delete(sessionId)),
    getSession: vi.fn((sessionId: string) => (spawned.some((input) => input.id === sessionId) ? { id: sessionId, agentSessionId: null } : undefined)),
    // The agent's TUI entered the alternate screen: it is at its input box.
    awaitAltScreen: vi.fn(async () => true),
    markIdleAuthoritative: vi.fn(),
    kill: vi.fn(),
    awaitExit: vi.fn(async () => {}),
    remove: vi.fn((sessionId: string) => { hidden.delete(sessionId); }),
  };
}

function makeSessionRepo() {
  return {
    getLatestForTaskByTypeAndIsolation: vi.fn(() => null),
    listForTaskNewestFirst: vi.fn(() => []),
    insert: vi.fn(),
    updateAppliedSettings: vi.fn(),
    compareAndUpdateStatus: vi.fn(() => true),
  };
}

function makeEngine(
  sessionManager: ReturnType<typeof makeSessionManager>,
  sessionRepo: ReturnType<typeof makeSessionRepo>,
  automationRepo?: { getForTrigger: ReturnType<typeof vi.fn> },
) {
  const taskRepo = { update: vi.fn(), getById: vi.fn(() => null) };
  const engine = new TransitionEngine(
    sessionManager as never,
    { submitKeystrokes: vi.fn() } as never,
    taskRepo as never,
    () => ({
      permissionMode: 'default',
      projectPath: '/some/project',
      projectId: 'project-1',
      projectName: 'Project',
      gitConfig: { defaultBaseBranch: 'main' } as never,
      defaultAgent: 'claude',
      cliPathOverrides: {},
      executionServers: {},
      execution: {},
      launchOptions: {},
    }),
    sessionRepo as never,
    { getPathsForTask: vi.fn(() => []) } as never,
    automationRepo as never,
  );
  return { engine, taskRepo };
}

const WORKTREE = '/some/project/.kangentic/worktrees/7';

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    display_id: 7,
    title: 'Fix login flow',
    description: 'Make the login form submit on Enter.',
    session_id: null,
    worktree_path: null,
    branch_name: null,
    agent: null,
    permission_mode: null,
    ...overrides,
  };
}

describe('launchEarlyAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.firstPromptMayBeTyped = vi.fn(() => true);
  });

  it('starts the agent hidden, seeded idle, in the worktree, with no prompt on its command line', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());

    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' });

    expect(handle).not.toBeNull();
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    const input = sessionManager.spawned[0];
    expect(input.hiddenUntilAdopted).toBe(true);
    expect(input.seedIdle).toBe(true);
    // A later background paste waits for its input box (SessionManager.awaitInputReady).
    expect((input as SpawnInput & { inputInAlternateScreen?: boolean }).inputInAlternateScreen).toBe(true);
    expect(input.resuming).toBe(false);
    expect(input.cwd).toBe(WORKTREE);
    expect(mockAdapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ prompt: undefined, cwd: WORKTREE }));
    expect(input.command).toBe('claude');
    expect(mockAdapter.ensureTrust).toHaveBeenCalledWith(WORKTREE, null);
  });

  it('launches nothing for an agent that cannot take its first prompt typed', async () => {
    mockAdapter.firstPromptMayBeTyped = undefined;
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());

    expect(await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' })).toBeNull();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('launches nothing, and builds no command, when this launch draws no input box in the alternate screen (Claude on its classic renderer)', async () => {
    mockAdapter.firstPromptMayBeTyped = vi.fn(() => false);
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());

    expect(await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' })).toBeNull();
    // Asked with the launch's own options, in the worktree.
    expect(mockAdapter.firstPromptMayBeTyped).toHaveBeenCalledWith(expect.objectContaining({ cwd: WORKTREE, prompt: undefined }));
    expect(mockAdapter.buildCommand).not.toHaveBeenCalled();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('launches nothing without a free slot, or when the task already has a session row', async () => {
    const noSlot = makeSessionManager();
    noSlot.getFreeAgentSlots.mockReturnValue(0);
    expect(await makeEngine(noSlot, makeSessionRepo()).engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' })).toBeNull();

    const hasRow = makeSessionManager();
    hasRow.hasSessionForTask.mockReturnValue(true);
    expect(await makeEngine(hasRow, makeSessionRepo()).engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' })).toBeNull();

    expect(noSlot.spawn).not.toHaveBeenCalled();
    expect(hasRow.spawn).not.toHaveBeenCalled();
  });

  it('launches nothing when the spawn would resume a conversation', async () => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue({
      id: 'record-1', status: 'suspended', agent_session_id: 'agent-session-1', cwd: WORKTREE,
    } as never);
    const { engine } = makeEngine(sessionManager, sessionRepo);

    expect(await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' })).toBeNull();
    expect(sessionManager.spawn).not.toHaveBeenCalled();
  });

  it('discard kills the agent, waits for its exit, then removes its row', async () => {
    const sessionManager = makeSessionManager();
    const order: string[] = [];
    sessionManager.kill.mockImplementation(() => { order.push('kill'); });
    sessionManager.awaitExit.mockImplementation(async () => { order.push('awaitExit'); });
    sessionManager.remove.mockImplementation(() => { order.push('remove'); });
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' }) as EarlyAgentHandle;

    await handle.discard();
    await handle.discard();

    // The exit wait is taken while the row exists, then the row goes.
    expect(order).toEqual(['kill', 'awaitExit', 'remove']);
  });
});

describe('adopting an early agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.firstPromptMayBeTyped = vi.fn(() => true);
  });

  it('commits the early agent as the task session and hands the opening prompt back to be typed', async () => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    const { engine, taskRepo } = makeEngine(sessionManager, sessionRepo);
    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' }) as EarlyAgentHandle;
    sessionManager.spawn.mockClear();
    mockAdapter.buildCommand.mockClear();

    // The worktree is recorded by now (the script succeeded).
    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined, { earlyAgent: handle },
    );

    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(mockAdapter.buildCommand).not.toHaveBeenCalled();
    expect(sessionManager.adoptSession).toHaveBeenCalledWith(handle.sessionId);
    expect(taskRepo.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'task-1', session_id: handle.sessionId, agent: 'claude' }));
    expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({ id: handle.sessionId, cwd: WORKTREE, status: 'running' }));
    // The task template, which the command line would have carried.
    expect(outcome.typedOpening).toContain('Fix login flow');
    expect(outcome.typedOpening).toContain('Make the login form submit on Enter.');
    expect(handle.isSettled()).toBe(true);
  });

  it('discards the early agent and launches fresh when the launch changed (another model)', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' }) as EarlyAgentHandle;
    sessionManager.spawn.mockClear();

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined,
      { model: 'opus', earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(sessionManager.kill).toHaveBeenCalledWith(handle.sessionId);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawned.at(-1)?.hiddenUntilAdopted).toBeUndefined();
    expect(outcome.typedOpening ?? null).toBeNull();
  });

  it('discards an early agent stopped short of its input box (an MCP approval) and launches as before', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' }) as EarlyAgentHandle;
    sessionManager.awaitAltScreen.mockResolvedValueOnce(false);
    sessionManager.spawn.mockClear();

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined, { earlyAgent: handle },
    );

    // Bounded by its launch: it had until 15 s after it started to get there.
    const budgetMs = sessionManager.awaitAltScreen.mock.calls[0]?.[1] as number;
    expect(budgetMs).toBeLessThanOrEqual(15_000);
    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(sessionManager.kill).toHaveBeenCalledWith(handle.sessionId);
    // The relaunch carries the prompt on its command line, so the user answers the screen first.
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawned.at(-1)?.command).toContain('Fix login flow');
    // The relaunch is marked too, so a held message waits until the user has answered that screen.
    expect((sessionManager.spawned.at(-1) as SpawnInput & { inputInAlternateScreen?: boolean }).inputInAlternateScreen).toBe(true);
    expect(outcome.typedOpening ?? null).toBeNull();
  });

  it('discards an early agent that is no longer running and launches fresh', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await engine.launchEarlyAgent({ task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude' }) as EarlyAgentHandle;
    sessionManager.hidden.delete(handle.sessionId);
    sessionManager.spawn.mockClear();

    await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined, { earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(handle.isSettled()).toBe(true);
  });
});

const CARRIED_MESSAGE = 'Run the tests before you finish.';

/** A suspended record the task's next spawn would resume, as the intent resolver reads it. */
function resumableRecord() {
  return { id: 'record-1', status: 'suspended', agent_session_id: 'agent-session-1', cwd: WORKTREE } as never;
}

/** Start the task's early agent in the worktree; `forceFresh` lets it start although a record is resumable. */
async function launchEarlyAgentFor(engine: TransitionEngine, spawnOverrides?: { forceFresh?: boolean }): Promise<EarlyAgentHandle> {
  const handle = await engine.launchEarlyAgent({
    task: makeTask() as never, worktreePath: WORKTREE, agentOverride: 'claude', spawnOverrides,
  });
  expect(handle).not.toBeNull();
  return handle as EarlyAgentHandle;
}

describe('adopting an early agent when a column message is carried', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.firstPromptMayBeTyped = vi.fn(() => true);
  });

  it('hands the carried message back unsent when a forced-fresh spawn adopts, and retires the prior record', async () => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord());
    const { engine } = makeEngine(sessionManager, sessionRepo);
    const handle = await launchEarlyAgentFor(engine, { forceFresh: true });
    sessionManager.spawn.mockClear();

    // An 'always_spawn_new' column: a resumable record is on the track, and the
    // column's message rides along as the resume prompt.
    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, CARRIED_MESSAGE, undefined, 'claude', undefined,
      { forceFresh: true, earlyAgent: handle },
    );

    expect(sessionManager.spawn).not.toHaveBeenCalled();
    expect(sessionManager.adoptSession).toHaveBeenCalledWith(handle.sessionId);
    // The task template owns the opening; the message it left out comes back for the caller to send after it.
    expect(outcome.typedOpening).toContain('Fix login flow');
    expect(outcome.typedOpening).not.toContain(CARRIED_MESSAGE);
    expect(outcome.unsentPrompt).toBe(CARRIED_MESSAGE);
    expect(outcome.startOver).toBeNull();
    expect(outcome.recapOnly).toBe(false);
    // The prior conversation is retired, not resumed.
    expect(sessionRepo.compareAndUpdateStatus).toHaveBeenCalledWith(
      'record-1', ['suspended', 'orphaned'], 'exited', { exited_at: expect.any(String) },
    );
    expect(sessionRepo.insert).toHaveBeenCalledWith(expect.objectContaining({
      id: handle.sessionId, status: 'running', prompt: outcome.typedOpening,
    }));
  });

  it.each([
    { label: 'no message', message: undefined },
    { label: 'a blank message', message: '   ' },
  ])('hands back nothing unsent for $label', async ({ message }) => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord());
    const { engine } = makeEngine(sessionManager, sessionRepo);
    const handle = await launchEarlyAgentFor(engine, { forceFresh: true });

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, message, undefined, 'claude', undefined,
      { forceFresh: true, earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).toHaveBeenCalledWith(handle.sessionId);
    expect(outcome.unsentPrompt).toBeNull();
  });

  it('hands back nothing unsent when the column has no task template, since the message is the opening itself', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await launchEarlyAgentFor(engine);

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, true, CARRIED_MESSAGE, undefined, 'claude', undefined,
      { earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).toHaveBeenCalledWith(handle.sessionId);
    expect(outcome.typedOpening).toBe(CARRIED_MESSAGE);
    expect(outcome.unsentPrompt).toBeNull();
  });
});

describe('an early agent the spawn does not adopt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdapter.firstPromptMayBeTyped = vi.fn(() => true);
  });

  it('discards it and resumes the conversation when a resumable record is on the track', async () => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    const { engine } = makeEngine(sessionManager, sessionRepo);
    // Started while the track held nothing to resume; the record appears before the spawn.
    const handle = await launchEarlyAgentFor(engine);
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord());
    const discardSpy = vi.spyOn(handle, 'discard');
    sessionManager.spawn.mockClear();
    mockAdapter.buildCommand.mockClear();

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined,
      { earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.kill).toHaveBeenCalledWith(handle.sessionId);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawned.at(-1)?.resuming).toBe(true);
    expect(sessionManager.spawned.at(-1)?.hiddenUntilAdopted).toBeUndefined();
    expect(mockAdapter.buildCommand).toHaveBeenCalledWith(expect.objectContaining({ resume: true, sessionId: 'agent-session-1' }));
    expect(outcome.typedOpening ?? null).toBeNull();
  });

  it('discards it and launches with the handoff pointer on the command line when a handoff prefix is passed', async () => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await launchEarlyAgentFor(engine);
    const discardSpy = vi.spyOn(handle, 'discard');
    sessionManager.spawn.mockClear();
    const handoffPrefix = 'The earlier agent session for this task is recorded in its history file.';

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', handoffPrefix,
      { earlyAgent: handle },
    );

    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    // The pointer needs the command line, which the early agent never had.
    expect(sessionManager.spawned.at(-1)?.command).toContain(handoffPrefix);
    expect(sessionManager.spawned.at(-1)?.command).toContain('Fix login flow');
    expect(sessionManager.spawned.at(-1)?.hiddenUntilAdopted).toBeUndefined();
    expect(outcome.typedOpening ?? null).toBeNull();
  });

  it('discards it and launches fresh when a resume started over (the conversation never had a turn)', async () => {
    const sessionManager = makeSessionManager();
    const sessionRepo = makeSessionRepo();
    sessionRepo.getLatestForTaskByTypeAndIsolation.mockReturnValue(resumableRecord());
    const { engine } = makeEngine(sessionManager, sessionRepo);
    const handle = await launchEarlyAgentFor(engine, { forceFresh: true });
    const discardSpy = vi.spyOn(handle, 'discard');
    sessionManager.spawn.mockClear();
    vi.mocked(assessResumeConversation).mockResolvedValueOnce('never-started');

    const outcome = await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE }) as never, null, false, undefined, undefined, 'claude', undefined,
      { earlyAgent: handle },
    );

    expect(outcome.startOver).toBe('never-started');
    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(discardSpy).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawned.at(-1)?.resuming).toBe(false);
    expect(sessionManager.spawned.at(-1)?.hiddenUntilAdopted).toBeUndefined();
  });

  it.each([
    { label: 'another task', taskOverrides: { id: 'task-2' }, agentOverride: 'claude' },
    { label: 'another folder', taskOverrides: { worktree_path: '/some/project/.kangentic/worktrees/8' }, agentOverride: 'claude' },
    { label: 'another agent', taskOverrides: {}, agentOverride: 'codex' },
  ])('discards it and launches normally when it was started for $label', async ({ taskOverrides, agentOverride }) => {
    const sessionManager = makeSessionManager();
    const { engine } = makeEngine(sessionManager, makeSessionRepo());
    const handle = await launchEarlyAgentFor(engine);
    sessionManager.spawn.mockClear();
    sessionManager.isHiddenUntilAdopted.mockClear();

    await engine.resumeSuspendedSession(
      makeTask({ worktree_path: WORKTREE, ...taskOverrides }) as never, null, false, undefined, undefined, agentOverride, undefined,
      { earlyAgent: handle },
    );

    // The identity check comes first: nothing reads the running agent for a handle that is not this spawn's.
    expect(sessionManager.isHiddenUntilAdopted).not.toHaveBeenCalled();
    expect(sessionManager.adoptSession).not.toHaveBeenCalled();
    expect(sessionManager.kill).toHaveBeenCalledWith(handle.sessionId);
    expect(handle.isSettled()).toBe(true);
    expect(sessionManager.spawn).toHaveBeenCalledTimes(1);
    expect(sessionManager.spawned.at(-1)?.hiddenUntilAdopted).toBeUndefined();
  });
});

describe('agentStartsFirstOnEnter', () => {
  const column = { id: 'column-1' };

  function engineWithEnterRows(rows: Array<{ id: string; type: string }>) {
    const automationRepo = { getForTrigger: vi.fn(() => rows) };
    const { engine } = makeEngine(makeSessionManager(), makeSessionRepo(), automationRepo);
    return { engine, automationRepo };
  }

  it('is true when the engine has no automation repo', () => {
    const { engine } = makeEngine(makeSessionManager(), makeSessionRepo());

    expect(engine.agentStartsFirstOnEnter(column)).toBe(true);
  });

  it('is true when the column has no enter row, and asks for the column\'s enter rows', () => {
    const { engine, automationRepo } = engineWithEnterRows([]);

    expect(engine.agentStartsFirstOnEnter(column)).toBe(true);
    expect(automationRepo.getForTrigger).toHaveBeenCalledWith('column-1', 'enter');
  });

  it.each([
    { type: 'send_message', startsFirst: true },
    { type: 'run_script', startsFirst: false },
    { type: 'webhook', startsFirst: false },
    { type: 'notify', startsFirst: false },
    { type: 'spawn_agent', startsFirst: false },
  ])('is $startsFirst when the first enter row is $type', ({ type, startsFirst }) => {
    const { engine } = engineWithEnterRows([{ id: 'row-1', type }]);

    expect(engine.agentStartsFirstOnEnter(column)).toBe(startsFirst);
  });

  it('reads only the first enter row: a script before a message row holds the agent back', () => {
    const { engine } = engineWithEnterRows([{ id: 'row-1', type: 'run_script' }, { id: 'row-2', type: 'send_message' }]);

    expect(engine.agentStartsFirstOnEnter(column)).toBe(false);
  });

  it('reads only the first enter row: a message row before a script lets the agent start first', () => {
    const { engine } = engineWithEnterRows([{ id: 'row-1', type: 'send_message' }, { id: 'row-2', type: 'run_script' }]);

    expect(engine.agentStartsFirstOnEnter(column)).toBe(true);
  });
});

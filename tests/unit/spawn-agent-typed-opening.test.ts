/**
 * When `spawnAgent`'s spawn adopts an agent launched during the worktree's
 * setup script, the engine hands back the opening prompt the command line
 * would have carried (`SpawnOutcome.typedOpening`), and spawnAgent types it in
 * before anything else reaches the agent (#955):
 *
 *   - a multi-line opening (the task template's XML) goes as one bracketed
 *     paste, and lands before the column's message row is scheduled;
 *   - a slash-command opening (a column whose message is the prompt) goes as
 *     keystrokes, which is the only way it runs;
 *   - the early agent is offered to the engine, and discarded when nothing
 *     adopted it;
 *   - an opening that did not land is reported as the task's first prompt (a
 *     cancel stays silent) and the held messages folded into it go back on
 *     hold;
 *   - the setup-script note rides the engine's prompt prefix, except on a slash
 *     command, which only runs as the prompt's first word.
 *
 * Harness follows spawn-agent-continuation-prompt.test.ts: the real spawnAgent
 * with injected engine, repos and context fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, Swimlane } from '../../src/shared/types';
import type { EarlyAgentHandle } from '../../src/main/transition-engine/early-agent';
import { IPC } from '../../src/shared/ipc-channels';

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));
// The agent has sat at its input box through the script, so its turn is over.
vi.mock('../../src/main/transition-engine/turn-completion', () => ({
  waitForTurnCompletion: vi.fn(async () => 'completed'),
}));

// Held messages are claimed from the project database. The claim is faked so a
// test can hand spawnAgent one and watch how it is settled; the rest of the
// module (composeOpeningMessage, commitWhenSessionRuns) stays real.
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/held-messages/held-messages')>();
  return { ...actual, claimHeldMessages: vi.fn(() => null) };
});

import { spawnAgent } from '../../src/main/ipc/helpers/agent-spawn';
import { claimHeldMessages } from '../../src/main/held-messages/held-messages';
import type { HeldClaim } from '../../src/main/held-messages/held-messages';

const TASK_ID = 'task-aaa00001';
const PROJECT_ID = 'project-aaa00001';
const OPENING_PROMPT_LABEL = 'its first prompt';
const LANE_ID = 'lane-executing';
const ADOPTED_SESSION_ID = 'early-session';
const TEMPLATE_PROMPT = '<task>\n<title>My Task</title>\n<description>Do the thing</description>\n</task>';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID, display_id: 1, title: 'My Task', description: 'Do the thing', swimlane_id: LANE_ID, position: 0,
    agent: null, agent_override: null, model_override: null, effort_override: null, session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/1', branch_name: 'my-task', pr_number: null, pr_url: null,
    base_branch: null, use_worktree: null, labels: [], priority: 0, attachment_count: 0, archived_at: null,
    created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeLane(): Swimlane {
  return {
    id: LANE_ID, name: 'Executing', role: null, position: 0, color: '#888', icon: null, is_archived: false, is_ghost: false,
    permission_mode: null, auto_spawn: true, auto_command: null, plan_exit_target_id: null, agent_override: null,
    model_override: null, effort_override: null, handoff_context: false, session_target: 'main',
    session_spawn_strategy: 'create_or_resume', created_at: '2025-01-01T00:00:00.000Z',
  };
}

function makeHandle(): EarlyAgentHandle & { discard: ReturnType<typeof vi.fn> } {
  return {
    sessionId: ADOPTED_SESSION_ID, taskId: TASK_ID, agentName: 'claude', agentSessionId: 'agent-session',
    command: 'claude', cwd: '/mock/project/.kangentic/worktrees/1', launchKey: 'key',
    isSettled: () => false,
    markAdopted: () => true,
    discard: vi.fn(async () => {}),
  };
}

/**
 * `columnMessage` is the column's send_message row, which the runner hands to
 * `startAgent` and then to `deliverToAgent`. `typedOpening` is what the engine
 * reports it could not put on the adopted agent's command line.
 */
function makeDeps(args: { columnMessage: string | null; typedOpening: string | null }) {
  const events: string[] = [];
  let sessionStarted = false;
  const tasks = {
    getById: vi.fn(() => makeTask({ session_id: sessionStarted ? ADOPTED_SESSION_ID : null })),
    // The durable half of reportAutoCommandOutcome.
    recordAutoCommandOutcome: vi.fn(),
  };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => null),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => undefined),
  };
  const engine = {
    executeTransition: vi.fn(async (
      _task: Task,
      _lane: Swimlane,
      _trigger: string,
      runOptions: {
        startAgent: (pendingPrompt?: string) => Promise<void>;
        deliverToAgent: (message: string, mode: 'immediate' | 'deferred') => Promise<void>;
      },
    ) => {
      if (!args.columnMessage) return { outcomes: [], failures: [], startedAgent: false };
      await runOptions.startAgent(args.columnMessage);
      await runOptions.deliverToAgent(args.columnMessage, 'immediate');
      return { outcomes: [], failures: [], startedAgent: true };
    }),
    resumeSuspendedSession: vi.fn(async () => {
      sessionStarted = true;
      return { startOver: null, recapOnly: false, unsentPrompt: null, typedOpening: args.typedOpening };
    }),
  };
  const scheduleKeystrokes = vi.fn((_taskId: string, _sessionId: string, commands: Array<{ text: string }>, options: { onOutcome?: (report: { outcome: string }) => void }) => {
    events.push(`keystrokes:${commands.map((command) => command.text).join('|')}`);
    options.onOutcome?.({ outcome: 'unconfirmed' });
  });
  const submitContent = vi.fn(async (_sessionId: string, text: string) => { events.push(`paste:${text}`); });
  const sendToRenderer = vi.fn();
  const context = {
    // The interrupting half of reportAutoCommandOutcome goes out through here.
    mainWindow: { isDestroyed: () => false, webContents: { send: sendToRenderer } },
    projectRepo: { getById: vi.fn(() => null) },
    terminalSubmitScheduler: { scheduleKeystrokes, hasPending: vi.fn(() => false) },
    terminalSubmit: { submitContent },
    sessionManager: {
      awaitAgentReady: vi.fn(async () => true),
      getSession: vi.fn(() => ({ id: ADOPTED_SESSION_ID, status: 'running' })),
    },
    configManager: {
      getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits' }, git: { defaultBaseBranch: 'main' } })),
    },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
  };
  /** The notices the user was interrupted with for a column message or opening prompt that did not run. */
  const autoCommandNotices = (): unknown[] => sendToRenderer.mock.calls
    .filter(([channel]) => channel === IPC.TASK_AUTO_COMMAND_RESULT)
    .map(([, notice]) => notice);
  return { tasks, sessionRepo, engine, context, events, scheduleKeystrokes, submitContent, autoCommandNotices };
}

async function runSpawn(
  deps: ReturnType<typeof makeDeps>,
  earlyAgent: EarlyAgentHandle,
  skipPromptTemplate: boolean,
  extraOptions: Partial<Parameters<typeof spawnAgent>[0]> = {},
): Promise<void> {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask(),
    fromSwimlaneId: 'lane-todo',
    toLane: makeLane(),
    skipPromptTemplate,
    earlyAgent,
    ...extraOptions,
  });
}

/** A claim for held messages, with every settling call spied. Not settled until a test says so. */
function makeHeldClaim(text: string) {
  return {
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    ids: ['held-1', 'held-2'],
    text,
    commit: vi.fn<(sessionId: string) => void>(),
    fail: vi.fn<(reason: string) => void>(),
    release: vi.fn<(options?: { flush?: boolean }) => void>(),
    isSettled: vi.fn(() => false),
  } satisfies HeldClaim;
}

/** The positional arguments spawnAgent gave the engine's resumeSuspendedSession. */
function engineCallArguments(deps: ReturnType<typeof makeDeps>): unknown[] {
  const call = deps.engine.resumeSuspendedSession.mock.calls[0] as unknown[] | undefined;
  if (!call) throw new Error('resumeSuspendedSession was never called');
  return call;
}

describe('spawnAgent with an adopted early agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the early agent to the engine with the spawn overrides', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: TEMPLATE_PROMPT });
    const handle = makeHandle();

    await runSpawn(deps, handle, false);

    const spawnOverrides = deps.engine.resumeSuspendedSession.mock.calls[0]?.[7] as { earlyAgent?: EarlyAgentHandle };
    expect(spawnOverrides.earlyAgent).toBe(handle);
  });

  it('pastes the task template first, then schedules the column message', async () => {
    const deps = makeDeps({ columnMessage: 'Run the tests before you finish.', typedOpening: TEMPLATE_PROMPT });

    await runSpawn(deps, makeHandle(), false);

    expect(deps.submitContent).toHaveBeenCalledWith(ADOPTED_SESSION_ID, TEMPLATE_PROMPT, expect.anything());
    expect(deps.events).toEqual([
      `paste:${TEMPLATE_PROMPT}`,
      'keystrokes:Run the tests before you finish.',
    ]);
  });

  it('types a slash-command opening as keystrokes, once, so it runs', async () => {
    const deps = makeDeps({ columnMessage: '/code-review', typedOpening: '/code-review' });

    await runSpawn(deps, makeHandle(), true);

    expect(deps.submitContent).not.toHaveBeenCalled();
    // The row's own delivery is skipped: the opening already carried it.
    expect(deps.events).toEqual(['keystrokes:/code-review']);
  });

  it('discards the early agent when the spawn did not adopt it', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: null });
    const handle = makeHandle();

    await runSpawn(deps, handle, false);

    expect(handle.discard).toHaveBeenCalledTimes(1);
    expect(deps.submitContent).not.toHaveBeenCalled();
  });
});

describe('spawnAgent when the typed opening does not land', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimHeldMessages).mockReturnValue(null);
  });

  it('tells the user the first prompt was not sent when typing it fails', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: TEMPLATE_PROMPT });
    deps.submitContent.mockRejectedValue(new Error('pty write failed'));

    await runSpawn(deps, makeHandle(), false);

    expect(deps.submitContent).toHaveBeenCalledTimes(1);
    // Named as a column command would be, so the notice reads "did not run its first prompt".
    expect(deps.autoCommandNotices()).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        taskTitle: 'My Task',
        state: 'failed',
        command: OPENING_PROMPT_LABEL,
        reason: expect.stringContaining('pty write failed'),
      }),
    ]);
    expect(deps.tasks.recordAutoCommandOutcome).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ state: 'failed', command: OPENING_PROMPT_LABEL }),
    );
  });

  it('tells the user the first prompt was not sent when the adopted agent exits first', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: TEMPLATE_PROMPT });
    deps.context.sessionManager.awaitAgentReady.mockResolvedValue(false);
    deps.context.sessionManager.getSession.mockReturnValue({ id: ADOPTED_SESSION_ID, status: 'exited' });

    await runSpawn(deps, makeHandle(), false);

    // Nothing was typed at a dead agent, and the user is told why.
    expect(deps.submitContent).not.toHaveBeenCalled();
    expect(deps.autoCommandNotices()).toEqual([
      expect.objectContaining({
        taskId: TASK_ID,
        state: 'failed',
        command: OPENING_PROMPT_LABEL,
        reason: 'The agent exited before its first prompt was sent.',
      }),
    ]);
  });

  it('announces nothing when the task moved on while the opening was being typed', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: TEMPLATE_PROMPT });
    const moveOn = new AbortController();
    // The user's own move supersedes the spawn mid-paste.
    deps.submitContent.mockImplementation(async () => {
      moveOn.abort();
      throw new Error('The paste was interrupted');
    });

    await runSpawn(deps, makeHandle(), false, { signal: moveOn.signal });

    expect(deps.submitContent).toHaveBeenCalledTimes(1);
    expect(deps.autoCommandNotices()).toEqual([]);
    // Recorded as a cancel, never as a failure.
    expect(deps.tasks.recordAutoCommandOutcome).toHaveBeenCalledWith(
      TASK_ID,
      expect.objectContaining({ state: 'cancelled', command: OPENING_PROMPT_LABEL }),
    );
  });
});

describe('spawnAgent with held messages folded into the typed opening', () => {
  const HELD_TEXT = '1. Check the migration.\n\n2. Rebase before you push.';
  // Held messages are the whole opening on a promptless spawn that has its slot open.
  const SKIP_PROMPT_TEMPLATE = true;
  const HELD_SPAWN_OPTIONS = { projectId: PROJECT_ID, settingsSourceLane: makeLane() };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimHeldMessages).mockReturnValue(null);
  });

  it('puts the held messages back on hold, flushing, when the opening did not land', async () => {
    const claim = makeHeldClaim(HELD_TEXT);
    vi.mocked(claimHeldMessages).mockReturnValue(claim);
    const deps = makeDeps({ columnMessage: null, typedOpening: HELD_TEXT });
    deps.submitContent.mockRejectedValue(new Error('pty write failed'));

    await runSpawn(deps, makeHandle(), SKIP_PROMPT_TEMPLATE, HELD_SPAWN_OPTIONS);

    expect(deps.submitContent).toHaveBeenCalledWith(ADOPTED_SESSION_ID, HELD_TEXT, expect.anything());
    expect(claim.release).toHaveBeenCalledWith({ flush: true });
    // Committing would mark messages the agent never saw as delivered.
    expect(claim.commit).not.toHaveBeenCalled();
    expect(claim.fail).not.toHaveBeenCalled();
  });

  it('commits the held messages to the adopted session once the opening landed', async () => {
    const claim = makeHeldClaim(HELD_TEXT);
    vi.mocked(claimHeldMessages).mockReturnValue(claim);
    const deps = makeDeps({ columnMessage: null, typedOpening: HELD_TEXT });

    await runSpawn(deps, makeHandle(), SKIP_PROMPT_TEMPLATE, HELD_SPAWN_OPTIONS);

    // The control for the test above: same spawn, the opening went in.
    expect(deps.submitContent).toHaveBeenCalledWith(ADOPTED_SESSION_ID, HELD_TEXT, expect.anything());
    expect(claim.commit).toHaveBeenCalledWith(ADOPTED_SESSION_ID);
    expect(claim.release).not.toHaveBeenCalled();
  });
});

describe('spawnAgent with the setup script still running', () => {
  const SETUP_NOTE = 'NOTE';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hands the engine the setup note when the opening is plain text in the prompt slot', async () => {
    const message = 'Run the tests before you finish.';
    const deps = makeDeps({ columnMessage: message, typedOpening: message });

    await runSpawn(deps, makeHandle(), true, { setupStillRunning: SETUP_NOTE });

    const callArguments = engineCallArguments(deps);
    expect(callArguments[3]).toBe(message);
    expect(callArguments[6]).toBe(SETUP_NOTE);
  });

  it('hands the engine the setup note when the task template is the prompt', async () => {
    const deps = makeDeps({ columnMessage: null, typedOpening: TEMPLATE_PROMPT });

    await runSpawn(deps, makeHandle(), false, { setupStillRunning: SETUP_NOTE });

    const callArguments = engineCallArguments(deps);
    // No prompt slot is open, so there is no opening prompt of the spawn's own.
    expect(callArguments[3]).toBeUndefined();
    expect(callArguments[6]).toBe(SETUP_NOTE);
  });

  it('keeps the setup note off a slash command, which only runs as the prompt\'s first word', async () => {
    const deps = makeDeps({ columnMessage: '/code-review', typedOpening: '/code-review' });

    await runSpawn(deps, makeHandle(), true, { setupStillRunning: SETUP_NOTE });

    const callArguments = engineCallArguments(deps);
    expect(callArguments[3]).toBe('/code-review');
    expect(callArguments[6]).toBeUndefined();
  });
});

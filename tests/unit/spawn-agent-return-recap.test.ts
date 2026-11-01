/**
 * The recap a task's main conversation gets when it resumes after an isolated
 * column's session (task #952), through the real spawnAgent
 * (src/main/ipc/helpers/agent-spawn.ts) and the real recap-turn marks.
 *
 * Overnight, Code Review ran in its own conversation, committed its fixes and
 * ended Ready; Testing resumed the main conversation, which never saw any of
 * it. The contract:
 *   - A plain-text opening message gets the recap ahead of it, in one turn.
 *   - A slash command cannot (text ahead of one stops it running): the recap is
 *     the resume's whole prompt, its turn is marked a context turn, and the
 *     command goes only once that turn has ended.
 *   - A session that leaves before the recap's turn ends sends nothing.
 *   - A move that carries its own message leaves the reply out.
 *   - No isolated session since the main conversation left: no recap.
 *   - A move that supersedes the delivery while the recap turn is pending drops
 *     it at once, and frees the held messages behind it.
 *   - A resume that could not carry its prompt on the command line (an unsent
 *     prompt) types the recap itself, ahead of a plain message and never ahead
 *     of a slash command.
 *   - No recap on a handoff, a force-fresh column, or an isolated column.
 *
 * Harness mirrors spawn-agent-continuation-prompt.test.ts: the resumePrompt is
 * the 4th positional arg of resumeSuspendedSession.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Task, Swimlane, SessionRecord } from '../../src/shared/types';
import type { SpawnOutcome } from '../../src/main/transition-engine/transition-engine';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';

const hoisted = vi.hoisted(() => ({
  readCommitsSince: vi.fn(),
  readSessionFinalReply: vi.fn(),
  deliverAgentMessageInBackground: vi.fn(),
  pasteAgentMessageInBackground: vi.fn(),
  reportAutoCommandOutcome: vi.fn(),
}));

vi.mock('../../src/main/transition-engine/agent-resolver', () => ({
  resolveTargetAgent: vi.fn(() => ({ agent: 'claude', isHandoff: false })),
}));
vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { get: vi.fn(() => ({ sessionType: 'claude_agent' })) },
}));
vi.mock('../../src/main/git/worktree-head', () => ({
  readCommitsSince: hoisted.readCommitsSince,
  readWorktreeHead: vi.fn(async () => ({ branch: null, sha: null })),
}));
vi.mock('../../src/main/automations/turn-end/final-reply-reader', () => ({
  readSessionFinalReply: hoisted.readSessionFinalReply,
}));
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/automations/turn-end/agent-message-delivery')>()),
  deliverAgentMessageInBackground: hoisted.deliverAgentMessageInBackground,
  pasteAgentMessageInBackground: hoisted.pasteAgentMessageInBackground,
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({
  reportAutoCommandOutcome: hoisted.reportAutoCommandOutcome,
}));
vi.mock('../../src/main/held-messages/held-messages', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/held-messages/held-messages')>()),
  claimHeldMessages: vi.fn(() => null),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    swimlanes: { getById: (id: string) => (id === REVIEW_LANE_ID ? { id, name: 'Code Review' } : null) },
  })),
}));

const { spawnAgent } = await import('../../src/main/ipc/helpers/agent-spawn');
const { forgetRecapSession, isRecapTurn, recapKindOf, resetRecapSessionsForTests } = await import('../../src/main/automations/turn-end/recap-turns');
const { supersedeMessageDeliveries } = await import('../../src/main/automations/turn-end/turn-end-passes');
const { resolveTargetAgent } = await import('../../src/main/transition-engine/agent-resolver');

const TASK_ID = 'task-aaa00001';
const TESTING_LANE_ID = 'lane-testing';
const REVIEW_LANE_ID = 'lane-review';
const PROJECT_ID = 'project-1';
const RESUMED_SESSION_ID = 'pty-resumed-1';
const MAIN_LEFT_AT = '2026-10-31T02:00:00.000Z';

const REVIEW_RUN = {
  id: 'rec-review',
  isolated_swimlane_id: REVIEW_LANE_ID,
  agent_session_id: 'agent-review',
  start_head_sha: 'aaaaaaa1111111',
  started_at: '2026-10-31T02:01:00.000Z',
};

const columnMessages = new Map<string, string>();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    display_id: 7,
    title: 'Add the export button',
    description: '',
    swimlane_id: TESTING_LANE_ID,
    position: 0,
    agent: 'claude',
    agent_override: null,
    model_override: null,
    effort_override: null,
    session_id: null,
    worktree_path: '/mock/project/.kangentic/worktrees/export',
    branch_name: 'export',
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
}

function makeSwimlane(id: string, autoCommand: string | null, overrides: Partial<Swimlane> = {}): Swimlane {
  if (autoCommand) columnMessages.set(id, autoCommand);
  return {
    id,
    name: 'Testing',
    role: null,
    position: 3,
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

const MAIN_RECORD = {
  id: 'rec-main',
  task_id: TASK_ID,
  session_type: 'claude_agent',
  isolated_swimlane_id: null,
  agent_session_id: 'agent-main',
  cwd: '/mock/project/.kangentic/worktrees/export',
  status: 'suspended',
  started_at: '2026-10-31T00:00:00.000Z',
  suspended_at: MAIN_LEFT_AT,
  exited_at: null,
} as unknown as SessionRecord;

/** What the real engine hands the enter group: the two callbacks a column's rows drive. */
interface EnterGroupCallbacks {
  startAgent: (pendingPrompt?: string) => Promise<unknown>;
  deliverToAgent: (message: string, mode: 'immediate' | 'deferred') => Promise<void>;
  suppressAgentMessages?: boolean;
}

/** The prompt a resume reports it kept off its command line (`SpawnOutcome.unsentPrompt`). */
const UNSENT_PROMPT = 'the prompt the resume kept off its command line';

interface DepsBehavior {
  /**
   * What the mocked resume reports. Unset, the resume returns nothing, as it
   * does when it carried the prompt on its command line.
   */
  outcome?: Partial<SpawnOutcome>;
  /**
   * The column's rows, driven in place of the default single Send message row
   * (start the agent with the column's message, then deliver it).
   */
  rows?: (callbacks: EnterGroupCallbacks) => Promise<void>;
}

function makeDeps(isolatedRuns: Array<typeof REVIEW_RUN>, behavior: DepsBehavior = {}) {
  let sessionStarted = false;
  const tasks = { getById: vi.fn(() => makeTask({ session_id: sessionStarted ? RESUMED_SESSION_ID : null })) };
  const sessionRepo = {
    getLatestForTask: vi.fn(() => MAIN_RECORD),
    getLatestForTaskByTypeAndIsolation: vi.fn(() => MAIN_RECORD),
    listIsolatedSince: vi.fn(() => isolatedRuns),
  };
  const engine = {
    executeTransition: vi.fn(async (_task: Task, lane: Swimlane, _trigger: string, runOptions: EnterGroupCallbacks) => {
      if (behavior.rows) {
        await behavior.rows(runOptions);
        return { outcomes: [], failures: [], startedAgent: true };
      }
      const message = columnMessages.get(lane.id);
      if (!message || runOptions.suppressAgentMessages) return { outcomes: [], failures: [], startedAgent: false };
      await runOptions.startAgent(message);
      await runOptions.deliverToAgent(message, 'immediate');
      return { outcomes: [], failures: [], startedAgent: true };
    }),
    resumeSuspendedSession: vi.fn(async (): Promise<SpawnOutcome | undefined> => {
      sessionStarted = true;
      return behavior.outcome ? { startOver: null, recapOnly: false, unsentPrompt: null, ...behavior.outcome } : undefined;
    }),
  };
  const context = {
    terminalSubmitScheduler: { scheduleKeystrokes: vi.fn() },
    configManager: { getEffectiveConfig: vi.fn(() => ({ agent: { permissionMode: 'acceptEdits' }, git: { defaultBaseBranch: 'main' } })) },
    boardConfigManager: { getDefaultBaseBranch: vi.fn(() => undefined) },
    projectRepo: { getById: vi.fn(() => ({ id: PROJECT_ID, name: 'Project', path: '/mock/project' })) },
  };
  return { tasks, sessionRepo, engine, context };
}

async function runSpawn(
  toLane: Swimlane,
  deps: ReturnType<typeof makeDeps>,
  extra: { moveCarriesMessage?: boolean; suppressAutoCommand?: boolean; continuationPrompt?: string } = {},
) {
  await spawnAgent({
    context: deps.context as never,
    engine: deps.engine as never,
    tasks: deps.tasks as never,
    sessionRepo: deps.sessionRepo as never,
    task: makeTask(),
    fromSwimlaneId: REVIEW_LANE_ID,
    toLane,
    skipPromptTemplate: true,
    projectId: PROJECT_ID,
    projectPath: '/mock/project',
    ...extra,
  });
}

function resumePromptArg(deps: ReturnType<typeof makeDeps>): string | undefined {
  return deps.engine.resumeSuspendedSession.mock.calls[0]?.[3] as string | undefined;
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

/** What one `deliverAgentMessageInBackground` call was asked to type. */
interface DeliveredMessage {
  taskId: string;
  sessionId: string;
  message: string;
  mode: string;
  freshlySpawned: boolean;
  onOutcome: (report: InjectionReport) => void;
}

function deliveries(): DeliveredMessage[] {
  return hoisted.deliverAgentMessageInBackground.mock.calls.map((call) => call[1] as DeliveredMessage);
}

function reportOf(outcome: InjectionReport['outcome']): InjectionReport {
  return {
    taskId: TASK_ID,
    sessionId: RESUMED_SESSION_ID,
    commands: [],
    outcome,
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
  };
}

const RECAP_HEADLINE = 'While this conversation was away, the task ran in Code Review';

describe('spawnAgent: the main conversation\'s return recap (task #952)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    columnMessages.clear();
    resetRecapSessionsForTests();
    hoisted.readCommitsSince.mockResolvedValue({
      head: 'ccccccc',
      commits: [{ sha: 'bbbbbbb', subject: 'fix(review): drop the unused export' }, { sha: 'ccccccc', subject: 'chore(review): record the pass' }],
      omitted: 0,
    });
    hoisted.readSessionFinalReply.mockResolvedValue({ text: '1. Fixed the export.\nVerdict: Ready', uuid: 'u1', ts: 1 });
  });

  // A test that leaves a delivery waiting on its recap turn would have its
  // drop fire after the next test's mocks were cleared. Settle everything here.
  afterEach(async () => {
    supersedeMessageDeliveries(TASK_ID);
    resetRecapSessionsForTests();
    await flushMicrotasks();
  });

  it('puts the recap ahead of a plain-text opening message, in one turn, with no mark', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.'), deps);

    const prompt = resumePromptArg(deps) ?? '';
    expect(prompt.endsWith('\n\nRun the gate and open the PR.')).toBe(true);
    expect(prompt).toContain('the task ran in Code Review in a conversation of its own');
    expect(prompt).toContain('- bbbbbbb fix(review): drop the unused export');
    expect(prompt).toContain('The branch is now at ccccccc.');
    expect(prompt).toContain('Code Review ended on this message:\n1. Fixed the export.\nVerdict: Ready');
    // The commits since the FIRST isolated session's start, from the main conversation's departure.
    expect(deps.sessionRepo.listIsolatedSince).toHaveBeenCalledWith(TASK_ID, MAIN_LEFT_AT);
    expect(hoisted.readCommitsSince).toHaveBeenCalledWith('/mock/project/.kangentic/worktrees/export', REVIEW_RUN.start_head_sha, 20);
    expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    // The message rode the resume; nothing is typed after it.
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  it('makes the recap the whole prompt ahead of a slash command, and sends the command once the recap turn ends', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

    const prompt = resumePromptArg(deps) ?? '';
    // Nothing ahead of the command, and the command not in the recap's turn.
    expect(prompt).not.toContain('/pull-request');
    expect(prompt).toContain('Reply with one line saying you have read this.');
    expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
    expect(isRecapTurn(RESUMED_SESSION_ID, null)).toBe(true);
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();

    // The turn-end runner forgets the mark at the recap's turn end.
    forgetRecapSession(RESUMED_SESSION_ID, true);
    await flushMicrotasks();

    expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
    expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledWith(deps.context, expect.objectContaining({
      sessionId: RESUMED_SESSION_ID,
      message: '/pull-request',
      // The session is idle after the recap: no first edge to wait for.
      freshlySpawned: false,
    }));
  });

  it('sends nothing, and records the message as not sent, when the session leaves before the recap turn ends', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

    forgetRecapSession(RESUMED_SESSION_ID, false);
    await flushMicrotasks();

    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
    expect(hoisted.reportAutoCommandOutcome).toHaveBeenCalledWith(
      deps.context, deps.tasks, expect.anything(),
      expect.objectContaining({ outcome: 'cancelled', commands: ['/pull-request'], textReachedAgent: false }),
      PROJECT_ID,
    );
  });

  it('leaves the reply out when the move carries a message of its own', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Address the findings.'), deps, { moveCarriesMessage: true });

    const prompt = resumePromptArg(deps) ?? '';
    expect(hoisted.readSessionFinalReply).not.toHaveBeenCalled();
    expect(prompt).not.toContain('ended on this message');
    expect(prompt).toContain('- bbbbbbb fix(review): drop the unused export');
  });

  it('opens with the lead alone when no isolated session ran since the main conversation left', async () => {
    const deps = makeDeps([]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

    expect(resumePromptArg(deps)).toBe('/pull-request');
    expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    expect(hoisted.readCommitsSince).not.toHaveBeenCalled();
  });

  it('opens with no recap when the isolated session left nothing to say', async () => {
    hoisted.readCommitsSince.mockResolvedValue({ head: 'aaaaaaa', commits: [], omitted: 0 });
    hoisted.readSessionFinalReply.mockResolvedValue(null);
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

    expect(resumePromptArg(deps)).toBe('/pull-request');
  });

  it('sends no recap on a recovery move out of Done, which sends nothing', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps, { suppressAutoCommand: true });

    expect(deps.sessionRepo.listIsolatedSince).not.toHaveBeenCalled();
    expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
  });

  it('asks only for a one-line answer, and marks the turn, when there is no opening message', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps);

    const prompt = resumePromptArg(deps) ?? '';
    expect(prompt).toContain('Reply with one line saying you have read this, then wait for the next instruction.');
    expect(prompt).not.toMatch(/carry on/i);
    // A context turn: no rows or step judge the acknowledgement.
    expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
    expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
  });

  // A send-back: Code Review moves the task to Executing, whose own message is
  // off, with its findings as the move's message. The agent must not start
  // working before they arrive, after this turn ends.
  it('on a send-back with the findings in the move, acknowledges and waits, leaving the reply to the move', async () => {
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps, { moveCarriesMessage: true });

    const prompt = resumePromptArg(deps) ?? '';
    expect(prompt).toContain('- bbbbbbb fix(review): drop the unused export');
    expect(prompt).not.toContain('ended on this message');
    expect(prompt).toContain('then wait for the next instruction');
    expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
  });

  it('goes ahead of messages held for the task when there is no opening message, in one turn', async () => {
    const heldMessages = await import('../../src/main/held-messages/held-messages');
    vi.mocked(heldMessages.claimHeldMessages).mockReturnValueOnce({
      projectId: PROJECT_ID,
      taskId: TASK_ID,
      ids: ['held-1'],
      text: 'Also check the export on Windows.',
      commit: vi.fn(),
      fail: vi.fn(),
      release: vi.fn(),
      isSettled: () => false,
    });
    const deps = makeDeps([REVIEW_RUN]);
    await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps);

    const prompt = resumePromptArg(deps) ?? '';
    expect(prompt.endsWith('\n\nAlso check the export on Windows.')).toBe(true);
    expect(prompt).toContain('the task ran in Code Review');
    expect(prompt).not.toContain('Reply with one line');
    expect(prompt).not.toContain('undefined');
    expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
  });

  describe('a move that supersedes the delivery while the recap turn is pending', () => {
    it('reports the message cancelled at once, frees the held messages behind it, and never sends either', async () => {
      const release = vi.fn();
      const heldMessages = await import('../../src/main/held-messages/held-messages');
      vi.mocked(heldMessages.claimHeldMessages).mockReturnValueOnce({
        projectId: PROJECT_ID,
        taskId: TASK_ID,
        ids: ['held-1'],
        text: 'Also check the export on Windows.',
        commit: vi.fn(),
        fail: vi.fn(),
        release,
        isSettled: () => false,
      });
      const deps = makeDeps([REVIEW_RUN]);
      await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

      // Waiting on the recap's turn: nothing sent, reported or released yet.
      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
      expect(hoisted.reportAutoCommandOutcome).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();

      // The task moves on. The abort is synchronous, so nothing is flushed
      // before these assertions: the drop does not wait for the recap's turn.
      supersedeMessageDeliveries(TASK_ID);

      expect(hoisted.reportAutoCommandOutcome).toHaveBeenCalledTimes(1);
      expect(hoisted.reportAutoCommandOutcome).toHaveBeenCalledWith(
        deps.context, deps.tasks, expect.anything(),
        expect.objectContaining({ sessionId: RESUMED_SESSION_ID, outcome: 'cancelled', commands: ['/pull-request'], textReachedAgent: false }),
        PROJECT_ID,
      );
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith({ flush: true });
      // The recap's turn has not ended: the drop was the supersede's doing.
      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');

      // The turn ends later. The message the move cancelled does not come back.
      forgetRecapSession(RESUMED_SESSION_ID, true);
      await flushMicrotasks();

      expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
      expect(hoisted.pasteAgentMessageInBackground).not.toHaveBeenCalled();
      expect(hoisted.reportAutoCommandOutcome).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  describe('a plan continuation that is a slash command', () => {
    it('is delivered once the recap turn ends when the destination takes no prompt slot', async () => {
      const deps = makeDeps([REVIEW_RUN]);
      // No column message: the destination's prompt slot is free for the continuation.
      await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps, { continuationPrompt: '/continue-plan' });

      const prompt = resumePromptArg(deps) ?? '';
      // The recap is the whole prompt, and the command is not part of its turn.
      expect(prompt.startsWith(RECAP_HEADLINE)).toBe(true);
      expect(prompt).toContain('The next instruction follows once you do.');
      expect(prompt).not.toContain('/continue-plan');
      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
      expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();

      forgetRecapSession(RESUMED_SESSION_ID, true);
      await flushMicrotasks();

      expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledTimes(1);
      expect(hoisted.deliverAgentMessageInBackground).toHaveBeenCalledWith(deps.context, expect.objectContaining({
        sessionId: RESUMED_SESSION_ID,
        message: '/continue-plan',
        mode: 'immediate',
        freshlySpawned: false,
      }));
    });

    it('is not sent when the session leaves before the recap turn ends', async () => {
      const deps = makeDeps([REVIEW_RUN]);
      await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps, { continuationPrompt: '/continue-plan' });

      forgetRecapSession(RESUMED_SESSION_ID, false);
      await flushMicrotasks();

      expect(hoisted.deliverAgentMessageInBackground).not.toHaveBeenCalled();
    });
  });

  describe('when the resume could not carry its prompt on the command line (an unsent prompt)', () => {
    it('types the recap on its own first ahead of a slash command, which waits for the recap turn', async () => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

      expect(deliveries()).toHaveLength(1);
      const [recapDelivery] = deliveries();
      expect(recapDelivery).toMatchObject({ taskId: TASK_ID, sessionId: RESUMED_SESSION_ID, mode: 'immediate', freshlySpawned: true });
      // The recap, as the resume's whole prompt would have been, and not the command.
      expect(recapDelivery.message).toBe(resumePromptArg(deps));
      expect(recapDelivery.message.startsWith(RECAP_HEADLINE)).toBe(true);
      expect(recapDelivery.message).toContain('The next instruction follows once you do.');
      expect(recapDelivery.message).not.toContain('/pull-request');
      // The command waits for the recap's turn.
      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
    });

    it('stops waiting on the recap, and sends the command, when the typed recap fails to deliver', async () => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);
      expect(deliveries()).toHaveLength(1);

      deliveries()[0].onOutcome(reportOf('failed'));
      await flushMicrotasks();

      // No recap turn will come, so the mark is gone and nothing waits for it.
      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
      expect(deliveries()).toHaveLength(2);
      expect(deliveries()[1]).toMatchObject({ sessionId: RESUMED_SESSION_ID, message: '/pull-request', freshlySpawned: false });
    });

    it.each(['confirmed', 'unconfirmed'] as const)('keeps the command waiting on the recap turn when the typed recap is %s', async (outcome) => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

      deliveries()[0].onOutcome(reportOf(outcome));
      await flushMicrotasks();

      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
      expect(deliveries()).toHaveLength(1);

      forgetRecapSession(RESUMED_SESSION_ID, true);
      await flushMicrotasks();

      expect(deliveries()).toHaveLength(2);
      expect(deliveries()[1].message).toBe('/pull-request');
    });

    it('prefixes the recap ahead of a plain-text message, in one delivery, with no mark', async () => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.'), deps);

      expect(deliveries()).toHaveLength(1);
      const [delivery] = deliveries();
      expect(delivery.message.startsWith(RECAP_HEADLINE)).toBe(true);
      expect(delivery.message.endsWith('\n\nRun the gate and open the PR.')).toBe(true);
      expect(delivery.message.split(RECAP_HEADLINE)).toHaveLength(2);
      expect(delivery.freshlySpawned).toBe(true);
      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    });

    // A recap that is the whole opening (nothing led or was held) is typed on
    // its own at once, so the session's recap mark names the recap's turn. Held
    // for the next message instead, the mark named that message's turn, whose
    // rows and workflow step then did not run.
    it('types a whole-opening recap on its own at once, then the slash command alone, with the mark on the recap\'s turn', async () => {
      const deps = makeDeps([REVIEW_RUN], {
        outcome: { unsentPrompt: UNSENT_PROMPT },
        rows: async (callbacks) => {
          // A first Send message row whose message is empty starts the agent
          // with no prompt (the runner calls startAgent with undefined) and
          // sends nothing; a later Send message row types the command.
          await callbacks.startAgent();
          await callbacks.deliverToAgent('/pull-request', 'immediate');
        },
      });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, null), deps);

      expect(deliveries()).toHaveLength(2);
      expect(deliveries()[0].message.startsWith(RECAP_HEADLINE)).toBe(true);
      expect(deliveries()[0].message).toContain('then wait for the next instruction');
      expect(deliveries()[0].message).not.toContain('/pull-request');
      expect(deliveries()[0].freshlySpawned).toBe(true);
      // Nothing ahead of the command, which would stop it running.
      expect(deliveries()[1].message).toBe('/pull-request');
      expect(recapKindOf(RESUMED_SESSION_ID)).toBe('return');
    });

    it('sends no recap and waits on nothing when the resume started the conversation over, ahead of a slash command', async () => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { startOver: 'never-started', unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, '/pull-request'), deps);

      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
      // The command goes at once, as it would have without a recap.
      expect(deliveries()).toHaveLength(1);
      expect(deliveries()[0]).toMatchObject({ sessionId: RESUMED_SESSION_ID, message: '/pull-request', freshlySpawned: true });
    });

    it('sends no recap when the resume started the conversation over, ahead of a plain-text message', async () => {
      const deps = makeDeps([REVIEW_RUN], { outcome: { startOver: 'expired', unsentPrompt: UNSENT_PROMPT } });
      await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.'), deps);

      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
      expect(deliveries()).toHaveLength(1);
      expect(deliveries()[0].message).toBe('Run the gate and open the PR.');
    });
  });

  describe('no recap', () => {
    it('on a handoff to another agent', async () => {
      // handoff_context is off on the lane, so the spawn takes the normal path
      // with isHandoff set. The other agent's history is its own handoff's job.
      vi.mocked(resolveTargetAgent).mockReturnValueOnce({ agent: 'claude', isHandoff: true } as ReturnType<typeof resolveTargetAgent>);
      const deps = makeDeps([REVIEW_RUN]);
      await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.'), deps);

      expect(resumePromptArg(deps)).toBe('Run the gate and open the PR.');
      expect(deps.sessionRepo.listIsolatedSince).not.toHaveBeenCalled();
      expect(hoisted.readCommitsSince).not.toHaveBeenCalled();
      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    });

    it('in a column that always starts a fresh conversation', async () => {
      const deps = makeDeps([REVIEW_RUN]);
      await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.', { session_spawn_strategy: 'always_spawn_new' }), deps);

      expect(resumePromptArg(deps)).toBe('Run the gate and open the PR.');
      expect(deps.sessionRepo.listIsolatedSince).not.toHaveBeenCalled();
      expect(hoisted.readCommitsSince).not.toHaveBeenCalled();
      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    });

    it('in an isolated column, which resumes its own conversation, not the main one', async () => {
      const deps = makeDeps([REVIEW_RUN]);
      // create_or_resume, so the column's own isolation is the only thing that stops the recap.
      await runSpawn(makeSwimlane(TESTING_LANE_ID, 'Run the gate and open the PR.', {
        session_target: 'isolated',
        session_spawn_strategy: 'create_or_resume',
      }), deps);

      expect(resumePromptArg(deps)).toBe('Run the gate and open the PR.');
      expect(deps.sessionRepo.listIsolatedSince).not.toHaveBeenCalled();
      expect(hoisted.readCommitsSince).not.toHaveBeenCalled();
      expect(recapKindOf(RESUMED_SESSION_ID)).toBeNull();
    });
  });
});

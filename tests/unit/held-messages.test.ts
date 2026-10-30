/**
 * Held messages (src/main/held-messages/held-messages.ts): a message for a task
 * whose agent is not running waits in the sent-messages log for the task's next
 * agent. Runs the REAL module over a REAL migrated in-memory database; only the
 * two delivery primitives are observed, and the session manager is a stub.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { runProjectMigrations } from '../../src/main/db/migrations/project-schema';
import type { InjectionReport } from '../../src/main/transition-engine/terminal-submit-scheduler';
import type { HeldClaim } from '../../src/main/held-messages/held-messages';
import { MOVE_MESSAGE_MAX_CHARS } from '../../src/main/agent/commands/move-message-limit';

let database: Database.Database;

vi.mock('../../src/main/db/database', () => ({
  getProjectDb: () => database,
}));

const mockPaste = vi.hoisted(() => vi.fn());
const mockDeliver = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/automations/turn-end/agent-message-delivery', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/automations/turn-end/agent-message-delivery')>();
  return { ...original, pasteAgentMessageInBackground: mockPaste, deliverAgentMessageInBackground: mockDeliver };
});

const {
  claimHeldMessages,
  clearHeldMessages,
  commitWhenSessionRuns,
  composeOpeningMessage,
  deliverOpeningRemainder,
  flushHeldIfLive,
  formatHeldMessages,
  holdTaskMessage,
  registerHeldMessageFlush,
  resetHeldMessagesForTests,
  settleClaimFromReport,
} = await import('../../src/main/held-messages/held-messages');
const { SentSessionMessageRepository } = await import('../../src/main/db/repositories/sent-session-message-repository');
const { markRecapSession, resetRecapSessionsForTests } = await import('../../src/main/automations/turn-end/recap-turns');

const PROJECT_ID = 'project-held';
const TASK_ID = 'task-held';

interface StubSession {
  id: string;
  status: 'running' | 'queued';
  writable: boolean;
}

/** A session manager stub: the task's live session (if any) and the events the flush listens to. */
function makeContext(live: StubSession | null = null) {
  const emitter = new EventEmitter();
  let current = live;
  const sessionManager = {
    findLiveSessionByTaskId: vi.fn(() => (current ? { id: current.id, transient: false } : undefined)),
    isWritable: vi.fn((sessionId: string) => current?.id === sessionId && current.writable),
    getSession: vi.fn((sessionId: string) => (current?.id === sessionId ? { id: current.id, status: current.status } : undefined)),
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter),
  };
  return {
    context: { sessionManager } as never,
    sessionManager,
    setLive: (session: StubSession | null) => { current = session; },
  };
}

function laneId(name: string): string {
  return (database.prepare('SELECT id FROM swimlanes WHERE name = ?').get(name) as { id: string }).id;
}

function seedTask(options: { lane?: string; archived?: boolean; displayId?: number } = {}): void {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO tasks (id, display_id, title, swimlane_id, position, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(TASK_ID, options.displayId ?? 412, 'Retry the sync', laneId(options.lane ?? 'Executing'), now, now, options.archived ? now : null);
}

function seedSession(sessionId: string): void {
  database.prepare(`
    INSERT INTO sessions (id, task_id, session_type, command, cwd, status, started_at)
    VALUES (?, ?, 'claude_agent', 'claude', '/mock/project', 'running', ?)
  `).run(sessionId, TASK_ID, new Date().toISOString());
}

function statuses(): string[] {
  return new SentSessionMessageRepository(database).listForTask(TASK_ID).map((row) => row.status);
}

function report(fields: Partial<InjectionReport>): InjectionReport {
  return {
    taskId: TASK_ID,
    sessionId: 'session-next',
    commands: [],
    outcome: 'unconfirmed',
    unconfirmedCommands: [],
    discardedDraft: null,
    interruptedTurn: false,
    escalated: false,
    ...fields,
  };
}

beforeEach(() => {
  database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  runProjectMigrations(database);
  resetHeldMessagesForTests();
  resetRecapSessionsForTests();
  mockPaste.mockReset();
  mockDeliver.mockReset();
});

afterEach(() => {
  database.close();
  vi.useRealTimers();
});

describe('formatting the opening message', () => {
  it('sends a single held message as written, with no number', () => {
    expect(formatHeldMessages(['Lower the cap to 3.'])).toBe('Lower the cap to 3.');
  });

  it('numbers several, oldest first, with a blank line between', () => {
    expect(formatHeldMessages(['Two findings need a decision.\n- The retry cap is 5.', 'Lower the cap to 3.']))
      .toBe('1. Two findings need a decision.\n- The retry cap is 5.\n\n2. Lower the cap to 3.');
  });

  it('puts the held messages after the column\'s message, a blank line between', () => {
    expect(composeOpeningMessage('Address the review findings, then push a fix.', '1. a\n\n2. b')).toEqual({
      prompt: 'Address the review findings, then push a fix.\n\n1. a\n\n2. b',
      heldAfterTurn: false,
    });
  });

  it('makes the held messages the whole opening message when there is no column message', () => {
    expect(composeOpeningMessage(undefined, 'Lower the cap.')).toEqual({ prompt: 'Lower the cap.', heldAfterTurn: false });
    expect(composeOpeningMessage('   ', 'Lower the cap.')).toEqual({ prompt: 'Lower the cap.', heldAfterTurn: false });
  });

  it('keeps them apart from a slash command, whose arguments they would become', () => {
    expect(composeOpeningMessage('/code-review main', 'Lower the cap.')).toEqual({ prompt: '/code-review main', heldAfterTurn: true });
  });

  it('leaves the lead alone with nothing held', () => {
    expect(composeOpeningMessage('/code-review', undefined)).toEqual({ prompt: '/code-review', heldAfterTurn: false });
  });
});

describe('holdTaskMessage', () => {
  it('holds a message for a task with no running agent', () => {
    seedTask();
    const { context } = makeContext();

    const outcome = holdTaskMessage(context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'Lower the cap to 3.', callerSessionId: 'caller' });

    expect(outcome).toEqual({ status: 'held', displayId: 412, rowId: expect.any(String) });
    expect(new SentSessionMessageRepository(database).listHeldForTask(TASK_ID)).toEqual([
      expect.objectContaining({ message: 'Lower the cap to 3.', session_id: null, caller_session_id: 'caller', status: 'held' }),
    ]);
  });

  it('holds for a task in To Do: its first agent gets it', () => {
    seedTask({ lane: 'To Do' });
    expect(holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'x' }).status).toBe('held');
  });

  it.each([
    ['in Done', { lane: 'Done' }],
    ['archived', { archived: true }],
  ])('refuses a task %s, which holds nothing', (_label, taskFields) => {
    seedTask(taskFields);

    const outcome = holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'x' });

    expect(outcome).toEqual({ status: 'refused', error: expect.stringContaining('is in Done') });
    expect(statuses()).toEqual([]);
  });

  it('refuses a task that does not exist', () => {
    expect(holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: 'missing', message: 'x' }).status).toBe('refused');
  });

  it('hands the message straight to an agent that went live meanwhile', () => {
    seedTask();
    seedSession('session-live');
    const { context } = makeContext({ id: 'session-live', status: 'running', writable: true });

    holdTaskMessage(context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'Lower the cap.' });

    expect(mockPaste).toHaveBeenCalledWith(context, expect.objectContaining({ sessionId: 'session-live', message: 'Lower the cap.' }));
    const onOutcome = (mockPaste.mock.calls[0][1] as { onOutcome: (report: InjectionReport) => void }).onOutcome;
    onOutcome(report({ sessionId: 'session-live', outcome: 'unconfirmed' }));
    expect(statuses()).toEqual(['delivered_from_hold']);
  });
});

describe('claims', () => {
  beforeEach(() => {
    seedTask();
    seedSession('session-next');
  });

  function hold(message: string): void {
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message });
  }

  it('claims every held message once, as one numbered message', () => {
    hold('first');
    hold('second');
    const { context } = makeContext();

    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    expect(claim?.text).toBe('1. first\n\n2. second');
    // A second start while the first is delivering gets nothing.
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)).toBeNull();

    claim?.commit('session-next');
    expect(statuses()).toEqual(['delivered_from_hold', 'delivered_from_hold']);
    // Delivered once: a later agent does not receive them again.
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)).toBeNull();
  });

  it('puts released messages back on hold for the next start', () => {
    hold('first');
    const { context } = makeContext();
    claimHeldMessages(context, PROJECT_ID, TASK_ID)?.release();

    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('first');
  });

  it('settles once: the first outcome wins', () => {
    hold('first');
    const claim = claimHeldMessages(makeContext().context, PROJECT_ID, TASK_ID);
    claim?.fail('typed and lost');
    claim?.commit('session-next');

    expect(statuses()).toEqual(['failed']);
    expect(claim?.isSettled()).toBe(true);
  });

  it('keeps a cleared message cleared when its delivery settles after the clear', () => {
    hold('first');
    const claim = claimHeldMessages(makeContext().context, PROJECT_ID, TASK_ID);

    clearHeldMessages(PROJECT_ID, TASK_ID);
    claim?.commit('session-next');

    expect(statuses()).toEqual(['cleared']);
  });

  describe('settling from a delivery report', () => {
    it.each([
      ['confirmed', report({ outcome: 'confirmed' }), 'delivered_from_hold'],
      ['unconfirmed', report({ outcome: 'unconfirmed' }), 'delivered_from_hold'],
      ['superseded before typing', report({ outcome: 'cancelled', textReachedAgent: false }), 'held'],
      ['the session gone before typing', report({ outcome: 'failed', textReachedAgent: false, reason: 'gone' }), 'held'],
      ['a CLI that never came alive', report({ outcome: 'failed', textReachedAgent: false, reason: 'never ready' }), 'held'],
      ['a failure after typing began', report({ outcome: 'failed', reason: 'no submission evidence' }), 'failed'],
    ])('%s', (_label, deliveryReport, expected) => {
      hold('first');
      const claim = claimHeldMessages(makeContext().context, PROJECT_ID, TASK_ID);
      if (!claim) throw new Error('nothing claimed');

      settleClaimFromReport(claim, deliveryReport, { flushOnRelease: false });

      expect(statuses()).toEqual([expected]);
    });
  });
});

describe('command-line rides', () => {
  beforeEach(() => {
    seedTask();
    seedSession('session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'first' });
  });

  it('commits at once when the session already runs', () => {
    const { context } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');

    commitWhenSessionRuns(context, claim, 'session-next');

    expect(statuses()).toEqual(['delivered_from_hold']);
  });

  it('waits for a queued session to run before it commits', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');

    commitWhenSessionRuns(context, claim, 'session-next');
    expect(statuses()).toEqual(['held']);

    sessionManager.emit('session-changed', 'session-next', { status: 'running', taskId: TASK_ID, projectId: PROJECT_ID });
    expect(statuses()).toEqual(['delivered_from_hold']);
    unsubscribe();
  });

  it('puts them back on hold when the queued session is removed before it runs', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');

    commitWhenSessionRuns(context, claim, 'session-next');
    sessionManager.emit('session-removed', 'session-next', {});

    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('first');
    unsubscribe();
  });
});

describe('the late flush', () => {
  beforeEach(() => {
    seedTask();
    seedSession('session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'first' });
  });

  it('does nothing without a live, writable agent', () => {
    flushHeldIfLive(makeContext().context, PROJECT_ID, TASK_ID);
    flushHeldIfLive(makeContext({ id: 'session-next', status: 'queued', writable: false }).context, PROJECT_ID, TASK_ID);

    expect(mockPaste).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['held']);
  });

  it('leaves them held for an agent that opened on an expired conversation\'s recap', () => {
    markRecapSession('session-next');

    flushHeldIfLive(makeContext({ id: 'session-next', status: 'running', writable: true }).context, PROJECT_ID, TASK_ID);

    expect(mockPaste).not.toHaveBeenCalled();
  });

  it('pastes them to an agent that started outside spawnAgent, a beat after it first runs', () => {
    vi.useFakeTimers();
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const unsubscribe = registerHeldMessageFlush(context);

    sessionManager.emit('session-changed', 'session-next', { status: 'running', taskId: TASK_ID, projectId: PROJECT_ID });
    expect(mockPaste).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);

    expect(mockPaste).toHaveBeenCalledWith(context, expect.objectContaining({ sessionId: 'session-next', message: 'first' }));
    unsubscribe();
  });

  it('never flushes again from its own release, so a paste that keeps failing cannot loop', () => {
    const { context } = makeContext({ id: 'session-next', status: 'running', writable: true });

    flushHeldIfLive(context, PROJECT_ID, TASK_ID);
    const onOutcome = (mockPaste.mock.calls[0][1] as { onOutcome: (report: InjectionReport) => void }).onOutcome;
    onOutcome(report({ outcome: 'failed', textReachedAgent: false, reason: 'turn wait timed out' }));

    expect(mockPaste).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['held']);
  });
});

describe('deliverOpeningRemainder', () => {
  beforeEach(() => {
    seedTask();
    seedSession('session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'Lower the cap.' });
  });

  it('types what the resume could not carry, and settles the held messages in it from its report', () => {
    const { context } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const held = claimHeldMessages(context, PROJECT_ID, TASK_ID);

    deliverOpeningRemainder(context, {
      taskId: TASK_ID, sessionId: 'session-next', unsentPrompt: '/code-review\n\nLower the cap.',
      held, heldInPrompt: true, heldAfterTurn: false, verifier: null,
    });

    expect(mockDeliver).toHaveBeenCalledWith(context, expect.objectContaining({ message: '/code-review\n\nLower the cap.', freshlySpawned: true }));
    expect(statuses()).toEqual(['held']);
    (mockDeliver.mock.calls[0][1] as { onOutcome: (report: InjectionReport) => void }).onOutcome(report({ outcome: 'confirmed' }));
    expect(statuses()).toEqual(['delivered_from_hold']);
  });

  it('commits held messages that rode the command line', () => {
    const { context } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const held = claimHeldMessages(context, PROJECT_ID, TASK_ID);

    deliverOpeningRemainder(context, {
      taskId: TASK_ID, sessionId: 'session-next', unsentPrompt: null,
      held, heldInPrompt: true, heldAfterTurn: false, verifier: null,
    });

    expect(mockDeliver).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['delivered_from_hold']);
  });

  it('pastes held messages after a slash command\'s turn', () => {
    const { context } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const held = claimHeldMessages(context, PROJECT_ID, TASK_ID);

    deliverOpeningRemainder(context, {
      taskId: TASK_ID, sessionId: 'session-next', unsentPrompt: null,
      held, heldInPrompt: false, heldAfterTurn: true, verifier: null,
    });

    expect(mockPaste).toHaveBeenCalledWith(context, expect.objectContaining({ message: 'Lower the cap.' }));
  });

  it('puts a claim that no delivery took back on hold instead of leaving it reserved', () => {
    // No live agent, so the release's flush has nothing to hand the rows to and
    // they are observable as claimable again.
    const { context, sessionManager } = makeContext();
    const held = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!held) throw new Error('nothing claimed');

    deliverOpeningRemainder(context, {
      taskId: TASK_ID, sessionId: 'session-next', unsentPrompt: null,
      held, heldInPrompt: false, heldAfterTurn: false, verifier: null,
    });

    expect(held.isSettled()).toBe(true);
    expect(mockDeliver).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
    // The release asked the flush to look for a live agent.
    expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('Lower the cap.');
  });
});

/** The payload of a `session-changed` report for a task session. */
function sessionChange(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: 'running', taskId: TASK_ID, projectId: PROJECT_ID, ...overrides };
}

describe('the session listeners of registerHeldMessageFlush', () => {
  beforeEach(() => {
    // A `running` report schedules a real one second timer; fake timers keep a
    // stray one from flushing into a later test's database.
    vi.useFakeTimers();
    seedTask();
    seedSession('session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'first' });
  });

  /** Claim what is held and hand the claim to a queued session, as a command line ride. */
  function rideOnQueuedSession(context: ReturnType<typeof makeContext>['context'], sessionId: string): HeldClaim {
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');
    commitWhenSessionRuns(context, claim, sessionId);
    return claim;
  }

  it('flushes once when the same session reports running twice', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const unsubscribe = registerHeldMessageFlush(context);

    sessionManager.emit('session-changed', 'session-next', sessionChange());
    sessionManager.emit('session-changed', 'session-next', sessionChange());
    vi.advanceTimersByTime(1_000);

    // The paste count alone cannot tell: a second flush finds the rows already
    // reserved and pastes nothing. The lookup of the live agent is the flush.
    expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledTimes(1);
    expect(mockPaste).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it.each([
    ['a transient session', { transient: true }],
    ['a session with no task', { taskId: undefined }],
    ['a session with no project', { projectId: undefined }],
  ])('runs no flush when %s reports running', (_label, overrides) => {
    // Live and writable, so a flush that did run would paste the held message.
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'running', writable: true });
    const unsubscribe = registerHeldMessageFlush(context);

    sessionManager.emit('session-changed', 'session-excluded', sessionChange(overrides));
    vi.advanceTimersByTime(1_000);

    expect(sessionManager.findLiveSessionByTaskId).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();

    // Control: an ordinary task session in the same run does flush.
    sessionManager.emit('session-changed', 'session-control', sessionChange());
    vi.advanceTimersByTime(1_000);

    expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledTimes(1);
    expect(mockPaste).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('puts a queued session\'s ride back on hold when the session exits', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const claim = rideOnQueuedSession(context, 'session-next');
    // Still riding: reserved, so nothing else can claim it.
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)).toBeNull();

    sessionManager.emit('exit', 'session-next', 1);

    expect(claim.isSettled()).toBe(true);
    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('first');
    unsubscribe();
  });

  it.each(['suspended', 'exited'])('puts a queued session\'s ride back on hold when it reports %s without ever running', (status) => {
    // Still queued and not writable in the stub, so the release's flush finds
    // nothing to paste to and the rows are observable as claimable again.
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const claim = rideOnQueuedSession(context, 'session-next');
    expect(sessionManager.findLiveSessionByTaskId).not.toHaveBeenCalled();

    sessionManager.emit('session-changed', 'session-next', sessionChange({ status }));

    expect(claim.isSettled()).toBe(true);
    // The release asked the flush to look for a live agent.
    expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('first');
    unsubscribe();
  });

  it('keeps a queued session\'s ride when it reports queued again, and commits it once the session runs', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const claim = rideOnQueuedSession(context, 'session-next');

    sessionManager.emit('session-changed', 'session-next', sessionChange({ status: 'queued' }));

    expect(claim.isSettled()).toBe(false);
    expect(sessionManager.findLiveSessionByTaskId).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)).toBeNull();

    sessionManager.emit('session-changed', 'session-next', sessionChange({ status: 'running' }));

    expect(claim.isSettled()).toBe(true);
    expect(statuses()).toEqual(['delivered_from_hold']);
    unsubscribe();
  });

  it('detaches its listeners and puts every waiting ride back on hold without a flush', () => {
    const { context, sessionManager, setLive } = makeContext({ id: 'session-a', status: 'queued', writable: false });
    sessionManager.getSession.mockImplementation((sessionId: string) => ({ id: sessionId, status: 'queued' as const }));
    const unsubscribe = registerHeldMessageFlush(context);
    const firstRide = rideOnQueuedSession(context, 'session-a');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'second' });
    const secondRide = rideOnQueuedSession(context, 'session-b');
    for (const eventName of ['session-changed', 'session-removed', 'exit']) {
      expect(sessionManager.listenerCount(eventName)).toBe(1);
    }
    // A live, writable agent: a release that flushed would hand the rows to it.
    setLive({ id: 'session-a', status: 'running', writable: true });

    unsubscribe();

    for (const eventName of ['session-changed', 'session-removed', 'exit']) {
      expect(sessionManager.listenerCount(eventName)).toBe(0);
    }
    expect(firstRide.isSettled()).toBe(true);
    expect(secondRide.isSettled()).toBe(true);
    expect(sessionManager.findLiveSessionByTaskId).not.toHaveBeenCalled();
    expect(mockPaste).not.toHaveBeenCalled();
    expect(statuses()).toEqual(['held', 'held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('1. first\n\n2. second');
  });

  it('releases the first ride when a second claim rides the same queued session', () => {
    const { context, sessionManager } = makeContext({ id: 'session-next', status: 'queued', writable: false });
    const unsubscribe = registerHeldMessageFlush(context);
    const firstRide = rideOnQueuedSession(context, 'session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'second' });
    const secondRide = rideOnQueuedSession(context, 'session-next');

    // The first claim is settled, not dropped: its row is claimable again, and
    // the second claim, still riding, keeps its own row reserved.
    expect(firstRide.isSettled()).toBe(true);
    expect(secondRide.isSettled()).toBe(false);
    expect(sessionManager.findLiveSessionByTaskId).not.toHaveBeenCalled();
    const reclaimed = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    expect(reclaimed?.text).toBe('first');

    // The second claim is the one that waits for the session to run.
    sessionManager.emit('session-changed', 'session-next', sessionChange({ status: 'running' }));
    expect(secondRide.isSettled()).toBe(true);
    expect(statuses()).toEqual(['held', 'delivered_from_hold']);
    unsubscribe();
  });
});

describe('a claim whose database write fails', () => {
  let spies: Array<{ mockRestore(): void }>;

  beforeEach(() => {
    spies = [];
    seedTask();
    seedSession('session-next');
    holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'first' });
    spies.push(vi.spyOn(console, 'error').mockImplementation(() => undefined));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
  });

  const settlements = [
    [
      'commit',
      () => vi.spyOn(SentSessionMessageRepository.prototype, 'markDeliveredFromHold'),
      (claim: HeldClaim) => claim.commit('session-next'),
    ],
    [
      'fail',
      () => vi.spyOn(SentSessionMessageRepository.prototype, 'markHeldFailed'),
      (claim: HeldClaim) => claim.fail('typed and lost'),
    ],
  ] as const;

  it.each(settlements)('keeps the rows held and reserved when %s throws', (_label, spyOnWrite, settle) => {
    const { context } = makeContext();
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');
    const write = spyOnWrite().mockImplementation(() => { throw new Error('database is locked'); });
    spies.push(write);

    expect(() => settle(claim)).not.toThrow();

    expect(write).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['held']);
    // Reserved: this process does not deliver them a second time.
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)).toBeNull();
  });

  it.each(settlements)('unreserves the rows once %s writes', (_label, spyOnWrite, settle) => {
    const { context } = makeContext();
    const claim = claimHeldMessages(context, PROJECT_ID, TASK_ID);
    if (!claim) throw new Error('nothing claimed');
    // The write succeeds and changes nothing, so the row stays held: the only
    // thing left to stop a second claim is the reservation, and it is gone.
    const write = spyOnWrite().mockReturnValue(0);
    spies.push(write);

    settle(claim);

    expect(write).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['held']);
    expect(claimHeldMessages(context, PROJECT_ID, TASK_ID)?.text).toBe('first');
  });
});

describe('holdTaskMessage checks before it writes', () => {
  function hold(admit?: () => string | null, message = 'Lower the cap.') {
    return holdTaskMessage(makeContext().context, { projectId: PROJECT_ID, taskId: TASK_ID, message, admit });
  }

  it('refuses a message longer than a Move to column message may be, and writes no row', () => {
    seedTask();

    const outcome = hold(undefined, 'x'.repeat(MOVE_MESSAGE_MAX_CHARS + 1));

    expect(outcome).toEqual({ status: 'refused', error: expect.stringContaining(String(MOVE_MESSAGE_MAX_CHARS)) });
    expect(statuses()).toEqual([]);
  });

  it('holds a message of exactly the limit', () => {
    seedTask();

    const outcome = hold(undefined, 'x'.repeat(MOVE_MESSAGE_MAX_CHARS));

    expect(outcome.status).toBe('held');
    expect(statuses()).toEqual(['held']);
  });

  it('refuses with the producer\'s own error when admit answers a string, and writes no row', () => {
    seedTask();
    const admit = vi.fn(() => 'Wait 12 seconds before sending another message.');

    const outcome = hold(admit);

    expect(outcome).toEqual({ status: 'refused', error: 'Wait 12 seconds before sending another message.' });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual([]);
  });

  it('holds normally when admit answers null', () => {
    seedTask();
    const admit = vi.fn(() => null);

    const outcome = hold(admit);

    expect(outcome).toEqual({ status: 'held', displayId: 412, rowId: expect.any(String) });
    expect(admit).toHaveBeenCalledTimes(1);
    expect(statuses()).toEqual(['held']);
  });

  it.each([
    ['a task in Done', () => seedTask({ lane: 'Done' }), 'Lower the cap.', 'is in Done'],
    ['an archived task', () => seedTask({ archived: true }), 'Lower the cap.', 'is in Done'],
    ['a task that does not exist', () => undefined, 'Lower the cap.', 'No task found'],
    ['a message over the limit', () => seedTask(), 'x'.repeat(MOVE_MESSAGE_MAX_CHARS + 1), 'characters'],
  ])('never calls admit for a hold refused anyway: %s', (_label, seed, message, expectedError) => {
    seed();
    const admit = vi.fn(() => null);

    const outcome = hold(admit, message);

    expect(outcome).toEqual({ status: 'refused', error: expect.stringContaining(expectedError) });
    expect(admit).not.toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });

  it('still holds the message when looking for a live agent throws', () => {
    seedTask();
    const { context, sessionManager } = makeContext();
    sessionManager.findLiveSessionByTaskId.mockImplementation(() => { throw new Error('session registry unavailable'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const outcome = holdTaskMessage(context, { projectId: PROJECT_ID, taskId: TASK_ID, message: 'Lower the cap.' });

      expect(outcome).toEqual({ status: 'held', displayId: 412, rowId: expect.any(String) });
      // The throwing lookup was reached, so the guard is what kept the hold intact.
      expect(sessionManager.findLiveSessionByTaskId).toHaveBeenCalledWith(TASK_ID);
      expect(new SentSessionMessageRepository(database).listHeldForTask(TASK_ID)).toEqual([
        expect.objectContaining({ message: 'Lower the cap.', status: 'held' }),
      ]);
      expect(() => flushHeldIfLive(context, PROJECT_ID, TASK_ID)).not.toThrow();
    } finally {
      consoleError.mockRestore();
    }
  });
});

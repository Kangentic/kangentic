/**
 * A running workflow's card stays locked while it is in motion, and a person may
 * drag it once it stops (owner's decision, 2026-11-05).
 *
 * `isWorkflowTaskStopped` is main's answer, asked under the task lock on every
 * hand move and read by the phone. `isStoppedOnBoard` is the board's, from what
 * the renderer holds, asked at the moment of a drag or a click.
 *
 * The first set runs the real predicate over a fake session manager, with the
 * real turn-end registries, since what a pass or a delivery holds is a fact of
 * those maps. Each "in motion" case starts from a stopped card and changes one
 * thing, so a pass cannot come from a card that was never stopped.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ActivityState, Session, Swimlane, Task } from '../../src/shared/types';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import { isStoppedOnBoard } from '../../src/shared/workflow-lock';

const hoisted = vi.hoisted(() => ({ inFlightSpawns: {} as Record<string, string> }));

vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  getInFlightSpawnProgress: () => hoisted.inFlightSpawns,
}));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(), getExistingProjectDb: vi.fn() }));

const { isWorkflowTaskStopped } = await import('../../src/main/workflows/workflow-lock-check');
const { trackMessageDelivery, trackTurnEndFollowUp, trackTurnEndGroup } = await import('../../src/main/automations/turn-end/turn-end-passes');

const TASK = { id: 'task-1', session_id: 'session-1' } as unknown as Task;
const WORKING_COLUMN = { id: 'lane-testing', role: null } as unknown as Swimlane;
const SESSION_ID = 'session-1';

describe('isWorkflowTaskStopped', () => {
  let liveSession: Pick<Session, 'id' | 'status'> | undefined;
  let activity: ActivityState | undefined;
  let keysBlocker: string | null;
  let starting: boolean;
  let heldByBackgroundWork: boolean;
  let messageScheduled: boolean;
  const releases: Array<() => void> = [];

  function resetFacts(): void {
    liveSession = { id: SESSION_ID, status: 'running' };
    activity = 'idle';
    keysBlocker = null;
    starting = false;
    heldByBackgroundWork = false;
    messageScheduled = false;
    hoisted.inFlightSpawns = {};
  }

  beforeEach(resetFacts);

  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });

  function stopped(column: Swimlane = WORKING_COLUMN): boolean {
    const context = {
      sessionManager: {
        findLiveSessionByTaskId: () => liveSession,
        hasLiveOrStartingSession: () => liveSession !== undefined || starting,
        getActivityCache: () => (activity ? { [SESSION_ID]: activity } : {}),
        isTurnHeldByBackgroundWork: () => heldByBackgroundWork,
        automatedKeysBlocker: () => keysBlocker,
      },
      terminalSubmitScheduler: { hasPending: () => messageScheduled },
    } as unknown as IpcContext;
    return isWorkflowTaskStopped(context, TASK, column);
  }

  it('reads an idle agent with nothing on its way as stopped: a Needs owner reply ends just so', () => {
    expect(stopped()).toBe(true);
  });

  it('reads a task with no agent as stopped', () => {
    liveSession = undefined;
    expect(stopped()).toBe(true);
  });

  describe('in motion, so locked', () => {
    it('the agent is working', () => {
      activity = 'thinking';
      expect(stopped()).toBe(false);
    });

    it('a turn is held by background work it left', () => {
      activity = 'thinking';
      heldByBackgroundWork = true;
      expect(stopped()).toBe(false);
    });

    it('the agent sits at a permission prompt, a question or a plan approval', () => {
      activity = 'permission';
      expect(stopped()).toBe(false);
    });

    it('a tool call has not ended, with the permission flag cleared early', () => {
      keysBlocker = 'the Bash tool call has not ended';
      expect(stopped()).toBe(false);
    });

    it('a turn-end pass is acting on the reply', () => {
      releases.push(trackTurnEndGroup(TASK.id, new AbortController()));
      expect(stopped()).toBe(false);
    });

    it('a column message is waiting to be pasted', () => {
      releases.push(trackMessageDelivery(TASK.id, new AbortController()));
      expect(stopped()).toBe(false);
    });

    it('a moved task\'s message is waiting for the agent where it landed', () => {
      releases.push(trackTurnEndFollowUp(TASK.id, new AbortController()));
      expect(stopped()).toBe(false);
    });

    it('a message is scheduled for the terminal', () => {
      messageScheduled = true;
      expect(stopped()).toBe(false);
    });

    it('it is queued for a slot', () => {
      liveSession = { id: SESSION_ID, status: 'queued' };
      expect(stopped()).toBe(false);
    });

    it('its spawn is under way, with no session yet', () => {
      liveSession = undefined;
      starting = true;
      expect(stopped()).toBe(false);
    });

    it('its column is still setting it up, before the spawn', () => {
      liveSession = undefined;
      hoisted.inFlightSpawns = { [TASK.id]: 'Fetching latest...' };
      expect(stopped()).toBe(false);
    });

    it('the session has reported no activity yet', () => {
      activity = undefined;
      expect(stopped()).toBe(false);
    });
  });

  describe('a card that is never the person\'s to take', () => {
    it('stays locked in To Do, where only the engine starts it, though no agent runs there', () => {
      liveSession = undefined;
      expect(stopped({ ...WORKING_COLUMN, role: 'todo' })).toBe(false);
    });

    it('stays locked in Done: moving it out would un-finish a blocker', () => {
      liveSession = undefined;
      expect(stopped({ ...WORKING_COLUMN, role: 'done' })).toBe(false);
    });
  });

  // The board asks first, so a drag never slides a card into a column main refuses. Main sees
  // more than the board, so main may read in motion where the board reads stopped (that race
  // gets the refusal toast). The invariant is one way: board stopped implies main stopped, for
  // the facts both can see.
  describe('the board never reads a card stopped where main reads it in motion', () => {
    const cases: Array<{
      name: string;
      arrange: () => void;
      column: Swimlane;
      facts: Parameters<typeof isStoppedOnBoard>[0];
    }> = [
      { name: 'no session', arrange: () => { liveSession = undefined; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: null, activity: undefined, starting: false } },
      { name: 'queued', arrange: () => { liveSession = { id: SESSION_ID, status: 'queued' }; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: 'queued', activity: undefined, starting: false } },
      { name: 'running idle', arrange: () => { activity = 'idle'; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: 'running', activity: 'idle', starting: false } },
      { name: 'running thinking', arrange: () => { activity = 'thinking'; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: 'running', activity: 'thinking', starting: false } },
      { name: 'running permission', arrange: () => { activity = 'permission'; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: 'running', activity: 'permission', starting: false } },
      { name: 'starting', arrange: () => { liveSession = undefined; starting = true; }, column: WORKING_COLUMN, facts: { columnRole: null, sessionStatus: null, activity: undefined, starting: true } },
      { name: 'To Do column', arrange: () => { liveSession = undefined; }, column: { ...WORKING_COLUMN, role: 'todo' }, facts: { columnRole: 'todo', sessionStatus: null, activity: undefined, starting: false } },
      { name: 'Done column', arrange: () => { liveSession = undefined; }, column: { ...WORKING_COLUMN, role: 'done' }, facts: { columnRole: 'done', sessionStatus: null, activity: undefined, starting: false } },
    ];

    it.each(cases)('$name', ({ arrange, column, facts }) => {
      arrange();
      const boardStopped = isStoppedOnBoard(facts);
      expect(!boardStopped || stopped(column)).toBe(true);
    });

    it('is not vacuous: at least one fact reads stopped on both, and at least one in motion on both', () => {
      const stoppedOnBoth = cases.filter(({ arrange, column, facts }) => {
        resetFacts();
        arrange();
        return isStoppedOnBoard(facts) && stopped(column);
      });
      const inMotionOnBoth = cases.filter(({ arrange, column, facts }) => {
        resetFacts();
        arrange();
        return !isStoppedOnBoard(facts) && !stopped(column);
      });
      expect(stoppedOnBoth.map((entry) => entry.name)).toEqual(['no session', 'running idle']);
      expect(inMotionOnBoth.map((entry) => entry.name)).toEqual(
        ['queued', 'running thinking', 'running permission', 'starting', 'To Do column', 'Done column'],
      );
    });
  });
});

describe('isStoppedOnBoard', () => {
  const stoppedFacts = { columnRole: null, sessionStatus: 'running', activity: 'idle', starting: false } as const;

  it('reads an idle agent and a task with no agent as stopped', () => {
    expect(isStoppedOnBoard(stoppedFacts)).toBe(true);
    expect(isStoppedOnBoard({ ...stoppedFacts, sessionStatus: null, activity: undefined })).toBe(true);
    expect(isStoppedOnBoard({ ...stoppedFacts, sessionStatus: 'suspended', activity: undefined })).toBe(true);
    expect(isStoppedOnBoard({ ...stoppedFacts, sessionStatus: 'exited', activity: undefined })).toBe(true);
  });

  it('reads a working agent, a prompt and a session with no activity yet as in motion', () => {
    expect(isStoppedOnBoard({ ...stoppedFacts, activity: 'thinking' })).toBe(false);
    expect(isStoppedOnBoard({ ...stoppedFacts, activity: 'permission' })).toBe(false);
    expect(isStoppedOnBoard({ ...stoppedFacts, activity: undefined })).toBe(false);
  });

  it('reads a queued session and a card still being set up as in motion', () => {
    expect(isStoppedOnBoard({ ...stoppedFacts, sessionStatus: 'queued' })).toBe(false);
    expect(isStoppedOnBoard({ ...stoppedFacts, sessionStatus: null, activity: undefined, starting: true })).toBe(false);
  });

  it('never unlocks a card in To Do or Done', () => {
    expect(isStoppedOnBoard({ ...stoppedFacts, columnRole: 'todo', sessionStatus: null, activity: undefined })).toBe(false);
    expect(isStoppedOnBoard({ ...stoppedFacts, columnRole: 'done', sessionStatus: null, activity: undefined })).toBe(false);
  });
});

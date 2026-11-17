/**
 * Whether an agent's `kangentic_move_task` is the owner's move (`turnStartedByOwner`, #1100), and
 * what that does to a row's Frequency (`AutomationRunRepository.countRuns`).
 *
 * In #1029 the owner answered the Merge agent in its session ("A"), the agent sent the card back to
 * Executing, and the re-review's "On to Testing" (at most once until you move the task) stopped the
 * card with its one run spent on the first pass. If the read breaks one way, that stall comes back.
 * If it breaks the other way, a Code Review agent that sends itself back after the `/code-review`
 * Kangentic typed resets its own round-trip limit.
 *
 * Real SQLite with the real migrations, the real typed-message record and ledger, and the real
 * transcript read; only the retrieval worker's answer (the turn's user messages) is stubbed.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { insertTask, openMigratedProjectDatabase } from './helpers/earlier-run-fixture';

const hoisted = vi.hoisted(() => ({
  database: null as Database.Database | null,
  call: vi.fn(),
  RetrievalUnavailableError: class extends Error {},
}));

vi.mock('../../src/main/db/database', () => ({
  getOpenProjectDb: () => hoisted.database,
}));
vi.mock('../../src/main/retrieval/retrieval-client', () => ({
  retrievalClient: { call: hoisted.call },
  RetrievalUnavailableError: hoisted.RetrievalUnavailableError,
}));
vi.mock('../../src/main/retrieval/remote-targets', () => ({ collectRemoteTargets: vi.fn(() => []) }));
vi.mock('../../src/main/agent/agent-registry', () => ({ agentRegistry: { getBySessionType: vi.fn() } }));

import {
  OWNER_TURN_READ_TIMEOUT_MS,
  ownerTurnReporter,
  turnStartedByOwner,
  type OwnerTurnSessions,
} from '../../src/main/automations/turn-end/owner-turn';
import { recordKangenticTypedInProject, resetTypedMessageLedgerForTest } from '../../src/main/automations/turn-end/typed-message-ledger';
import { AutomationRunRepository } from '../../src/main/db/repositories/automation-run-repository';
import { SwimlaneRepository } from '../../src/main/db/repositories/swimlane-repository';
import { TaskRepository } from '../../src/main/db/repositories/task-repository';
import { frequencyLimitReason } from '../../src/main/automations/automation-runner';
import type { ColumnAutomation, Swimlane } from '../../src/shared/types';

const PROJECT_ID = 'project-a';
const TASK_ID = 'task-a';
const SESSION_ID = 'session-merge';
const ANCHOR = { agentSessionId: 'agent-merge', byteOffset: 1_200 };
const EARLIER = '2026-11-17T17:38:00.000Z';
const SPENT_REASON = 'Already ran once on this task, its limit.';

function sessionsWith(anchor: typeof ANCHOR | null, known = true): OwnerTurnSessions {
  return {
    getSession: () => (known ? { projectId: PROJECT_ID } : undefined),
    currentTurnAnchor: () => anchor,
  };
}

/** The turn's user messages, as the retrieval worker reads them from the anchor. */
function turnUserMessages(messages: string[] | null): void {
  hoisted.call.mockResolvedValue(messages);
}

beforeEach(() => {
  resetTypedMessageLedgerForTest();
  hoisted.call.mockReset();
  hoisted.database = openMigratedProjectDatabase();
  insertTask(hoisted.database, TASK_ID);
  hoisted.database.prepare(`
    INSERT INTO sessions (id, task_id, session_type, agent_session_id, command, cwd, status, started_at)
    VALUES (?, ?, 'claude_agent', ?, 'claude', '/mock/worktree', 'running', '2026-11-17T17:00:00.000Z')
  `).run(SESSION_ID, TASK_ID, ANCHOR.agentSessionId);
});

afterEach(() => {
  hoisted.database?.close();
  hoisted.database = null;
});

describe('turnStartedByOwner', () => {
  it('is true for a turn holding a message the owner typed', async () => {
    recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, '/merge-pull-request');
    turnUserMessages(['A, send it back for another pass']);

    expect(await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID)).toBe(true);
    expect(hoisted.call).toHaveBeenCalledWith(
      'transcript.turnUserMessages',
      expect.objectContaining({ since: ANCHOR }),
      { timeoutMs: OWNER_TURN_READ_TIMEOUT_MS },
    );
  });

  it('is false for a turn whose only message is one Kangentic typed (the board started it)', async () => {
    recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, '/code-review');
    turnUserMessages(['/code-review']);

    expect(await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID)).toBe(false);
  });

  it('is false for a turn with no user message (a task notification or a wakeup opened it)', async () => {
    turnUserMessages([]);
    expect(await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID)).toBe(false);
  });

  it('is false when the worker cannot read the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    hoisted.call.mockRejectedValue(new Error('the transcript could not be parsed'));

    expect(await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID)).toBe(false);
    warn.mockRestore();
  });

  it('is false, and reads nothing, with no turn anchor or no live session', async () => {
    turnUserMessages(['A, send it back for another pass']);

    expect(await turnStartedByOwner(sessionsWith(null), SESSION_ID)).toBe(false);
    expect(await turnStartedByOwner(sessionsWith(ANCHOR, false), SESSION_ID)).toBe(false);
    expect(hoisted.call).not.toHaveBeenCalled();
  });

  it('is false, reads nothing and reports nothing, when the project is not open', async () => {
    const report = vi.spyOn(ownerTurnReporter, 'report').mockReturnValue(true);
    turnUserMessages(['A, send it back for another pass']);

    expect(await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID, () => null)).toBe(false);
    expect(hoisted.call).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    report.mockRestore();
  });

  // The move waits on the read before it commits, and the agent's turn ends a
  // few seconds after its call. A read that ran past that would let the
  // column's turn-end rows judge a turn whose task is leaving.
  it('is false once the read has taken its whole budget', async () => {
    vi.useFakeTimers();
    try {
      recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, '/merge-pull-request');
      hoisted.call.mockReturnValue(new Promise(() => undefined));

      const answer = turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID);
      await vi.advanceTimersByTimeAsync(OWNER_TURN_READ_TIMEOUT_MS);

      expect(await answer).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // The move waits on this answer and the tool fires it without awaiting, so a
  // rejection would fail the agent's move with no one told.
  it('never rejects, so a throw reads as the agent\'s move and is reported', async () => {
    const report = vi.spyOn(ownerTurnReporter, 'report').mockReturnValue(true);
    const broken: OwnerTurnSessions = {
      getSession: () => { throw new TypeError('the session registry is gone'); },
      currentTurnAnchor: () => ANCHOR,
    };

    await expect(turnStartedByOwner(broken, SESSION_ID)).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith(expect.any(TypeError));
    report.mockRestore();
  });

  it('is false for a session with no record, such as a Command Terminal', async () => {
    turnUserMessages(['move it back']);
    expect(await turnStartedByOwner(sessionsWith(ANCHOR), 'session-without-a-record')).toBe(false);
  });
});

describe('the move it decides, against a row\'s Frequency', () => {
  let tasks: TaskRepository;
  let runs: AutomationRunRepository;
  let executingLane: Swimlane;
  let codeReviewLane: Swimlane;
  let mergeLane: Swimlane;

  const onToTesting = (): ColumnAutomation => ({
    id: 'row-on-to-testing',
    swimlane_id: codeReviewLane.id,
    name: 'On to Testing',
    type: 'move_to_column',
    trigger: 'turn_end',
    position: 0,
    enabled: true,
    config: { targetColumn: 'Testing' },
    condition: null,
    max_runs: 1,
    created_at: EARLIER,
    updated_at: EARLIER,
  });

  beforeEach(() => {
    const database = hoisted.database!;
    const lanes = new SwimlaneRepository(database).list();
    executingLane = lanes.find((lane) => lane.name === 'Executing')!;
    codeReviewLane = lanes.find((lane) => lane.name === 'Code Review')!;
    mergeLane = lanes.find((lane) => lane.name === 'Merge')!;
    tasks = new TaskRepository(database);
    runs = new AutomationRunRepository(database);
    // The first pass: On to Testing ran from Code Review, and the card reached Merge.
    database.prepare('UPDATE tasks SET swimlane_id = ? WHERE id = ?').run(mergeLane.id, TASK_ID);
    runs.start({ id: 'run-first-pass', automation: onToTesting(), taskId: TASK_ID });
    runs.finish('run-first-pass', 'succeeded', 'Moved to Testing.');
    database.prepare('UPDATE automation_runs SET started_at = ? WHERE id = ?').run(EARLIER, 'run-first-pass');
  });

  /** The agent's move back to Executing, carrying what the read decided, as `handleTaskMove` writes it. */
  async function agentMovesBack(): Promise<void> {
    const ownerRequested = await turnStartedByOwner(sessionsWith(ANCHOR), SESSION_ID);
    tasks.move(
      { taskId: TASK_ID, targetSwimlaneId: executingLane.id, targetPosition: 0 },
      { origin: 'agent', ...(ownerRequested ? { ownerRequested: true } : {}) },
    );
  }

  it('starts the count over when the owner asked in the session (#1029)', async () => {
    recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, '/merge-pull-request');
    turnUserMessages(['A']);

    await agentMovesBack();

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(0);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBeNull();
  });

  it('keeps the count when the board started the turn', async () => {
    recordKangenticTypedInProject(PROJECT_ID, SESSION_ID, '/code-review');
    turnUserMessages(['/code-review']);

    await agentMovesBack();

    expect(runs.countRuns('row-on-to-testing', TASK_ID)).toBe(1);
    expect(frequencyLimitReason(onToTesting(), runs, TASK_ID)).toBe(SPENT_REASON);
  });
});

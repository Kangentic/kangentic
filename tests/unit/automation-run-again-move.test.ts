/**
 * Run again (`runAutomationAgain`, src/main/ipc/helpers/automation-run-again.ts)
 * on a Move to column row moves the task.
 *
 * It used to hand the runner no `moveTask`, so the failure toast's Run again
 * and `kangentic_run_automation` failed every Move to column row with "runs
 * only when the agent finishes a turn", even right after the agent had. That
 * left an agent recovering a dropped turn end no way to move the card itself.
 *
 * The move row runs outside the task lock, as it does at a turn end: its move
 * goes through `handleTaskMove`, which takes the lock, and the lock is not
 * reentrant. The fake `handleTaskMove` here takes the REAL lock the way the
 * real one does, so a re-run that held it would never finish.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Swimlane } from '../../src/shared/types';
import { withTaskLock } from '../../src/main/ipc/task-lifecycle-lock';

const TASK_ID = 'task-rerun-move-1';

interface MoveInput {
  column: string | null;
  message: string | null;
  reason: string;
}

const hoisted = vi.hoisted(() => ({
  rowType: 'move_to_column',
  taskColumn: 'lane-review',
  handleTaskMove: vi.fn(),
  executeSingleAutomation: vi.fn(),
  deliverMessageAfterMove: vi.fn(),
}));

function column(id: string, name: string, position: number): Swimlane {
  return { id, name, position, role: null, is_archived: false, is_ghost: false } as unknown as Swimlane;
}

const COLUMNS = [column('lane-review', 'Code Review', 3), column('lane-testing', 'Testing', 4)];

vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn(() => ({})) }));
vi.mock('../../src/main/db/repositories/session-repository', () => ({ SessionRepository: class {} }));
vi.mock('../../src/main/ipc/handlers/system', () => ({ showDesktopNotification: vi.fn() }));
vi.mock('../../src/main/transition-engine/spawn-progress', () => ({
  createProgressCallback: vi.fn(() => vi.fn()),
  clearSpawnProgress: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/auto-command-outcome', () => ({ reportAutoCommandOutcome: vi.fn() }));
vi.mock('../../src/main/ipc/handlers/task-move', () => ({ handleTaskMove: hoisted.handleTaskMove }));
vi.mock('../../src/main/automations/turn-end/deliver-message', () => ({
  deliverMessageAfterMove: hoisted.deliverMessageAfterMove,
  deliverMessageToSession: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/agent-spawn', () => ({
  resolveInjectionVerifier: vi.fn(() => null),
  createTransitionEngine: vi.fn(() => ({ executeSingleAutomation: hoisted.executeSingleAutomation })),
}));
vi.mock('../../src/main/ipc/helpers/project-repos', () => ({
  getProjectRepos: vi.fn(() => ({
    automations: {
      listAll: vi.fn(() => [{
        id: 'row-on-to-testing',
        swimlane_id: 'lane-review',
        name: 'On to Testing',
        type: hoisted.rowType,
        trigger: 'turn_end',
        config: { targetColumn: 'Testing', message: 'Run the tests.' },
        condition: null,
        final_line: null,
      }]),
    },
    swimlanes: { getById: vi.fn((id: string) => COLUMNS.find((lane) => lane.id === id)), list: vi.fn(() => COLUMNS) },
    tasks: {
      getById: vi.fn(() => ({ id: TASK_ID, title: 'Document the board', agent: 'claude', swimlane_id: hoisted.taskColumn, session_id: 'session-1' })),
      list: vi.fn(() => []),
    },
    automationRuns: {},
    attachments: {},
  })),
}));

const { runAutomationAgain } = await import('../../src/main/ipc/helpers/automation-run-again');

function makeContext() {
  return {
    projectRepo: { getById: vi.fn(() => ({ id: 'proj-test', path: '/mock/project' })) },
    mainWindow: { isDestroyed: vi.fn(() => false), webContents: { send: vi.fn() } },
    sessionManager: { getSession: vi.fn() },
  };
}

describe('runAutomationAgain: a Move to column row', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.rowType = 'move_to_column';
    hoisted.taskColumn = 'lane-review';
    // The real move takes the task lock. Held by the re-run, this would wait forever.
    hoisted.handleTaskMove.mockImplementation(async (_context: unknown, input: { taskId: string; targetSwimlaneId: string }) => {
      await withTaskLock(input.taskId, async () => {
        hoisted.taskColumn = input.targetSwimlaneId;
      });
    });
    // The runner reduced to the row: a move row calls `moveTask`, as the adapter does.
    hoisted.executeSingleAutomation.mockImplementation(async (
      _task: unknown,
      _column: unknown,
      _automation: unknown,
      options: { moveTask?: (input: MoveInput) => Promise<{ columnName: string }> },
    ) => {
      if (!options.moveTask) {
        return { outcomes: [{ runId: 'run-1', name: 'On to Testing', columnName: 'Code Review', status: 'succeeded', detail: 'Sent.' }] };
      }
      const { columnName } = await options.moveTask({ column: 'Testing', message: 'Run the tests.', reason: 'On to Testing' });
      return { outcomes: [{ runId: 'run-1', name: 'On to Testing', columnName: 'Code Review', status: 'succeeded', detail: `Moved to ${columnName}.` }] };
    });
  });

  it('moves the task through the one move path, outside the task lock', async () => {
    const result = await runAutomationAgain(makeContext() as never, 'proj-test', TASK_ID, 'row-on-to-testing');

    expect(result).toEqual(expect.objectContaining({ ok: true, detail: 'Moved to Testing.' }));
    expect(hoisted.handleTaskMove).toHaveBeenCalledTimes(1);
    expect(hoisted.handleTaskMove).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ taskId: TASK_ID, targetSwimlaneId: 'lane-testing' }),
      'automation',
      'proj-test',
      '/mock/project',
      // Not the turn-end group's own move: a re-run's move stops any turn-end work the task has going.
      // And only from the row's own column, checked again inside the move's lock. The row
      // carries a message, which the move is told so a return recap does not repeat it.
      { moveReason: 'On to Testing', fromTurnEndGroup: false, expectedFromSwimlaneId: 'lane-review', carriesMessage: true },
    );
    expect(hoisted.taskColumn).toBe('lane-testing');
    // The row's message follows the task to where it lands.
    expect(hoisted.deliverMessageAfterMove).toHaveBeenCalledWith(expect.anything(), 'proj-test', TASK_ID, 'Testing', 'Run the tests.');
  });

  it('refuses when the task has left the row\'s column, and runs nothing', async () => {
    hoisted.taskColumn = 'lane-testing';

    const result = await runAutomationAgain(makeContext() as never, 'proj-test', TASK_ID, 'row-on-to-testing');

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('no longer in Code Review');
    expect(hoisted.executeSingleAutomation).not.toHaveBeenCalled();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('waits for a move queued ahead of it before reading where the task is', async () => {
    let releaseQueuedMove: () => void = () => undefined;
    const queuedMove = withTaskLock(TASK_ID, () => new Promise<void>((resolve) => {
      releaseQueuedMove = () => {
        hoisted.taskColumn = 'lane-testing';
        resolve();
      };
    }));

    const rerun = runAutomationAgain(makeContext() as never, 'proj-test', TASK_ID, 'row-on-to-testing');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(hoisted.executeSingleAutomation).not.toHaveBeenCalled();

    releaseQueuedMove();
    await queuedMove;
    const result = await rerun;

    // The queued move took the task out of Code Review first.
    expect(result.ok).toBe(false);
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  it('hands no move to a row that does not move the task, and runs it inside the lock', async () => {
    hoisted.rowType = 'send_message';
    let releaseHolder: () => void = () => undefined;
    const holder = withTaskLock(TASK_ID, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));

    const rerun = runAutomationAgain(makeContext() as never, 'proj-test', TASK_ID, 'row-on-to-testing');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Still waiting on the lock holder.
    expect(hoisted.executeSingleAutomation).not.toHaveBeenCalled();

    releaseHolder();
    await holder;
    const result = await rerun;

    expect(result.ok).toBe(true);
    const options = hoisted.executeSingleAutomation.mock.calls[0][3] as { moveTask?: unknown };
    expect(options.moveTask).toBeUndefined();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });

  // A row stored with a type this build does not know (written by a newer
  // version, or hand-edited). The manifest has no entry to ask, so
  // `automationMovesTask` must answer no on the `isAutomationType` half rather than read `endsGroup`
  // off an entry that is not there. Reverting that guard makes the re-run reject
  // with a TypeError before it reaches the lock, instead of running the row.
  it('hands no move to a row whose type is not a known automation type, and runs it inside the lock', async () => {
    hoisted.rowType = 'a_type_no_manifest_entry_declares';
    // A move row runs OUTSIDE the lock (its move takes the lock itself), so a
    // run that is still going while the lock is held is the locked path. The
    // lock is not reentrant, so a probe queued from inside the run cannot get
    // it until the run ends; the race below ends first, by the timer.
    let probeAcquiredLockDuringRun: boolean | null = null;
    let probe: Promise<string> = Promise.resolve('');
    hoisted.executeSingleAutomation.mockImplementationOnce(async () => {
      probe = withTaskLock(TASK_ID, async () => 'acquired');
      probeAcquiredLockDuringRun = await Promise.race([
        probe.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 50)),
      ]);
      return { outcomes: [{ runId: 'run-1', name: 'On to Testing', columnName: 'Code Review', status: 'succeeded', detail: 'Sent.' }] };
    });
    let releaseHolder: () => void = () => undefined;
    const holder = withTaskLock(TASK_ID, () => new Promise<void>((resolve) => { releaseHolder = resolve; }));

    const rerun = runAutomationAgain(makeContext() as never, 'proj-test', TASK_ID, 'row-on-to-testing');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Still waiting on the lock holder.
    expect(hoisted.executeSingleAutomation).not.toHaveBeenCalled();

    releaseHolder();
    await holder;
    const result = await rerun;
    await probe;

    expect(result.ok).toBe(true);
    expect(hoisted.executeSingleAutomation).toHaveBeenCalledTimes(1);
    expect(probeAcquiredLockDuringRun).toBe(false);
    const options = hoisted.executeSingleAutomation.mock.calls[0][3] as { moveTask?: unknown };
    expect(options.moveTask).toBeUndefined();
    expect(hoisted.handleTaskMove).not.toHaveBeenCalled();
  });
});

/**
 * What the workflow's step check asks the Automation agent, and the route it is
 * told (src/main/workflows/workflow-step-condition.ts). Pure: no database, no
 * Electron. The board is the seeded default (To Do, Planning, Executing, Code
 * Review, Testing, Merge, Done), so the route line is read against the names a
 * real board carries.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_SWIMLANES } from '../../src/main/db/migrations/default-data';
import {
  columnExitRows,
  describeStepRoute,
  isSendBackOnly,
  stepExitVerdict,
  workflowBlockerConditions,
  workflowStepCondition,
  type StepExitRow,
} from '../../src/main/workflows/workflow-step-condition';
import type { ColumnAutomation, Swimlane, Task } from '../../src/shared/types';

type BoardColumn = Pick<Swimlane, 'id' | 'name' | 'position' | 'role' | 'is_archived' | 'is_ghost' | 'description'>;
type RouteTask = Pick<Task, 'route_start_swimlane_id' | 'route_last_swimlane_id' | 'skipped_swimlane_ids'>;

const BOARD: BoardColumn[] = DEFAULT_SWIMLANES.map((lane, index) => ({
  id: lane.name.toLowerCase().replace(/\s+/g, '-'),
  name: lane.name,
  position: index,
  role: lane.role,
  is_archived: lane.archived === 1,
  is_ghost: false,
  description: null,
}));

const OPEN_ROUTE: RouteTask = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: [] };
const EXECUTING_ONLY: RouteTask = { route_start_swimlane_id: 'executing', route_last_swimlane_id: 'executing', skipped_swimlane_ids: [] };

function columnNamed(name: string): BoardColumn {
  const found = BOARD.find((column) => column.name === name);
  if (!found) throw new Error(`The default board has no ${name} column.`);
  return found;
}

describe('describeStepRoute', () => {
  it('lists the open route\'s columns and then Done, skipping nothing, and is not last before the final column', () => {
    const route = describeStepRoute(BOARD, OPEN_ROUTE, 'executing');
    expect(route.steps).toEqual(['Planning', 'Executing', 'Code Review', 'Testing', 'Merge', 'Done']);
    expect(route.skipped).toEqual([]);
    expect(route.isLast).toBe(false);
  });

  it('names the columns a cut route skips, in board order', () => {
    const route = describeStepRoute(BOARD, EXECUTING_ONLY, 'executing');
    expect(route.steps).toEqual(['Executing', 'Done']);
    expect(route.skipped).toEqual(['Planning', 'Code Review', 'Testing', 'Merge']);
  });

  it('is last in the route\'s final column, whether that is cut short or the board\'s own last', () => {
    expect(describeStepRoute(BOARD, EXECUTING_ONLY, 'executing').isLast).toBe(true);
    expect(describeStepRoute(BOARD, OPEN_ROUTE, 'merge').isLast).toBe(true);
  });

  it('is last from a column off the route, once nothing on the route is left to visit', () => {
    // The route ends at Executing; the task sits in Code Review, which the
    // route does not visit. The next stop is Done.
    expect(describeStepRoute(BOARD, EXECUTING_ONLY, 'code-review').isLast).toBe(true);
  });

  it('is not last from a column off the route while a route column still lies ahead', () => {
    // A route of Code Review only; the task sits in Planning, before it.
    const reviewOnly: RouteTask = { route_start_swimlane_id: 'code-review', route_last_swimlane_id: 'code-review', skipped_swimlane_ids: [] };
    expect(describeStepRoute(BOARD, reviewOnly, 'planning').isLast).toBe(false);
  });

  it('is not last in a skipped middle column that has a later route column after it', () => {
    const skippingTesting: RouteTask = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['testing'] };
    expect(describeStepRoute(BOARD, skippingTesting, 'testing').isLast).toBe(false);
    expect(describeStepRoute(BOARD, skippingTesting, 'testing').skipped).toEqual(['Testing']);
  });
});

describe('workflowStepCondition at the route\'s last column', () => {
  const route = describeStepRoute(BOARD, EXECUTING_ONLY, 'executing');
  const condition = workflowStepCondition(columnNamed('Executing'), route);

  it('says it is the last step and names the route with this step marked and the skipped columns', () => {
    expect(condition).toContain('The Executing step is the last on the task\'s route');
    expect(condition).toContain('(Executing (this step), then Done; it skips Planning, Code Review, Testing and Merge)');
  });

  it('asks whether the final message reports the work as done, not still under way', () => {
    expect(condition).toContain('the agent\'s final message reports its work as done, not as still under way');
    expect(condition).toContain('a progress note such as "running the tests now" is not done');
  });

  it('does not wait on the user for an answer, a decision or an approval', () => {
    expect(condition).toContain('the final message is not waiting on the user for an answer, a decision or an approval');
  });

  it('says what a skipped column\'s criteria are worth: nothing here', () => {
    expect(condition).toContain('Anything the task\'s description asks of a column the route skips does not apply.');
  });

  it('does not judge the column\'s purpose, even when it has one', () => {
    const described = workflowStepCondition({ name: 'Executing', description: 'Write the code' }, route);
    expect(described).not.toContain('purpose');
    expect(described).not.toContain('Write the code');
  });

  it('reads without a skip clause when the route skips nothing', () => {
    const lastOfOpenRoute = workflowStepCondition(columnNamed('Merge'), describeStepRoute(BOARD, OPEN_ROUTE, 'merge'));
    expect(lastOfOpenRoute).toContain('(Planning, then Executing, then Code Review, then Testing, then Merge (this step), then Done)');
    expect(lastOfOpenRoute).not.toContain('it skips');
  });

  it('says "and" between two skipped columns and nothing between one', () => {
    const skippingTwo: RouteTask = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['planning', 'testing'] };
    const twoSkipped = workflowStepCondition(columnNamed('Merge'), describeStepRoute(BOARD, skippingTwo, 'merge'));
    expect(twoSkipped).toContain('it skips Planning and Testing');
    const skippingOne: RouteTask = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['planning'] };
    const oneSkipped = workflowStepCondition(columnNamed('Merge'), describeStepRoute(BOARD, skippingOne, 'merge'));
    expect(oneSkipped).toContain('it skips Planning)');
  });
});

describe('workflowStepCondition before the last column', () => {
  const openRoute = describeStepRoute(BOARD, OPEN_ROUTE, 'executing');

  it('judges only that step\'s work, and the final message not waiting on the user', () => {
    const condition = workflowStepCondition(columnNamed('Executing'), openRoute);
    expect(condition).toContain('The work of the Executing step is done, and the final message is not waiting on the user for an answer, a decision or an approval.');
    expect(condition).toContain('Judge only the Executing step');
  });

  it('says criteria for a later step, or a column the route skips, do not apply here', () => {
    const condition = workflowStepCondition(columnNamed('Executing'), openRoute);
    expect(condition).toContain('anything the task\'s description asks of a later step, or of a column the route skips, does not apply here.');
  });

  it('gives the route with this step marked', () => {
    const condition = workflowStepCondition(columnNamed('Executing'), openRoute);
    expect(condition).toContain('The task\'s route: Planning, then Executing (this step), then Code Review, then Testing, then Merge, then Done.');
  });

  it('is not the last-column wording', () => {
    const condition = workflowStepCondition(columnNamed('Executing'), openRoute);
    expect(condition).not.toContain('is the last on the task\'s route');
    expect(condition).not.toContain('reports its work as done');
  });

  it('adds the column\'s purpose only when its description has text', () => {
    const withPurpose = workflowStepCondition({ name: 'Executing', description: 'Write the code' }, openRoute);
    expect(withPurpose).toContain('The work of the Executing step is done (the column\'s purpose: Write the code), and');

    const trimmed = workflowStepCondition({ name: 'Executing', description: '  Write the code \n' }, openRoute);
    expect(trimmed).toContain('(the column\'s purpose: Write the code)');

    for (const blank of [null, '', '   \n']) {
      const without = workflowStepCondition({ name: 'Executing', description: blank }, openRoute);
      expect(without).not.toContain('purpose');
      expect(without).toContain('The work of the Executing step is done, and');
    }
  });

  it('names the skipped columns in the route line when the route is cut', () => {
    const cut: RouteTask = { route_start_swimlane_id: 'executing', route_last_swimlane_id: 'testing', skipped_swimlane_ids: ['code-review'] };
    const condition = workflowStepCondition(columnNamed('Executing'), describeStepRoute(BOARD, cut, 'executing'));
    expect(condition).toContain('The task\'s route: Executing (this step), then Testing, then Done; it skips Planning, Code Review and Merge.');
  });
});

// The second ask, made only when the step is not done and nothing of the
// agent's own is still running: what the reply says it is stuck on, so the
// nudge can aim at it. Whether it needs the owner is the agent's own line, and
// whether work still runs comes from the hook events, so neither is asked.
describe('workflowStepCondition in a column with only send-back rows', () => {
  const testing = { name: 'Testing', description: 'Opens the PR and waits for CI. Stays here until 1+ reviewer approves, then drag to Merge.' };
  const route = { steps: ['Executing', 'Testing', 'Merge', 'Done'], skipped: [], isLast: false };

  it('asks whether the agent finished what it can do alone, whatever the column says about a reviewer', () => {
    const condition = workflowStepCondition(testing, route, { sendBackOnly: true });
    expect(condition).toContain('finished what it can do alone');
    expect(condition).toContain('waits on a person');
    expect(condition).toContain(testing.description);
    expect(condition).not.toContain('not waiting on the user');
  });

  it('asks the same at the route\'s last column, which a person also moves on', () => {
    const condition = workflowStepCondition(testing, { ...route, steps: ['Testing', 'Done'], isLast: true }, { sendBackOnly: true });
    expect(condition).toContain('finished what it can do alone');
  });

  it('keeps the measured wording everywhere else', () => {
    expect(workflowStepCondition(testing, route)).toContain('not waiting on the user');
  });
});

describe('what a step that is not done is stuck on', () => {
  it('asks one row per blocker the nudge has an instruction for, and nothing about the owner', () => {
    const rows = workflowBlockerConditions({ name: 'Executing' }, 'main');
    expect(rows.map((row) => row.blocker)).toEqual(['resource', 'main-fails-too']);
    for (const row of rows) {
      expect(row.condition).not.toMatch(/the user|the owner/i);
    }
  });

  it('reads a gate stopped for memory or load, and not a mistake in the code, as a resource blocker', () => {
    const [resource] = workflowBlockerConditions({ name: 'Executing' }, 'main');
    expect(resource.condition).toContain('the gate it ran for the Executing step was stopped, killed or failed');
    expect(resource.condition).toContain('ran low on memory or was too busy');
    // Claude Code's memory reaper, and a gate that failed on load beside other runs.
    expect(resource.condition).toContain('a process reaper');
    expect(resource.condition).toContain('other runs at the same time');
    expect(resource.condition).toContain('not because of a mistake in the code');
  });

  it('names the task\'s own base branch for failures that also happen there', () => {
    const [, mainFailsToo] = workflowBlockerConditions({ name: 'Testing' }, 'develop');
    expect(mainFailsToo.condition).toContain('also happen on develop (the base branch, without this task\'s changes)');
  });

  it('leaves the measured first ask untouched by the second', () => {
    // Byte for byte what the step asked before the second ask existed.
    const openRoute = describeStepRoute(BOARD, OPEN_ROUTE, 'executing');
    expect(workflowStepCondition(columnNamed('Executing'), openRoute)).toBe(
      'The work of the Executing step is done, and the final message is not waiting on the user for an answer, a decision or an approval. '
      + 'The task\'s route: Planning, then Executing (this step), then Code Review, then Testing, then Merge, then Done. '
      + 'Judge only the Executing step: anything the task\'s description asks of a later step, or of a column the route skips, does not apply here.',
    );
  });
});

/**
 * The column's own exit rows against a reply the check judged done. The rows
 * are this repo's Code Review pair (kangentic.json): "Verdict: Blocked" back to
 * Executing and "Verdict: Ready" on to Testing.
 */
describe('stepExitVerdict', () => {
  const codeReview = columnNamed('Code Review');
  const exitTo = (finalLine: string, targetName: string | null, source: StepExitRow['source'] = 'agent'): StepExitRow => ({
    finalLine,
    source,
    target: targetName === null ? null : columnNamed(targetName),
  });
  const BACK_FOR_REVISIONS = exitTo('Verdict: Blocked', 'Executing');
  const ON_TO_TESTING = exitTo('Verdict: Ready', 'Testing');
  const REVIEW_ROWS = [BACK_FOR_REVISIONS, ON_TO_TESTING];

  // #1078: a forward row on the user's message is the person's way on. The agent's line never
  // takes it, the column is a person's gate, and the step stops the card rather than moving it.
  describe('a forward row on the user\'s message', () => {
    const ON_TO_TESTING_BY_USER = exitTo('*signed off*', 'Testing', 'user');

    it('is a person\'s gate with no agent exit at all', () => {
      expect(isSendBackOnly(codeReview, [ON_TO_TESTING_BY_USER])).toBe(true);
      expect(stepExitVerdict(codeReview, [ON_TO_TESTING_BY_USER], 'All done, the canvas is ready.')).toEqual({ accepted: true, stopsHere: true });
    });

    it('never accepts the agent\'s line, even one that names the sign-off', () => {
      expect(stepExitVerdict(codeReview, [ON_TO_TESTING_BY_USER], 'To sign off, type signed off')).toEqual({ accepted: true, stopsHere: true });
    });

    it('refuses an empty reply as a stall', () => {
      expect(stepExitVerdict(codeReview, [ON_TO_TESTING_BY_USER], null)).toMatchObject({ accepted: false });
    });

    it('keeps a send-back row on the agent\'s line working beside it', () => {
      const rows = [exitTo('Design: shelved', 'Executing'), ON_TO_TESTING_BY_USER];
      expect(isSendBackOnly(codeReview, rows)).toBe(true);
      expect(stepExitVerdict(codeReview, rows, 'Design: shelved')).toMatchObject({ accepted: false });
      expect(stepExitVerdict(codeReview, rows, 'Here is the canvas.')).toEqual({ accepted: true, stopsHere: true });
    });

    it('leaves a user row that sends the task back out of the gate', () => {
      expect(isSendBackOnly(codeReview, [exitTo('*start over*', 'Executing', 'user')])).toBe(false);
      expect(stepExitVerdict(codeReview, [exitTo('*start over*', 'Executing', 'user')], 'Done.')).toBeNull();
    });
  });

  it('refuses a reply neither row matches (task 916)', () => {
    expect(stepExitVerdict(codeReview, REVIEW_ROWS, 'The branch is identical to main.\n\nNo changes to review.')).toEqual({
      accepted: false,
      reason: 'the final line, "No changes to review.", is not one Code Review moves the task on from',
    });
  });

  it('accepts a reply the forward row matches, through markdown and case', () => {
    expect(stepExitVerdict(codeReview, REVIEW_ROWS, '### Summary\n\n**verdict: ready**')).toEqual({ accepted: true });
  });

  it('refuses a reply only the send-back row matches, and names where it sends the task', () => {
    expect(stepExitVerdict(codeReview, REVIEW_ROWS, '1. src/a.ts:4: commit the fix\nVerdict: Blocked')).toEqual({
      accepted: false,
      reason: 'the final line, "Verdict: Blocked", sends the task back to Executing',
    });
  });

  it('accepts a line that a forward row and a send-back row both match', () => {
    // Two rows match the one line, one back to Executing and one on to Testing.
    // A forward match is enough, so the check's yes stands.
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS, exitTo('Verdict: Blocked', 'Testing')], 'Verdict: Blocked')).toEqual({ accepted: true });
  });

  it('does not read a matched row with no target as a send-back, and refuses with the not-an-exit reason', () => {
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Blocked', null), ON_TO_TESTING], 'Verdict: Blocked')).toEqual({
      accepted: false,
      reason: 'the final line, "Verdict: Blocked", is not one Code Review moves the task on from',
    });
  });

  it('refuses an empty reply in a column with a forward row', () => {
    expect(stepExitVerdict(codeReview, REVIEW_ROWS, null)).toEqual({ accepted: false, reason: 'the turn ended without a final message' });
    expect(stepExitVerdict(codeReview, REVIEW_ROWS, '   \n')).toEqual({ accepted: false, reason: 'the turn ended without a final message' });
  });

  it('leaves the check alone when the column has no exit rows', () => {
    expect(stepExitVerdict(codeReview, [], 'No changes to review.')).toBeNull();
  });

  // A review gate: the column has said how a task goes back, and left the way on
  // to a person. On one PR state the check alone held six tasks and moved three
  // on, and those three merged with no approval. So its yes stops the card.
  it('stops the card on a yes in a column whose only rows send the task back, when the reply matches neither', () => {
    const rows = [BACK_FOR_REVISIONS, exitTo('Changes requested', 'Executing')];
    expect(stepExitVerdict(codeReview, rows, 'PR open, checks green.\n\nPR: awaiting review')).toEqual({ accepted: true, stopsHere: true });
  });

  // A yes on a turn with no final message would tell a person the agent finished
  // with nothing to show for it. Refused, it is a stall and gets its nudge.
  it('refuses an empty reply there too, so it is nudged rather than handed to a person', () => {
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS], null)).toEqual({ accepted: false, reason: 'the turn ended without a final message' });
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS], '   \n')).toEqual({ accepted: false, reason: 'the turn ended without a final message' });
  });

  it('counts a send-back with a Text match that can match no line as no exit at all', () => {
    expect(stepExitVerdict(codeReview, [exitTo('---', 'Executing')], 'PR: awaiting review')).toBeNull();
  });

  it('still refuses a send-back match in a column with no forward row', () => {
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS], 'Verdict: Blocked')).toMatchObject({ accepted: false });
  });

  it('counts a row into Done as forward, and a wildcard pattern as a match', () => {
    expect(stepExitVerdict(codeReview, [exitTo('Ready for *', 'Done')], 'Ready for testing')).toEqual({ accepted: true });
  });

  it('reads a ! exit row by the runner\'s rule: any line but the ones it rules out', () => {
    const notWaiting = exitTo('!Design: waiting on you\n!Design: shelved', 'Testing');
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS, notWaiting], 'Findings: applied')).toEqual({ accepted: true });
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS, notWaiting], 'Design: shelved')).toMatchObject({ accepted: false });
    // No message is no line to rule out, so a ! row moves nothing.
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS, notWaiting], null)).toEqual({ accepted: false, reason: 'the turn ended without a final message' });
  });

  it('counts a later column as forward even when the route skips it', () => {
    // A route that skips Testing: the row still names Testing, and the step
    // then moves the task to the route's own next column.
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', 'Merge')], 'Verdict: Ready')).toEqual({ accepted: true });
  });

  it('never stops the card in a column with a forward row', () => {
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS, ON_TO_TESTING], 'Verdict: Ready')).toEqual({ accepted: true });
  });

  it('treats a row whose target names no column as no forward exit', () => {
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', null)], 'Verdict: Ready')).toBeNull();
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', null)], 'No changes to review.')).toBeNull();
  });

  // Decision: a dangling row (its target column no longer exists) is not a forward exit, so a
  // column with one send-back row and one dangling row is send-back-only. Stopping for a person
  // is the safe direction: the step never moves the card on past a row it cannot resolve.
  it('reads a send-back row beside a dangling row as send-back-only, and stops the card on a reply matching the dangling row', () => {
    const rows = [BACK_FOR_REVISIONS, exitTo('Verdict: Ready', null)];
    expect(isSendBackOnly(codeReview, rows)).toBe(true);
    expect(stepExitVerdict(codeReview, rows, 'Verdict: Ready')).toEqual({ accepted: true, stopsHere: true });
  });

  it('ignores a row whose Text match can match no line, since it never runs', () => {
    expect(stepExitVerdict(codeReview, [exitTo('---', 'Testing')], 'No changes to review.')).toBeNull();
  });

  it('quotes a long final line cut short', () => {
    const verdict = stepExitVerdict(codeReview, REVIEW_ROWS, 'x'.repeat(300));
    expect(verdict).toMatchObject({ accepted: false });
    expect(verdict && !verdict.accepted ? verdict.reason : '').toContain(`"${'x'.repeat(120)}...",`);
  });
});

/**
 * Which of a column's turn-end rows are exits, and where each sends the task.
 * Full Swimlane rows, since resolving a target reads the whole board.
 */
describe('columnExitRows', () => {
  function lane(id: string, name: string, position: number, overrides: Partial<Swimlane> = {}): Swimlane {
    return {
      id,
      name,
      description: null,
      role: null,
      position,
      color: '#888888',
      icon: null,
      is_archived: false,
      is_ghost: false,
      permission_mode: null,
      auto_spawn: true,
      auto_command: null,
      auto_command_mode: 'immediate',
      plan_exit_target_id: null,
      plan_approval: 'manual',
      agent_override: null,
      model_override: null,
      effort_override: null,
      handoff_context: false,
      session_target: 'main',
      session_spawn_strategy: 'create_or_resume',
      max_agents: null,
      created_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  const FULL_BOARD: Swimlane[] = [
    lane('todo', 'To Do', 0, { role: 'todo' }),
    lane('executing', 'Executing', 1),
    lane('review', 'Code Review', 2),
    lane('testing', 'Testing', 3),
    lane('done', 'Done', 4, { role: 'done', is_archived: true }),
  ];
  const REVIEW = FULL_BOARD[2];

  function row(overrides: Partial<ColumnAutomation>): ColumnAutomation {
    return {
      id: 'row',
      swimlane_id: 'review',
      name: 'Row',
      type: 'move_to_column',
      trigger: 'turn_end',
      position: 0,
      enabled: true,
      config: { targetColumn: 'Testing' },
      condition: null,
      final_line: 'Verdict: Ready',
      max_runs: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('keeps a move row with a final line, resolved to the board column it names', () => {
    expect(columnExitRows([row({})], FULL_BOARD, REVIEW, null)).toEqual([
      { finalLine: 'Verdict: Ready', source: 'agent', target: FULL_BOARD[3] },
    ]);
  });

  // #1078: a row on the user's message keeps its source, so the step check never reads it as an exit.
  it('marks a row whose Text match reads the user\'s message', () => {
    const [exit] = columnExitRows([row({ final_line: '*signed off*', text_match_source: 'user' })], FULL_BOARD, REVIEW, null);
    expect(exit.source).toBe('user');
  });

  it('drops a move row with no final line, since it moves on every turn end', () => {
    expect(columnExitRows([row({ final_line: null }), row({ final_line: '   ' })], FULL_BOARD, REVIEW, null)).toEqual([]);
  });

  it('drops a row that does not move the task, even with a final line', () => {
    const notAMove = row({ type: 'send_message', config: { message: 'Review done' } });
    expect(columnExitRows([notAMove], FULL_BOARD, REVIEW, null)).toEqual([]);
  });

  it('records a null target for a row whose column name matches no column', () => {
    const dangling = row({ config: { targetColumn: 'Nowhere' } });
    expect(columnExitRows([dangling], FULL_BOARD, REVIEW, null)).toEqual([
      { finalLine: 'Verdict: Ready', source: 'agent', target: null },
    ]);
  });

  it('sends a forward row to Done instead when the route skips the column it names', () => {
    // Testing is the last column before Done and the route skips it, so the
    // route's next column after Code Review is Done (resolveMoveTarget).
    const skippingTesting = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['testing'] };
    const [exit] = columnExitRows([row({})], FULL_BOARD, REVIEW, skippingTesting);
    expect(exit.target?.id).toBe('done');
  });

  it('keeps a send-back row on the column it names even when the route skips that column', () => {
    const skippingExecuting = { route_start_swimlane_id: null, route_last_swimlane_id: null, skipped_swimlane_ids: ['executing'] };
    const sendBack = row({ final_line: 'Verdict: Blocked', config: { targetColumn: 'Executing' } });
    const [exit] = columnExitRows([sendBack], FULL_BOARD, REVIEW, skippingExecuting);
    expect(exit.target?.id).toBe('executing');
  });
});

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
  describeStepRoute,
  stepExitVerdict,
  workflowBlockerConditions,
  workflowStepCondition,
  type StepExitRow,
} from '../../src/main/workflows/workflow-step-condition';
import type { Swimlane, Task } from '../../src/shared/types';

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
  const exitTo = (finalLine: string, targetName: string | null): StepExitRow => ({
    finalLine,
    target: targetName === null ? null : columnNamed(targetName),
  });
  const BACK_FOR_REVISIONS = exitTo('Verdict: Blocked', 'Executing');
  const ON_TO_TESTING = exitTo('Verdict: Ready', 'Testing');
  const REVIEW_ROWS = [BACK_FOR_REVISIONS, ON_TO_TESTING];

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

  it('leaves the check alone in a column whose only row sends the task back, when the reply does not match it', () => {
    // The step itself is that column's forward exit.
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS], 'Reviewed and fixed everything.')).toBeNull();
  });

  it('still refuses a send-back match in a column with no forward row', () => {
    expect(stepExitVerdict(codeReview, [BACK_FOR_REVISIONS], 'Verdict: Blocked')).toMatchObject({ accepted: false });
  });

  it('counts a row into Done as forward, and a wildcard pattern as a match', () => {
    expect(stepExitVerdict(codeReview, [exitTo('Ready for *', 'Done')], 'Ready for testing')).toEqual({ accepted: true });
  });

  it('counts a later column as forward even when the route skips it', () => {
    // A route that skips Testing: the row still names Testing, and the step
    // then moves the task to the route's own next column.
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', 'Merge')], 'Verdict: Ready')).toEqual({ accepted: true });
  });

  it('treats a row whose target names no column as no forward exit', () => {
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', null)], 'Verdict: Ready')).toBeNull();
    expect(stepExitVerdict(codeReview, [exitTo('Verdict: Ready', null)], 'No changes to review.')).toBeNull();
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

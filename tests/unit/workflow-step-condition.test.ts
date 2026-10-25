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
  workflowStepCondition,
  workflowStepNeedsUserCondition,
  workflowStepRunningCondition,
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

// The second ask, made only when the step is not done: why the agent stopped.
// Its wording is measured with scripts/eval-condition-check.mjs; these pin what
// each question must say so an edit cannot drop a case it covers.
describe('why a step that is not done stopped', () => {
  it('asks whether the agent waits on work still running on its own, which wakes it by itself', () => {
    const condition = workflowStepRunningCondition({ name: 'Executing' });
    expect(condition).toContain('it is waiting for something other than the user to finish for the Executing step');
    expect(condition).toContain('background');
    // Measured: a bare "Waiting for the gate." read as no running work until CI
    // and a gate were named, and until a bare wait was said to count. Naming
    // them made a plain progress note ("still working through the failing
    // tests") read as running, so the agent's own in-turn work is named as not this.
    expect(condition).toContain('CI checks, a gate');
    expect(condition).toContain('it will go on once that finishes');
    expect(condition).toContain('only says it is waiting for the gate, the tests or CI counts');
    expect(condition).toContain('work the agent itself was in the middle of');
  });

  // The workflow stops only on this yes, so it must be shown, never assumed.
  // Measured: when the unsure answer stopped the workflow instead, 30 of a
  // board's 311 not-done turn ends stopped wrongly, 5 of the 7 a person had to
  // push on among them.
  it('asks whether the agent needs what only the user can give, and names what is not that', () => {
    const condition = workflowStepNeedsUserCondition({ name: 'Executing' });
    expect(condition).toContain('asks the user for something it cannot get or decide on its own, and the Executing step cannot go on without it');
    expect(condition).toContain('a choice between options that changes the result');
    expect(condition).toContain('information or a secret that is not in the repository or the environment');
    expect(condition).toContain('an approval for something outside the step\'s own work, such as deleting data');
    // The one real question on that board's history asked to go on with the
    // step's own work, and the person answered by moving the card on.
    expect(condition).toContain('Asking whether to go ahead with the step\'s own work (commit, run the gate or the tests, open the pull request, move on) is not this.');
    expect(condition).toContain('a list of next steps, a progress note, or a note that a tool or service failed');
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

import type { WorkflowState } from '../../../shared/types';

/**
 * The workflow engine's decisions, as pure functions over plain data.
 *
 * Nothing here reads a database, an IPC channel, Electron, analytics or Sentry,
 * and nothing here schedules a timer: the host (`workflow-engine-host.ts`)
 * gathers a snapshot of each running workflow, asks this module what to do, and
 * carries out the answer through the one move path. That split is what lets the
 * core move to a utility process later as a transport change, not a rewrite
 * (#732, Open questions 2), and it is pinned by
 * `tests/unit/workflow-engine-boundary.test.ts`.
 *
 * The rules it encodes (the plan's "Gates and starting"):
 * - A task starts when every task it waits for is in Done. There is no early
 *   start. A blocker missing from the snapshot never counts as done: its
 *   project's database may only be failing to open for a moment, with the
 *   blocker still running there.
 * - A link with an end that is provably gone (its task deleted, or its project
 *   removed, with the link left behind because its removal failed) is dropped,
 *   as the delete would have dropped it. The host decides "provably"
 *   (`linkEndState`) and hands those links over as `goneLinks`, apart from
 *   `links`, so they hold nothing in the pass that drops them.
 * - Ready tasks start in To Do order, up to the free agent slots. To Do is the
 *   durable queue, so a large workflow never fills the in-memory spawn queue.
 * - A workflow is complete when every task in it is in Done.
 */

/** Where a task is, as far as gating is concerned. */
export type CorePlace = 'todo' | 'working' | 'done';

export interface CoreTask {
  projectId: string;
  taskId: string;
  displayId: number;
  place: CorePlace;
  /** Its order in To Do: starts go top first. */
  todoPosition: number;
  /** The column a start moves it into, or null when its board has nowhere to start it. */
  startColumnId: string | null;
  /** Whether that column starts an agent, so a start takes a slot. */
  startTakesSlot: boolean;
  /** Its automations are paused: it stays in To Do, and what waits for it keeps waiting. */
  held: boolean;
}

export interface CoreLink {
  blockerProjectId: string;
  blockerTaskId: string;
  blockedProjectId: string;
  blockedTaskId: string;
}

export interface CoreWorkflow {
  workflowId: string;
  homeProjectId: string;
  state: WorkflowState;
  /** Started first, served first, when slots are short. */
  startedAt: string | null;
  tasks: CoreTask[];
  links: CoreLink[];
  /** Links with an end that is provably gone: dropped, and never read as holding a task. */
  goneLinks: CoreLink[];
}

export type CoreIntent =
  | {
    kind: 'start';
    workflowId: string;
    homeProjectId: string;
    projectId: string;
    taskId: string;
    toSwimlaneId: string;
    /** Whether the start spends an agent slot, so the host can hold one back while it is in flight. */
    takesSlot: boolean;
  }
  | { kind: 'complete'; workflowId: string; homeProjectId: string }
  | { kind: 'drop-links'; workflowId: string; homeProjectId: string; links: CoreLink[] };

function taskKey(projectId: string, taskId: string): string {
  return `${projectId}\n${taskId}`;
}

/** What `task` waits for, as links. */
export function blockersOf(workflow: CoreWorkflow, task: Pick<CoreTask, 'projectId' | 'taskId'>): CoreLink[] {
  return workflow.links.filter((link) => link.blockedTaskId === task.taskId && link.blockedProjectId === task.projectId);
}

/**
 * Is every task `task` waits for in Done? A blocker missing from the workflow's
 * tasks is not done: a provably gone one arrives in `goneLinks` instead, so what
 * is left missing here is one the host could not read.
 */
export function blockersDone(workflow: CoreWorkflow, task: Pick<CoreTask, 'projectId' | 'taskId'>): boolean {
  const placeByKey = new Map(workflow.tasks.map((entry) => [taskKey(entry.projectId, entry.taskId), entry.place]));
  return blockersOf(workflow, task).every(
    (link) => placeByKey.get(taskKey(link.blockerProjectId, link.blockerTaskId)) === 'done',
  );
}

/** Tasks that can start now: in To Do, not held, with somewhere to start, and nothing left to wait for. */
export function readyTasks(workflow: CoreWorkflow): CoreTask[] {
  return workflow.tasks
    .filter((task) => task.place === 'todo' && !task.held && task.startColumnId !== null && blockersDone(workflow, task))
    .sort((left, right) => left.todoPosition - right.todoPosition);
}

/** Every task in Done. An empty workflow is never complete: it has not done anything. */
export function isComplete(workflow: CoreWorkflow): boolean {
  return workflow.tasks.length > 0 && workflow.tasks.every((task) => task.place === 'done');
}

/**
 * One pass over every running workflow: which links to drop, which tasks to
 * start, and which workflows are complete.
 *
 * `freeSlots` is the app-wide count of agent slots not in use; a start into a
 * column that starts no agent takes none. The host passes it net of the starts
 * still in flight, since a start's session does not count against the slots
 * until its spawn registers, seconds later. `inFlight` holds the keys
 * (`projectId\ntaskId`) of starts already issued and not yet committed, so a
 * pass that runs while a start is still moving never issues it twice.
 */
export function planPass(
  workflows: readonly CoreWorkflow[],
  freeSlots: number,
  inFlight: ReadonlySet<string>,
): CoreIntent[] {
  const intents: CoreIntent[] = [];
  let slots = Math.max(0, freeSlots);
  const ordered = workflows
    .slice()
    .sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''));
  for (const workflow of ordered) {
    if (workflow.state !== 'running' && workflow.state !== 'paused') continue;
    if (workflow.goneLinks.length > 0) {
      intents.push({ kind: 'drop-links', workflowId: workflow.workflowId, homeProjectId: workflow.homeProjectId, links: workflow.goneLinks });
    }
    if (isComplete(workflow)) {
      intents.push({ kind: 'complete', workflowId: workflow.workflowId, homeProjectId: workflow.homeProjectId });
      continue;
    }
    // A paused workflow starts nothing; it can still complete (a person may
    // drag its last card to Done while it is paused).
    if (workflow.state !== 'running') continue;
    for (const task of readyTasks(workflow)) {
      if (inFlight.has(inFlightKey(task.projectId, task.taskId))) continue;
      if (task.startTakesSlot) {
        if (slots === 0) continue;
        slots -= 1;
      }
      intents.push({
        kind: 'start',
        workflowId: workflow.workflowId,
        homeProjectId: workflow.homeProjectId,
        projectId: task.projectId,
        taskId: task.taskId,
        toSwimlaneId: task.startColumnId!,
        takesSlot: task.startTakesSlot,
      });
    }
  }
  return intents;
}

/** The key `planPass` reads `inFlight` by. */
export function inFlightKey(projectId: string, taskId: string): string {
  return taskKey(projectId, taskId);
}

/**
 * Would linking `blocker` before `blocked` close a loop? True when `blocked`
 * already leads to `blocker` through existing links (or they are the same task).
 * Used by every write that adds a link, before it writes.
 */
export function wouldCreateCycle(
  links: ReadonlyArray<Pick<CoreLink, 'blockerTaskId' | 'blockedTaskId'>>,
  blockerTaskId: string,
  blockedTaskId: string,
): boolean {
  if (blockerTaskId === blockedTaskId) return true;
  const dependents = new Map<string, string[]>();
  for (const link of links) {
    const list = dependents.get(link.blockerTaskId) ?? [];
    list.push(link.blockedTaskId);
    dependents.set(link.blockerTaskId, list);
  }
  // Walk forward from `blocked`: reaching `blocker` means blocker already waits on blocked.
  const stack = [blockedTaskId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockerTaskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of dependents.get(current) ?? []) stack.push(next);
  }
  return false;
}

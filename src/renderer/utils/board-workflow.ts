import type { Swimlane, Task, Workflow, WorkflowBoardTask, WorkflowState, WorkflowSummary } from '../../shared/types';
import { workflowMoveRefusal } from '../../shared/workflow-lock';
import { WORKFLOW_REFUSALS } from '../../shared/workflow-refusals';
import { waitingLabel } from '../../shared/workflow-waiting';

/**
 * A workflow task as its board card reads it: the workflow's name, color and
 * state for the strip, what the footer says it waits for, and the lock. Read
 * from the workflow summaries (this board's project, and each other project a
 * card's workflow lives in), never from the workflow's full detail, so a board
 * pays nothing per card beyond a lookup.
 *
 * Pure and free of the canvas library: the board imports it eagerly.
 */
export interface BoardWorkflow {
  workflowId: string;
  homeProjectId: string;
  title: string;
  colorSlot: number;
  state: WorkflowState;
  /** The tasks it waits for that are not done ("#413"). */
  waitingFor: readonly string[];
  /** While it runs and the task sits in a human gate: the column a person may drag it to. */
  humanGateTargetId: string | null;
  /** It has a link, either way, so its strip can show the links. */
  hasLinks: boolean;
  /** Why its running workflow stalled on it, while that holds, for the strip's mark. */
  stallReason: string | null;
}

const NOTHING: readonly string[] = [];

/** Where a card's workflow facts live: its summary, its own row in it, and the workflow's home. */
export interface BoardWorkflowSource {
  workflow: Workflow;
  facts: WorkflowBoardTask | null;
  homeProjectId: string;
}

export function boardWorkflowSource(
  summaries: readonly WorkflowSummary[],
  homeSummaries: Readonly<Record<string, WorkflowSummary[]>>,
  task: Pick<Task, 'id' | 'workflow_id' | 'workflow_project_id'>,
  boardProjectId: string | null,
): BoardWorkflowSource | null {
  if (!task.workflow_id) return null;
  const homeProjectId = task.workflow_project_id ?? boardProjectId;
  if (!homeProjectId) return null;
  const list = homeProjectId !== boardProjectId ? homeSummaries[homeProjectId] ?? [] : summaries;
  const summary = list.find((candidate) => candidate.workflow.id === task.workflow_id);
  // Not loaded yet, or finished (a finished workflow leaves every list): no strip.
  if (!summary) return null;
  return { workflow: summary.workflow, facts: summary.boardTasks[task.id] ?? null, homeProjectId };
}

export function toBoardWorkflow(source: BoardWorkflowSource): BoardWorkflow {
  return {
    workflowId: source.workflow.id,
    homeProjectId: source.homeProjectId,
    title: source.workflow.title,
    colorSlot: source.workflow.color_slot,
    state: source.workflow.state,
    waitingFor: source.facts?.waitingFor ?? NOTHING,
    humanGateTargetId: source.facts?.humanGateTargetId ?? null,
    hasLinks: source.facts?.hasLinks ?? false,
    stallReason: source.facts?.stallReason ?? null,
  };
}

/** A card's workflow, read at the moment of a click or a drop rather than subscribed. */
export function boardWorkflowOf(
  summaries: readonly WorkflowSummary[],
  homeSummaries: Readonly<Record<string, WorkflowSummary[]>>,
  task: Pick<Task, 'id' | 'workflow_id' | 'workflow_project_id'>,
  boardProjectId: string | null,
): BoardWorkflow | null {
  const source = boardWorkflowSource(summaries, homeSummaries, task, boardProjectId);
  return source ? toBoardWorkflow(source) : null;
}

/**
 * Only its workflow moves this card: the workflow runs and the card is not in
 * a human gate, where a person drags it on. A drag of it stays in its own
 * column, to reorder it there (`useBoardDragDrop`), and reaches no other.
 */
export function isLockedOnBoard(workflow: BoardWorkflow): boolean {
  return workflow.state === 'running' && workflow.humanGateTargetId === null;
}

/** Why a person may not move this card to that column, in main's own words; null allows it. */
export function boardMoveRefusal(
  workflow: BoardWorkflow | null,
  task: Pick<Task, 'display_id' | 'swimlane_id'>,
  target: Pick<Swimlane, 'id' | 'role'> | null | undefined,
): string | null {
  if (!workflow || !target) return null;
  return workflowMoveRefusal({
    displayId: task.display_id,
    workflowTitle: workflow.title,
    workflowState: workflow.state,
    origin: 'renderer',
    fromSwimlaneId: task.swimlane_id,
    toSwimlaneId: target.id,
    toRole: target.role ?? null,
    moverIsTaskAgent: false,
    humanGateTargetId: workflow.humanGateTargetId,
  });
}

/** Is this error text one of the lock's refusals for this task (rather than some other failure)? */
export function isWorkflowLockMessage(message: string, task: Pick<Task, 'display_id'>, workflow: BoardWorkflow | null): boolean {
  if (!workflow) return false;
  const label = `#${task.display_id}`;
  return message === WORKFLOW_REFUSALS.locked(label, workflow.title)
    || message === WORKFLOW_REFUSALS.toDoNeedsRemove(label, workflow.title)
    || message === WORKFLOW_REFUSALS.pausedForAgents(label, workflow.title);
}

/**
 * Why Backlog and Archive are not offered: each takes the task out of its
 * workflow, which only Remove does. While the workflow runs the card is locked
 * outright; otherwise it says how.
 */
export function sendAwayRefusal(workflow: BoardWorkflow | null, task: Pick<Task, 'display_id'>): string | null {
  if (!workflow) return null;
  const label = `#${task.display_id}`;
  return workflow.state === 'running'
    ? WORKFLOW_REFUSALS.locked(label, workflow.title)
    : WORKFLOW_REFUSALS.removeFirst(label, workflow.title);
}

/** What a workflow task's footer says while it sits in To Do with no session. */
export function boardWaiting(workflow: BoardWorkflow | null): { label: string; paused: boolean } | null {
  if (!workflow || workflow.state === 'draft' || workflow.state === 'done') return null;
  return waitingLabel(workflow.waitingFor, workflow.state === 'paused');
}

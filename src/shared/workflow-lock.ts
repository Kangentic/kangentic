import type { MessageDescriptor } from '@lingui/core';
import type { SwimlaneRole, WorkflowState } from './types';
import { WORKFLOW_REFUSAL_MESSAGES } from './workflow-refusals';
import { englishText } from './i18n/english';
import { isMoveByAPerson } from './task-move-origin';

/**
 * Who may move a workflow task, as one pure predicate.
 *
 * Every move path asks this before it moves anything: `handleTaskMove`
 * (drags, the phone, plan exit, automations, the engine), and the MCP move
 * tool before it fires its move, which is the only place an agent can see a
 * refusal. The board asks it too, before a drag or a menu move leaves the
 * card's column, so a refused move never shows the card moving first. The
 * answer is a sentence for the person or agent that asked, or null to allow.
 *
 * The rules (the plan's "Running, pausing, the lock" and "Revise and return"):
 * - A task in a running workflow moves only by the workflow and its
 *   automations, and by its OWN agent (main session or an isolated column's),
 *   whose `kangentic_move_task` is how a column's work reports itself done.
 *   Drags, the phone and other agents are refused, except that a person may drag
 *   a card out of a human gate (a column whose work no agent can judge) into
 *   the next column on its route: the drag is the report.
 * - A paused workflow's cards move by hand, except into To Do.
 * - A card whose automations are paused (the task's own hold) moves by hand as
 *   a paused workflow's card does, while the rest of its workflow runs: the
 *   person working it is the one who moves it on.
 * - No workflow task moves into To Do by any path: that move kills the session
 *   and deletes the worktree and branch. Remove it from the workflow first.
 *   A person moving a running workflow's card reads the lock's own sentence
 *   for To Do as for every other column (boards 6 and 1d): the card is locked
 *   outright, so the To Do row says nothing different. A paused or held card,
 *   and any agent, read the To Do sentence, which says what to do instead.
 * - Reordering within a column is presentation and is never refused.
 */
export type WorkflowMoveOrigin = 'renderer' | 'agent' | 'mobile' | 'auto-move' | 'automation' | 'workflow';

export interface WorkflowMoveCheck {
  displayId: number;
  workflowTitle: string;
  workflowState: WorkflowState;
  origin: WorkflowMoveOrigin;
  fromSwimlaneId: string;
  toSwimlaneId: string;
  toRole: SwimlaneRole | null;
  /** The mover is the task's own agent session. */
  moverIsTaskAgent: boolean;
  /**
   * The task's automations are paused (`canTaskRunAutomations` is not ok): a
   * person may move it as a paused workflow's card, whatever its workflow does.
   */
  taskHeld: boolean;
  /**
   * When the task's column is a human gate, the column a person may drag it
   * to (the next on its route); null when the column is not a gate.
   */
  humanGateTargetId: string | null;
}

/**
 * The refusal in English: what main throws, an agent reads, and the board
 * matches a failed move against (`workflow-refusals.ts`).
 */
export function workflowMoveRefusal(check: WorkflowMoveCheck): string | null {
  const refusal = workflowMoveRefusalMessage(check);
  return refusal === null ? null : englishText(refusal);
}

/** The same refusal as a message, for the board to show in the session language. */
export function workflowMoveRefusalMessage(check: WorkflowMoveCheck): MessageDescriptor | null {
  if (check.fromSwimlaneId === check.toSwimlaneId) return null;
  if (check.workflowState === 'draft' || check.workflowState === 'done') return null;
  const label = `#${check.displayId}`;
  const byHand = isMoveByAPerson(check.origin);
  // A held card in a running workflow is the person's to move, as a paused one is.
  const lockedForHands = check.workflowState === 'running' && !check.taskHeld;
  if (check.toRole === 'todo') {
    return byHand && lockedForHands
      ? WORKFLOW_REFUSAL_MESSAGES.locked(label, check.workflowTitle)
      : WORKFLOW_REFUSAL_MESSAGES.toDoNeedsRemove(label, check.workflowTitle);
  }
  if (check.origin === 'workflow' || check.origin === 'automation' || check.origin === 'auto-move') return null;
  if (check.origin === 'agent' && check.moverIsTaskAgent) return null;

  if (check.workflowState === 'paused') {
    if (byHand) return null;
    return WORKFLOW_REFUSAL_MESSAGES.pausedForAgents(label, check.workflowTitle);
  }
  if (byHand && check.taskHeld) return null;
  if (byHand && check.humanGateTargetId !== null && check.humanGateTargetId === check.toSwimlaneId) return null;
  return WORKFLOW_REFUSAL_MESSAGES.locked(label, check.workflowTitle);
}

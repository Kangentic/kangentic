import type { MessageDescriptor } from '@lingui/core';
import type { ActivityState, SessionStatus, SwimlaneRole, WorkflowState } from './types';
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
 * - A task in a running workflow moves by the workflow and its automations, and
 *   by its OWN agent (main session or an isolated column's), whose
 *   `kangentic_move_task` is how a column's work reports itself done. Other agents
 *   are refused. A person's hand is too while the card is in motion, and a
 *   person may move it once it stops: in motion, locked; stopped, the owner's
 *   (owner's decision, 2026-11-05). In motion means the agent is working, sits at
 *   a prompt, a turn-end pass is acting on its reply, a message is on its way to
 *   it, or it is starting. A card that stopped moves anywhere but To Do, as a
 *   paused workflow's card does, and the route carries on from where it lands
 *   (`nextOnRoute` works from any column). A card still in To Do stays locked,
 *   because only the engine starts it, and so does a card in Done, because moving
 *   it out would un-finish a blocker.
 * - A paused workflow moves none of its cards itself: a step move or an
 *   engine start that raced the Pause is refused here, under the move's task
 *   lock. A person moves its cards by hand, except into To Do. A card a person
 *   works while it is paused is an ordinary card, so its column automations,
 *   its own agent and a plan approval still move it.
 * - No workflow task moves into To Do by any path: that move kills the session
 *   and deletes the worktree and branch. Remove it from the workflow first.
 *   A person moving a running workflow's card reads the lock's own sentence
 *   for To Do as for every other column (boards 6 and 1d): the card is locked
 *   outright, so the To Do row says nothing different. A paused or stopped
 *   card, and any agent, read the To Do sentence, which says what to do instead.
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
   * The card has stopped, so a person may move it: `isWorkflowTaskStopped` in
   * main, `isStoppedOnBoard` on the board. Agents ask with false.
   */
  taskStopped: boolean;
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
  // A stopped card in a running workflow is the person's to move, as a paused one is.
  const lockedForHands = check.workflowState === 'running' && !check.taskStopped;
  if (check.toRole === 'todo') {
    return byHand && lockedForHands
      ? WORKFLOW_REFUSAL_MESSAGES.locked(label, check.workflowTitle)
      : WORKFLOW_REFUSAL_MESSAGES.toDoNeedsRemove(label, check.workflowTitle);
  }
  if (check.origin === 'workflow') {
    return check.workflowState === 'paused' ? WORKFLOW_REFUSAL_MESSAGES.pausedForAgents(label, check.workflowTitle) : null;
  }
  if (check.origin === 'automation' || check.origin === 'auto-move') return null;
  if (check.origin === 'agent' && check.moverIsTaskAgent) return null;

  if (check.workflowState === 'paused') {
    if (byHand) return null;
    return WORKFLOW_REFUSAL_MESSAGES.pausedForAgents(label, check.workflowTitle);
  }
  if (byHand && check.taskStopped) return null;
  return WORKFLOW_REFUSAL_MESSAGES.locked(label, check.workflowTitle);
}

/** What the board holds about a card when a person reaches for it. */
export interface BoardStopFacts {
  columnRole: SwimlaneRole | null | undefined;
  /** The task's session row, or null when the replica holds none. */
  sessionStatus: SessionStatus | null;
  activity: ActivityState | undefined;
  /** Main is setting the card's agent up: a worktree, a fetch, a spawn. */
  starting: boolean;
}

/**
 * Has this card stopped, as far as the board can see? Asked at the moment of a
 * drag or a click, so a card never slides into a column main would refuse. Main
 * sees more (a turn-end pass, a message on its way) and asks again in
 * `isWorkflowTaskStopped`: a drag that races one gets the refusal toast.
 *
 * Idle alone, not `requiresUserInteraction`: that bucket holds a permission
 * prompt, which is the agent mid-turn, in motion.
 */
export function isStoppedOnBoard(facts: BoardStopFacts): boolean {
  if (facts.columnRole === 'todo' || facts.columnRole === 'done') return false;
  if (facts.starting || facts.sessionStatus === 'queued') return false;
  if (facts.sessionStatus !== 'running') return true;
  // activity-state-ok: granular, only a finished turn stops a card, never a prompt.
  return facts.activity === 'idle';
}

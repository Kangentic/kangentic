import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { englishText } from './i18n/english';

/**
 * What a workflow guard says, in one place. Main refuses with these sentences
 * (over IPC and MCP), and the Workflows view and task detail's workflow panel
 * put the same words on the control they disable, so a disabled control's
 * tooltip and the refusal its action would get can never drift apart.
 *
 * `label` names the task the way the reader sees it: "#414" once it exists,
 * its title in quotes before Start (a planned task has no number yet).
 *
 * Two forms of one wording. `WORKFLOW_REFUSAL_MESSAGES` holds the messages,
 * which the renderer shows in the session language (`translateText`).
 * `WORKFLOW_REFUSALS` is the same sentence in English: what main throws, what
 * an agent reads over MCP, what crosses to the phone, and what the renderer
 * matches a thrown refusal against. Main and the renderer only agree on a
 * refusal while both read it in English.
 */
export const WORKFLOW_REFUSAL_MESSAGES = {
  /** A link onto a task that has left To Do. */
  cannotWait: (label: string) => withValues(msg({ message: '{label} has started. Only a task in To Do can wait for another.' }), { label }),
  /** Add blocker on a task whose every other task is done, already blocks it, or waits on it. */
  noBlockerCandidates: msg`No task it can wait for.`,
  /** A link from a task already in Done. */
  blockerDone: (label: string) => withValues(msg({ message: '{label} is done. Waiting for it changes nothing.' }), { label }),
  selfLink: msg`A task cannot wait for itself.`,
  alreadyWaits: (blockedLabel: string, blockerLabel: string) =>
    withValues(msg({ message: '{blockedLabel} already waits for {blockerLabel}.' }), { blockedLabel, blockerLabel }),
  loop: msg`That link closes a loop. A workflow's links cannot go in a circle.`,
  /** Removing a link whose waiting task has started, or whose blocker is done. */
  unlinkChangesNothing: (label: string, fact: 'is done' | 'has started') => (fact === 'is done'
    ? withValues(msg({ message: '{label} is done. Removing the link changes nothing.' }), { label })
    : withValues(msg({ message: '{label} has started. Removing the link changes nothing.' }), { label })),
  /** Removing a task in Done from its workflow. */
  doneStays: (label: string) => withValues(msg({ message: '{label} is done and stays with its workflow.' }), { label }),
  routeEmpty: msg`A task visits at least one column.`,
  /** A route step at or before the column the task is in (finished, current, or skipped on the way). */
  stepReached: (label: string, columnName: string) =>
    withValues(msg({ message: '{label} has reached {columnName}. Only the columns after it can change.' }), { label, columnName }),
  /** A plan approval change on a task past its last plan column. */
  planPassed: (label: string, columnName: string) =>
    withValues(msg({ message: '{label} has passed {columnName}. Its plan approval can no longer change.' }), { label, columnName }),
  /** A plan approval change on a task in Done. */
  planDone: (label: string) => withValues(msg({ message: '{label} is done. Its plan approval can no longer change.' }), { label }),
  /** A plan approval value outside the two, from an IPC, MCP or mobile caller. */
  planApprovalValue: msg`planApproval must be "automatic", "manual", or null.`,
  /** kangentic_save_workflow's removed workflow-level planApproval. */
  planApprovalPerTask: msg`planApproval is set per task now. Put planApproval on each task entry.`,
  /** A plan approval change, over MCP, on a task in no workflow. */
  notInWorkflow: (label: string) =>
    withValues(msg({ message: "{label} is not in a workflow. Its column's Plan approval decides; change that with kangentic_update_column." }), { label }),
  /** While the workflow agent's turn runs, whatever would change its plan waits. */
  agentWorking: msg`Available when the workflow agent finishes`,
  /** A move of a running workflow's task that only the workflow may make. */
  locked: (label: string, workflowTitle: string) =>
    withValues(msg({ message: '{label} is locked while {workflowTitle} runs.' }), { label, workflowTitle }),
  /** A move into To Do, which would delete the task's worktree and branch. */
  toDoNeedsRemove: (label: string, workflowTitle: string) =>
    withValues(msg({ message: '{label} is in {workflowTitle}. Remove it from the workflow to move it to To Do.' }), { label, workflowTitle }),
  /**
   * A paused workflow's task moved by another task's agent, or by the workflow
   * itself (a step move or a start that raced the Pause). A person may still
   * move it by hand.
   */
  pausedForAgents: (label: string, workflowTitle: string) =>
    withValues(msg({ message: '{label} is in {workflowTitle}, which is paused. Resume it to move its tasks.' }), { label, workflowTitle }),
  /** Sending a workflow task to the backlog or the archive. */
  removeFirst: (label: string, workflowTitle: string) =>
    withValues(msg({ message: 'Remove {label} from {workflowTitle} first.' }), { label, workflowTitle }),
  /**
   * A workflow its home does not hold: deleted, or its home project is. A task
   * detail's workflow panel reads this sentence in a failed read to tell a
   * workflow that is gone from one that could not be read this time.
   */
  notFound: (workflowSelector: string) =>
    withValues(msg({ message: 'No workflow "{workflowSelector}" in this project.' }), { workflowSelector }),
} as const;

type RefusalMessages = typeof WORKFLOW_REFUSAL_MESSAGES;
type EnglishRefusal<Entry> = Entry extends (...args: infer Args) => MessageDescriptor ? (...args: Args) => string : string;
type EnglishRefusals = { readonly [Key in keyof RefusalMessages]: EnglishRefusal<RefusalMessages[Key]> };

/**
 * Each refusal in English. A plain refusal is a getter, so it resolves when it
 * is read rather than when this module loads: the English catalog is not loaded
 * yet then, and a production renderer's descriptor carries only its id.
 */
export const WORKFLOW_REFUSALS: EnglishRefusals = englishRefusals(WORKFLOW_REFUSAL_MESSAGES);

function englishRefusals(messages: RefusalMessages): EnglishRefusals {
  const english: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(messages)) {
    if (typeof entry === 'function') {
      // Every builder takes strings: labels, titles and the one 'is done' | 'has started' fact.
      const build = entry as (...values: string[]) => MessageDescriptor;
      english[key] = (...args: string[]) => englishText(build(...args));
    } else {
      Object.defineProperty(english, key, { enumerable: true, get: () => englishText(entry) });
    }
  }
  return english as EnglishRefusals;
}

/** A message with the values its placeholders read. The object form of `msg` takes none of its own. */
function withValues(descriptor: MessageDescriptor, values: Record<string, string>): MessageDescriptor {
  return { ...descriptor, values };
}

/** How a task is named in a refusal: its number once it exists, its title before Start. */
export function workflowTaskLabel(displayId: number | null | undefined, title: string): string {
  return displayId ? `#${displayId}` : `"${title}"`;
}

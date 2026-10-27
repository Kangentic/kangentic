import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { OnboardingStepKey, Swimlane } from '../../../shared/types';
import type { LocalizedText } from '../../../shared/i18n/text';

import { resolveAutoSpawnLane } from '../../hooks/useOnboardingProgress';
import { translateText } from '../../i18n/translate';

/** What a checklist item needs in order to take the user to the right place. Passed in by
 *  the dialog rather than imported here, so these definitions stay pure and testable. */
export interface WalkthroughActivateContext {
  openProjectSettings: (tabId: string) => void;
  openBoardManager: (laneId: string | null) => void;
  requestNewTask: () => void;
  swimlanes: Swimlane[];
}

export interface WalkthroughStepDefinition {
  key: OnboardingStepKey;
  /** Checklist row label. Sentence case, verb-first. Read it through `resolveStepLabel`. */
  label: LocalizedText;
  /** One line under the label in the checklist. Resolve it with `translateText` where it renders. */
  description: LocalizedText;
  /** Runs when the user clicks the row. Opens the surface; never fills anything in. */
  activate: (context: WalkthroughActivateContext) => void;
  /**
   * Whether `activate` puts a dialog on screen.
   *
   * The callout is positioned around whatever dialogs are up, and a dialog takes a moment to
   * mount and animate in. Without knowing one is COMING, the overlay places itself against an
   * empty screen, paints, and then jumps once the dialog lands - a visible flash on every one
   * of these steps. Declared here rather than sniffed from store flags because the New Task
   * dialog keeps its open state inside the board component.
   */
  opensDialog: boolean;
  /**
   * CSS selector for the element to ring, resolved live against the DOM. Returning null
   * means "nothing to point at" - the callout then renders unanchored rather than ringing
   * whatever happens to be at 0,0.
   */
  resolveTargetSelector: (swimlanes: Swimlane[]) => string | null;
  /** Callout heading beside the ring. Resolved in the session's language when called. */
  calloutTitle: (swimlanes: Swimlane[]) => string;
  /**
   * Callout body. States what to do, why it matters, and what earns the tick.
   *
   * Fixed for the life of the step: it does NOT swap to a confirmation once the step
   * completes. Rewriting the instructions out from under someone who is still working in the
   * panel loses the thing they were reading; the check beside the title is state enough.
   * Resolved in the session's language when called.
   */
  calloutBody: (swimlanes: Swimlane[]) => string;
}

/**
 * The column Board manager should land on when the checklist opens it.
 *
 * The agent-starting column, not the first one. Board manager renders no editor at all with
 * nothing selected, and landing on To Do showed a form whose Agent, Automation, and Handoff
 * sections all read "sessions don't run in To Do columns, so this doesn't apply" - which
 * flatly contradicts a callout offering to change the column's agent. The agent-starting
 * column has every section live, and it is the same column step 4 goes on to talk about.
 */
function initialBoardManagerLaneId(swimlanes: Swimlane[]): string | null {
  const autoSpawnLane = resolveAutoSpawnLane(swimlanes);
  if (autoSpawnLane) return autoSpawnLane.id;
  const candidates = swimlanes
    .filter((lane) => !lane.is_ghost && !lane.is_archived)
    .slice()
    .sort((first, second) => first.position - second.position);
  return candidates[0]?.id ?? null;
}

/**
 * The five steps, in presentation order.
 *
 * Step 4 resolves its target and its copy from `resolveAutoSpawnLane`, never from the name
 * "Planning". Step 2 invites the user to rename columns, so a name-based lookup would break
 * for precisely the users who did what we asked. The same bug already shipped once as a
 * `[data-swimlane-name="Backlog"]` selector that matched nothing.
 */
export const WALKTHROUGH_STEPS: readonly WalkthroughStepDefinition[] = [
  {
    key: 'defaultsChosen',
    label: msg`Choose your defaults`,
    // "or", not "and". The step ticks on ANY one of the four differing from what the project
    // started with, and which of them an agent even exposes varies, so copy that lists all
    // four as a set reads as a checklist of its own and makes the step look unfinished.
    description: msg`Set the agent, model, effort, or permission mode new tasks inherit.`,
    activate: ({ openProjectSettings }) => openProjectSettings('agent'),
    opensDialog: true,
    // No spotlight: this step just takes the user to the Agent tab, and that tab IS the
    // guidance. A ring here was worse than nothing - scoped to the four inputs it sliced
    // through every dropdown chevron and bisected the Agent description, and scoped wider
    // it would just outline a panel already filling half the screen, with the callout
    // floating over the settings nav.
    resolveTargetSelector: () => null,
    calloutTitle: () => i18n._(msg`Set your defaults`),
    // Ends by naming the bar, because there is no way to guess it from the panel: four
    // controls with nothing marking any of them as required reads as "fill all of these in".
    calloutBody: () => i18n._(msg`Every task starts with these unless a column overrides them. Change any one and this step is done.`),
  },
  {
    key: 'boardShaped',
    label: msg`Shape your board`,
    description: msg`Rename columns, change their colors and icons, or add your own.`,
    activate: ({ openBoardManager, swimlanes }) => openBoardManager(initialBoardManagerLaneId(swimlanes)),
    opensDialog: true,
    // No spotlight, for the same reason as step 1 - and because the ring was actively
    // misleading here: it sat on the Name field, while this step is about the whole
    // column editor (icon, color, agent, automation, the column list, Save).
    resolveTargetSelector: () => null,
    calloutTitle: () => i18n._(msg`Make the board yours`),
    // Any saved change ticks this off. Ends by naming the way back in, since the checklist
    // opened this dialog for the user and they would otherwise never learn that a column
    // header is what opens it.
    calloutBody: () => i18n._(msg`Rename a column, or give it a different icon, color, or agent. Click any column header to open this again.`),
  },
  {
    key: 'taskCreated',
    label: msg`Create a task`,
    description: msg`Say what you want done in a sentence or two.`,
    activate: ({ requestNewTask }) => requestNewTask(),
    opensDialog: true,
    // Rings the real Add task button even though the dialog is already open, so the user
    // learns where tasks come from next time. The dialog itself renders above the scrim,
    // so both are readable at once.
    resolveTargetSelector: () => '[data-testid="swimlane-add-task"]',
    calloutTitle: () => i18n._(msg`Add your first task`),
    calloutBody: () => i18n._(msg`Tasks start from this button. An agent can also create them for you through Kangentic's MCP server.`),
  },
  {
    key: 'draggedToAutoSpawnLane',
    // The label with no agent-starting column. `resolveStepLabel` names the column when there is one.
    label: msg`Drag it to a column that starts an agent`,
    description: msg`Dropping a task in a column that starts an agent runs it.`,
    activate: () => undefined,
    opensDialog: false,
    // Both ends of the drag. Lighting only the destination leaves the task the user is
    // being asked to drag sitting in a dimmed column, which makes the instruction
    // impossible to follow. The two are adjacent in the seeded board, so the union is one
    // contiguous region; if the user has reordered, it simply spans a little more.
    resolveTargetSelector: (swimlanes) => {
      const destination = resolveAutoSpawnLane(swimlanes);
      const source = swimlanes.find((lane) => lane.role === 'todo' && !lane.is_ghost);
      const selectors = [source, destination]
        .filter((lane): lane is Swimlane => lane !== undefined && lane !== null)
        .map((lane) => `[data-swimlane-id="${lane.id}"]`);
      return selectors.length > 0 ? selectors.join(', ') : null;
    },
    calloutTitle: (swimlanes) => {
      const lane = resolveAutoSpawnLane(swimlanes);
      if (!lane) return i18n._(msg`Drag a task into a column that starts an agent`);
      // A column's name is data the user chose; it is a placeholder in the sentence.
      const laneName = lane.name;
      return i18n._(msg`Drag a task into ${laneName}`);
    },
    // Says WHY, not just what: the point is that starting an agent is a per-column
    // setting the seeded board turns on for you, not something this column does by
    // magic - and that the agent's opening prompt is the task itself, which is the
    // half of the mental model the setting alone does not teach.
    calloutBody: (swimlanes) => {
      const lane = resolveAutoSpawnLane(swimlanes);
      if (!lane) return i18n._(msg`No column starts an agent yet. Turn that on for a column in Board manager.`);
      const laneName = lane.name;
      return i18n._(msg`${laneName} comes preset to start an agent, with the task's title and description as its prompt. Any column can start one; you set that in Board manager.`);
    },
  },
  {
    key: 'taskDetailOpened',
    label: msg`Open the task`,
    description: msg`Watch the agent work, read its output, and steer it.`,
    // Nothing to open on the user's behalf - opening the task IS the step.
    activate: () => undefined,
    opensDialog: false,
    // Rings the card itself, in whichever lane it is running in. Like step 4 this is a
    // "find it on the board" step, which is the only kind a spotlight earns.
    resolveTargetSelector: (swimlanes) => {
      const lane = resolveAutoSpawnLane(swimlanes);
      return lane ? `[data-swimlane-id="${lane.id}"] [data-task-id]` : '[data-task-id]';
    },
    calloutTitle: () => i18n._(msg`Open the task`),
    calloutBody: () => i18n._(msg`This is where the run lives: the agent's terminal, its changes, and a prompt to steer it. Moves to later columns carry this same conversation along.`),
  },
];

/**
 * The step to run next, or null when every step is done.
 *
 * Completed steps are skipped rather than re-offered, and the search wraps: someone who took
 * the steps out of order and finished on step 5 is sent back to whatever they left behind
 * rather than being told they are finished when they are not. `progress` is passed in (not
 * read from a store) so callers can account for the step they have only just completed, whose
 * state has not reached them yet.
 */
export function resolveNextStep(
  progress: Record<OnboardingStepKey, boolean>,
  afterKey: OnboardingStepKey | null,
): WalkthroughStepDefinition | null {
  const afterIndex = afterKey ? WALKTHROUGH_STEPS.findIndex((step) => step.key === afterKey) : -1;
  const startIndex = afterIndex + 1;
  const searchOrder = [
    ...WALKTHROUGH_STEPS.slice(startIndex),
    ...WALKTHROUGH_STEPS.slice(0, startIndex),
  ];
  return searchOrder.find((step) => !progress[step.key]) ?? null;
}

/**
 * The step label, resolved against live board state.
 *
 * Step 4's checklist label names a column the user can rename, so it cannot be the static
 * descriptor. Every other step's label is fixed.
 */
export function resolveStepLabel(step: WalkthroughStepDefinition, swimlanes: Swimlane[]): string {
  if (step.key !== 'draggedToAutoSpawnLane') return translateText(step.label);
  const lane = resolveAutoSpawnLane(swimlanes);
  if (!lane) return translateText(step.label);
  const laneName = lane.name;
  return i18n._(msg`Drag it to ${laneName}`);
}

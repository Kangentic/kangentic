/**
 * What a click on a terminal link does: which browser each link hotkey opens it
 * in, and which of the two a given click names.
 *
 * Two rebindable hotkeys (`terminal.openLinkInDefaultBrowser`, Ctrl+click, and
 * `terminal.openLinkInKangenticBrowser`, Ctrl+Shift+click) decide it. Swapping
 * their combos swaps which one the plainer click does, so the actions are listed
 * by how few modifiers each needs, and the tip shows them in that order. A
 * terminal with no Kangentic browser beside it (the bottom panel, the Workflows
 * pane, a project with the Browser pane off, a browser popped out to its own
 * window) has one place to open a link, so either hotkey opens the default
 * browser there and the tip shows the plainer one.
 *
 * Pure: the caller hands in the combos and the browser's availability, read at
 * hover and at click.
 */

import { isModifiedClickCombo } from '../../../shared/keybindings';
import { matchesClickCombo, type ClickModifiers } from '../keybindings';

/** Every place a link opens, the default browser first: it wins a tie on modifier count. */
export const LINK_TARGETS = ['default-browser', 'kangentic-browser'] as const;

/** Where a link opens. */
export type LinkTarget = typeof LINK_TARGETS[number];

/** The hotkey behind each target. Ids are stable: user overrides key on them. */
export const LINK_TARGET_KEYBINDINGS: Record<LinkTarget, string> = {
  'default-browser': 'terminal.openLinkInDefaultBrowser',
  'kangentic-browser': 'terminal.openLinkInKangenticBrowser',
};

/** One way to open a link: the place, and the click combo that does it. */
export interface LinkAction {
  target: LinkTarget;
  combo: string;
}

/** What the tip lists, and how a click is read. */
export interface LinkActionPlan {
  /** The tip's rows, plainest click first. Empty when no hotkey is bound. */
  actions: LinkAction[];
  /** Where this click opens the link, or null when it names no action. */
  targetFor(event: ClickModifiers): LinkTarget | null;
}

function modifierCount(combo: string): number {
  return combo.split('+').length - 1;
}

/**
 * The plan for one terminal at one moment. `combos` are the effective combos of
 * the two hotkeys; a combo that is unbound or not a link click is left out.
 */
export function planLinkActions(
  combos: Record<LinkTarget, string>,
  kangenticBrowserAvailable: boolean,
  isMac?: boolean,
): LinkActionPlan {
  const bound: LinkAction[] = LINK_TARGETS
    .filter((target) => isModifiedClickCombo(combos[target]))
    .map((target) => ({ target, combo: combos[target] }));
  // Stable sort: on a tie the default browser, today's behavior, stays first.
  bound.sort((first, second) => modifierCount(first.combo) - modifierCount(second.combo));

  const matching = (event: ClickModifiers): LinkAction | undefined =>
    bound.find((action) => matchesClickCombo(event, action.combo, isMac));

  if (!kangenticBrowserAvailable) {
    return {
      actions: bound.length > 0 ? [{ target: 'default-browser', combo: bound[0].combo }] : [],
      targetFor: (event) => (matching(event) ? 'default-browser' : null),
    };
  }
  return {
    actions: bound,
    targetFor: (event) => matching(event)?.target ?? null,
  };
}

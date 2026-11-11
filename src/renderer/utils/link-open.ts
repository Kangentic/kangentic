/**
 * What a click on a link does, everywhere a link shows (#1056): a terminal
 * link, the PR pill, a task's artifacts.
 *
 * A plain click opens the browser the user chose in Settings > Behavior
 * ("Click opens links in"), the default browser unless they change it.
 * Ctrl+Click (Cmd on a Mac) opens the other one. Both stay one click away; the
 * setting only swaps which is which, so there is no hotkey to rebind.
 *
 * A place with no Kangentic browser beside it (the bottom panel, a task with
 * no running session, a browser popped out to its own window) has one place to
 * open a link, so both clicks open the default browser there and the tip shows
 * one row.
 *
 * Pure: the caller hands in the setting and the browser's availability, read
 * at hover and at click.
 */

import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { CLICK_TOKEN } from '../../shared/keybindings';
import type { LinkClickTarget } from '../../shared/types';
import { IS_MAC, type ClickModifiers } from './keybindings';

/** Where a link opens. */
export type LinkTarget = 'default-browser' | 'kangentic-browser';

/**
 * What a tip calls each place, on a terminal link (`link-tip.ts`) and on a PR
 * pill or an artifact (`useLinkOpener`). One list, so the two tips cannot name
 * one browser two ways. Translated where a tip renders.
 */
export const LINK_TARGET_LABELS: Record<LinkTarget, MessageDescriptor> = {
  'default-browser': msg`Open in default browser`,
  'kangentic-browser': msg`Open in Kangentic browser`,
};

/** The two clicks, as combos the tip draws as key chips. */
export const PLAIN_CLICK_COMBO = CLICK_TOKEN;
export const MODIFIED_CLICK_COMBO = `Mod+${CLICK_TOKEN}`;

/** One way to open a link: the place, and the click that does it. */
export interface LinkAction {
  target: LinkTarget;
  combo: string;
}

/** What the tip lists, and how a click is read. */
export interface LinkActionPlan {
  /** The tip's rows, the plain click first. */
  actions: LinkAction[];
  /** Where this click opens the link, or null when it names no action. */
  targetFor(event: ClickModifiers): LinkTarget | null;
}

/**
 * Cmd, or Ctrl off a Mac: the click that opens the other browser. Ctrl+click
 * on a Mac is a right click, which opens a context menu.
 */
export function isLinkOpenGesture(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>, isMac: boolean = IS_MAC): boolean {
  return event.metaKey || (event.ctrlKey && !isMac);
}

/** A click with no modifier held. Shift and Alt clicks are left to whatever owns them (a selection). */
export function isPlainClick(event: ClickModifiers): boolean {
  return !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

const TARGET_OF_SETTING: Record<LinkClickTarget, LinkTarget> = {
  default: 'default-browser',
  kangentic: 'kangentic-browser',
};

function otherTarget(target: LinkTarget): LinkTarget {
  return target === 'default-browser' ? 'kangentic-browser' : 'default-browser';
}

/** The plan for one link at one moment. `clickOpens` is the user's setting. */
export function planLinkActions(
  clickOpens: LinkClickTarget,
  kangenticBrowserAvailable: boolean,
  isMac?: boolean,
): LinkActionPlan {
  if (!kangenticBrowserAvailable) {
    return {
      actions: [{ target: 'default-browser', combo: PLAIN_CLICK_COMBO }],
      targetFor: (event) => (isPlainClick(event) || isLinkOpenGesture(event, isMac) ? 'default-browser' : null),
    };
  }
  const plain = TARGET_OF_SETTING[clickOpens] ?? 'default-browser';
  const modified = otherTarget(plain);
  return {
    actions: [
      { target: plain, combo: PLAIN_CLICK_COMBO },
      { target: modified, combo: MODIFIED_CLICK_COMBO },
    ],
    targetFor: (event) => {
      if (isLinkOpenGesture(event, isMac)) return modified;
      return isPlainClick(event) ? plain : null;
    },
  };
}

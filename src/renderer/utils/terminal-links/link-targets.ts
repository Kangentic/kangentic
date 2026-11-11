/**
 * One terminal's link targets: the default browser through the shell bridge, and
 * the Kangentic browser beside it when its host has one. Both the OSC 8 handler
 * and the printed-URL provider ask this, at hover for the tip and at click for
 * the open, so the two always agree.
 */

import type { LinkClickTarget } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { planLinkActions, type LinkActionPlan, type LinkTarget } from '../link-open';

/** The Kangentic browser beside a terminal, as its host offers it. */
export interface TerminalLinkBrowser {
  /** Show the browser if it is hidden and load the URL in it. Keyboard focus stays in the terminal. */
  open(url: string): void;
}

export interface TerminalLinkTargets {
  /** The actions a link offers now, read live: a changed setting or a browser closing shows on the next hover. */
  plan(): LinkActionPlan;
  /** Open a URL the caller already checked is http(s). */
  open(target: LinkTarget, url: string): void;
}

/** The user's "Click opens links in" setting, read live. */
export function readLinkClickTarget(): LinkClickTarget {
  return useConfigStore.getState().config.linkClickTarget ?? 'default';
}

export function createTerminalLinkTargets(options: {
  getBrowser: () => TerminalLinkBrowser | null;
  openExternal: (url: string) => void;
  readClickTarget?: () => LinkClickTarget;
}): TerminalLinkTargets {
  const readClickTarget = options.readClickTarget ?? readLinkClickTarget;
  return {
    plan: () => planLinkActions(readClickTarget(), options.getBrowser() !== null),
    open: (target, url) => {
      const browser = target === 'kangentic-browser' ? options.getBrowser() : null;
      if (browser) browser.open(url);
      else options.openExternal(url);
    },
  };
}

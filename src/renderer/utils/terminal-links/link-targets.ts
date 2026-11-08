/**
 * One terminal's link targets: the default browser through the shell bridge, and
 * the Kangentic browser beside it when its host has one. Both the OSC 8 handler
 * and the printed-URL provider ask this, at hover for the tip and at click for
 * the open, so the two always agree.
 */

import { effectiveCombo } from '../../../shared/keybindings';
import { useConfigStore } from '../../stores/config-store';
import { LINK_TARGET_KEYBINDINGS, planLinkActions, type LinkActionPlan, type LinkTarget } from './link-actions';

/** The Kangentic browser beside a terminal, as its host offers it. */
export interface TerminalLinkBrowser {
  /** Show the browser if it is hidden and load the URL in it. Keyboard focus stays in the terminal. */
  open(url: string): void;
}

export interface TerminalLinkTargets {
  /** The actions a link offers now, read live: a rebind or a browser closing shows on the next hover. */
  plan(): LinkActionPlan;
  /** Open a URL the caller already checked is http(s). */
  open(target: LinkTarget, url: string): void;
}

/** The effective combos of the two link hotkeys, from the user's overrides. */
export function readLinkCombos(): Record<LinkTarget, string> {
  const overrides = useConfigStore.getState().globalConfig.hotkeyOverrides;
  return {
    'default-browser': effectiveCombo(LINK_TARGET_KEYBINDINGS['default-browser'], overrides),
    'kangentic-browser': effectiveCombo(LINK_TARGET_KEYBINDINGS['kangentic-browser'], overrides),
  };
}

export function createTerminalLinkTargets(options: {
  getBrowser: () => TerminalLinkBrowser | null;
  openExternal: (url: string) => void;
  readCombos?: () => Record<LinkTarget, string>;
}): TerminalLinkTargets {
  const readCombos = options.readCombos ?? readLinkCombos;
  return {
    plan: () => planLinkActions(readCombos(), options.getBrowser() !== null),
    open: (target, url) => {
      const browser = target === 'kangentic-browser' ? options.getBrowser() : null;
      if (browser) browser.open(url);
      else options.openExternal(url);
    },
  };
}

/**
 * Keeps a link click from reaching the TUI as well.
 *
 * xterm's Linkifier opens a link on mouseup, and xterm reports the same press to
 * an app that holds the mouse. A TUI that opens links itself then opens it again.
 * Claude Code does: it defers to the terminal only when `TERM_PROGRAM` is `vscode`
 * or XTVERSION names xterm.js, and Kangentic sends neither, by decision
 * (`pty-spawn.ts`, `xterm-query-replies.md`). So whichever side opens the link, the
 * other must not see it, and this side decides at the press.
 *
 * The press decides on the DOM event, not the report: the mouse protocol has no bit
 * for Cmd, so on a Mac a TUI reads Cmd+click as a plain click and would act on the
 * row under the link.
 */

import { IS_MAC } from '../keybindings';
import type { LinkHover, TerminalLinkTip } from './link-tip';

/**
 * Cmd, or Ctrl off a Mac. A plain click in a terminal selects or belongs to the TUI,
 * and Ctrl+click on a Mac is a right click, which opens the terminal's context menu.
 */
export function isLinkOpenGesture(event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>, isMac: boolean = IS_MAC): boolean {
  return event.metaKey || (event.ctrlKey && !isMac);
}

export interface TerminalLinkGesture {
  /** `hover` says where the link is, for its tip. Without it only the click claim follows the hover. */
  noteLinkHover(hover?: LinkHover): void;
  noteLinkLeave(): void;
  /**
   * Starts watching presses on the terminal's element, which takes the listener with it on
   * dispose, and shows `tip` for each hovered link.
   */
  attach(element: HTMLElement, tip?: TerminalLinkTip): void;
  /** True from a Ctrl or Cmd press on a link until that press has been released. */
  isClickingLink(): boolean;
}

export function createTerminalLinkGesture(eventTarget: Pick<Window, 'addEventListener'> = window): TerminalLinkGesture {
  let hoveringLink = false;
  let clickingLink = false;
  let linkTip: TerminalLinkTip | null = null;

  const release = (): void => {
    // After this dispatch, so the report xterm's own mouseup listener makes on
    // `document` still reads as part of the click.
    setTimeout(() => {
      clickingLink = false;
    }, 0);
  };

  return {
    noteLinkHover: (hover) => {
      hoveringLink = true;
      if (hover) linkTip?.show(hover);
    },
    noteLinkLeave: () => {
      hoveringLink = false;
      linkTip?.leave();
    },
    attach: (element, tip) => {
      linkTip = tip ?? null;
      // Capture phase, ahead of xterm's listeners on the same subtree, because
      // xterm reports the press synchronously from its own.
      element.addEventListener('mousedown', (event) => {
        // Every press answers afresh, so a release that never arrived cannot
        // hold the flag past the next click.
        clickingLink = hoveringLink && event.button === 0 && isLinkOpenGesture(event);
        if (clickingLink) eventTarget.addEventListener('mouseup', release, { capture: true, once: true });
      }, { capture: true });
    },
    isClickingLink: () => clickingLink,
  };
}

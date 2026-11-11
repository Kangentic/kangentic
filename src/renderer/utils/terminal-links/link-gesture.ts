/**
 * Decides which presses on a terminal link open it, and keeps that click from
 * reaching the TUI as well.
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
 *
 * A plain click opens a URL too (#1056), which a terminal has three reasons to be
 * careful with:
 * - **A drag still selects.** A plain press is claimed only until the pointer moves
 *   past a few pixels. Then the claim is let go (`onClaimReleased`, where the
 *   terminal sends the press report it was holding back), and the release opens
 *   nothing.
 * - **A click that only focuses the terminal opens nothing.** A plain press on a
 *   terminal that does not hold the keyboard is not claimed and opens nothing: it
 *   is the click that brings the terminal forward.
 * - **The link opens once.** While a press is claimed the terminal holds back its
 *   press and release reports (`isClickingLink`), so a TUI never sees the click.
 */

import type { ClickModifiers } from '../keybindings';
import { isLinkOpenGesture, isPlainClick } from '../link-open';
import type { LinkHover, TerminalLinkKind, TerminalLinkTip } from './link-tip';

/** Whether a press on a link of this kind is one that opens it. */
export type LinkOpenPredicate = (event: ClickModifiers, kind: TerminalLinkKind) => boolean;

/** A plain press that moves further than this is a drag, not a click. */
export const LINK_CLICK_DRAG_THRESHOLD_PX = 4;

/**
 * The press report a terminal holds back while a link click is being decided,
 * after one more button report arrives during that click: `held` is the report
 * held so far, and the result is what is held next.
 *
 * An SGR report (`CSI < ... M`) marks its release with a lowercase `m`, so a
 * release holds nothing. An X10 report (`CSI M` and three bytes) carries no
 * such mark, and its last byte is the row, which is `m` on row 77: there the
 * report after a held press is the release, and the press itself is always held.
 */
export function heldPressAfterReport(report: string, held: string | null): string | null {
  const isSgrRelease = report.startsWith('\x1b[<') && report.endsWith('m');
  if (isSgrRelease || held !== null) return null;
  return report;
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
  /** True from a press that opens a link until that press is released, or until it turns into a drag. */
  isClickingLink(): boolean;
  /**
   * Whether the release of the current press may open the link. A Ctrl or Cmd
   * click always may. A plain click may only if its press was claimed (the
   * terminal held the keyboard) and it did not turn into a drag.
   */
  opensOnRelease(event: ClickModifiers): boolean;
  /**
   * Called when a claimed plain press turns into a drag, so the terminal can
   * send the press report it held back. One listener; a later call replaces it.
   */
  onClaimReleased(listener: () => void): void;
}

/**
 * `opensLink` decides which presses on the hovered link claim the click: a URL on
 * a plain click or on Ctrl or Cmd (`link-open.ts`), a path on Ctrl or Cmd only. A
 * hover that names no kind falls back to Ctrl or Cmd.
 */
export function createTerminalLinkGesture(
  eventTarget: Pick<Window, 'addEventListener' | 'removeEventListener'> = window,
  opensLink: LinkOpenPredicate = (event) => isLinkOpenGesture(event),
): TerminalLinkGesture {
  let hoveringLink = false;
  let hoveredKind: TerminalLinkKind | null = null;
  let clickingLink = false;
  let linkTip: TerminalLinkTip | null = null;
  // The plain press now down, if it was claimed: where it started, and whether
  // the pointer has left that spot. Null for a modified press and between presses.
  let plainPress: { x: number; y: number; dragged: boolean } | null = null;
  let claimReleased: (() => void) | null = null;

  const watchForDrag = (event: MouseEvent): void => {
    if (!plainPress || plainPress.dragged) return;
    const moved = Math.hypot(event.clientX - plainPress.x, event.clientY - plainPress.y);
    if (moved <= LINK_CLICK_DRAG_THRESHOLD_PX) return;
    // A drag: the press is the program's after all. Let go before xterm reports
    // this move, so the held press report goes out ahead of it.
    plainPress.dragged = true;
    clickingLink = false;
    eventTarget.removeEventListener('mousemove', watchForDrag, { capture: true });
    claimReleased?.();
  };

  const release = (): void => {
    eventTarget.removeEventListener('mousemove', watchForDrag, { capture: true });
    // After this dispatch, so the report xterm's own mouseup listener makes on
    // `document` still reads as part of the click, and the link's own release
    // still reads the press it belongs to (`opensOnRelease`). Then the press is
    // over: a later release with no press of its own opens nothing.
    setTimeout(() => {
      clickingLink = false;
      plainPress = null;
    }, 0);
  };

  return {
    noteLinkHover: (hover) => {
      hoveringLink = true;
      hoveredKind = hover?.kind ?? null;
      if (hover) linkTip?.show(hover);
    },
    noteLinkLeave: () => {
      hoveringLink = false;
      hoveredKind = null;
      linkTip?.leave();
    },
    attach: (element, tip) => {
      linkTip = tip ?? null;
      // Capture phase, ahead of xterm's listeners on the same subtree, because
      // xterm reports the press synchronously from its own, and focuses the
      // terminal from its own: this still reads where focus was before the press.
      element.addEventListener('mousedown', (event) => {
        // Every press answers afresh, so a release that never arrived cannot
        // hold the flag past the next click.
        eventTarget.removeEventListener('mousemove', watchForDrag, { capture: true });
        plainPress = null;
        const opens = hoveredKind === null ? isLinkOpenGesture(event) : opensLink(event, hoveredKind);
        const plain = isPlainClick(event);
        // A plain press on a terminal that does not hold the keyboard only
        // brings it forward.
        const heldKeyboard = element.contains(element.ownerDocument.activeElement);
        clickingLink = hoveringLink && event.button === 0 && opens && (!plain || heldKeyboard);
        if (!clickingLink) return;
        if (plain) {
          plainPress = { x: event.clientX, y: event.clientY, dragged: false };
          eventTarget.addEventListener('mousemove', watchForDrag, { capture: true });
        }
        eventTarget.addEventListener('mouseup', release, { capture: true, once: true });
      }, { capture: true });
    },
    isClickingLink: () => clickingLink,
    opensOnRelease: (event) => {
      if (isLinkOpenGesture(event)) return true;
      return plainPress !== null && !plainPress.dragged;
    },
    onClaimReleased: (listener) => {
      claimReleased = listener;
    },
  };
}

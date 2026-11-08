import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { Terminal } from '@xterm/xterm';
import { useToastStore } from '../../stores/toast-store';
import { readRangeText } from './buffer-line-text';
import { isLinkOpenGesture, type LinkOpenPredicate, type TerminalLinkGesture } from './link-gesture';
import { createLinkPathCache } from './link-path-cache';
import { createPathLinkProvider, createUrlLinkProvider } from './link-providers';
import type { TerminalLinkTargets } from './link-targets';
import { createTerminalLinkTip, linkTipContent, osc8Destination, type LinkHover, type LinkTipContent } from './link-tip';

function showPathGone(printedPath: string): void {
  useToastStore.getState().addToast({
    title: i18n._(msg`Couldn't show file`),
    message: printedPath,
    variant: 'warning',
  });
}

/**
 * Whether a press opens a link of this kind: a URL on either link hotkey, a path on
 * Ctrl or Cmd. The terminal's link gesture claims exactly these presses.
 */
export function linkOpensOn(targets: TerminalLinkTargets): LinkOpenPredicate {
  return (event, kind) => (kind === 'path' ? isLinkOpenGesture(event) : targets.plan().targetFor(event) !== null);
}

/**
 * A link click with Shift held (Ctrl+Shift+click, the Kangentic browser's default)
 * keeps the selection the user had. xterm reads Shift+click as "extend the selection
 * to here" while no program holds the mouse, so without this the click stretched a
 * selection from wherever it was down to the link. Runs after the gesture's own
 * capture listener, which `attach` registered first, so the press is already claimed
 * or not.
 *
 * xterm stretches the selection on the press and may again on the release, from
 * listeners on the terminal and on `document`. So the selection is put back in the
 * window's bubble phase of each, which runs after both, and synchronously: Chrome
 * runs queued input ahead of timers, so a restore on a timer lost to a copy pressed
 * right after the click.
 *
 * Returns what drops a pending restore. One press holds at most one: the next press
 * on the terminal drops a release that never came, so a later, unrelated release
 * cannot put an old selection back, and so does disposing the terminal.
 */
function keepSelectionThroughLinkClick(terminal: Terminal, gesture: TerminalLinkGesture, element: HTMLElement): () => void {
  let pendingRestore: AbortController | null = null;
  const dropPendingRestore = (): void => {
    pendingRestore?.abort();
    pendingRestore = null;
  };
  element.addEventListener('mousedown', (event) => {
    dropPendingRestore();
    if (!event.shiftKey || !gesture.isClickingLink()) return;
    const kept = terminal.getSelectionPosition();
    if (kept === undefined) return;
    const controller = new AbortController();
    pendingRestore = controller;
    const restore = (): void => {
      const length = (kept.end.y - kept.start.y) * terminal.cols + (kept.end.x - kept.start.x);
      terminal.select(kept.start.x, kept.start.y, length);
    };
    const view = element.ownerDocument.defaultView ?? window;
    view.addEventListener('mousedown', restore, { once: true, signal: controller.signal });
    view.addEventListener('mouseup', () => {
      restore();
      if (pendingRestore === controller) dropPendingRestore();
    }, { once: true, signal: controller.signal });
  }, { capture: true });
  return dropPendingRestore;
}

/**
 * Plain URLs and printed paths, in that order, behind xterm's own OSC 8 provider,
 * and the tip every link shows on hover. Registered once per terminal, and disposed
 * with it. A session-less pane has no working folder to resolve a path against, so
 * it links URLs only.
 */
export function registerTerminalLinks(
  terminal: Terminal,
  gesture: TerminalLinkGesture,
  sessionId: string | null,
  targets: TerminalLinkTargets,
): void {
  if (terminal.element) {
    // Read at each render, so a rebind or a browser closing shows on the next hover.
    const describe = (hover: LinkHover): LinkTipContent | null => {
      const actions = hover.kind === 'url' ? targets.plan().actions : [];
      const destination = hover.osc8Uri !== undefined
        ? osc8Destination(hover.osc8Uri, readRangeText(terminal.buffer.active, hover.range, terminal.cols))
        : null;
      return linkTipContent(hover.kind, actions, destination);
    };
    const tip = createTerminalLinkTip(terminal, describe);
    gesture.attach(terminal.element, tip);
    const dropPendingRestore = keepSelectionThroughLinkClick(terminal, gesture, terminal.element);
    // Disposed with the terminal, so a window closed under the pointer leaves no tip
    // behind, and no restore that would select in a disposed terminal.
    terminal.loadAddon({ activate: () => {}, dispose: () => { tip.dispose(); dropPendingRestore(); } });
  }
  terminal.registerLinkProvider(createUrlLinkProvider(terminal, gesture, targets));
  if (!sessionId) return;
  const cache = createLinkPathCache((paths) => window.electronAPI.sessions.resolveLinkPaths(sessionId, paths));
  terminal.registerLinkProvider(createPathLinkProvider(terminal, gesture, cache, (printedPath) => {
    void window.electronAPI.sessions.revealLinkPath(sessionId, printedPath).then((revealed) => {
      if (!revealed) showPathGone(printedPath);
    }, () => showPathGone(printedPath));
  }));
}

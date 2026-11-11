import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { Terminal } from '@xterm/xterm';
import { useToastStore } from '../../stores/toast-store';
import { readRangeText } from './buffer-line-text';
import { isLinkOpenGesture } from '../link-open';
import type { LinkOpenPredicate, TerminalLinkGesture } from './link-gesture';
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
 * Whether a press opens a link of this kind: a URL on a plain click or on Ctrl or
 * Cmd, a path on Ctrl or Cmd. The terminal's link gesture claims exactly these
 * presses.
 */
export function linkOpensOn(targets: TerminalLinkTargets): LinkOpenPredicate {
  return (event, kind) => (kind === 'path' ? isLinkOpenGesture(event) : targets.plan().targetFor(event) !== null);
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
    // Read at each render, so a changed setting or a browser closing shows on the next hover.
    const describe = (hover: LinkHover): LinkTipContent | null => {
      const actions = hover.kind === 'url' ? targets.plan().actions : [];
      const destination = hover.osc8Uri !== undefined
        ? osc8Destination(hover.osc8Uri, readRangeText(terminal.buffer.active, hover.range, terminal.cols))
        : null;
      return linkTipContent(hover.kind, actions, destination);
    };
    const tip = createTerminalLinkTip(terminal, describe);
    gesture.attach(terminal.element, tip);
    // Disposed with the terminal, so a window closed under the pointer leaves no tip behind.
    terminal.loadAddon({ activate: () => {}, dispose: () => { tip.dispose(); } });
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

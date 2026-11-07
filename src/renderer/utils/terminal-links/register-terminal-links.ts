import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { Terminal } from '@xterm/xterm';
import { useToastStore } from '../../stores/toast-store';
import type { TerminalLinkGesture } from './link-gesture';
import { createLinkPathCache } from './link-path-cache';
import { createPathLinkProvider, createUrlLinkProvider } from './link-providers';

function showPathGone(printedPath: string): void {
  useToastStore.getState().addToast({
    title: i18n._(msg`Couldn't show file`),
    message: printedPath,
    variant: 'warning',
  });
}

/**
 * Plain URLs and printed paths, in that order, behind xterm's own OSC 8 provider.
 * Registered once per terminal, and disposed with it. A session-less pane has no
 * working folder to resolve a path against, so it links URLs only.
 */
export function registerTerminalLinks(terminal: Terminal, gesture: TerminalLinkGesture, sessionId: string | null): void {
  if (terminal.element) gesture.attach(terminal.element);
  terminal.registerLinkProvider(createUrlLinkProvider(
    terminal,
    gesture,
    (url) => { void window.electronAPI.shell.openExternal(url); },
  ));
  if (!sessionId) return;
  const cache = createLinkPathCache((paths) => window.electronAPI.sessions.resolveLinkPaths(sessionId, paths));
  terminal.registerLinkProvider(createPathLinkProvider(terminal, gesture, cache, (printedPath) => {
    void window.electronAPI.sessions.revealLinkPath(sessionId, printedPath).then((revealed) => {
      if (!revealed) showPathGone(printedPath);
    }, () => showPathGone(printedPath));
  }));
}

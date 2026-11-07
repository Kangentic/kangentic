/**
 * Which session's terminal has a find bar mounted, and whether it is open.
 *
 * The header icon and the bar sit in different subtrees: the icon in a window's
 * header, the bar in the terminal's own pane. Sessions key the registry because a
 * session has one xterm at a time, whichever surface holds it.
 */

import { useCallback, useSyncExternalStore } from 'react';

interface TerminalFindEntry {
  open: boolean;
  toggle: () => void;
}

// hmr-safe: each mounted bar registers from an effect, so a reload rebuilds this map.
const entries = new Map<string, TerminalFindEntry>();
// hmr-safe: each subscriber re-subscribes when the module reloads.
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function registerTerminalFind(sessionId: string, toggle: () => void): () => void {
  const entry: TerminalFindEntry = { open: false, toggle };
  entries.set(sessionId, entry);
  notify();
  return () => {
    // A remount of the same session registers before the old one cleans up.
    if (entries.get(sessionId) !== entry) return;
    entries.delete(sessionId);
    notify();
  };
}

export function setTerminalFindOpen(sessionId: string, open: boolean): void {
  const entry = entries.get(sessionId);
  if (!entry || entry.open === open) return;
  entry.open = open;
  notify();
}

export interface TerminalFindControl {
  /** The session has a terminal with a find bar in this window. */
  available: boolean;
  open: boolean;
  toggle: () => void;
}

export function useTerminalFindControl(sessionId: string | null): TerminalFindControl {
  const state = useSyncExternalStore(subscribe, () => {
    const entry = sessionId ? entries.get(sessionId) : undefined;
    if (!entry) return 'absent';
    return entry.open ? 'open' : 'closed';
  });
  const toggle = useCallback(() => {
    if (sessionId) entries.get(sessionId)?.toggle();
  }, [sessionId]);
  return { available: state !== 'absent', open: state === 'open', toggle };
}

/**
 * Keeps keyboard focus inside the window group when a window closes. If closing a
 * window orphans the focus - the focused element lived inside it, so
 * `document.activeElement` falls back to <body> after the close - this moves focus
 * to the most-recently-active remaining window's terminal. The focus cue + blinking
 * cursor follow, so a docked group keeps an active pane, like closing the focused
 * tab in a tab group hands focus to a sibling. Mounted once by WindowLayer.
 *
 * It only steps in when the close ACTUALLY orphaned focus: if focus still lives
 * somewhere valid (another window, a dialog), it leaves it alone, so it never
 * steals focus from where the user is working.
 */

import { useEffect, useRef } from 'react';
import { useWindowStore } from '../store/window-store';

export function useWindowFocusReconcile(): void {
  const windows = useWindowStore((state) => state.windows);
  const previousCountRef = useRef(0);

  useEffect(() => {
    const entries = Object.values(windows);
    const closed = entries.length < previousCountRef.current;
    previousCountRef.current = entries.length;
    if (!closed || entries.length === 0) return;

    // Only act when the close orphaned focus (activeElement fell back to <body>).
    // Focus still living in another window or a dialog is left untouched.
    const active = document.activeElement;
    if (active && active !== document.body) return;

    // Hand focus to the most-recently-active remaining window's terminal.
    const next = entries.reduce((top, candidate) => (candidate.zIndex > top.zIndex ? candidate : top));
    const frame = document.querySelector(`[data-testid="window-frame-${next.id}"]`);
    const textarea = frame?.querySelector('.xterm-helper-textarea');
    if (textarea instanceof HTMLElement) textarea.focus();
  }, [windows]);
}

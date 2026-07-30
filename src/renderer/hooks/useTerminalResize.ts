import { useState, useCallback, useRef, useEffect } from 'react';
import type { AppConfig } from '../../shared/types';
import { startPanelDrag } from './panel-drag';

const MIN_HEIGHT = 100;
export const COLLAPSED_HEIGHT = 36;
// How long after a project switch the height transition stays suppressed so the panel
// snaps to the destination's collapsed/expanded state. Comfortably covers the switch's
// height-change cascade (~1 frame) and exceeds the 200ms animation it replaces.
const SWITCH_SNAP_WINDOW_MS = 250;

/** What to do with the panel's mounted terminal content when the effective collapsed
 *  state changes. Extracted as a pure function so the regression-prone
 *  `reveal-immediately` branch (the blank-panel guard) can be unit tested without a DOM. */
export type ContentRevealAction =
  | 'none'
  | 'hide-after-collapse'
  | 'reveal-immediately'
  | 'reveal-on-transition-end';

/**
 * Decide how the panel reveals/hides its terminal content on a collapse-state change.
 *
 * - No change in collapsed state -> 'none'.
 * - Collapsing -> 'hide-after-collapse' (hide once the 200ms height animation finishes;
 *   content is harmlessly clipped by overflow-hidden in the meantime).
 * - Expanding with the height transition SUPPRESSED (a project switch snaps the panel
 *   open) -> 'reveal-immediately': no `transitionend` will fire, so the content must be
 *   revealed now or the panel stays blank.
 * - Expanding with the animation running -> 'reveal-on-transition-end': wait so the
 *   terminal mounts at the container's final height.
 */
export function resolveContentAction(
  wasCollapsed: boolean,
  isCollapsed: boolean,
  transitionSuppressed: boolean,
): ContentRevealAction {
  if (wasCollapsed === isCollapsed) return 'none';
  if (isCollapsed) return 'hide-after-collapse';
  return transitionSuppressed ? 'reveal-immediately' : 'reveal-on-transition-end';
}

export interface TerminalResizeState {
  height: number;
  collapsed: boolean;
  isResizing: boolean;
  showContent: boolean;
  ready: boolean;
  /** True for a short window after a project switch, so the panel snaps to the
   *  destination's state instead of animating the height change. The consumer drops the
   *  height-transition class while this is set. */
  suppressTransition: boolean;
  contentColRef: React.RefObject<HTMLDivElement | null>;
  onToggleCollapse: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
  handleTransitionEnd: () => void;
}

/** `switchKey` is the current project id; a change to it triggers the snap-across-switch
 *  behavior (suppress the height transition for one settle window). */
export function useTerminalResize(
  config: AppConfig,
  forceCollapsed = false,
  switchKey: string | null = null,
): TerminalResizeState {
  const [height, setHeight] = useState(config.terminal.panelHeight);
  // User-toggled collapse (persisted). The EFFECTIVE collapse below folds in
  // `forceCollapsed` (a task-detail window is open) without overwriting this, so
  // the user's preference is restored when the last window closes.
  const [collapsed, setCollapsed] = useState(config.terminal.panelCollapsed ?? false);
  const [isResizing, setIsResizing] = useState(false);
  const [showContent, setShowContent] = useState(!((config.terminal.panelCollapsed ?? false) || forceCollapsed));
  const [ready, setReady] = useState(false);
  // Snap (no animation) across a project switch. `suppressTransitionRef` mirrors the
  // state so the showContent effect can read the latest value without re-subscribing.
  const [suppressTransition, setSuppressTransition] = useState(false);
  const suppressTransitionRef = useRef(false);
  suppressTransitionRef.current = suppressTransition;
  const switchKeyRef = useRef(switchKey);
  const switchSnapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The panel collapses if the user collapsed it OR a task-detail window is open
  // (the panel steps aside while windows own the terminals). Everything
  // animated/returned keys off this; `collapsed` stays the user's preference.
  const effectiveCollapsed = collapsed || forceCollapsed;

  const latestHeightRef = useRef(height);
  const terminalConfigRef = useRef(config.terminal);
  terminalConfigRef.current = config.terminal;
  const effectiveCollapsedRef = useRef(effectiveCollapsed);
  const availableHeightRef = useRef(0);
  const contentColRef = useRef<HTMLDivElement>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from config on load
  useEffect(() => {
    const saved = config.terminal?.panelHeight;
    if (typeof saved === 'number' && saved >= MIN_HEIGHT) {
      setHeight(saved);
      latestHeightRef.current = saved;
    }
  }, [config]);

  // Enable transitions after first frame to prevent animation on mount
  useEffect(() => {
    requestAnimationFrame(() => setReady(true));
  }, []);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    };
  }, []);

  // On a project switch (switchKey change), suppress the height transition for one
  // settle window so the panel snaps to the destination's state rather than animating
  // the slide. Skips the initial mount (ref seeded to the first switchKey). Declared
  // before the showContent effect so the ref is up to date when that effect reads it.
  useEffect(() => {
    if (switchKeyRef.current === switchKey) return;
    switchKeyRef.current = switchKey;
    setSuppressTransition(true);
    if (switchSnapTimerRef.current) clearTimeout(switchSnapTimerRef.current);
    switchSnapTimerRef.current = setTimeout(() => {
      setSuppressTransition(false);
      switchSnapTimerRef.current = null;
    }, SWITCH_SNAP_WINDOW_MS);
    return () => {
      if (switchSnapTimerRef.current) {
        clearTimeout(switchSnapTimerRef.current);
        switchSnapTimerRef.current = null;
        // Lift the suppression along with the timer that would have lifted it.
        // Clearing the timer alone strands `suppressTransition` at true if the
        // effect is torn down mid-window and re-runs with an unchanged key (the
        // guard above returns early, so nothing re-arms) - and a stuck
        // suppression drops the height-transition class, so the expand path
        // waits for a `transitionend` that can never fire and the panel stays
        // blank. Seen live during a Fast Refresh that changed the key's shape.
        setSuppressTransition(false);
      }
    };
  }, [switchKey]);

  // Drive showContent on every effectiveCollapsed transition (whether the user
  // toggled or a window opened/closed). Collapsing: hide content after the 200ms
  // height animation. Expanding: handleTransitionEnd remounts it once the
  // container reaches full height (so the terminal fits at the right size).
  useEffect(() => {
    const wasCollapsed = effectiveCollapsedRef.current;
    effectiveCollapsedRef.current = effectiveCollapsed;
    const action = resolveContentAction(wasCollapsed, effectiveCollapsed, suppressTransitionRef.current);
    if (action === 'none') return;
    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }
    if (action === 'hide-after-collapse') {
      contentTimerRef.current = setTimeout(() => {
        setShowContent(false);
        contentTimerRef.current = null;
      }, 200);
    } else if (action === 'reveal-immediately') {
      setShowContent(true);
    }
    // 'reveal-on-transition-end': handleTransitionEnd mounts content once the height
    // animation completes.
  }, [effectiveCollapsed]);

  const getMaxHeight = useCallback(() => {
    return Math.floor(availableHeightRef.current / 2) - 4;
  }, []);

  const clampHeight = useCallback((h: number) => {
    if (availableHeightRef.current === 0) {
      return Math.max(MIN_HEIGHT, h);
    }
    const max = getMaxHeight();
    if (max <= MIN_HEIGHT) return MIN_HEIGHT;
    return Math.max(MIN_HEIGHT, Math.min(max, h));
  }, [getMaxHeight]);

  // Track content column height via ResizeObserver and clamp when window shrinks
  useEffect(() => {
    const el = contentColRef.current;
    if (!el) return;

    availableHeightRef.current = el.getBoundingClientRect().height;

    let previousHeight = availableHeightRef.current;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newHeight = entry.contentRect.height;
        // Skip if only the width changed (e.g. sidebar open/close)
        if (newHeight === previousHeight) return;
        previousHeight = newHeight;
        availableHeightRef.current = newHeight;
      }
      const clamped = clampHeight(latestHeightRef.current);
      if (clamped !== latestHeightRef.current) {
        latestHeightRef.current = clamped;
        setHeight(clamped);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampHeight]);

  const onToggleCollapse = useCallback(() => {
    // Only the user's preference flips here; the showContent timing is driven by
    // the effectiveCollapsed effect above (which also reacts to windows opening).
    setCollapsed((prev) => {
      const newCollapsed = !prev;
      window.electronAPI.config.set({
        terminal: { ...terminalConfigRef.current, panelCollapsed: newCollapsed },
      });
      return newCollapsed;
    });
  }, []);

  const handleTransitionEnd = useCallback(() => {
    // When expanding, mount content NOW (container has final height).
    // TerminalTab's init effect handles fit at the correct size.
    if (!effectiveCollapsedRef.current) {
      setShowContent(true);
    }
  }, []);

  const onResizeStart = useCallback((event: React.MouseEvent) => {
    setIsResizing(true);

    const startY = event.clientY;
    const startHeight = height;

    startPanelDrag(event, {
      cursor: 'row-resize',
      onMove: (moveEvent) => {
        const delta = startY - moveEvent.clientY;
        const newHeight = clampHeight(startHeight + delta);
        setHeight(newHeight);
        latestHeightRef.current = newHeight;
      },
      onRelease: () => {
        window.electronAPI.config.set({
          terminal: { ...config.terminal, panelHeight: latestHeightRef.current },
        });
        setIsResizing(false);
        // Explicit refit signal. The debounced ResizeObserver also handles this,
        // but the explicit event gives a faster 50ms response.
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      },
    });
  }, [height, config.terminal, clampHeight]);

  return { height, collapsed: effectiveCollapsed, isResizing, showContent, ready, suppressTransition, contentColRef, onToggleCollapse, onResizeStart, handleTransitionEnd };
}

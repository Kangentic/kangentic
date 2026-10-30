import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import type { AppConfig } from '../../shared/types';
import { startPanelDrag } from './panel-drag';
import { claimArrivalFocus } from '../utils/terminal-arrival-focus';
import { runTerminalLayoutChange } from '../utils/terminal-layout-transition';
import { derivePanelSessions } from '../utils/panel-sessions';
import { derivePanelSessionId } from '../utils/focused-sessions';
import { useSessionStore } from '../stores/session-store';
import { useProjectStore } from '../stores/project-store';

const MIN_HEIGHT = 100;
export const COLLAPSED_HEIGHT = 36;
// How long after a project switch the height transition stays suppressed so the panel
// snaps to the destination's collapsed/expanded state. Comfortably covers the switch's
// height-change cascade (~1 frame) and exceeds the 200ms animation it replaces. The
// sidebar's view-switch fold (`useSidebarResize`) snaps for the same window.
export const SWITCH_SNAP_WINDOW_MS = 250;

/** What to do with the panel's mounted terminal content when the effective collapsed
 *  state changes. Extracted as a pure function so the regression-prone
 *  `reveal-immediately` branch (the blank-panel guard) can be unit tested without a DOM. */
export type ContentRevealAction =
  | 'none'
  | 'hide-after-collapse'
  | 'reveal-immediately'
  | 'reveal-when-transition-settles';

/**
 * Decide how the panel reveals/hides its terminal content on a collapse-state change.
 *
 * - No change in collapsed state -> 'none'.
 * - Collapsing -> 'hide-after-collapse' (hide once the 200ms height animation finishes;
 *   content is harmlessly clipped by overflow-hidden in the meantime).
 * - Expanding while a height transition runs on the container ->
 *   'reveal-when-transition-settles': wait for it to finish or be cancelled, so the
 *   terminal mounts at the container's final height.
 * - Expanding with NO height transition running -> 'reveal-immediately'. Nothing will
 *   settle, so waiting would leave the panel blank. This is every expand that does not
 *   animate: a container that mounts already expanded (back from Workflows), no container
 *   at all (Backlog), and a project-switch snap.
 */
export function resolveContentAction(
  wasCollapsed: boolean,
  isCollapsed: boolean,
  heightTransitionRunning: boolean,
): ContentRevealAction {
  if (wasCollapsed === isCollapsed) return 'none';
  if (isCollapsed) return 'hide-after-collapse';
  return heightTransitionRunning ? 'reveal-when-transition-settles' : 'reveal-immediately';
}

/**
 * The height transition running on the panel container, if any. Asked of the element
 * after the commit rather than predicted from state: the reveal used to assume an expand
 * always animated the mounted container up from its strip, and every way that assumption
 * failed left the panel expanded and blank. `getAnimations()` flushes pending style
 * first, so a transition the commit just started is already in the list.
 */
function findHeightTransition(element: HTMLElement | null): Animation | null {
  if (!element || typeof element.getAnimations !== 'function') return null;
  return element.getAnimations().find(
    (animation) => 'transitionProperty' in animation && animation.transitionProperty === 'height',
  ) ?? null;
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
  onToggleCollapse: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
}

/**
 * The session the bottom panel is about to mount a terminal for, read from the
 * live stores. Runs the same two derivations the panel itself renders from, so a
 * claim can never name a session the panel is not going to show. `panelShowsTerminal`
 * is deliberately left at its default: the caller is in the act of showing it.
 * The cycle keys (`useCycleShortcuts`) read it too, for the tab an expanded panel shows.
 */
export function panelArrivalSessionId(): string | null {
  const sessionState = useSessionStore.getState();
  const currentProjectId = useProjectStore.getState().currentProject?.id ?? null;
  const { owned } = derivePanelSessions({
    sessions: sessionState.sessions,
    currentProjectId,
    dialogSessionIds: sessionState.dialogSessionIds,
    remoteDetailTaskIds: sessionState.remoteDetailTaskIds,
    mobileTerminalStreamedSessionIds: sessionState.mobileTerminalStreamedSessionIds,
  });
  return derivePanelSessionId({
    activeSessionId: sessionState.activeSessionId,
    sessions: sessionState.sessions,
    currentProjectId,
    sessionActivity: sessionState.sessionActivity,
    ownedSessionIds: owned,
  });
}

/** `switchKey` is the current project id; a change to it triggers the snap-across-switch
 *  behavior (suppress the height transition for one settle window).
 *
 *  `contentColRef` is the content column the panel's available height is measured
 *  against, and `panelContainerRef` is the panel container whose height animates. The
 *  CALLER owns both and attaches them to the elements: a ref returned inside the state
 *  object would make React's compiler rules read every field of that object as a ref
 *  access during render. */
export function useTerminalResize(
  config: Pick<AppConfig, 'terminal'>,
  contentColRef: React.RefObject<HTMLDivElement | null>,
  panelContainerRef: React.RefObject<HTMLDivElement | null>,
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
  // Snap (no animation) across a project switch. Raised during RENDER, as the config
  // sync below is, so the commit that applies the switch's height change already lacks
  // the transition class. Dropping the class a commit later does not stop a transition
  // that commit started, because the bare `transition-property` falls back to `all`.
  // The initial mount does not snap, since the key starts out equal.
  const [suppressTransition, setSuppressTransition] = useState(false);
  const [snapKey, setSnapKey] = useState(switchKey);
  if (switchKey !== snapKey) {
    setSnapKey(switchKey);
    setSuppressTransition(true);
  }

  // The panel collapses if the user collapsed it OR a task-detail window is open
  // (the panel steps aside while windows own the terminals). Everything
  // animated/returned keys off this; `collapsed` stays the user's preference.
  const effectiveCollapsed = collapsed || forceCollapsed;

  const latestHeightRef = useRef(height);
  const effectiveCollapsedRef = useRef(effectiveCollapsed);
  // Mirrored for `onToggleCollapse`, which has no deps and would otherwise close
  // over a stale value. A toggle while `forceCollapsed` holds flips only the
  // user's preference, so no terminal mounts and nothing arrives.
  const forceCollapsedRef = useRef(forceCollapsed);
  // The committed collapse, for the reveal callback below. `effectiveCollapsedRef`
  // moves only in the showContent effect, which is passive. After a collapse that is
  // not a discrete event, a frame can cancel the expand's transition before that effect
  // runs, and the reveal would then read the stale expanded value.
  const committedCollapsedRef = useRef(effectiveCollapsed);
  // The two mirrors are written on commit, in a layout effect that runs ahead
  // of every passive effect and handler below that reads them; never during
  // render, which the compiler rules forbid.
  useLayoutEffect(() => {
    forceCollapsedRef.current = forceCollapsed;
    committedCollapsedRef.current = effectiveCollapsed;
  });
  const availableHeightRef = useRef(0);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Adopt the saved height when IT changes. A render-time adjustment (React's
  // "adjusting state when a prop changes" pattern) rather than an effect, so the
  // panel never paints the old height for a frame. The initial state already comes
  // from the mount-time config.
  //
  // Keyed on the value, never on the config object. The drag below persists its
  // height straight to main, so the renderer's config store keeps the height it
  // loaded, and every unrelated config write rebuilds that object around the stale
  // value. A window layout save is one, and opening a task's detail makes one, so
  // a sync on the object put the panel back to its loaded height whenever a task
  // was opened after a drag.
  const savedHeight = config.terminal?.panelHeight;
  const [syncedSavedHeight, setSyncedSavedHeight] = useState(savedHeight);
  if (savedHeight !== syncedSavedHeight) {
    setSyncedSavedHeight(savedHeight);
    if (typeof savedHeight === 'number' && savedHeight >= MIN_HEIGHT) setHeight(savedHeight);
  }
  // The ref half of that sync, which render cannot do. Keyed on the saved value,
  // like the state half, so it stays the config's write and not a mirror of every
  // `height` (the drag and clamp paths write the ref themselves).
  useLayoutEffect(() => {
    if (typeof savedHeight === 'number' && savedHeight >= MIN_HEIGHT) latestHeightRef.current = savedHeight;
  }, [savedHeight]);

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

  // Lift the snap after its settle window. Keyed on the switch key as well, so a second
  // switch inside the window restarts it. A re-run of this effect (Fast Refresh, the
  // StrictMode double mount) re-arms the timer while the suppression holds, so it can
  // never strand at true and leave the panel without its animation.
  useEffect(() => {
    if (!suppressTransition) return;
    const timer = setTimeout(() => setSuppressTransition(false), SWITCH_SNAP_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [suppressTransition, switchKey]);

  // Drive showContent on every effectiveCollapsed transition (whether the user
  // toggled or a window opened/closed). Collapsing: hide content after the 200ms
  // height animation. Expanding: mount it once the container's height transition
  // settles, so the terminal fits at the final size, or at once when no transition
  // runs (see `resolveContentAction`).
  useEffect(() => {
    const wasCollapsed = effectiveCollapsedRef.current;
    effectiveCollapsedRef.current = effectiveCollapsed;
    const expanding = wasCollapsed && !effectiveCollapsed;
    const heightTransition = expanding ? findHeightTransition(panelContainerRef.current) : null;
    const action = resolveContentAction(wasCollapsed, effectiveCollapsed, heightTransition !== null);
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
    } else if (heightTransition) {
      // 'reveal-when-transition-settles', which comes back only with a transition in hand.
      // `finished` resolves when the transition ends and rejects when it is cancelled:
      // reversed by a collapse, or the container removed by a view switch mid-expand.
      // Either way it settles, so the reveal never waits on an event that may not come.
      // A collapse in between is the one settle that must not reveal.
      const revealIfExpanded = () => {
        if (!committedCollapsedRef.current) setShowContent(true);
      };
      heightTransition.finished.then(revealIfExpanded, revealIfExpanded);
    }
  }, [effectiveCollapsed, panelContainerRef]);

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
  }, [clampHeight, contentColRef]);

  const onToggleCollapse = useCallback(() => {
    // Expanding REMOUNTS the panel's TerminalTab (`showContent` gates whether it
    // renders one at all), which is an arrival. Claim focus for it, because the
    // bottom panel is not a window: expanding moves no layer's `focusedWindowId`,
    // so with a detail window open the arbiter would otherwise leave focus there
    // and the freshly expanded terminal would need a click before it could be
    // typed into. Read from the ref rather than `collapsed`, which this callback
    // closes over stale (it has no deps, by design). A claim whose session never
    // mounts simply expires.
    // Only when the toggle will actually un-collapse. While `forceCollapsed`
    // holds (a project switch with detail windows still restoring), the panel
    // stays collapsed and mounts nothing, so a claim here would name a terminal
    // that never arrives - and tier 1 is EXCLUSIVE, so that dangling claim would
    // deny the restoring windows' own terminals for the full TTL.
    if (effectiveCollapsedRef.current && !forceCollapsedRef.current) {
      claimArrivalFocus(panelArrivalSessionId());
    }

    // Only the user's preference flips here; the showContent timing is driven by
    // the effectiveCollapsed effect above (which also reacts to windows opening).
    // The write names only the field it changes. Main merges `terminal`, and a full
    // object spread from the config store would carry the store's stale height and
    // overwrite the one the last drag saved.
    setCollapsed((prev) => {
      const newCollapsed = !prev;
      window.electronAPI.config.set({ terminal: { panelCollapsed: newCollapsed } });
      return newCollapsed;
    });
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
        // Only the height, for the same reason as the collapse toggle's write.
        window.electronAPI.config.set({ terminal: { panelHeight: latestHeightRef.current } });
        // The final refit is a layout change: the terminal holds its frame at the
        // new height until its agent has repainted (`terminal-layout-transition.ts`).
        runTerminalLayoutChange(document.querySelector<HTMLElement>('[data-testid="terminal-panel-container"]'), () => {
          setIsResizing(false);
          // Explicit refit signal. The debounced ResizeObserver also handles this,
          // but the explicit event gives a faster response (at once in a transition).
          window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
        });
      },
    });
  }, [height, clampHeight]);

  return { height, collapsed: effectiveCollapsed, isResizing, showContent, ready, suppressTransition, onToggleCollapse, onResizeStart };
}

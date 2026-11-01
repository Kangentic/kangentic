/**
 * The Command Terminal rail's width and fold, in the panel and the detached
 * window alike.
 *
 * The saved state (`AppConfig.commandTerminalRail`) is global: one width and
 * one fold for every project, kept across restarts. What the rail SHOWS is
 * resolved from it (`resolveRailWidth`): a row too narrow for the saved width
 * beside the terminals at their floor (one terminal's width, or two side by
 * side) shows the rail narrower, and the saved width comes back when there is
 * room. Nothing here writes a clamped width.
 *
 * The edge drags by the project sidebar's rule (`resolveFoldingEdgeDrag`): 200
 * to 400, held at 200 while the pointer goes on to 100, and folded to the strip
 * past that, while the drag runs, so letting go keeps what the screen shows;
 * back past 100 it opens at 200. As the panel's own edges do, the drag writes
 * the width straight to the rail's element, so the terminals' tiles follow it
 * without a render, and it holds the manager-resize gate for the whole gesture,
 * so the terminals refit once on release, a fold or an open included, since
 * that too lands during the drag. The release commits, saves and closes the
 * gate as one layout change, so each terminal holds its frame until its agent
 * has repainted. Escape, a pointer cancel or the window losing focus cancel the
 * drag.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useConfigStore } from '../../stores/config-store';
import { beginManagerResize, type ManagerResizeGesture } from '../../window-manager/terminal/manager-resize-gate';
import { resolveFoldingEdgeDrag } from '../../utils/folding-edge-drag';
import { usePanelWidthChange, type PanelWidthSession } from './panel-edge-push';
import {
  COMMAND_RAIL_COLLAPSED_WIDTH_PX,
  COMMAND_RAIL_DEFAULT_WIDTH_PX,
  COMMAND_RAIL_MAX_WIDTH_PX,
  COMMAND_RAIL_MIN_WIDTH_PX,
  resolveRailWidth,
  savedRailWidth,
  type CommandTerminalRailState,
} from '../../../shared/command-terminal-rail';

const DEFAULT_RAIL: CommandTerminalRailState = { width: COMMAND_RAIL_DEFAULT_WIDTH_PX, collapsed: false };

/** One edge drag in flight. */
interface RailGesture {
  pointerId: number;
  startX: number;
  /** The width shown when the drag began (the strip's, when it began folded). */
  startWidth: number;
  startedCollapsed: boolean;
  /** The widest the rail may go: its own maximum beside a panel that resizes with it, else beside the terminals at their floor. */
  maxWidth: number;
  /** How far the terminals can narrow for the rail, to their floor, where the panel cannot grow. */
  spare: number;
  /** The panel's width change (`panel-edge-push.ts`), or null where it cannot change (maximized, the detached window). */
  panel: PanelWidthSession | null;
  /** Where the drag would leave the rail if it ended now. */
  width: number;
  collapsed: boolean;
  resize: ManagerResizeGesture | null;
  stopListening: () => void;
}

/** What a drag shows in React: the fold, and the width the rail had when the fold last changed. */
interface DraggedRail {
  collapsed: boolean;
  width: number;
}

export interface CommandTerminalRail {
  /** The rail shows its strip. */
  collapsed: boolean;
  /** The width the rail renders at. Mid-drag the element itself has the live width. */
  width: number;
  /** An edge drag is in flight. */
  resizing: boolean;
  onEdgePointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  /** Fold the rail to its strip, or open it at the width it had. */
  toggle: () => void;
}

const shownWidthOf = (rail: DraggedRail): number => (rail.collapsed ? COMMAND_RAIL_COLLAPSED_WIDTH_PX : rail.width);

/**
 * Write a drag's rail straight to its element: the width and, with it, the
 * minimum the open rail keeps (`CommandTerminalRail`). Writing the width alone
 * left the open minimum on a strip the drag had just folded until React rendered,
 * the rail laid out at 200 for those frames, and the terminals refit narrower.
 */
function applyRail(element: HTMLElement | null, rail: DraggedRail): void {
  if (!element) return;
  element.style.width = `${shownWidthOf(rail)}px`;
  element.style.minWidth = rail.collapsed ? '' : `${COMMAND_RAIL_MIN_WIDTH_PX}px`;
}

/**
 * `railRef` is the rail's root element, whose parent is the row the rail shares
 * with the terminals. The caller owns it, so nothing this returns is a ref.
 * `terminalsMinWidth` is the width the terminals need beside it: the grid at the
 * pane floor (`commandTerminalGridMinimum`).
 */
export function useCommandTerminalRail(
  railRef: React.RefObject<HTMLElement | null>,
  onLayoutChange: (change: () => void) => void,
  terminalsMinWidth: number,
): CommandTerminalRail {
  const saved = useConfigStore((state) => state.config.commandTerminalRail) ?? DEFAULT_RAIL;
  const saveRail = useConfigStore((state) => state.saveCommandTerminalRail);
  const [rowWidth, setRowWidth] = useState(0);
  const [dragged, setDragged] = useState<DraggedRail | null>(null);
  const gestureRef = useRef<RailGesture | null>(null);
  const panelWidth = usePanelWidthChange();

  // The row the rail shares with the terminals, measured as it changes. Not
  // while the edge drags: the drag resizes the panel every frame, the rail
  // shows the drag's own width meanwhile, and its end measures the row once.
  useLayoutEffect(() => {
    const row = railRef.current?.parentElement;
    if (!row) return;
    const measure = (): void => {
      if (!gestureRef.current) setRowWidth(row.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [railRef]);

  /**
   * The row as it is now, for a change that resized the panel in the same step:
   * its observer reports a frame late, and the rail would render narrowed beside
   * the panel's old width for that frame.
   */
  const measureRowNow = useCallback((): void => {
    const row = railRef.current?.parentElement;
    if (row) setRowWidth(row.clientWidth);
  }, [railRef]);

  // The detached window writes this too, and the panel mounts on a config this
  // window loaded earlier, so it reads the saved state back once on mount.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.config.getGlobal()
      .then((global) => {
        const fresh = global.commandTerminalRail;
        if (cancelled || !fresh || gestureRef.current) return;
        const current = useConfigStore.getState().config.commandTerminalRail;
        if (current && current.width === fresh.width && current.collapsed === fresh.collapsed) return;
        useConfigStore.getState().adoptCommandTerminalRail({ width: savedRailWidth(fresh.width), collapsed: fresh.collapsed === true });
      })
      .catch(() => {
        // The rail keeps the state this window already has.
      });
    return () => { cancelled = true; };
  }, []);

  const collapsed = dragged ? dragged.collapsed : saved.collapsed === true;
  const width = dragged
    ? shownWidthOf(dragged)
    : collapsed ? COMMAND_RAIL_COLLAPSED_WIDTH_PX : resolveRailWidth({ saved, rowWidth, terminalFloorWidth: terminalsMinWidth });

  // A fold flip mid-drag re-renders the rail at the width the flip had; the
  // drag's live width goes back on before paint.
  useLayoutEffect(() => {
    const gesture = gestureRef.current;
    if (gesture) applyRail(railRef.current, gesture);
  }, [dragged, railRef]);

  const endGesture = useCallback((commit: boolean): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stopListening();
    const endsCollapsed = commit ? gesture.collapsed : gesture.startedCollapsed;
    const endsWidth = commit ? gesture.width : gesture.startWidth;
    // On screen at once, as the render after it will draw it.
    applyRail(railRef.current, { collapsed: endsCollapsed, width: endsWidth });
    const finish = (): void => {
      setDragged(null);
      // The panel keeps the width the rail gave it, or goes back with the rail.
      if (commit) gesture.panel?.commit();
      else gesture.panel?.cancel();
      measureRowNow();
      if (commit && endsCollapsed !== gesture.startedCollapsed) {
        // Folded, the rail keeps the width it opens at again.
        saveRail(endsCollapsed
          ? { width: savedRailWidth(saved.width), collapsed: true }
          : { width: savedRailWidth(endsWidth), collapsed: false });
      } else if (commit && !endsCollapsed && endsWidth !== gesture.startWidth) {
        saveRail({ width: savedRailWidth(endsWidth), collapsed: false });
      }
      // Closing the gate is what sends each terminal its one refit.
      gesture.resize?.end();
    };
    if (commit && gesture.resize) onLayoutChange(finish);
    else finish();
  }, [railRef, saved.width, saveRail, onLayoutChange, measureRowNow]);

  const onEdgePointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const roomBesideTerminals = rowWidth > 0 ? rowWidth - terminalsMinWidth : COMMAND_RAIL_MAX_WIDTH_PX;
    // The rail is the panel's: its width changes the panel's by the same amount
    // and the terminals keep theirs. Where the panel cannot change (maximized,
    // the detached window), the rail keeps to the room beside the terminals.
    const panel = panelWidth?.begin() ?? null;
    const maxWidth = panel
      ? COMMAND_RAIL_MAX_WIDTH_PX
      : Math.max(COMMAND_RAIL_MIN_WIDTH_PX, Math.min(COMMAND_RAIL_MAX_WIDTH_PX, roomBesideTerminals));

    const onMove = (moveEvent: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (!gesture || moveEvent.pointerId !== pointerId) return;
      const raw = Math.round(gesture.startWidth + (moveEvent.clientX - gesture.startX));
      const wasCollapsed = gesture.collapsed;
      const starting = !gesture.resize;
      if (starting) {
        // Closed when the drag ends, or by the gate if the release never reaches this window.
        gesture.resize = beginManagerResize('command-terminal-rail', pointerId, () => endGesture(true));
      }
      const step = resolveFoldingEdgeDrag({ raw, minWidth: COMMAND_RAIL_MIN_WIDTH_PX, maxWidth: gesture.maxWidth });
      gesture.collapsed = step.collapsed;
      if (gesture.panel) {
        // The panel takes the rail's change, a fold or an open included; only
        // growth the area stops is taken from the terminals, down to their floor.
        const wanted = (step.collapsed ? COMMAND_RAIL_COLLAPSED_WIDTH_PX : step.width) - gesture.startWidth;
        const granted = gesture.panel.resize(wanted);
        const fromTerminals = wanted > granted ? Math.min(wanted - granted, gesture.spare) : 0;
        gesture.width = step.collapsed
          ? step.width
          : Math.max(COMMAND_RAIL_MIN_WIDTH_PX, gesture.startWidth + granted + fromTerminals);
      } else {
        gesture.width = step.width;
      }
      applyRail(railRef.current, gesture);
      if (starting || gesture.collapsed !== wasCollapsed) setDragged({ collapsed: gesture.collapsed, width: gesture.width });
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId === pointerId) endGesture(true);
    };
    const onCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId === pointerId) endGesture(false);
    };
    const onBlur = (): void => endGesture(false);
    // Escape cancels the drag, before anything under it sees the key.
    const onKeyDown = (keyEvent: KeyboardEvent): void => {
      if (keyEvent.key !== 'Escape' || !gestureRef.current) return;
      keyEvent.preventDefault();
      keyEvent.stopImmediatePropagation();
      endGesture(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('keydown', onKeyDown, true);
    gestureRef.current = {
      pointerId,
      startX: event.clientX,
      startWidth: width,
      startedCollapsed: collapsed,
      maxWidth,
      spare: Math.max(0, roomBesideTerminals - width),
      panel,
      width,
      collapsed,
      resize: null,
      stopListening: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onBlur);
        document.removeEventListener('keydown', onKeyDown, true);
      },
    };
  }, [railRef, rowWidth, terminalsMinWidth, width, collapsed, endGesture, panelWidth]);

  // An unmount mid-drag stops listening and closes the gate it held, which
  // would otherwise hold every terminal's refit in the app.
  useEffect(() => () => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stopListening();
    gesture.panel?.cancel();
    gesture.resize?.end();
  }, []);

  // Folding or opening resizes the panel by the rail's change, so the terminals
  // keep their size; with no pointer to follow, an open the right edge cannot take
  // grows the panel to the left. Where the panel cannot change, the terminals take it.
  const toggle = useCallback((): void => {
    const next = { width: savedRailWidth(saved.width), collapsed: saved.collapsed !== true };
    const shownNow = railRef.current?.getBoundingClientRect().width ?? width;
    const shownNext = next.collapsed ? COMMAND_RAIL_COLLAPSED_WIDTH_PX : next.width;
    const panel = panelWidth?.begin({ spillLeft: true }) ?? null;
    onLayoutChange(() => {
      if (panel) {
        panel.resize(shownNext - shownNow);
        panel.commit();
        measureRowNow();
      }
      saveRail(next);
    });
  }, [saved.width, saved.collapsed, saveRail, onLayoutChange, railRef, width, panelWidth, measureRowNow]);

  return { collapsed, width, resizing: dragged !== null, onEdgePointerDown, toggle };
}

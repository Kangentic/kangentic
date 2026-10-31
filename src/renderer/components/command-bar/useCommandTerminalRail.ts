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
  /** The widest the rail may go beside the terminals at their floor. */
  maxWidth: number;
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

  // The row the rail shares with the terminals, measured as it changes.
  useLayoutEffect(() => {
    const row = railRef.current?.parentElement;
    if (!row) return;
    const measure = (): void => setRowWidth(row.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
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
    if (gesture && railRef.current) railRef.current.style.width = `${shownWidthOf(gesture)}px`;
  }, [dragged, railRef]);

  const endGesture = useCallback((commit: boolean): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stopListening();
    const endsCollapsed = commit ? gesture.collapsed : gesture.startedCollapsed;
    const endsWidth = commit ? gesture.width : gesture.startWidth;
    // On screen at once, as the render after it will draw it.
    if (railRef.current) railRef.current.style.width = `${shownWidthOf({ collapsed: endsCollapsed, width: endsWidth })}px`;
    const finish = (): void => {
      setDragged(null);
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
  }, [railRef, saved.width, saveRail, onLayoutChange]);

  const onEdgePointerDown = useCallback((event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || gestureRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    const pointerId = event.pointerId;
    const roomBesideTerminals = rowWidth > 0 ? rowWidth - terminalsMinWidth : COMMAND_RAIL_MAX_WIDTH_PX;
    const maxWidth = Math.max(COMMAND_RAIL_MIN_WIDTH_PX, Math.min(COMMAND_RAIL_MAX_WIDTH_PX, roomBesideTerminals));

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
      gesture.width = step.width;
      if (railRef.current) railRef.current.style.width = `${shownWidthOf(gesture)}px`;
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
  }, [railRef, rowWidth, terminalsMinWidth, width, collapsed, endGesture]);

  // An unmount mid-drag stops listening and closes the gate it held, which
  // would otherwise hold every terminal's refit in the app.
  useEffect(() => () => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    gesture.stopListening();
    gesture.resize?.end();
  }, []);

  const toggle = useCallback((): void => {
    const next = { width: savedRailWidth(saved.width), collapsed: saved.collapsed !== true };
    onLayoutChange(() => saveRail(next));
  }, [saved.width, saved.collapsed, saveRail, onLayoutChange]);

  return { collapsed, width, resizing: dragged !== null, onEdgePointerDown, toggle };
}

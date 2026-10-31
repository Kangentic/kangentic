/**
 * The Command Terminal PANEL: one window over the board that holds the rail
 * and every running terminal. It moves by its header, resizes from its outer
 * edges, and maximizes to the whole area between the title bar and the status
 * bar; the terminals inside never float on their own (the window layer tiles
 * them into the panel's terminal area, `hostArranged`).
 *
 * Its place is GLOBAL (`AppConfig.commandTerminalPanel`), like the terminals'
 * layout: fractions of the area it sits in, so it rescales with the window. A
 * move or a resize follows the pointer live and is saved once, on release. A
 * resize holds the manager-resize gate for the whole gesture, so the terminals
 * inside keep their grid while the panel changes size and refit once, after.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize, Minimize, SquareArrowOutUpRight, SquareTerminal, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { useConfigStore } from '../../stores/config-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { beginManagerResize, type ManagerResizeGesture } from '../../window-manager/terminal/manager-resize-gate';
import { runTerminalLayoutChange } from '../../utils/terminal-layout-transition';
import type { ContainerSize as PanelSize, PixelRect } from '../../window-manager/store/geometry';
import type { CommandTerminalPanelGeometry } from '../../../shared/types';

/** The panel header's height, which the terminals' area excludes. */
export const COMMAND_PANEL_HEADER_HEIGHT_PX = 40;

/**
 * The share of the area a Command Terminal opened at before the panel: a
 * floating window centered at 58% by 70%, the window manager's first-window
 * default. Copied rather than imported so a change to board windows' default
 * does not move this panel.
 */
const RELEASED_TERMINAL_SHARE = { width: 0.58, height: 0.7 };

/**
 * The header's window controls are drawn the way a task window draws its own
 * (`MaximizeToggleButton`, `TaskDetailWindow`'s close): 16px, in the dim
 * `fg-faint` tone that brightens on hover. They were 15px in the brighter
 * `fg-muted`, which read as smaller and louder beside the task windows.
 */
const PANEL_CONTROL_ICON_PX = 16;
const PANEL_CONTROL_CLASS = 'p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0';

/**
 * Where the panel opens before it was ever moved or resized: centered, and
 * sized so a lone terminal is as large as one opened before the panel existed,
 * with the rail and the panel header (`chrome`) added around it. Every user
 * meets this the first time they open the panel after updating, since the
 * panel's place is a new setting. Fractions of the area, as a saved place is.
 */
function defaultPanelGeometry(area: PanelSize, chrome: PanelSize): CommandTerminalPanelGeometry {
  if (area.width <= 0 || area.height <= 0) return { x: 0, y: 0, w: 1, h: 1, maximized: false };
  const widthShare = Math.min(1, (RELEASED_TERMINAL_SHARE.width * area.width + chrome.width) / area.width);
  const heightShare = Math.min(1, (RELEASED_TERMINAL_SHARE.height * area.height + chrome.height) / area.height);
  return { x: (1 - widthShare) / 2, y: (1 - heightShare) / 2, w: widthShare, h: heightShare, maximized: false };
}

/**
 * A saved place whose numbers can be laid out. config.json is the user's to
 * edit, and a place with a missing or non-numeric field would size the panel
 * to NaN and leave it nowhere on screen.
 */
function isUsableGeometry(geometry: CommandTerminalPanelGeometry | null | undefined): geometry is CommandTerminalPanelGeometry {
  return !!geometry && [geometry.x, geometry.y, geometry.w, geometry.h].every((value) => Number.isFinite(value));
}

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const RESIZE_EDGES: Array<{ edge: ResizeEdge; className: string }> = [
  { edge: 'n', className: 'top-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 's', className: 'bottom-0 left-2 right-2 h-1.5 cursor-ns-resize' },
  { edge: 'e', className: 'right-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'w', className: 'left-0 top-2 bottom-2 w-1.5 cursor-ew-resize' },
  { edge: 'ne', className: 'right-0 top-0 h-2.5 w-2.5 cursor-nesw-resize' },
  { edge: 'nw', className: 'left-0 top-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { edge: 'se', className: 'right-0 bottom-0 h-2.5 w-2.5 cursor-nwse-resize' },
  { edge: 'sw', className: 'left-0 bottom-0 h-2.5 w-2.5 cursor-nesw-resize' },
];

/**
 * `rect` on whole pixels, still inside the area. The terminals are tiled from
 * the terminal area's whole-pixel `clientWidth` and `clientHeight`, so a panel
 * on a fractional box (fractions of the area land anywhere) left each tile up
 * to a pixel bigger than the area it sits in, and the panel's clip cut the
 * tile's bottom border, the edge that turns accent when the terminal has focus.
 */
function toWholePixels(rect: PixelRect, size: PanelSize): PixelRect {
  const left = Math.round(rect.left);
  const top = Math.round(rect.top);
  return {
    left,
    top,
    width: Math.min(Math.round(rect.width), Math.floor(size.width) - left),
    height: Math.min(Math.round(rect.height), Math.floor(size.height) - top),
  };
}

/** The panel's pixel rect in an area of `size`, kept inside it and above the
 *  floor (which itself gives way to an area smaller than it). */
function toPixels(geometry: CommandTerminalPanelGeometry, size: PanelSize, minSize: PanelSize): PixelRect {
  if (geometry.maximized) return toWholePixels({ left: 0, top: 0, width: size.width, height: size.height }, size);
  const width = Math.min(size.width, Math.max(minSize.width, geometry.w * size.width));
  const height = Math.min(size.height, Math.max(minSize.height, geometry.h * size.height));
  const left = Math.min(Math.max(0, geometry.x * size.width), Math.max(0, size.width - width));
  const top = Math.min(Math.max(0, geometry.y * size.height), Math.max(0, size.height - height));
  return toWholePixels({ left, top, width, height }, size);
}

function toGeometry(rect: PixelRect, size: PanelSize): CommandTerminalPanelGeometry {
  const width = size.width || 1;
  const height = size.height || 1;
  return { x: rect.left / width, y: rect.top / height, w: rect.width / width, h: rect.height / height, maximized: false };
}

/** A rect resized by dragging `edge` by `deltaX`/`deltaY`, held above the floor and inside the area. */
function resizeRect(start: PixelRect, edge: ResizeEdge, deltaX: number, deltaY: number, size: PanelSize, minSize: PanelSize): PixelRect {
  const minWidth = Math.min(minSize.width, size.width);
  const minHeight = Math.min(minSize.height, size.height);
  let { left, top, width, height } = start;
  if (edge.includes('e')) width = Math.min(size.width - left, Math.max(minWidth, start.width + deltaX));
  if (edge.includes('s')) height = Math.min(size.height - top, Math.max(minHeight, start.height + deltaY));
  if (edge.includes('w')) {
    const nextLeft = Math.min(start.left + start.width - minWidth, Math.max(0, start.left + deltaX));
    width = start.width + (start.left - nextLeft);
    left = nextLeft;
  }
  if (edge.includes('n')) {
    const nextTop = Math.min(start.top + start.height - minHeight, Math.max(0, start.top + deltaY));
    height = start.height + (start.top - nextTop);
    top = nextTop;
  }
  return toWholePixels({ left, top, width, height }, size);
}

/** A move or a resize in flight, with the geometry it started from and the call that stops listening for it. */
interface PanelGesture {
  pointerId: number;
  startX: number;
  startY: number;
  edge: ResizeEdge | null;
  startRect: PixelRect;
  area: PanelSize;
  floor: PanelSize;
  /** The resize's hold on the manager-resize gate, opened by its first move; null for a move or before one. */
  resizeGesture: ManagerResizeGesture | null;
  /** The last pointer position the gesture followed, which an abandoned resize commits. */
  lastX: number;
  lastY: number;
  stopListening: () => void;
}

function applyBox(panel: HTMLElement | null, box: PixelRect): void {
  if (!panel) return;
  panel.style.left = `${box.left}px`;
  panel.style.top = `${box.top}px`;
  panel.style.width = `${box.width}px`;
  panel.style.height = `${box.height}px`;
}

/** Stop following a gesture and put the panel back where it started. A save that follows re-renders it. */
function releaseGesture(gesture: PanelGesture, panel: HTMLElement | null): void {
  gesture.stopListening();
  if (panel) panel.style.transform = '';
  if (gesture.edge !== null) applyBox(panel, gesture.startRect);
  gesture.resizeGesture?.end();
}

interface CommandTerminalPanelProps {
  /** Hide the whole layer (keeps every terminal running). */
  onHide: () => void;
  /** The rail, drawn down the panel's left side. */
  rail: ReactNode;
  /** The terminal area's element, once mounted: the window layer renders into it. */
  onTerminalAreaReady: (element: HTMLElement | null) => void;
  /** The smallest the panel may be: the terminals' grid at the pane floor beside the rail. */
  minSize: PanelSize;
  /** What the panel adds around its terminals: the rail and the header, with the border. */
  chrome: PanelSize;
  /** Move the panel into a window of its own. */
  onOpenInNewWindow: () => void;
  /** Why Open in new window is off right now, or null when it is on. */
  openInNewWindowDisabledReason: string | null;
}

export function CommandTerminalPanel({
  onHide,
  rail,
  onTerminalAreaReady,
  minSize,
  chrome,
  onOpenInNewWindow,
  openInNewWindowDisabledReason,
}: CommandTerminalPanelProps) {
  const { t } = useLingui();
  const areaRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const savedGeometry = useConfigStore((state) => state.globalConfig.commandTerminalPanel);
  const saveGeometry = useConfigStore((state) => state.saveCommandTerminalPanel);
  const geometry = isUsableGeometry(savedGeometry) ? savedGeometry : defaultPanelGeometry(areaSize, chrome);
  const rect = toPixels(geometry, areaSize, minSize);

  // The gesture in flight. A move translates the panel; a resize writes its box
  // straight to the element, and React takes it back over on the save.
  const gestureRef = useRef<PanelGesture | null>(null);

  // A panel its terminals outgrew (one added, or the grid restored from an
  // expanded terminal) already shows at the larger size, since `toPixels` holds
  // it above the floor. Saving that size keeps it, so the next Expand does not
  // shrink the panel back; the box on screen does not move. A floor the area
  // cannot hold (a small window) is not a size to keep.
  const previousMinSizeRef = useRef(minSize);
  useLayoutEffect(() => {
    const previous = previousMinSizeRef.current;
    previousMinSizeRef.current = minSize;
    if (minSize.width <= previous.width && minSize.height <= previous.height) return;
    if (gestureRef.current) return;
    if (!isUsableGeometry(savedGeometry) || savedGeometry.maximized || areaSize.width === 0 || areaSize.height === 0) return;
    if (minSize.width > areaSize.width || minSize.height > areaSize.height) return;
    if (savedGeometry.w * areaSize.width >= minSize.width && savedGeometry.h * areaSize.height >= minSize.height) return;
    saveGeometry(toGeometry(rect, areaSize));
  });

  useLayoutEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const measure = () => {
      const width = area.clientWidth;
      const height = area.clientHeight;
      // A hidden or collapsing window can report a zero box for a frame; keeping
      // the last real size stops the panel, and every terminal in it, unmounting.
      if (width === 0 || height === 0) return;
      setAreaSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  // Every terminal in the panel resizes: the new layout shows at once, and each
  // terminal holds its frame until its agent has repainted.
  const toggleMaximized = useCallback(() => {
    runTerminalLayoutChange(areaRef.current, () => saveGeometry({ ...geometry, maximized: !geometry.maximized }));
  }, [geometry, saveGeometry]);

  useKeybinding('panel.maximize', toggleMaximized, { capture: true });

  /** Where a move by `deltaX`/`deltaY` puts the panel, kept inside the area. */
  const movedBy = (gesture: { startRect: PixelRect; area: PanelSize }, deltaX: number, deltaY: number): { x: number; y: number } => ({
    x: Math.min(Math.max(deltaX, -gesture.startRect.left), gesture.area.width - gesture.startRect.left - gesture.startRect.width),
    y: Math.min(Math.max(deltaY, -gesture.startRect.top), gesture.area.height - gesture.startRect.top - gesture.startRect.height),
  });

  /** End the gesture in flight, committing it on a release and dropping it on a cancel. */
  const endGesture = (commit: boolean, clientX: number, clientY: number): void => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    const deltaX = clientX - gesture.startX;
    const deltaY = clientY - gesture.startY;
    if (!commit || (deltaX === 0 && deltaY === 0)) {
      releaseGesture(gesture, panelRef.current);
      return;
    }
    if (gesture.edge === null) {
      releaseGesture(gesture, panelRef.current);
      const offset = movedBy(gesture, deltaX, deltaY);
      saveGeometry(toGeometry({ ...gesture.startRect, left: gesture.startRect.left + offset.x, top: gesture.startRect.top + offset.y }, gesture.area));
      return;
    }
    // The panel already has its final box, so the save changes nothing the
    // terminals can see: closing the gate is what sends their one refit. Both
    // run as one layout change, so the terminals hold their frames until they repaint.
    const box = resizeRect(gesture.startRect, gesture.edge, deltaX, deltaY, gesture.area, gesture.floor);
    gesture.stopListening();
    runTerminalLayoutChange(areaRef.current, () => {
      applyBox(panelRef.current, box);
      saveGeometry(toGeometry(box, gesture.area));
      gesture.resizeGesture?.end();
    });
  };

  /**
   * Follow a press to its release on the window, as the window engine's own
   * drag does: a pointer capture taken on the press would swallow the header's
   * double-click, and the release can land anywhere.
   */
  const beginGesture = (event: React.PointerEvent, edge: ResizeEdge | null): void => {
    const pointerId = event.pointerId;
    const onMove = (moveEvent: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (!gesture || moveEvent.pointerId !== pointerId) return;
      gesture.lastX = moveEvent.clientX;
      gesture.lastY = moveEvent.clientY;
      const deltaX = moveEvent.clientX - gesture.startX;
      const deltaY = moveEvent.clientY - gesture.startY;
      if (gesture.edge === null) {
        const offset = movedBy(gesture, deltaX, deltaY);
        if (panelRef.current) panelRef.current.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
        return;
      }
      if (!gesture.resizeGesture) {
        // Closed when the gesture ends, or by the gate if the release never reaches this window's listeners.
        gesture.resizeGesture = beginManagerResize('command-terminal-panel', pointerId, () => {
          if (gestureRef.current === gesture) endGesture(true, gesture.lastX, gesture.lastY);
        });
      }
      applyBox(panelRef.current, resizeRect(gesture.startRect, gesture.edge, deltaX, deltaY, gesture.area, gesture.floor));
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId === pointerId) endGesture(true, upEvent.clientX, upEvent.clientY);
    };
    const onCancel = (cancelEvent: PointerEvent): void => {
      if (cancelEvent.pointerId === pointerId) endGesture(false, cancelEvent.clientX, cancelEvent.clientY);
    };
    const onBlur = (): void => endGesture(false, 0, 0);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    gestureRef.current = {
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      edge,
      startRect: rect,
      area: areaSize,
      floor: minSize,
      resizeGesture: null,
      lastX: event.clientX,
      lastY: event.clientY,
      stopListening: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onBlur);
      },
    };
  };

  const handleHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || geometry.maximized || gestureRef.current) return;
    if ((event.target as HTMLElement).closest('button')) return;
    beginGesture(event, null);
  };

  const handleResizePointerDown = (edge: ResizeEdge) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current) return;
    event.stopPropagation();
    event.preventDefault();
    beginGesture(event, edge);
  };

  // Escape cancels a gesture in flight, before anything under it sees the key.
  // An unmount mid-gesture stops listening for it and closes the gate it held,
  // which would otherwise hold every terminal's refit in the app.
  useEffect(() => {
    const panel = panelRef;
    const cancelOnEscape = (event: KeyboardEvent) => {
      const gesture = gestureRef.current;
      if (event.key !== 'Escape' || !gesture) return;
      event.stopImmediatePropagation();
      gestureRef.current = null;
      releaseGesture(gesture, panel.current);
    };
    document.addEventListener('keydown', cancelOnEscape, true);
    return () => {
      document.removeEventListener('keydown', cancelOnEscape, true);
      const gesture = gestureRef.current;
      gestureRef.current = null;
      if (gesture) releaseGesture(gesture, panel.current);
    };
  }, []);

  return (
    <div
      ref={areaRef}
      className="absolute inset-0 pointer-events-none"
      data-testid="command-terminal-panel-area"
      // The panel's layout changes land here, so every terminal in it holds its frame.
      data-terminal-layout-scope=""
    >
      {areaSize.width > 0 && (
        <div
          ref={panelRef}
          className={`absolute flex flex-col overflow-hidden bg-surface-raised border border-edge pointer-events-auto ${
            geometry.maximized ? 'rounded-none' : 'rounded-lg shadow-2xl'
          }`}
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
          data-testid="command-terminal-panel"
          data-maximized={geometry.maximized ? 'true' : 'false'}
        >
          <div
            className={`flex items-center gap-2.5 pl-3.5 pr-2 border-b border-edge flex-shrink-0 select-none ${
              geometry.maximized ? '' : 'cursor-grab active:cursor-grabbing'
            }`}
            style={{ height: COMMAND_PANEL_HEADER_HEIGHT_PX }}
            onPointerDown={handleHeaderPointerDown}
            // A press on the header (a move, Maximize) leaves keyboard focus in
            // the terminal the user was typing in, as a title bar does.
            onMouseDown={(event) => event.preventDefault()}
            onDoubleClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              toggleMaximized();
            }}
            data-testid="command-terminal-panel-header"
          >
            <SquareTerminal size={14} className="text-fg-muted flex-shrink-0" />
            <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-fg"><Trans>Command Terminal</Trans></span>
            <Tooltip
              label={tipLabel({
                disabled: openInNewWindowDisabledReason !== null,
                disabledReason: openInNewWindowDisabledReason,
                tip: t`Move to its own window`,
              })}
            >
              <button
                type="button"
                onClick={onOpenInNewWindow}
                disabled={openInNewWindowDisabledReason !== null}
                className={`${PANEL_CONTROL_CLASS} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-faint`}
                aria-label={t`Open in new window`}
                data-testid="command-terminal-panel-pop-out"
              >
                <SquareArrowOutUpRight size={PANEL_CONTROL_ICON_PX} />
              </button>
            </Tooltip>
            <Tooltip label={geometry.maximized ? t`Restore panel` : t`Maximize panel`} keys="panel.maximize">
              <button
                type="button"
                onClick={toggleMaximized}
                className={PANEL_CONTROL_CLASS}
                aria-label={geometry.maximized ? t`Restore panel` : t`Maximize panel`}
                data-testid="command-terminal-panel-maximize"
              >
                {geometry.maximized ? <Minimize size={PANEL_CONTROL_ICON_PX} /> : <Maximize size={PANEL_CONTROL_ICON_PX} />}
              </button>
            </Tooltip>
            <Tooltip label={t`Hide panel`} keys="panel.close">
              <button
                type="button"
                onClick={onHide}
                className={PANEL_CONTROL_CLASS}
                aria-label={t`Hide Command Terminal`}
                data-testid="command-terminal-panel-hide"
              >
                <X size={PANEL_CONTROL_ICON_PX} />
              </button>
            </Tooltip>
          </div>
          <div className="flex flex-1 min-h-0">
            {rail}
            <div ref={onTerminalAreaReady} className="relative flex-1 min-w-0" data-testid="command-terminal-area" />
          </div>
          {!geometry.maximized && RESIZE_EDGES.map(({ edge, className }) => (
            <div
              key={edge}
              className={`absolute z-30 ${className}`}
              onPointerDown={handleResizePointerDown(edge)}
              data-testid={`command-terminal-panel-resize-${edge}`}
              aria-hidden
            />
          ))}
        </div>
      )}
    </div>
  );
}

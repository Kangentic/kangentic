/**
 * The Command Terminal PANEL: one window over the board that holds the rail
 * and every running terminal. It moves by its header, resizes from its outer
 * edges, and maximizes to the whole area between the title bar and the status
 * bar; the terminals inside never float on their own (the window layer tiles
 * them into the panel's terminal area, `hostArranged`).
 *
 * Its place is GLOBAL (`AppConfig.commandTerminalPanel`), like the terminals'
 * layout: fractions of the area it sits in, so it rescales with the window. A
 * move or a resize is previewed and committed once, on release, so the
 * terminals inside refit once rather than on every pointer frame.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Maximize, Minimize, SquareArrowOutUpRight, SquareTerminal, X } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';
import { useConfigStore } from '../../stores/config-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import type { CommandTerminalPanelGeometry } from '../../../shared/types';

/** Where the panel opens before it was ever moved: centered, with a margin of board around it. */
const DEFAULT_PANEL_GEOMETRY: CommandTerminalPanelGeometry = { x: 0.03, y: 0.04, w: 0.94, h: 0.92, maximized: false };

interface PixelRect { left: number; top: number; width: number; height: number }

interface PanelSize { width: number; height: number }

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

/** The panel's pixel rect in an area of `size`, kept inside it and above the
 *  floor (which itself gives way to an area smaller than it). */
function toPixels(geometry: CommandTerminalPanelGeometry, size: PanelSize, minSize: PanelSize): PixelRect {
  if (geometry.maximized) return { left: 0, top: 0, width: size.width, height: size.height };
  const width = Math.min(size.width, Math.max(minSize.width, geometry.w * size.width));
  const height = Math.min(size.height, Math.max(minSize.height, geometry.h * size.height));
  const left = Math.min(Math.max(0, geometry.x * size.width), Math.max(0, size.width - width));
  const top = Math.min(Math.max(0, geometry.y * size.height), Math.max(0, size.height - height));
  return { left, top, width, height };
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
  return { left, top, width, height };
}

interface CommandTerminalPanelProps {
  /** Hide the whole layer (keeps every terminal running). */
  onHide: () => void;
  /** The rail, drawn down the panel's left side. */
  rail: ReactNode;
  /** The terminal area's element, once mounted: the window layer renders into it. */
  onTerminalAreaReady: (element: HTMLElement | null) => void;
  /** The smallest the panel may be, from how many terminals it holds. */
  minSize: PanelSize;
  /** Move the panel into a window of its own. */
  onOpenInNewWindow: () => void;
  /** Why Open in new window is off right now, or null when it is on. */
  openInNewWindowDisabledReason: string | null;
}

export function CommandTerminalPanel({ onHide, rail, onTerminalAreaReady, minSize, onOpenInNewWindow, openInNewWindowDisabledReason }: CommandTerminalPanelProps) {
  const areaRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [areaSize, setAreaSize] = useState({ width: 0, height: 0 });
  const savedGeometry = useConfigStore((state) => state.globalConfig.commandTerminalPanel);
  const saveGeometry = useConfigStore((state) => state.saveCommandTerminalPanel);
  const geometry = savedGeometry ?? DEFAULT_PANEL_GEOMETRY;
  const rect = toPixels(geometry, areaSize, minSize);

  // A resize is previewed as an outline and committed on release, so the
  // terminals refit once. A move translates the real panel, which costs no refit.
  const [resizePreview, setResizePreview] = useState<PixelRect | null>(null);
  // The gesture in flight, with the geometry it started from, and the call that
  // stops listening for it.
  const gestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    edge: ResizeEdge | null;
    startRect: PixelRect;
    area: PanelSize;
    floor: PanelSize;
    stopListening: () => void;
  } | null>(null);

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

  const toggleMaximized = useCallback(() => {
    saveGeometry({ ...geometry, maximized: !geometry.maximized });
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
    gesture.stopListening();
    if (panelRef.current) panelRef.current.style.transform = '';
    setResizePreview(null);
    const deltaX = clientX - gesture.startX;
    const deltaY = clientY - gesture.startY;
    if (!commit || (deltaX === 0 && deltaY === 0)) return;
    if (gesture.edge === null) {
      const offset = movedBy(gesture, deltaX, deltaY);
      saveGeometry(toGeometry({ ...gesture.startRect, left: gesture.startRect.left + offset.x, top: gesture.startRect.top + offset.y }, gesture.area));
    } else {
      saveGeometry(toGeometry(resizeRect(gesture.startRect, gesture.edge, deltaX, deltaY, gesture.area, gesture.floor), gesture.area));
    }
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
      const deltaX = moveEvent.clientX - gesture.startX;
      const deltaY = moveEvent.clientY - gesture.startY;
      if (gesture.edge === null) {
        const offset = movedBy(gesture, deltaX, deltaY);
        if (panelRef.current) panelRef.current.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
      } else {
        setResizePreview(resizeRect(gesture.startRect, gesture.edge, deltaX, deltaY, gesture.area, gesture.floor));
      }
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
      stopListening: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('blur', onBlur);
      },
    };
    if (edge !== null) setResizePreview(rect);
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
  // An unmount mid-gesture stops listening for it.
  useEffect(() => {
    const cancelOnEscape = (event: KeyboardEvent) => {
      const gesture = gestureRef.current;
      if (event.key !== 'Escape' || !gesture) return;
      event.stopImmediatePropagation();
      gestureRef.current = null;
      gesture.stopListening();
      if (panelRef.current) panelRef.current.style.transform = '';
      setResizePreview(null);
    };
    document.addEventListener('keydown', cancelOnEscape, true);
    return () => {
      document.removeEventListener('keydown', cancelOnEscape, true);
      gestureRef.current?.stopListening();
      gestureRef.current = null;
    };
  }, []);

  return (
    <div ref={areaRef} className="absolute inset-0 pointer-events-none" data-testid="command-terminal-panel-area">
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
            className={`flex items-center gap-2.5 h-10 pl-3.5 pr-2 border-b border-edge flex-shrink-0 select-none ${
              geometry.maximized ? '' : 'cursor-grab active:cursor-grabbing'
            }`}
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
            <span className="flex-1 min-w-0 truncate text-[13px] font-semibold text-fg">Command Terminal</span>
            <Tooltip
              label={tipLabel({
                disabled: openInNewWindowDisabledReason !== null,
                disabledReason: openInNewWindowDisabledReason,
                tip: 'Move the panel to its own window. The terminals keep running.',
              })}
            >
              <button
                type="button"
                onClick={onOpenInNewWindow}
                disabled={openInNewWindowDisabledReason !== null}
                className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                aria-label="Open in new window"
                data-testid="command-terminal-panel-pop-out"
              >
                <SquareArrowOutUpRight size={15} />
              </button>
            </Tooltip>
            <Tooltip label={geometry.maximized ? 'Restore panel' : 'Maximize panel'} keys="panel.maximize">
              <button
                type="button"
                onClick={toggleMaximized}
                className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors"
                aria-label={geometry.maximized ? 'Restore panel' : 'Maximize panel'}
                data-testid="command-terminal-panel-maximize"
              >
                {geometry.maximized ? <Minimize size={15} /> : <Maximize size={15} />}
              </button>
            </Tooltip>
            <Tooltip label="Hide. The terminals keep running." keys="panel.close">
              <button
                type="button"
                onClick={onHide}
                className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors"
                aria-label="Hide Command Terminal"
                data-testid="command-terminal-panel-hide"
              >
                <X size={15} />
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
      {resizePreview && (
        <div
          className="absolute rounded-lg border-2 border-dashed border-accent/70 pointer-events-none"
          style={{ left: resizePreview.left, top: resizePreview.top, width: resizePreview.width, height: resizePreview.height }}
          data-testid="command-terminal-panel-resize-preview"
          aria-hidden
        />
      )}
    </div>
  );
}

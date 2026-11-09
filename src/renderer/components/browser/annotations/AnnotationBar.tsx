import { forwardRef, useRef, useState } from 'react';
import { GripVertical, Pencil, SquareMousePointer, Undo2 } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { Tooltip } from '../../Tooltip';
import { tipLabel } from '../../../utils/tooltip';

// The small bar floating over the page: Select element, Draw and Undo, with a
// grip that moves it to another corner. The corner is kept per project, as a
// per-viewer convenience in localStorage. It fades while a stroke is drawn
// under it, so the ink stays visible.

export type AnnotationBarCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

const CORNERS: readonly AnnotationBarCorner[] = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
const STORAGE_PREFIX = 'kng-annotation-bar-corner:';

export function readBarCorner(projectId: string | null): AnnotationBarCorner {
  try {
    const stored = window.localStorage.getItem(`${STORAGE_PREFIX}${projectId ?? 'none'}`);
    if (stored && (CORNERS as readonly string[]).includes(stored)) return stored as AnnotationBarCorner;
  } catch {
    // Storage can be unavailable; the default corner is fine.
  }
  return 'top-right';
}

export function writeBarCorner(projectId: string | null, corner: AnnotationBarCorner): void {
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${projectId ?? 'none'}`, corner);
  } catch {
    // Not kept: the bar still moves for this session.
  }
}

/** The corner nearest a point inside a box. */
export function nearestCorner(x: number, y: number, width: number, height: number): AnnotationBarCorner {
  const top = y < height / 2;
  const left = x < width / 2;
  if (top) return left ? 'top-left' : 'top-right';
  return left ? 'bottom-left' : 'bottom-right';
}

const CORNER_CLASS: Record<AnnotationBarCorner, string> = {
  'top-right': 'top-2 right-2',
  'top-left': 'top-2 left-2',
  'bottom-right': 'bottom-2 right-2',
  'bottom-left': 'bottom-2 left-2',
};

interface AnnotationBarProps {
  corner: AnnotationBarCorner;
  onCornerChange: (corner: AnnotationBarCorner) => void;
  selectActive: boolean;
  drawActive: boolean;
  canUndo: boolean;
  /** A stroke is being drawn: the bar fades so it never hides the ink. */
  faded: boolean;
  onToggleSelect: () => void;
  onToggleDraw: () => void;
  onUndo: () => void;
}

export const AnnotationBar = forwardRef<HTMLDivElement, AnnotationBarProps>(function AnnotationBar(
  { corner, onCornerChange, selectActive, drawActive, canUndo, faded, onToggleSelect, onToggleDraw, onUndo },
  ref,
) {
  const { t } = useLingui();
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const startRef = useRef<{ pointerX: number; pointerY: number } | null>(null);

  const onGripDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { pointerX: event.clientX, pointerY: event.clientY };
    setDrag({ x: 0, y: 0 });
  };
  const onGripMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = startRef.current;
    if (!start) return;
    setDrag({ x: event.clientX - start.pointerX, y: event.clientY - start.pointerY });
  };
  const onGripUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = startRef.current;
    startRef.current = null;
    setDrag(null);
    if (!start) return;
    const container = event.currentTarget.closest('[data-annotation-bar-bounds]');
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    const next = nearestCorner(event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
    if (next !== corner) onCornerChange(next);
  };

  const buttonClass = (active: boolean) => `flex items-center justify-center w-7 h-7 rounded transition-colors ${
    active ? 'bg-accent/20 text-accent-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover'
  }`;

  return (
    <div
      ref={ref}
      className={`absolute ${CORNER_CLASS[corner]} z-10 flex items-center gap-0.5 p-[3px] rounded-lg border border-edge bg-surface shadow-lg transition-opacity duration-150 ${
        faded ? 'opacity-30' : 'opacity-100'
      }`}
      style={drag ? { transform: `translate(${drag.x}px, ${drag.y}px)` } : undefined}
      // A press on the bar leaves focus in the note being written.
      onMouseDown={(event) => event.preventDefault()}
      data-testid="annotation-bar"
      data-corner={corner}
    >
      <button
        type="button"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
        className="flex items-center justify-center w-4 h-7 text-fg-faint hover:text-fg-muted cursor-grab touch-none"
        aria-label={t`Move the annotation bar`}
        data-no-dismiss
        data-testid="annotation-bar-grip"
      >
        <GripVertical size={13} />
      </button>
      <Tooltip label={t`Select element`} keys="browser.inspect">
        <button
          type="button"
          onClick={onToggleSelect}
          className={buttonClass(selectActive)}
          aria-label={t`Select element`}
          aria-pressed={selectActive}
          data-testid="browser-inspect-toggle"
        >
          <SquareMousePointer size={15} />
        </button>
      </Tooltip>
      <Tooltip label={t`Draw on the page`} keys="browser.draw">
        <button
          type="button"
          onClick={onToggleDraw}
          className={buttonClass(drawActive)}
          aria-label={t`Draw`}
          aria-pressed={drawActive}
          data-testid="browser-draw-toggle"
        >
          <Pencil size={15} />
        </button>
      </Tooltip>
      <Tooltip
        label={tipLabel({ disabled: !canUndo, disabledReason: t`Nothing marked yet`, tip: t`Undo the last mark` })}
        keys={canUndo ? 'browser.undoMark' : undefined}
      >
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className={`${buttonClass(false)} disabled:opacity-40 disabled:hover:bg-transparent`}
          aria-label={t`Undo`}
          data-testid="annotation-undo"
        >
          <Undo2 size={15} />
        </button>
      </Tooltip>
    </div>
  );
});

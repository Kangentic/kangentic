import { useCallback, useEffect, useRef, useState } from 'react';

// The canvas a stroke is drawn on before it joins an annotation. Strokes are
// in CSS px relative to the canvas's bounding rect. The canvas shows a stroke
// only until the page layer draws it, and the capture compositor blits any
// still showing when Send captures the page.

export interface DrawPoint {
  x: number;
  y: number;
}

export type Stroke = DrawPoint[];

/** `PointerEvent.button` and its `buttons` flag for the left button. */
const LEFT_BUTTON = 0;
const LEFT_BUTTON_FLAG = 1;

/**
 * What a `pointermove` does to a stroke when other buttons are in play. A chorded
 * press has `button` 0 with its flag set. A release of the left button under
 * another one leaves the flag off, and with nothing left to fire `pointerup`, that
 * move is the stroke's only end.
 */
export function chordedStrokeChange(
  drawing: boolean,
  event: { button: number; buttons: number },
): 'start' | 'end' | null {
  const leftHeld = (event.buttons & LEFT_BUTTON_FLAG) !== 0;
  if (!drawing && event.button === LEFT_BUTTON && leftHeld) return 'start';
  if (drawing && event.button === LEFT_BUTTON && !leftHeld) return 'end';
  return null;
}

interface UseDrawingOverlayOptions {
  enabled: boolean;
  color?: string;
  lineWidth?: number;
  /** Runs as a stroke starts, whichever way it started. */
  onStrokeStart?: () => void;
  /**
   * Takes a finished stroke. The canvas keeps drawing it until the returned
   * promise settles, then drops it: by then the page draws it, so the ink
   * never blinks out between the two.
   */
  onStrokeEnd?: (stroke: Stroke) => Promise<void> | void;
}

/** A press on the canvas keeps focus where it is. The canvas takes no focus, so
 *  the default would drop it to `<body>` and off the note beside the drawing. */
function keepFocusOnCanvasPress(event: React.MouseEvent<HTMLCanvasElement>): void {
  event.preventDefault();
}

export function useDrawingOverlay({
  enabled,
  color = '#ff3b3b',
  lineWidth = 3,
  onStrokeStart,
  onStrokeEnd,
}: UseDrawingOverlayOptions) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const drawingRef = useRef(false);
  const currentStrokeRef = useRef<Stroke>([]);

  const sizeCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    canvas.width = Math.floor(rect.width);
    canvas.height = Math.floor(rect.height);
  }, []);

  useEffect(() => {
    sizeCanvas();
    const observer = new ResizeObserver(() => sizeCanvas());
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, [sizeCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of strokes) {
      if (stroke.length === 0) continue;
      ctx.beginPath();
      stroke.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    }
  }, [strokes, color, lineWidth]);

  const pointFromEvent = useCallback((event: React.PointerEvent<HTMLCanvasElement>): DrawPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    drawingRef.current = true;
    const started: Stroke = [point];
    currentStrokeRef.current = started;
    canvasRef.current?.setPointerCapture(event.pointerId);
    setStrokes((previous) => [...previous, started]);
    onStrokeStart?.();
  }, [enabled, onStrokeStart, pointFromEvent]);

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const finished = currentStrokeRef.current;
    if (onStrokeEnd && finished.length > 0) {
      void Promise.resolve(onStrokeEnd(finished))
        .catch(() => undefined)
        .finally(() => setStrokes((previous) => previous.filter((stroke) => stroke !== finished)));
    }
    try {
      canvasRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // No-op if capture was already released by the browser (fast drags
      // can fire pointerLeave + pointerUp in close succession; the second
      // release throws InvalidPointerId on some browser builds).
    }
    currentStrokeRef.current = [];
  }, [onStrokeEnd]);

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!enabled) return;
    // The left button going down or up with another one held, push-to-talk above
    // all, reports as a move and fires neither `pointerdown` nor `pointerup`.
    const change = chordedStrokeChange(drawingRef.current, event);
    if (change === 'start') {
      onPointerDown(event);
      return;
    }
    if (change === 'end') {
      onPointerUp(event);
      return;
    }
    if (!drawingRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    // Capture the new array at schedule time. Without this, fast drags
    // race onPointerUp/onPointerLeave: if up fires between the setStrokes
    // schedule and flush, the updater reads currentStrokeRef.current
    // AFTER it was reset to [] and commits an empty stroke, blanking the
    // visible drawing.
    const nextStroke = [...currentStrokeRef.current, point];
    currentStrokeRef.current = nextStroke;
    setStrokes((previous) => {
      const next = previous.slice();
      next[next.length - 1] = nextStroke;
      return next;
    });
  }, [enabled, onPointerDown, onPointerUp, pointFromEvent]);

  // Reset transient draw state whenever enabled toggles. Catches the case
  // where the user toggles draw off and on again to "kick" stuck state.
  useEffect(() => {
    drawingRef.current = false;
    currentStrokeRef.current = [];
  }, [enabled]);

  return {
    canvasRef,
    strokes,
    handlers: {
      onMouseDown: keepFocusOnCanvasPress,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onPointerLeave: onPointerUp,
    },
  };
}

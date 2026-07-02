import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Terminal } from '@xterm/xterm';
import {
  findBlockAtPoint,
  extractBlockContentAt,
  pixelToBufferRow,
  getScreenRect,
  getBlockPixelBounds,
  readCellDimensions,
  createBufferLineSource,
} from '../../utils/terminal-block-buffer';
import { findBlockAt, type BlockRange } from '../../utils/terminal-blocks';
import { useConfigStore } from '../../stores/config-store';

interface TerminalBlockCopyButtonProps {
  /** The relative wrapper that hosts the xterm div (the overlay positions within it). */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Reads the live xterm Terminal (or null when not yet initialized). */
  getTerminal: () => Terminal | null;
}

/** A block rectangle in container-relative pixels, plus the terminal row height. */
interface BlockRect {
  top: number;
  left: number;
  width: number;
  height: number;
  rowHeight: number;
}

/**
 * Hover affordance for copying a quote / code block. On hover it draws a
 * highlight rectangle over the exact region that will be copied, and anchors a
 * GitHub-style copy button to that rectangle's top-right corner. This is the
 * progressive enhancement the feature request asked for; the right-click "Copy
 * Block" menu item is the primary, accessible affordance (see ui-conventions.md).
 *
 * The overlay root is pointer-events: none so it never steals xterm's text
 * selection; only the button is interactive. Block state is always re-derived
 * from the live buffer (never cached across a remount), matching the
 * one-xterm-per-session ownership rule.
 */
export function TerminalBlockCopyButton({ containerRef, getTerminal }: TerminalBlockCopyButtonProps) {
  const [rect, setRect] = useState<BlockRect | null>(null);
  const [copied, setCopied] = useState(false);
  const rangeRef = useRef<BlockRange | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Viewport-space bounds of the currently shown highlight. While the pointer is
  // anywhere inside these, the highlight is held steady (no recompute), so moving
  // across an interior blank line or the block's edge never makes it flicker.
  const shownBoundsRef = useRef<{ top: number; left: number; right: number; bottom: number } | null>(null);
  const enabled = useConfigStore((state) => state.config.terminalBlockCopy);

  const visible = rect !== null;

  const hide = useCallback(() => {
    rangeRef.current = null;
    shownBoundsRef.current = null;
    setRect(null);
  }, []);

  // Tear down any shown highlight the moment the affordance is disabled.
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

  // Container-relative rectangle for a block plus its viewport-space bounds, or
  // null when the block is not on screen.
  const rectForRange = useCallback((terminal: Terminal, range: BlockRange) => {
    const container = containerRef.current;
    const screenRect = getScreenRect(terminal);
    const bounds = getBlockPixelBounds(terminal, range);
    const dimensions = readCellDimensions(terminal);
    if (!container || !screenRect || !bounds || !dimensions) return null;
    const containerRect = container.getBoundingClientRect();
    const top = screenRect.top - containerRect.top + bounds.top;
    const left = screenRect.left - containerRect.left + bounds.left;
    const rect: BlockRect = { top, left, width: bounds.width, height: bounds.height, rowHeight: dimensions.height };
    const clientTop = containerRect.top + top;
    const clientLeft = containerRect.left + left;
    return {
      rect,
      bounds: { top: clientTop, left: clientLeft, right: clientLeft + bounds.width, bottom: clientTop + bounds.height },
    };
  }, [containerRef]);

  const show = useCallback((terminal: Terminal, range: BlockRange) => {
    const computed = rectForRange(terminal, range);
    if (!computed) { hide(); return; }
    rangeRef.current = range;
    shownBoundsRef.current = computed.bounds;
    setRect(computed.rect);
  }, [rectForRange, hide]);

  // Show / move the highlight as the pointer moves over a block (rAF-throttled).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;

    const handleMove = (event: MouseEvent) => {
      if (moveRafRef.current != null) return;
      const { clientX, clientY } = event;
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = null;
        // Sticky: if the pointer is still inside the shown highlight, keep it.
        const current = shownBoundsRef.current;
        if (current && clientX >= current.left && clientX <= current.right
          && clientY >= current.top && clientY <= current.bottom) return;
        const terminal = getTerminal();
        if (!terminal) { hide(); return; }
        const range = findBlockAtPoint(terminal, clientX, clientY);
        if (!range) { hide(); return; }
        show(terminal, range);
      });
    };

    container.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', hide);
    return () => {
      container.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', hide);
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
    };
  }, [containerRef, getTerminal, hide, show, enabled]);

  // While visible, follow scroll / output writes / resize so the highlight stays
  // anchored (or hides when the block scrolls off or changes). Subscribed only
  // while visible so a busy agent's repaints don't churn.
  useEffect(() => {
    if (!visible) return;
    const terminal = getTerminal();
    if (!terminal) return;

    let refreshRaf: number | null = null;
    const refresh = () => {
      if (refreshRaf != null) return;
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = null;
        const range = rangeRef.current;
        if (!range) { hide(); return; }
        const current = findBlockAt(createBufferLineSource(terminal), range.startY);
        if (!current || current.kind !== range.kind) { hide(); return; }
        show(terminal, current);
      });
    };

    const scrollDisposable = terminal.onScroll(refresh);
    const writeDisposable = terminal.onWriteParsed(refresh);
    const resizeDisposable = terminal.onResize(hide);
    return () => {
      scrollDisposable.dispose();
      writeDisposable.dispose();
      resizeDisposable.dispose();
      if (refreshRaf != null) cancelAnimationFrame(refreshRaf);
    };
  }, [visible, getTerminal, hide, show]);

  const copyBlockAt = useCallback((clientX: number, clientY: number) => {
    const terminal = getTerminal();
    if (!terminal) return;
    const row = pixelToBufferRow(terminal, clientX, clientY);
    if (row == null) return;
    const hit = extractBlockContentAt(terminal, row);
    if (!hit?.content) return;
    navigator.clipboard.writeText(hit.content).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard access denied */ });
  }, [getTerminal]);

  // Clicking anywhere on a block copies it. Runs in the CAPTURE phase and never
  // preventDefault/stopPropagation, so the same click still reaches xterm (which
  // has mouse tracking on for Claude Code) - the copy is a passive side effect.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    const handleClick = (event: MouseEvent) => {
      if (buttonRef.current?.contains(event.target as Node)) return; // button has its own handler
      copyBlockAt(event.clientX, event.clientY);
    };
    container.addEventListener('click', handleClick, true);
    return () => container.removeEventListener('click', handleClick, true);
  }, [containerRef, copyBlockAt, enabled]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  // A legible copy icon in a square chip one row tall, placed flush to the
  // highlight's outer top-right corner and sharing its border radius so the two
  // corners coincide seamlessly (the chip covers the border corner, no sliver).
  const iconSize = 14;
  const buttonSize = rect ? Math.max(rect.rowHeight, iconSize) : 0;

  if (!enabled) return null;

  return (
    <div className="absolute inset-0 z-10 pointer-events-none" data-testid="terminal-block-copy-overlay">
      {rect && (
        <>
          {/* Border-forward highlight: an accent outline reads identically over a
              shaded user box and a plain black assistant line (a translucent fill
              would look grey-on-grey on the box). */}
          <div
            className="absolute rounded-sm border border-accent bg-accent/5"
            style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
            data-testid="terminal-block-copy-highlight"
          />
          <button
            ref={buttonRef}
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => copyBlockAt(e.clientX, e.clientY)}
            className="pointer-events-auto absolute flex items-center justify-center rounded-sm bg-accent-emphasis text-accent-on shadow-sm hover:bg-accent transition-colors"
            style={{
              top: rect.top,
              left: rect.left + rect.width - buttonSize,
              width: buttonSize,
              height: buttonSize,
            }}
            title="Copy block"
            data-testid="terminal-block-copy-button"
          >
            {/* translate-x nudges the Copy glyph, whose mass leans left, to optically center it. */}
            {copied ? <Check size={iconSize} /> : <Copy size={iconSize} className="translate-x-[1px]" />}
          </button>
        </>
      )}
    </div>
  );
}

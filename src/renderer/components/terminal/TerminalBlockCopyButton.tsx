import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { Terminal, IDisposable } from '@xterm/xterm';
import {
  findBlockAtPoint,
  getScreenRect,
  getBlockPixelBounds,
  readCellDimensions,
  createBufferLineSource,
} from '../../utils/terminal-block-buffer';
import { findBlockAt, extractBlockContent, type BlockRange } from '../../utils/terminal-blocks';
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
 * Milliseconds of quiet (no parsed writes) required before a hover highlight is
 * shown, and the settle window a "hot" candidate waits to confirm. While output
 * is streaming, the buffer mutates faster than a highlight can meaningfully track
 * it, so the affordance holds off rather than crawling across a live region.
 */
const WRITE_QUIET_MS = 250;

/**
 * Two block ranges frame the same region. `barColumn` is compared too: a quote block
 * re-indented in place (same rows, shifted bar column) counts as changed, so a stale
 * `barColumn` never survives in the shown range and mis-slices the copied content.
 */
function sameRange(first: BlockRange, second: BlockRange): boolean {
  return first.kind === second.kind
    && first.startY === second.startY
    && first.endY === second.endY
    && first.barColumn === second.barColumn;
}

/**
 * Hover affordance for copying a quote / code / message block. On hover it draws
 * a highlight rectangle over the exact region that will be copied and anchors a
 * GitHub-style copy button to that rectangle's top-right corner. Copying is done
 * ONLY via that button (a plain click on the block passes through untouched, so
 * clicking an interactive prompt to answer it never touches the clipboard); the
 * right-click "Copy Block" menu item is the primary, accessible affordance (see
 * ui-conventions.md).
 *
 * The overlay root is pointer-events: none so it never steals xterm's text
 * selection; only the button is interactive. Detection settles before showing and
 * hides on churn: while the buffer is actively mutating around a block, the
 * affordance holds off (or hides) rather than tracking every write, so a live
 * region never crawls, reflows, or frames empty space.
 */
export function TerminalBlockCopyButton({ containerRef, getTerminal }: TerminalBlockCopyButtonProps) {
  const [rect, setRect] = useState<BlockRect | null>(null);
  const [copied, setCopied] = useState(false);
  const rangeRef = useRef<BlockRange | null>(null);
  const moveRafRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Viewport-space bounds of the currently shown highlight. While the pointer is
  // anywhere inside these, the highlight is held steady (no recompute), so moving
  // across an interior blank line or the block's edge never makes it flicker.
  const shownBoundsRef = useRef<{ top: number; left: number; right: number; bottom: number } | null>(null);

  // Settle-gate state (all component refs, so no module-scope HMR obligations).
  // `lastWriteAtRef` timestamps the most recent parsed write; `pendingRef` holds a
  // candidate awaiting confirmation across a live buffer; `liveDisposablesRef`
  // owns the write / scroll / resize subscriptions, attached lazily once xterm
  // exists and re-pointed if the terminal instance is ever swapped.
  const lastWriteAtRef = useRef(0);
  const pendingRef = useRef<{ range: BlockRange; clientX: number; clientY: number } | null>(null);
  const pendingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveDisposablesRef = useRef<IDisposable[] | null>(null);
  const liveTerminalRef = useRef<Terminal | null>(null);

  const enabled = useConfigStore((state) => state.config.terminalBlockCopy);

  const clearPending = useCallback(() => {
    pendingRef.current = null;
    if (pendingTimerRef.current) {
      clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
  }, []);

  const clearShown = useCallback(() => {
    rangeRef.current = null;
    shownBoundsRef.current = null;
    setRect(null);
  }, []);

  const hide = useCallback(() => {
    clearShown();
    clearPending();
  }, [clearShown, clearPending]);

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
    const nextRect: BlockRect = { top, left, width: bounds.width, height: bounds.height, rowHeight: dimensions.height };
    const clientTop = containerRect.top + top;
    const clientLeft = containerRect.left + left;
    return {
      rect: nextRect,
      bounds: { top: clientTop, left: clientLeft, right: clientLeft + bounds.width, bottom: clientTop + bounds.height },
    };
  }, [containerRef]);

  const show = useCallback((terminal: Terminal, range: BlockRange) => {
    const computed = rectForRange(terminal, range);
    if (!computed) { hide(); return; }
    clearPending();
    rangeRef.current = range;
    shownBoundsRef.current = computed.bounds;
    setRect(computed.rect);
  }, [rectForRange, hide, clearPending]);

  // Confirm a held candidate: re-derive the block at the stored pointer position
  // (catches both content change and output-driven scroll under a stationary
  // pointer). Identical to the candidate -> show; changed -> drop, so a growing
  // block never flashes.
  const confirmPending = useCallback((terminal: Terminal) => {
    const pending = pendingRef.current;
    if (!pending) return;
    const range = findBlockAtPoint(terminal, pending.clientX, pending.clientY);
    clearPending();
    if (range && sameRange(range, pending.range)) show(terminal, range);
  }, [clearPending, show]);

  // Hold a candidate while output is hot, confirming on the next parsed write OR
  // after WRITE_QUIET_MS of quiet (the timeout is load-bearing: without it a
  // candidate would never confirm if writes stop right after the pointer move).
  const setPending = useCallback((terminal: Terminal, candidate: { range: BlockRange; clientX: number; clientY: number }) => {
    clearPending();
    clearShown(); // drop any stale highlight while we wait to confirm the new candidate
    pendingRef.current = candidate;
    pendingTimerRef.current = setTimeout(() => {
      pendingTimerRef.current = null;
      const terminalNow = getTerminal();
      if (terminalNow) confirmPending(terminalNow);
      else clearPending();
    }, WRITE_QUIET_MS);
  }, [clearPending, clearShown, getTerminal, confirmPending]);

  // While a highlight is shown, a parsed write re-derives the block at its anchor
  // row; ANY difference (it grew, shrank, or re-classified) hides it and keeps it
  // hidden until the next pointer move. An identical block is left exactly where
  // it is (its viewport position only moves on scroll), so a stable scrollback
  // block stays put mid-stream instead of re-rendering every frame.
  const refreshVisible = useCallback((terminal: Terminal) => {
    const range = rangeRef.current;
    if (!range) return;
    const current = findBlockAt(createBufferLineSource(terminal), range.startY);
    if (!current || !sameRange(current, range)) hide();
  }, [hide]);

  const disposeLive = useCallback(() => {
    if (liveDisposablesRef.current) {
      for (const disposable of liveDisposablesRef.current) disposable.dispose();
      liveDisposablesRef.current = null;
    }
    liveTerminalRef.current = null;
  }, []);

  // Attach the write / scroll / resize subscriptions once (and re-point them if
  // the terminal instance is ever swapped under a mounted component). onWriteParsed
  // fires at most once per frame, so it needs no extra throttle. Stamp "now" at
  // attach so the very first hover during active streaming is treated as hot and
  // waits to settle rather than flashing over a growing block.
  const ensureLive = useCallback((terminal: Terminal) => {
    if (liveTerminalRef.current === terminal && liveDisposablesRef.current) return;
    disposeLive();
    liveTerminalRef.current = terminal;
    lastWriteAtRef.current = Date.now();

    const onWrite = () => {
      lastWriteAtRef.current = Date.now();
      if (pendingRef.current) { confirmPending(terminal); return; }
      if (rangeRef.current) refreshVisible(terminal);
    };
    // Output-driven scroll (writes still hot) hides; a settled user scroll of
    // static scrollback re-anchors the shown block to its new viewport position.
    const onScroll = () => {
      if (!rangeRef.current) return;
      if (Date.now() - lastWriteAtRef.current < WRITE_QUIET_MS) { hide(); return; }
      show(terminal, rangeRef.current);
    };
    liveDisposablesRef.current = [
      terminal.onWriteParsed(onWrite),
      terminal.onScroll(onScroll),
      terminal.onResize(hide),
    ];
  }, [disposeLive, confirmPending, refreshVisible, hide, show]);

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
        ensureLive(terminal);
        const range = findBlockAtPoint(terminal, clientX, clientY);
        if (!range) { hide(); return; }
        // Show immediately when the buffer is settled (the common case, zero added
        // latency); otherwise hold the candidate until output quiets.
        if (Date.now() - lastWriteAtRef.current >= WRITE_QUIET_MS) { show(terminal, range); return; }
        setPending(terminal, { range, clientX, clientY });
      });
    };

    container.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', hide);
    return () => {
      container.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', hide);
      if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
    };
  }, [containerRef, getTerminal, hide, show, setPending, ensureLive, enabled]);

  // Tear down the shown highlight and the live subscriptions the moment the
  // affordance is disabled.
  useEffect(() => {
    if (!enabled) {
      hide();
      disposeLive();
    }
  }, [enabled, hide, disposeLive]);

  // Copy the currently highlighted block. Bound to the copy button only - there is
  // no click-anywhere-to-copy, so answering an interactive prompt never overwrites
  // the clipboard.
  const copyShownBlock = useCallback(() => {
    const terminal = getTerminal();
    const range = rangeRef.current;
    if (!terminal || !range) return;
    const content = extractBlockContent(createBufferLineSource(terminal), range);
    if (!content) return;
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard access denied */ });
  }, [getTerminal]);

  useEffect(() => () => {
    disposeLive();
    clearPending();
    if (moveRafRef.current != null) cancelAnimationFrame(moveRafRef.current);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [disposeLive, clearPending]);

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
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={copyShownBlock}
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

import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '../addons/fit-addon';
import { attachWebglRenderer } from '../utils/terminal-webgl';
import { copySelectionToClipboard, enableTerminalClipboard, stripOsc52Sequences } from '../utils/terminal-clipboard';
import { createWriteBatcher, type WriteBatcher } from '../utils/write-batcher';
import { createIncomingWriteQueue, writeChunkedToTerminal } from '../utils/incoming-write-queue';
import { isBoardDragActive, onBoardDragEnd } from '../lib/session-update-coalescer';
import { noteTerminalFocus } from '../utils/dictation-target';
import '@xterm/xterm/css/xterm.css';

/** Delay before forwarding a resize to the PTY. Coalesces rapid resizes
 *  (panel drag, window resize) into a single PTY resize so the TUI
 *  (Claude Code) only redraws once and scrollback isn't churned. */
const PTY_RESIZE_DEBOUNCE_MS = 200;

/** Scroll positions saved before xterm dispose, keyed by session ID.
 *  Preserved across HMR via import.meta.hot.data so terminals restore
 *  the user's viewport position instead of jumping to the bottom. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const savedScrollPositions: Map<string, number> = import.meta.hot?.data?.savedScrollPositions ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.savedScrollPositions = savedScrollPositions;
  });
}

// hmr-safe: a monotonic counter only used to mint a unique renderer-report key
// for a session-less (transient) terminal; resetting it on HMR at worst reuses
// a key for a terminal that has since disposed its report entry.
let transientRendererKeyCounter = 0;
function nextTransientRendererKey(): number {
  transientRendererKeyCounter += 1;
  return transientRendererKeyCounter;
}

/** Fixed dark terminal theme -- Claude Code's TUI is designed for dark backgrounds. */
const TERMINAL_THEME = {
  background: '#18181b',
  foreground: '#e4e4e7',
  // Light cursor. It was the background color (#18181b) - i.e. invisible - which is
  // why no cursor ever showed. cursorAccent is the dark background so the character
  // under a block cursor stays readable (dark glyph on the light block).
  cursor: '#e4e4e7',
  cursorAccent: '#18181b',
  selectionBackground: 'rgba(58, 130, 246, 0.35)',
  black: '#18181b',
  red: '#ef4444',
  green: '#22c55e',
  yellow: '#eab308',
  blue: '#3b82f6',
  magenta: '#a855f7',
  cyan: '#06b6d4',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#f87171',
  brightGreen: '#4ade80',
  brightYellow: '#facc15',
  brightBlue: '#60a5fa',
  brightMagenta: '#c084fc',
  brightCyan: '#22d3ee',
  brightWhite: '#fafafa',
} as const;

interface UseTerminalOptions {
  sessionId: string | null;
  fontFamily?: string;
  fontSize?: number;
  scrollbackLines?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  shellName?: string;
  /** Let Escape bubble (to close the containing dialog) when the mouse pointer
   *  is outside the terminal. Used by the task detail dialog. */
  releaseEscapeWhenPointerOutside?: boolean;
}

/** Restore a saved scroll position (from HMR) or pin to the bottom.
 *  Consumes and deletes the saved entry so it's only applied once.
 *  Returns true if the terminal ended up at the bottom. */
function restoreScrollPosition(terminal: Terminal, sessionId: string | null): boolean {
  const savedViewportY = sessionId
    ? savedScrollPositions.get(sessionId)
    : undefined;
  if (savedViewportY !== undefined) {
    terminal.scrollToLine(savedViewportY);
    savedScrollPositions.delete(sessionId!);
    return false;
  }
  terminal.scrollToBottom();
  return true;
}

export function useTerminal(options: UseTerminalOptions) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollbackPendingRef = useRef(false);
  /** Monotonic counter to abandon stale scrollback operations when a newer
   *  one starts (e.g. initTerminal and reloadScrollback racing). */
  const scrollbackGenerationRef = useRef(0);
  const isAtBottomRef = useRef(true);
  /** When true, onData writes are suppressed. Controlled by the caller
   *  (e.g. TerminalTab) to gate PTY output while a loading overlay is shown. */
  const suppressDataRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coalesces xterm onData bursts (paste, key-repeat, clipboard callback)
   *  into one IPC write per microtask. */
  const writeBatcherRef = useRef<WriteBatcher | null>(null);
  /** Tears down the WebGL renderer attachment (cancels retries, disposes addon). */
  const disposeWebglRef = useRef<(() => void) | null>(null);

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const xtermTheme = TERMINAL_THEME;

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Menlo, Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: xtermTheme,
      scrollback: options.scrollbackLines || 5000,
      cursorBlink: true,
      cursorStyle: options.cursorStyle || 'block',
      // HIDE the cursor when this terminal is BLURRED. Only the focused pane (where
      // you are typing) shows a cursor - a solid blinking block - so the cursor is a
      // clean "you are here" cue. The window's accent outline + pulsing line carry
      // the "which window is selected" cue for the unfocused panes.
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

    // Record this terminal as the last-focused one for dictation injection
    // target resolution. The textarea is xterm's focusable element, so this
    // fires on both a user click and a programmatic focus(); it is torn down
    // automatically when the terminal is disposed on unmount.
    if (options.sessionId) {
      const focusedSessionId = options.sessionId;
      terminal.textarea?.addEventListener('focus', () => noteTerminalFocus(focusedSessionId));
    }

    // Batch outgoing input into one IPC write per microtask. A paste or
    // programmatic terminal.paste() often dispatches onData multiple times
    // synchronously; concatenating those into a single ipcRenderer.invoke
    // avoids N round-trips across the process boundary. PTY byte order is
    // preserved for sequential pty.write calls, so concatenation is safe.
    const batcher = createWriteBatcher((payload) => {
      if (options.sessionId) {
        window.electronAPI.sessions.write(options.sessionId, payload);
      }
    });
    writeBatcherRef.current = batcher;

    // Enable Ctrl+C copy (when text selected), Ctrl+V paste, and Ctrl+Enter newline
    enableTerminalClipboard(terminal, terminalRef.current, batcher.schedule, options.shellName, options.sessionId ?? undefined, options.releaseEscapeWhenPointerOutside);

    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      isAtBottomRef.current = buffer.viewportY >= buffer.baseY;
    });

    // Attach the WebGL renderer with context-loss recovery (retry + backoff,
    // logged, renderer type tracked). Keyed by session id, or a stable transient
    // key for a session-less pane so the devtools report can distinguish them.
    const rendererKey = options.sessionId ?? `transient-${nextTransientRendererKey()}`;
    disposeWebglRef.current = attachWebglRenderer(terminal, rendererKey);

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Send user input to PTY (via the microtask-batched queue above).
    if (options.sessionId) {
      terminal.onData(batcher.schedule);

      // Debounced PTY resize -- coalesces rapid dimension changes so the
      // TUI only redraws once after resizing settles.
      const sid = options.sessionId;
      terminal.onResize(({ cols, rows }) => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null;
          window.electronAPI.sessions.resize(sid, cols, rows);
        }, PTY_RESIZE_DEBOUNCE_MS);
      });

      // Resize-first scrollback replay: fit the terminal to the container
      // FIRST, then fetch scrollback. The width change (if any) and the sample
      // are ordered on the main process, not here - see the parallel-IPC note
      // below.
      scrollbackPendingRef.current = true;
      const scrollbackGeneration = ++scrollbackGenerationRef.current;
      const suppressScrollback = suppressDataRef.current;

      // Fit immediately to calculate actual container cols/rows
      fitAddon.fit();
      const { cols, rows } = terminal;

      // Parallel IPCs: resize forwards SIGWINCH on main; getScrollback is a
      // pure in-memory read. Firing them together is safe because main
      // preserves per-renderer IPC order and the resize handler is synchronous,
      // so main records the width change before getScrollback runs. When cols
      // changed, main's getScrollback waits for the agent TUI's async SIGWINCH
      // repaint to land before sampling (PtyBufferManager.waitForResizeRepaint),
      // so the replay is at the fitted width - no stale frame, no compensating
      // resize needed here. The colsChanged field of the resize result is
      // therefore intentionally unused by the renderer.
      const resizePromise = window.electronAPI.sessions.resize(sid, cols, rows);
      const scrollbackPromise = suppressScrollback
        ? Promise.resolve<string | null>(null)
        : window.electronAPI.sessions.getScrollback(sid);

      Promise.all([resizePromise, scrollbackPromise])
        .then(([, scrollback]) => {
          // A newer scrollback operation has started; abandon this one.
          if (scrollbackGenerationRef.current !== scrollbackGeneration) {
            scrollbackPendingRef.current = false;
            return;
          }

          const afterWrite = () => {
            // Re-fit to handle any layout shifts during the async gap
            if (fitAddonRef.current) {
              fitAddonRef.current.fit();
            }
            // Restore saved scroll position (HMR) or pin to bottom (cold start)
            if (xtermRef.current) {
              isAtBottomRef.current = restoreScrollPosition(xtermRef.current, options.sessionId);
            }
            scrollbackPendingRef.current = false;
            // Focus the terminal after the full init chain completes. No
            // corrective resize: main already sampled the settled frame at the
            // fitted width, and a same-dims resize is a documented no-op (POSIX
            // sends SIGWINCH only on a real size change; ConPTY likewise).
            requestAnimationFrame(() => {
              xtermRef.current?.focus();
            });
          };
          if (scrollback && xtermRef.current) {
            // Chunked so a 512KB replay doesn't parse in one synchronous write.
            // Strip OSC 52 so replaying recorded output never clobbers the live clipboard.
            writeChunkedToTerminal(xtermRef.current, stripOsc52Sequences(scrollback), afterWrite);
          } else {
            afterWrite();
          }
        })
        .catch(() => {
          // IPC may reject if session was killed during the async gap.
          // Unblock onData so the terminal isn't permanently silenced.
          if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
          scrollbackPendingRef.current = false;
        });
    } else {
      // No session -- just fit immediately
      fitAddon.fit();
    }
  }, [options.sessionId, options.fontFamily, options.fontSize, options.scrollbackLines, options.cursorStyle, options.shellName, options.releaseEscapeWhenPointerOutside]);

  // Set up data listener. Inbound PTY data flows through a bounded queue that
  // writes capped slices paced by xterm.write's completion callback, yielding
  // to input/React between slices so a heavy output burst can't freeze the UI.
  // Each consumed slice is acked back to main, which drives per-session PTY
  // backpressure (pause when the renderer falls behind, resume as it drains).
  useEffect(() => {
    const sessionId = options.sessionId;
    if (!sessionId) return;

    const queue = createIncomingWriteQueue({
      getTerminal: () => xtermRef.current,
      // While scrollback is loading (or an overlay is up), drop onData -- it's
      // duplicate data already included in the scrollback replay. The
      // server-side getScrollback() drains the pending buffer, so this is
      // defense-in-depth. Dropped slices are still acked inside the queue.
      shouldDrop: () => scrollbackPendingRef.current || suppressDataRef.current,
      // While a board drag is active, HOLD (not drop) inbound writes so xterm
      // parsing doesn't compete with the drag on the renderer thread. Held bytes
      // are retained and resumed on drag end; the coalescer's 30s watchdog
      // bounds the hold if a drag end is ever missed.
      shouldHold: () => isBoardDragActive(),
      ack: (bytes) => window.electronAPI.sessions.ackData(sessionId, bytes),
    });

    const cleanup = window.electronAPI.sessions.onData((incomingSessionId, data) => {
      if (incomingSessionId !== sessionId) return;
      queue.push(data);
    });
    // Resume the held drain the moment a board drag ends (also via the
    // coalescer's watchdog / window-blur backstops, which route through here).
    const unsubscribeDragEnd = onBoardDragEnd(() => queue.kick());

    cleanupRef.current = cleanup;
    return () => {
      cleanup();
      cleanupRef.current = null;
      unsubscribeDragEnd();
      queue.reset();
    };
  }, [options.sessionId]);

  // Handle context-menu actions dispatched from the main process: Copy, Select
  // All, and Paste. The event detail carries the right-click coordinates so we
  // only act when the click landed inside THIS terminal's container.
  useEffect(() => {
    const isInside = (e: Event): boolean => {
      const el = terminalRef.current;
      if (!el || !xtermRef.current) return false;
      const { x, y } = (e as CustomEvent).detail || {};
      if (x == null || y == null) return false;
      const rect = el.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const handleCopy = (e: Event) => {
      if (!isInside(e)) return;
      // Write via the main process (focus-independent). The native context menu's
      // Menu.popup steals document focus, so navigator.clipboard.writeText would reject.
      copySelectionToClipboard(xtermRef.current!);
    };
    const handleSelectAll = (e: Event) => {
      if (!isInside(e)) return;
      xtermRef.current!.selectAll();
    };
    const handlePaste = (e: Event) => {
      if (!isInside(e)) return;
      navigator.clipboard.readText().then((text) => {
        if (text) xtermRef.current?.paste(text);
      }).catch(() => { /* clipboard access denied */ });
    };
    window.addEventListener('terminal-copy', handleCopy);
    window.addEventListener('terminal-select-all', handleSelectAll);
    window.addEventListener('terminal-paste', handlePaste);
    return () => {
      window.removeEventListener('terminal-copy', handleCopy);
      window.removeEventListener('terminal-select-all', handleSelectAll);
      window.removeEventListener('terminal-paste', handlePaste);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      // Flush any pending batched writes synchronously so keystrokes queued
      // just before unmount (sessionId change, HMR dispose) aren't dropped.
      writeBatcherRef.current?.flush();
      writeBatcherRef.current = null;
      // Save scroll position before dispose for HMR restoration.
      // Only save if the user scrolled up; at-bottom is the default.
      if (xtermRef.current && options.sessionId && !isAtBottomRef.current) {
        savedScrollPositions.set(options.sessionId, xtermRef.current.buffer.active.viewportY);
      } else if (options.sessionId) {
        savedScrollPositions.delete(options.sessionId);
      }
      // Tear down WebGL (cancel any pending re-init retry, drop the report entry)
      // before disposing the terminal it is attached to.
      disposeWebglRef.current?.();
      disposeWebglRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only teardown; adding options.sessionId would dispose and recreate the xterm on every session switch. The scroll-save reads sessionId from the disposing render, which is correct because the component remounts per session (terminal ownership handoff)
  }, []);

  // fit() only refits xterm visually. The debounced onResize callback
  // forwards dimensions to the PTY automatically when cols/rows change.
  const fit = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    const wasAtBottom = isAtBottomRef.current;
    fitAddonRef.current.fit();
    if (wasAtBottom) {
      xtermRef.current.scrollToBottom();
    }
  }, []);

  // Flush a pending (debounced) PTY resize immediately, instead of waiting out
  // PTY_RESIZE_DEBOUNCE_MS. Window-hosted terminals fit synchronously on the
  // window manager's committed resize, and the manager-resize gate already
  // coalesces a gesture to a single dimension change, so for them the debounce is
  // pure latency: it delays Claude's SIGWINCH redraw well past the visual reflow,
  // which reads as "reflow ... then flash". Calling this right after fit() lands
  // the PTY resize (and Claude's redraw) in the same beat as the reflow. No-op if
  // no resize is pending (cols/rows did not change).
  const flushResize = useCallback(() => {
    if (!resizeTimerRef.current || !xtermRef.current || !options.sessionId) return;
    clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = null;
    const { cols, rows } = xtermRef.current;
    window.electronAPI.sessions.resize(options.sessionId, cols, rows);
  }, [options.sessionId]);

  // Re-fetch scrollback from the PTY and write it to xterm. Called when
  // the loading overlay lifts so that suppressed TUI output is recovered.
  //
  // `skipResize` re-renders the buffer at the CURRENT (already-synced) width
  // without sending any SIGWINCH. Used by the window manager to clean up a
  // full-screen TUI's accumulated resize redraws AFTER resizing has settled:
  // the PTY is already the right size, so a resize here would only trigger more
  // TUI redraws (re-polluting the buffer with duplicated frames).
  const reloadScrollback = useCallback((reloadOptions?: { skipResize?: boolean }) => {
    if (!options.sessionId || !xtermRef.current || !fitAddonRef.current) return;
    const skipResize = reloadOptions?.skipResize ?? false;
    scrollbackPendingRef.current = true;
    const scrollbackGeneration = ++scrollbackGenerationRef.current;
    xtermRef.current.reset();

    // Resize-first: fit to container, then sync PTY dimensions before
    // fetching scrollback (clears stale buffer if cols changed). When
    // skipResize, the PTY is already synced; fit() is a no-op at the stable
    // width and we send no SIGWINCH.
    fitAddonRef.current.fit();
    const { cols, rows } = xtermRef.current;
    const sessionId = options.sessionId;

    // Parallel IPCs: same shape as initTerminal's mount-time path. Resize
    // forwards SIGWINCH on main; getScrollback is an in-memory read. When cols
    // changed, main waits for the agent TUI's repaint to settle before sampling
    // (see the initTerminal note), so the reload lands the fitted-width frame.
    // skipResize sends no SIGWINCH: the window manager calls it once resizing
    // has already settled, so there is nothing to wait for.
    const resizePromise = skipResize
      ? Promise.resolve(undefined)
      : window.electronAPI.sessions.resize(sessionId, cols, rows);
    const scrollbackPromise = window.electronAPI.sessions.getScrollback(sessionId);

    Promise.all([resizePromise, scrollbackPromise])
      .then(([, scrollback]) => {
        // A newer scrollback operation has started; abandon this one.
        if (scrollbackGenerationRef.current !== scrollbackGeneration) {
          scrollbackPendingRef.current = false;
          return;
        }

        const afterWrite = () => {
          if (fitAddonRef.current) fitAddonRef.current.fit();
          // Restore saved scroll position (HMR) or pin to bottom
          if (xtermRef.current) {
            isAtBottomRef.current = restoreScrollPosition(xtermRef.current, options.sessionId);
          }
          scrollbackPendingRef.current = false;
          // Focus after the reload completes. No corrective resize: when a
          // resize was sent above, main sampled the settled frame; a same-dims
          // resize is a no-op either way.
          requestAnimationFrame(() => {
            xtermRef.current?.focus();
          });
        };
        if (scrollback && xtermRef.current) {
          // Chunked so a 512KB replay (tab/window switch, resize) doesn't parse
          // in one synchronous write that stalls the renderer mid-drag.
          // Strip OSC 52 so replaying recorded output never clobbers the live clipboard.
          writeChunkedToTerminal(xtermRef.current, stripOsc52Sequences(scrollback), afterWrite);
        } else {
          afterWrite();
        }
      })
      .catch(() => {
        // IPC may reject if session was killed during the async gap.
        // Unblock onData so the terminal isn't permanently silenced.
        if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
        scrollbackPendingRef.current = false;
      });
  }, [options.sessionId]);

  const focus = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  return {
    terminalRef,
    initTerminal,
    fit,
    flushResize,
    focus,
    reloadScrollback,
    scrollbackPending: scrollbackPendingRef,
    suppressDataRef,
  };
}

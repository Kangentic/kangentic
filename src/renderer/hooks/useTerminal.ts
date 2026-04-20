import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '../addons/fit-addon';
import { WebglAddon } from '@xterm/addon-webgl';
import { cleanSelection, enableTerminalClipboard } from '../utils/terminal-clipboard';
import { createWriteBatcher, type WriteBatcher } from '../utils/write-batcher';
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

/** Fixed dark terminal theme -- Claude Code's TUI is designed for dark backgrounds. */
const TERMINAL_THEME = {
  background: '#18181b',
  foreground: '#e4e4e7',
  cursor: '#18181b',
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

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const xtermTheme = TERMINAL_THEME;

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Menlo, Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: xtermTheme,
      scrollback: options.scrollbackLines || 5000,
      cursorBlink: false,
      cursorStyle: options.cursorStyle || 'block',
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

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
    enableTerminalClipboard(terminal, terminalRef.current, batcher.schedule, options.shellName);

    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      isAtBottomRef.current = buffer.viewportY >= buffer.baseY;
    });

    // Try WebGL renderer
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available, use canvas fallback
    }

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
      // FIRST, then send an immediate (non-debounced) resize to the PTY.
      // If cols changed, skip scrollback entirely -- the PTY may still flush
      // output at the old width before SIGWINCH is processed, so replaying
      // scrollback would show truncated/garbled content. Instead, let Claude
      // Code's SIGWINCH redraw populate the terminal via live onData.
      scrollbackPendingRef.current = true;
      const scrollbackGeneration = ++scrollbackGenerationRef.current;
      const suppressScrollback = suppressDataRef.current;

      // Fit immediately to calculate actual container cols/rows
      fitAddon.fit();
      const { cols, rows } = terminal;

      // Immediate resize to sync PTY dimensions
      window.electronAPI.sessions.resize(sid, cols, rows)
        .then(() => {
          // Skip scrollback when the overlay is suppressing data (shimmer showing).
          // The shimmer-lift effect will call reloadScrollback() when ready.
          if (suppressScrollback) return null;
          // Always fetch scrollback regardless of cols change.
          // getScrollback() strips pre-TUI noise at read time.
          return window.electronAPI.sessions.getScrollback(sid);
        })
        .then((scrollback) => {
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
            // Force an explicit resize to the PTY even if dimensions haven't
            // changed, so the running process (Claude Code's TUI) re-renders.
            // Focus the terminal after the full init chain completes.
            requestAnimationFrame(() => {
              if (xtermRef.current && options.sessionId) {
                const { cols, rows } = xtermRef.current;
                window.electronAPI.sessions.resize(options.sessionId, cols, rows);
              }
              xtermRef.current?.focus();
            });
          };
          if (scrollback && xtermRef.current) {
            xtermRef.current.write(scrollback, afterWrite);
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
  }, [options.sessionId, options.fontFamily, options.fontSize, options.scrollbackLines, options.cursorStyle, options.shellName]);

  // Set up data listener
  useEffect(() => {
    if (!options.sessionId) return;

    const cleanup = window.electronAPI.sessions.onData((sessionId, data) => {
      if (sessionId !== options.sessionId || !xtermRef.current) return;

      // While scrollback is loading, drop onData -- it's duplicate data
      // already included in the scrollback replay. The server-side
      // getScrollback() drains the pending buffer to prevent stale
      // flushes, so this guard is defense-in-depth only.
      if (scrollbackPendingRef.current) return;
      if (suppressDataRef.current) return;

      xtermRef.current.write(data);
    });

    cleanupRef.current = cleanup;
    return () => {
      cleanup();
      cleanupRef.current = null;
    };
  }, [options.sessionId]);

  // Handle context-menu Copy / Select All dispatched from the main process.
  // The event detail carries the right-click coordinates so we only act when
  // the click landed inside THIS terminal's container.
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
      const term = xtermRef.current!;
      const selection = term.getSelection();
      if (selection) {
        const cleaned = cleanSelection(selection, term.cols);
        if (cleaned) navigator.clipboard.writeText(cleaned);
      }
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
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
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

  // Re-fetch scrollback from the PTY and write it to xterm. Called when
  // the loading overlay lifts so that suppressed TUI output is recovered.
  const reloadScrollback = useCallback(() => {
    if (!options.sessionId || !xtermRef.current || !fitAddonRef.current) return;
    scrollbackPendingRef.current = true;
    const scrollbackGeneration = ++scrollbackGenerationRef.current;
    xtermRef.current.reset();

    // Resize-first: fit to container, then sync PTY dimensions before
    // fetching scrollback (clears stale buffer if cols changed).
    fitAddonRef.current.fit();
    const { cols, rows } = xtermRef.current;
    const sessionId = options.sessionId;

    window.electronAPI.sessions.resize(sessionId, cols, rows)
      .then(() => {
        // Always replay scrollback. getScrollback() strips pre-TUI noise
        // (shell command) at read time. Wrong-width content may briefly
        // flash but the SIGWINCH redraw corrects it immediately.
        return window.electronAPI.sessions.getScrollback(sessionId);
      })
      .then((scrollback) => {
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
          requestAnimationFrame(() => {
            if (xtermRef.current && options.sessionId) {
              const { cols, rows } = xtermRef.current;
              window.electronAPI.sessions.resize(options.sessionId, cols, rows);
            }
            xtermRef.current?.focus();
          });
        };
        if (scrollback && xtermRef.current) {
          xtermRef.current.write(scrollback, afterWrite);
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
    focus,
    reloadScrollback,
    scrollbackPending: scrollbackPendingRef,
    suppressDataRef,
  };
}

import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { cleanSelection } from '../utils/terminal-clipboard';
import '@xterm/xterm/css/xterm.css';

/** Delay before forwarding a resize to the PTY. Coalesces rapid resizes
 *  (panel drag, window resize) into a single PTY resize so the TUI
 *  (Claude Code) only redraws once and scrollback isn't churned. */
const PTY_RESIZE_DEBOUNCE_MS = 200;

/** Fixed dark terminal theme -- Claude Code's TUI is designed for dark backgrounds. */
const TERMINAL_THEME = {
  background: '#18181b',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
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
}

export function useTerminal(options: UseTerminalOptions) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollbackPendingRef = useRef(false);
  const isAtBottomRef = useRef(true);
  /** When true, onData writes are suppressed. Controlled by the caller
   *  (e.g. TerminalTab) to gate PTY output while a loading overlay is shown. */
  const suppressDataRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const xtermTheme = TERMINAL_THEME;

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: xtermTheme,
      scrollback: options.scrollbackLines || 5000,
      cursorBlink: true,
      cursorStyle: options.cursorStyle || 'block',
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

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

    // Send user input to PTY
    if (options.sessionId) {
      terminal.onData((data) => {
        window.electronAPI.sessions.write(options.sessionId!, data);
      });

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

      // Replay buffered scrollback BEFORE fitting so xterm's reflow engine
      // can properly re-wrap lines when fit() changes the column count.
      // The scrollback was generated at the PTY's initial 120x30 which
      // likely differs from the dialog's actual dimensions.
      scrollbackPendingRef.current = true;
      const suppressScrollback = suppressDataRef.current;
      window.electronAPI.sessions.getScrollback(options.sessionId).then((scrollback) => {
        // xterm.write() is async (queued). Post-write logic (fit, scroll,
        // PTY resize) must run inside the write callback so it executes
        // AFTER xterm processes the data. Otherwise scrollToBottom() runs
        // on an empty buffer, and the later onScroll from the processed
        // write sets isAtBottomRef = false, blocking subsequent fit() calls
        // from ResizeObserver (e.g. after CSS panel-expand transitions).
        const afterWrite = () => {
          // Fit to actual container size; onResize fires to sync PTY.
          if (fitAddonRef.current) {
            fitAddonRef.current.fit();
          }
          // Pin to bottom after scrollback replay -- terminal should always
          // start at the latest output when re-created (e.g. dialog handoff).
          if (xtermRef.current) {
            xtermRef.current.scrollToBottom();
            isAtBottomRef.current = true;
          }
          scrollbackPendingRef.current = false;
          // Force an explicit resize to the PTY even if dimensions haven't
          // changed, so the running process (Claude Code's TUI) re-renders.
          requestAnimationFrame(() => {
            if (xtermRef.current && options.sessionId) {
              const { cols, rows } = xtermRef.current;
              window.electronAPI.sessions.resize(options.sessionId, cols, rows);
            }
          });
        };
        if (scrollback && xtermRef.current && !suppressScrollback) {
          xtermRef.current.write(scrollback, afterWrite);
        } else {
          afterWrite();
        }
      });
    } else {
      // No session -- just fit immediately
      fitAddon.fit();
    }
  }, [options.sessionId, options.fontFamily, options.fontSize, options.scrollbackLines, options.cursorStyle]);

  // Set up data listener
  useEffect(() => {
    if (!options.sessionId) return;

    const cleanup = window.electronAPI.sessions.onData((sessionId, data) => {
      if (sessionId !== options.sessionId || !xtermRef.current) return;

      // While scrollback is loading, drop onData -- it's duplicate data
      // already included in the scrollback replay. Any in-flight buffer
      // flushes that arrive just after scrollbackPending clears may cause
      // a brief duplicate write, but xterm handles this gracefully for
      // TUI apps (absolute cursor positioning rewrites the same cells).
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
    window.addEventListener('terminal-copy', handleCopy);
    window.addEventListener('terminal-select-all', handleSelectAll);
    return () => {
      window.removeEventListener('terminal-copy', handleCopy);
      window.removeEventListener('terminal-select-all', handleSelectAll);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
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

  // Unconditional fit + scroll-to-bottom. Used for deliberate layout
  // changes (panel expand/collapse, drag resize) where the terminal
  // should refit and pin to the latest output.
  const forceFit = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    // FitAddon.fit() has a same-dimension guard: if terminal.rows/cols
    // already match the proposed dimensions, it skips resize entirely
    // (no renderService.clear(), no terminal.resize(), no visual update).
    // Always perturb rows so fit() sees a dimension mismatch and runs
    // its full renderService.clear() + terminal.resize() path. This
    // handles both same-dimension cases (where the guard would skip)
    // and growing cases (where the WebGL canvas may not update without
    // a clear). Both resize calls are synchronous and batch into one
    // browser paint, so no visual flash occurs.
    const dims = fitAddonRef.current.proposeDimensions();
    if (dims && !isNaN(dims.cols) && !isNaN(dims.rows)) {
      xtermRef.current.resize(dims.cols, Math.max(1, dims.rows - 1));
    }
    fitAddonRef.current.fit();
    xtermRef.current.scrollToBottom();
    isAtBottomRef.current = true;
  }, []);

  // Re-fetch scrollback from the PTY and write it to xterm. Called when
  // the loading overlay lifts so that suppressed TUI output is recovered.
  const reloadScrollback = useCallback(() => {
    if (!options.sessionId || !xtermRef.current) return;
    scrollbackPendingRef.current = true;
    window.electronAPI.sessions.getScrollback(options.sessionId).then((scrollback) => {
      if (scrollback && xtermRef.current) {
        xtermRef.current.write(scrollback, () => {
          if (fitAddonRef.current) fitAddonRef.current.fit();
          if (xtermRef.current) {
            xtermRef.current.scrollToBottom();
            isAtBottomRef.current = true;
          }
          scrollbackPendingRef.current = false;
          requestAnimationFrame(() => {
            if (xtermRef.current && options.sessionId) {
              const { cols, rows } = xtermRef.current;
              window.electronAPI.sessions.resize(options.sessionId, cols, rows);
            }
          });
        });
      } else {
        scrollbackPendingRef.current = false;
      }
    });
  }, [options.sessionId]);

  const focus = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  return {
    terminalRef,
    initTerminal,
    fit,
    forceFit,
    focus,
    reloadScrollback,
    scrollbackPending: scrollbackPendingRef,
    suppressDataRef,
  };
}

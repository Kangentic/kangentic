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

interface UseTerminalOptions {
  sessionId: string | null;
  fontFamily?: string;
  fontSize?: number;
}

export function useTerminal(options: UseTerminalOptions) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollbackPendingRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: {
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
      },
      scrollback: 5000,
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

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

      // Debounced PTY resize — coalesces rapid dimension changes so the
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
      window.electronAPI.sessions.getScrollback(options.sessionId).then((scrollback) => {
        if (scrollback && xtermRef.current) {
          xtermRef.current.write(scrollback);
        }
        // Now fit — xterm reflows all content to the actual container size,
        // and onResize fires to sync the PTY to the correct dimensions.
        if (fitAddonRef.current) {
          fitAddonRef.current.fit();
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
      });
    } else {
      // No session — just fit immediately
      fitAddon.fit();
    }
  }, [options.sessionId, options.fontFamily, options.fontSize]);

  // Set up data listener
  useEffect(() => {
    if (!options.sessionId) return;

    const cleanup = window.electronAPI.sessions.onData((sessionId, data) => {
      if (sessionId !== options.sessionId || !xtermRef.current) return;

      // While scrollback is loading, drop onData — it's duplicate data
      // already included in the scrollback replay. Any in-flight buffer
      // flushes that arrive just after scrollbackPending clears may cause
      // a brief duplicate write, but xterm handles this gracefully for
      // TUI apps (absolute cursor positioning rewrites the same cells).
      if (scrollbackPendingRef.current) return;

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
    if (!fitAddonRef.current) return;
    fitAddonRef.current.fit();
  }, []);

  const focus = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  const clear = useCallback(() => {
    xtermRef.current?.clear();
  }, []);

  return {
    terminalRef,
    initTerminal,
    fit,
    focus,
    clear,
    scrollbackPending: scrollbackPendingRef,
  };
}

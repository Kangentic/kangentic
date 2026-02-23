import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

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

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: {
        background: '#18181b',
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
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

    fitAddon.fit();
    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Send user input to PTY
    if (options.sessionId) {
      terminal.onData((data) => {
        window.electronAPI.sessions.write(options.sessionId!, data);
      });

      // Resize PTY when terminal resizes
      terminal.onResize(({ cols, rows }) => {
        window.electronAPI.sessions.resize(options.sessionId!, cols, rows);
      });

      // Replay buffered scrollback so we see past output
      window.electronAPI.sessions.getScrollback(options.sessionId).then((scrollback) => {
        if (scrollback && xtermRef.current) {
          xtermRef.current.write(scrollback);
        }
      });
    }
  }, [options.sessionId, options.fontFamily, options.fontSize]);

  // Set up data listener
  useEffect(() => {
    if (!options.sessionId) return;

    const cleanup = window.electronAPI.sessions.onData((sessionId, data) => {
      if (sessionId === options.sessionId && xtermRef.current) {
        xtermRef.current.write(data);
      }
    });

    cleanupRef.current = cleanup;
    return () => {
      cleanup();
      cleanupRef.current = null;
    };
  }, [options.sessionId]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  const fit = useCallback(() => {
    fitAddonRef.current?.fit();
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
  };
}

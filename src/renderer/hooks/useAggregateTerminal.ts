import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { createAnsiFilter } from '../utils/ansi-filter';
import { enableTerminalClipboard, cleanSelection } from '../utils/terminal-clipboard';
import '@xterm/xterm/css/xterm.css';

// 8 distinct ANSI 256-color codes for session badges
const BADGE_COLORS = [33, 39, 208, 170, 76, 214, 81, 196];

interface UseAggregateTerminalOptions {
  sessionIds: string[];
  taskIdMap: Map<string, string>;
  fontFamily?: string;
  fontSize?: number;
}

export function useAggregateTerminal(options: UseAggregateTerminalOptions) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastSessionRef = useRef<string | null>(null);
  const filterMapRef = useRef<Map<string, ReturnType<typeof createAnsiFilter>>>(new Map());
  const colorMapRef = useRef<Map<string, number>>(new Map());
  const colorIndexRef = useRef(0);
  const scrollbackDoneRef = useRef(false);

  const getColor = useCallback((sessionId: string): number => {
    const map = colorMapRef.current;
    if (!map.has(sessionId)) {
      map.set(sessionId, BADGE_COLORS[colorIndexRef.current % BADGE_COLORS.length]);
      colorIndexRef.current++;
    }
    return map.get(sessionId)!;
  }, []);

  const getFilter = useCallback((sessionId: string) => {
    const map = filterMapRef.current;
    if (!map.has(sessionId)) {
      map.set(sessionId, createAnsiFilter());
    }
    return map.get(sessionId)!;
  }, []);

  const writeBadge = useCallback((sessionId: string) => {
    const term = xtermRef.current;
    if (!term) return;
    const color = getColor(sessionId);
    const label = options.taskIdMap.get(sessionId) || sessionId.slice(0, 8);
    term.write(`\x1b[1;38;5;${color}m[${label}]\x1b[0m `);
  }, [getColor, options.taskIdMap]);

  const writeFiltered = useCallback((sessionId: string, filtered: string) => {
    const term = xtermRef.current;
    if (!term || !filtered) return;

    // Badge only on session switch
    const isSwitch = lastSessionRef.current !== sessionId;
    if (isSwitch) {
      if (lastSessionRef.current !== null) {
        term.write('\r\n');
      }
      writeBadge(sessionId);
      term.write('\r\n');
      lastSessionRef.current = sessionId;
    }

    // Write the filtered content, converting newlines for xterm
    const lines = filtered.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) term.write('\r\n');
      const line = lines[i];
      if (line) term.write(line);
    }
  }, [writeBadge]);

  const writeSessionData = useCallback((sessionId: string, data: string) => {
    const { filter } = getFilter(sessionId);
    filter(data, (filtered) => {
      writeFiltered(sessionId, filtered);
    });
  }, [getFilter, writeFiltered]);

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
      scrollback: 10000,
      cursorBlink: false,
      // Not using disableStdin so that text selection and copy work.
      // We simply don't wire onData to any PTY — the terminal is read-only
      // by virtue of having no input handler.
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef.current);
    enableTerminalClipboard(terminal, terminalRef.current);

    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => webglAddon.dispose());
      terminal.loadAddon(webglAddon);
    } catch {
      // WebGL not available
    }

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Load scrollback for all current sessions
    scrollbackDoneRef.current = false;
    const promises = options.sessionIds.map(async (sid) => {
      const scrollback = await window.electronAPI.sessions.getScrollback(sid);
      if (scrollback && xtermRef.current) {
        const color = getColor(sid);
        const label = options.taskIdMap.get(sid) || sid.slice(0, 8);
        xtermRef.current.write(
          `\x1b[2m--- Scrollback: \x1b[1;38;5;${color}m[${label}]\x1b[0;2m ---\x1b[0m\r\n`,
        );

        // Wait for the filter to process the scrollback data
        await new Promise<void>((resolve) => {
          const { filter } = getFilter(sid);
          filter(scrollback, (filtered) => {
            writeFiltered(sid, filtered);
            if (xtermRef.current) xtermRef.current.write('\r\n');
            lastSessionRef.current = null;
            resolve();
          });
        });
      }
    });

    Promise.all(promises).then(() => {
      scrollbackDoneRef.current = true;
      fitAddonRef.current?.fit();
    });
  }, [options.sessionIds, options.taskIdMap, options.fontFamily, options.fontSize, getColor, getFilter, writeFiltered]);

  // Live data listener — listens to ALL sessions
  useEffect(() => {
    if (options.sessionIds.length === 0) return;

    const activeSet = new Set(options.sessionIds);
    const cleanup = window.electronAPI.sessions.onData((sessionId, data) => {
      if (!activeSet.has(sessionId) || !xtermRef.current) return;
      if (!scrollbackDoneRef.current) return;
      writeSessionData(sessionId, data);
    });

    return cleanup;
  }, [options.sessionIds, writeSessionData]);

  // Session join/exit events
  const prevSessionIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const prevSet = prevSessionIdsRef.current;
    const currentSet = new Set(options.sessionIds);
    const term = xtermRef.current;

    if (term && scrollbackDoneRef.current) {
      for (const sid of currentSet) {
        if (!prevSet.has(sid)) {
          const color = getColor(sid);
          const label = options.taskIdMap.get(sid) || sid.slice(0, 8);
          term.write(
            `\r\n\x1b[2m+ Session joined: \x1b[1;38;5;${color}m[${label}]\x1b[0m\r\n`,
          );
          lastSessionRef.current = null;
        }
      }
    }

    prevSessionIdsRef.current = currentSet;
  }, [options.sessionIds, options.taskIdMap, getColor]);

  // Listen for session exits
  useEffect(() => {
    const cleanup = window.electronAPI.sessions.onExit((sessionId, exitCode) => {
      const term = xtermRef.current;
      if (!term || !colorMapRef.current.has(sessionId)) return;
      const color = getColor(sessionId);
      const label = options.taskIdMap.get(sessionId) || sessionId.slice(0, 8);
      term.write(
        `\r\n\x1b[2m- Session exited: \x1b[1;38;5;${color}m[${label}]\x1b[0;2m (code ${exitCode})\x1b[0m\r\n`,
      );
      lastSessionRef.current = null;
    });
    return cleanup;
  }, [options.taskIdMap, getColor]);

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

  // Cleanup on unmount — dispose headless filters too
  useEffect(() => {
    return () => {
      for (const f of filterMapRef.current.values()) {
        f.dispose();
      }
      filterMapRef.current.clear();
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

  return {
    terminalRef,
    initTerminal,
    fit,
    focus,
  };
}

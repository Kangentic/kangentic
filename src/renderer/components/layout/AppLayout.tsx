import React, { useState, useCallback, useRef, useEffect } from 'react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { KanbanBoard } from '../board/KanbanBoard';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsPage } from '../settings/SettingsPage';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { ToastContainer } from './ToastContainer';

const MIN_TERMINAL_HEIGHT = 100;

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(config.terminal.panelHeight);
  const [terminalCollapsed, setTerminalCollapsed] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const contentColRef = useRef<HTMLDivElement>(null);
  const latestHeightRef = useRef(terminalHeight);
  const availableHeightRef = useRef(0);

  // Compute max terminal height: 50% of the content column so the board
  // is always at least 50% visible.  Subtract the 4px resize handle.
  const getMaxHeight = useCallback(() => {
    return Math.floor(availableHeightRef.current / 2) - 4;
  }, []);

  const clampHeight = useCallback((h: number) => {
    if (availableHeightRef.current === 0) {
      // Not measured yet — only enforce minimum, skip max constraint
      return Math.max(MIN_TERMINAL_HEIGHT, h);
    }
    const max = getMaxHeight();
    if (max <= MIN_TERMINAL_HEIGHT) return MIN_TERMINAL_HEIGHT;
    return Math.max(MIN_TERMINAL_HEIGHT, Math.min(max, h));
  }, [getMaxHeight]);

  // Track the content column height via ResizeObserver.
  // When the window (or column) shrinks, clamp terminalHeight so the
  // board never drops below 50%.
  useEffect(() => {
    const el = contentColRef.current;
    if (!el) return;

    // Initialize immediately so clampHeight works before ResizeObserver fires
    availableHeightRef.current = el.getBoundingClientRect().height;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        availableHeightRef.current = entry.contentRect.height;
      }
      const clamped = clampHeight(latestHeightRef.current);
      if (clamped !== latestHeightRef.current) {
        latestHeightRef.current = clamped;
        setTerminalHeight(clamped);
      }
      // Always signal terminals to refit when the content column resizes
      // (window resize, sidebar toggle, height clamp, etc.)
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampHeight]);

  const handleToggleCollapse = useCallback(() => {
    setTerminalCollapsed((prev) => {
      // Fire resize event after the layout settles so terminals refit
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
      return !prev;
    });
  }, []);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = terminalHeight;

    // Signal terminals to defer fit() until drag ends, preventing
    // incremental scrollback eviction from repeated row-count changes.
    window.dispatchEvent(new CustomEvent('terminal-panel-drag-start'));

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const newHeight = clampHeight(startHeight + delta);
      setTerminalHeight(newHeight);
      latestHeightRef.current = newHeight;
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Persist the final panel height
      window.electronAPI.config.set({
        terminal: { ...config.terminal, panelHeight: latestHeightRef.current },
      });
      // End drag suppression then signal terminals to refit.
      // Double rAF ensures React has committed the final height.
      window.dispatchEvent(new CustomEvent('terminal-panel-drag-end'));
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
        });
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [terminalHeight, config.terminal, clampHeight]);

  if (settingsOpen) {
    return (
      <div className="h-screen flex flex-col bg-zinc-900">
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <SettingsPage />
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-900" ref={containerRef}>
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

      <div className="flex flex-1 min-h-0">
        <div
          className={`flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out border-r border-zinc-700 ${
            sidebarOpen ? 'w-56' : 'w-0 border-r-0'
          }`}
        >
          <ProjectSidebar />
        </div>

        <div className="flex-1 flex flex-col min-w-0" ref={contentColRef}>
          {currentProject ? (
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KanbanBoard />
              </div>

              {/* Resize handle — hidden when collapsed */}
              {!terminalCollapsed && (
                <div
                  className="resize-handle h-1 bg-zinc-700 flex-shrink-0 cursor-row-resize hover:bg-zinc-500 transition-colors"
                  onMouseDown={handleResizeStart}
                />
              )}

              {/* Terminal panel */}
              <div
                style={terminalCollapsed ? undefined : { height: terminalHeight }}
                className={`flex-shrink-0 ${isResizing ? 'pointer-events-none' : ''}`}
              >
                <TerminalPanel
                  collapsed={terminalCollapsed}
                  onToggleCollapse={handleToggleCollapse}
                />
              </div>
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-500">
              <div className="text-center">
                <div className="text-4xl mb-4">&#9776;</div>
                <div className="text-lg">Select or create a project to get started</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <StatusBar />
      <ToastContainer />
    </div>
  );
}

import React, { useState, useCallback, useRef } from 'react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { KanbanBoard } from '../board/KanbanBoard';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsPage } from '../settings/SettingsPage';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const currentProject = useProjectStore((s) => s.currentProject);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(250);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';

    const startY = e.clientY;
    const startHeight = terminalHeight;

    const onMouseMove = (e: MouseEvent) => {
      const delta = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(600, startHeight + delta));
      setTerminalHeight(newHeight);
    };

    const onMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // Signal terminals to refit after the panel resize settles
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('terminal-panel-resize'));
      });
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [terminalHeight]);

  if (settingsOpen) {
    return (
      <div className="h-screen flex flex-col bg-zinc-900">
        <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        <SettingsPage />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-900" ref={containerRef}>
      <TitleBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen(!sidebarOpen)} />

      <div className="flex flex-1 min-h-0">
        {sidebarOpen && <ProjectSidebar />}

        <div className="flex-1 flex flex-col min-w-0">
          {currentProject ? (
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KanbanBoard />
              </div>

              {/* Resize handle */}
              <div
                className="resize-handle h-1 bg-zinc-700 flex-shrink-0 cursor-row-resize hover:bg-zinc-500 transition-colors"
                onMouseDown={handleResizeStart}
              />

              {/* Terminal panel */}
              <div style={{ height: terminalHeight }} className={`flex-shrink-0 ${isResizing ? 'pointer-events-none' : ''}`}>
                <TerminalPanel />
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
    </div>
  );
}

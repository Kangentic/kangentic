import React from 'react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { KanbanBoard } from '../board/KanbanBoard';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsPage } from '../settings/SettingsPage';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { ToastContainer } from './ToastContainer';
import { useSidebarResize } from '../../hooks/useSidebarResize';
import { useTerminalResize, COLLAPSED_HEIGHT } from '../../hooks/useTerminalResize';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);

  const sidebar = useSidebarResize(config);
  const terminal = useTerminalResize(config);

  if (settingsOpen) {
    return (
      <div className="h-screen flex flex-col bg-zinc-900">
        <TitleBar sidebarOpen={sidebar.open} onToggleSidebar={sidebar.toggle} />
        <SettingsPage />
        <ToastContainer />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-zinc-900">
      <TitleBar sidebarOpen={sidebar.open} onToggleSidebar={sidebar.toggle} />

      <div className="flex flex-1 min-h-0">
        <div
          className={`flex-shrink-0 overflow-hidden border-r border-zinc-700 ${
            !sidebar.open && !sidebar.isResizing ? 'w-0 border-r-0' : ''
          } ${sidebar.ready && !sidebar.isResizing ? 'transition-[width] duration-200 ease-in-out' : ''}`}
          style={sidebar.open || sidebar.isResizing ? { width: sidebar.width } : undefined}
        >
          <ProjectSidebar onToggleSidebar={sidebar.toggle} />
        </div>

        {/* Sidebar resize handle — wider hit target when collapsed */}
        <div
          className={`flex-shrink-0 cursor-col-resize transition-colors ${
            sidebar.open
              ? 'w-1 bg-zinc-700 hover:bg-zinc-500'
              : 'w-1.5 bg-zinc-700/50 hover:bg-zinc-500'
          }`}
          onMouseDown={sidebar.onResizeStart}
        />

        <div className="flex-1 flex flex-col min-w-0" ref={terminal.contentColRef}>
          {currentProject ? (
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KanbanBoard />
              </div>

              {/* Resize handle — hidden when collapsed */}
              {!terminal.collapsed && (
                <div
                  className="resize-handle h-1 bg-zinc-700 flex-shrink-0 cursor-row-resize hover:bg-zinc-500 transition-colors"
                  onMouseDown={terminal.onResizeStart}
                />
              )}

              {/* Terminal panel */}
              <div
                style={{ height: terminal.collapsed ? COLLAPSED_HEIGHT : terminal.height }}
                className={`flex-shrink-0 overflow-hidden ${
                  terminal.ready && !terminal.isResizing ? 'transition-[height] duration-200 ease-in-out' : ''
                } ${terminal.isResizing || sidebar.isResizing ? 'pointer-events-none' : ''}`}
              >
                <TerminalPanel
                  collapsed={terminal.collapsed}
                  showContent={terminal.showContent}
                  onToggleCollapse={terminal.onToggleCollapse}
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

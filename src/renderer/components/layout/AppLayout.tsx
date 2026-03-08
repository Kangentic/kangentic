import React from 'react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { KanbanBoard } from '../board/KanbanBoard';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { AppSettingsPanel } from '../settings/AppSettingsPanel';
import { ProjectSettingsPanel } from '../settings/ProjectSettingsPanel';
import { WelcomeScreen } from './WelcomeScreen';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { ToastContainer } from './ToastContainer';
import { useSidebarResize } from '../../hooks/useSidebarResize';
import { useTerminalResize, COLLAPSED_HEIGHT } from '../../hooks/useTerminalResize';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const projectSettingsOpen = useConfigStore((s) => s.projectSettingsOpen);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);

  const sidebar = useSidebarResize(config);
  const terminal = useTerminalResize(config);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <TitleBar sidebarOpen={sidebar.open} onToggleSidebar={sidebar.toggle} />

      <div className="flex flex-1 min-h-0">
        <div
          className={`flex-shrink-0 overflow-hidden border-r border-edge ${
            !sidebar.open && !sidebar.isResizing ? 'w-0 border-r-0' : ''
          } ${sidebar.ready && !sidebar.isResizing ? 'transition-[width] duration-200 ease-in-out' : ''}`}
          style={sidebar.open || sidebar.isResizing ? { width: sidebar.width } : undefined}
        >
          <ProjectSidebar onToggleSidebar={sidebar.toggle} />
        </div>

        {/* Sidebar resize handle -- wider hit target when collapsed */}
        <div
          className={`flex-shrink-0 cursor-col-resize transition-colors ${
            sidebar.open
              ? 'w-1 bg-edge hover:bg-fg-faint'
              : 'w-1.5 bg-edge/50 hover:bg-fg-faint'
          }`}
          onMouseDown={sidebar.onResizeStart}
        />

        <div className="flex-1 flex flex-col min-w-0" ref={terminal.contentColRef}>
          {currentProject ? (
            <>
              <div className="flex-1 min-h-0 overflow-hidden">
                <KanbanBoard />
              </div>

              {/* Resize handle -- hidden when collapsed */}
              {!terminal.collapsed && (
                <div
                  className="resize-handle h-1 bg-edge flex-shrink-0 cursor-row-resize hover:bg-fg-faint transition-colors"
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
          ) : projects.length === 0 ? (
            <WelcomeScreen />
          ) : (
            <div className="flex-1 flex items-center justify-center text-fg-faint">
              <div className="text-center">
                <div className="text-lg">Select a project from the sidebar</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <StatusBar />
      {settingsOpen && <AppSettingsPanel />}
      {projectSettingsOpen && <ProjectSettingsPanel />}
      <ToastContainer />
    </div>
  );
}

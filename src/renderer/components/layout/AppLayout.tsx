import React from 'react';
import { PanelLeft } from 'lucide-react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { KanbanBoard } from '../board/KanbanBoard';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { WelcomeScreen } from './WelcomeScreen';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { ToastContainer } from './ToastContainer';
import { useSidebarResize, COLLAPSED_STRIP_WIDTH } from '../../hooks/useSidebarResize';
import { useTerminalResize, COLLAPSED_HEIGHT } from '../../hooks/useTerminalResize';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);

  const sidebar = useSidebarResize(config);
  const terminal = useTerminalResize(config);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <TitleBar />

      <div className="flex flex-1 min-h-0">
        {/* Hide sidebar entirely when no projects (welcome screen is primary UI) */}
        {projects.length > 0 && (
          <>
            {/* Sidebar area -- animates between full width and collapsed strip */}
            <div
              className={`flex-shrink-0 overflow-hidden border-r border-edge relative ${
                sidebar.ready && !sidebar.isResizing ? 'transition-[width] duration-200 ease-in-out' : ''
              }`}
              style={{ width: sidebar.open ? sidebar.width : COLLAPSED_STRIP_WIDTH }}
            >
              {/* Full sidebar content -- hidden when collapsed */}
              <div
                className={`h-full ${
                  sidebar.ready ? 'transition-opacity duration-200 ease-in-out' : ''
                } ${sidebar.open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
              >
                <ProjectSidebar onToggleSidebar={sidebar.toggle} />
              </div>

              {/* Collapsed strip overlay -- visible when closed */}
              <div
                className={`absolute inset-0 bg-surface-raised flex flex-col items-center pt-3 px-1.5 ${
                  sidebar.ready ? 'transition-opacity duration-200 ease-in-out' : ''
                } ${sidebar.open ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              >
                <button
                  onClick={sidebar.toggle}
                  className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
                  title="Show sidebar"
                  data-testid="sidebar-expand-button"
                >
                  <PanelLeft size={18} />
                </button>
              </div>
            </div>

            {/* Sidebar resize handle -- click to toggle, drag to resize */}
            <div
              className="flex-shrink-0 cursor-col-resize transition-colors w-1 bg-edge hover:bg-fg-faint"
              onMouseDown={sidebar.onResizeStart}
            />
          </>
        )}

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
                onTransitionEnd={(event) => {
                  if (event.target === event.currentTarget && event.propertyName === 'height') {
                    terminal.handleTransitionEnd();
                  }
                }}
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
      {settingsOpen && <SettingsPanel />}
      <ToastContainer />
    </div>
  );
}

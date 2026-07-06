import { useCallback } from 'react';
import { TitleBar } from './TitleBar';
import { StatusBar } from './StatusBar';
import { ProjectSidebar } from '../sidebar/ProjectSidebar';
import { CollapsedRail } from '../sidebar/CollapsedRail';
import { KanbanBoard } from '../board/KanbanBoard';
import { ViewToggle } from '../board/ViewToggle';
import { BacklogView } from '../backlog/BacklogView';
import { BacklogDialogs } from '../backlog/BacklogDialogs';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { SettingsPanel } from '../settings/SettingsPanel';
import { CommandTerminalLayer, MAX_COMMAND_TERMINALS, spawnAdditionalCommandTerminal } from '../command-bar/CommandTerminalLayer';
import { commandWindowManager } from '../../window-manager';
import { SearchPalette } from '../search/SearchPalette';
import { WelcomeScreen } from './WelcomeScreen';
import { ProjectPathMissingDialog } from '../dialogs/ProjectPathMissingDialog';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { ToastContainer } from './ToastContainer';
import { WindowLayer } from '../../window-manager';
import { useSidebarResize, COLLAPSED_STRIP_WIDTH } from '../../hooks/useSidebarResize';
import { useTerminalResize, COLLAPSED_HEIGHT } from '../../hooks/useTerminalResize';
import { shouldForceCollapseTerminal } from '../../utils/terminal-force-collapse';
import { useCommandBar } from '../../hooks/useCommandBar';
import { useSearchPalette } from '../../hooks/useSearchPalette';
import { useViewToggle } from '../../hooks/useViewToggle';
import { useFocusedSessionsSync } from '../../hooks/useFocusedSessionsSync';
import { useDictation } from '../../hooks/useDictation';
import { DictationSurface } from '../dictation/DictationSurface';
import { useKeybinding } from '../../hooks/useKeybinding';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const openProjectSettings = useConfigStore((s) => s.openProjectSettings);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const hydrated = useProjectStore((s) => s.hydrated);
  const activeView = useBoardStore((s) => s.activeView);
  const requestBoardSearchFocus = useBoardStore((s) => s.requestBoardSearchFocus);

  const sidebar = useSidebarResize(config);
  // The bottom panel steps aside (collapses) while any task-detail window is open;
  // the two are mutually exclusive terminal surfaces. `pendingDetailWindowsProjectId` keeps it
  // collapsed from the first frame of a project switch when the destination project will restore
  // detail windows, so it never flashes expanded while `dialogSessionIds` is transiently empty
  // during the async workspace restore (see utils/terminal-force-collapse.ts).
  const dialogSessionIds = useSessionStore((s) => s.dialogSessionIds);
  const pendingDetailWindowsProjectId = useSessionStore((s) => s.pendingDetailWindowsProjectId);
  const detailWindowsOpen = shouldForceCollapseTerminal({
    dialogSessionIds,
    pendingDetailWindowsProjectId,
    currentProjectId: currentProject?.id ?? null,
  });
  const terminal = useTerminalResize(config, detailWindowsOpen, currentProject?.id ?? null);
  const commandBar = useCommandBar();
  // Destructured for the callback's dep list: `open` is stable, `isOpen` changes;
  // depending on the fresh `commandBar` object would rebuild the callback every render.
  const { isOpen: commandBarIsOpen, open: openCommandBar } = commandBar;
  // Live count of Command Terminal windows (the store is a module singleton that
  // outlives the layer's mount), so the "+" affordance disables at the cap.
  const commandWindowCount = commandWindowManager.store((state) => Object.keys(state.windows).length);
  // The title-bar terminal button is context-aware: open the layer when closed,
  // spawn another terminal when already open.
  const handleCommandTerminalButton = useCallback(() => {
    if (commandBarIsOpen) spawnAdditionalCommandTerminal();
    else openCommandBar();
  }, [commandBarIsOpen, openCommandBar]);
  // Plain Ctrl+F focuses the board search on the board view; otherwise it falls
  // back to the global search palette (resolved inside useSearchPalette).
  const handlePlainFindKey = useCallback(() => {
    if (activeView !== 'board') return false;
    requestBoardSearchFocus();
    return true;
  }, [activeView, requestBoardSearchFocus]);
  const searchPalette = useSearchPalette({ onPlainFindKey: handlePlainFindKey });
  useViewToggle();
  useFocusedSessionsSync();
  useDictation();

  // App-level shortcuts wired here, where the layout owns the relevant state and
  // resize controllers. Combos come from the central keybinding registry.
  // Settings toggle mirrors the title-bar gear's behavior.
  useKeybinding('settings.toggle', () => {
    if (settingsOpen) setSettingsOpen(false);
    else if (currentProject) openProjectSettings(currentProject.path, currentProject.name);
    else setSettingsOpen(true);
  });
  useKeybinding('view.toggleSidebar', () => sidebar.toggle());
  useKeybinding('view.toggleTerminalPanel', () => terminal.onToggleCollapse());
  useKeybinding('task.create', () => useBoardStore.getState().requestNewTask(), {
    enabled: activeView === 'board' && !!currentProject,
  });

  return (
    <div className="h-screen flex flex-col bg-surface">
      <TitleBar
        onQuickSession={handleCommandTerminalButton}
        onOpenSearch={searchPalette.open}
        commandBarOpen={commandBar.isOpen}
        canSpawnMore={commandWindowCount < MAX_COMMAND_TERMINALS}
      />

      <div className="flex flex-1 min-h-0">
        {/* Hide sidebar entirely when no projects (welcome screen is primary UI) */}
        {hydrated && projects.length > 0 && (
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
                className={`absolute inset-0 ${
                  sidebar.ready ? 'transition-opacity duration-200 ease-in-out' : ''
                } ${sidebar.open ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              >
                <CollapsedRail onExpandSidebar={sidebar.toggle} />
              </div>
            </div>

            {/* Sidebar resize handle - drag to resize, drag past the threshold to collapse.
                A plain click is a no-op (collapse is the PROJECTS-panel chevron only). */}
            <div
              data-testid="sidebar-resize-handle"
              className="flex-shrink-0 cursor-col-resize transition-colors w-1 bg-edge hover:bg-fg-faint"
              onMouseDown={sidebar.onResizeStart}
            />
          </>
        )}

        <div className="flex-1 flex flex-col min-w-0" ref={terminal.contentColRef}>
          {currentProject ? (
            <>
              <ViewToggle />
              {activeView === 'board' ? (
                <>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <KanbanBoard />
                  </div>

                  {/* Terminal panel -- completely hidden when disabled in Appearance settings */}
                  {config.terminalPanelVisible !== false && (
                    <>
                      {/* Resize handle -- hidden when collapsed */}
                      {!terminal.collapsed && (
                        <div
                          className="resize-handle h-1 bg-edge flex-shrink-0 cursor-row-resize hover:bg-fg-faint transition-colors"
                          onMouseDown={terminal.onResizeStart}
                        />
                      )}

                      {/* Terminal panel */}
                      <div
                        data-testid="terminal-panel-container"
                        data-collapsed={terminal.collapsed ? 'true' : 'false'}
                        style={{ height: terminal.collapsed ? COLLAPSED_HEIGHT : terminal.height }}
                        className={`flex-shrink-0 overflow-hidden ${
                          terminal.ready && !terminal.isResizing && !terminal.suppressTransition
                            ? 'transition-[height] duration-200 ease-in-out'
                            : ''
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
                  )}
                </>
              ) : (
                <>
                  <div className="flex-1 min-h-0 overflow-hidden">
                    <BacklogView />
                  </div>
                  <BacklogDialogs />
                </>
              )}
            </>
          ) : !hydrated ? (
            null /* Empty content area while project store hydrates from IPC */
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

      {config.statusBarVisible !== false && <StatusBar />}
      {settingsOpen && <SettingsPanel />}
      {commandBar.isOpen && <CommandTerminalLayer onHide={commandBar.close} />}
      {searchPalette.isOpen && <SearchPalette onClose={searchPalette.close} />}
      <ProjectPathMissingDialog />
      <ToastContainer />
      <DictationSurface />
      <WindowLayer />
    </div>
  );
}

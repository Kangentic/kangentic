import { useCallback, useEffect, useRef, useState } from 'react';
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
import { WelcomeChecklistDialog } from '../onboarding/WelcomeChecklistDialog';
import { WalkthroughLayer } from '../onboarding/WalkthroughLayer';
import { WALKTHROUGH_STEPS, resolveNextStep } from '../onboarding/walkthrough-steps';
import { useWalkthroughActivation } from '../onboarding/useWalkthroughActivation';
import { useOnboardingProgress } from '../../hooks/useOnboardingProgress';
import { ProjectPathMissingDialog } from '../dialogs/ProjectPathMissingDialog';
import { ReleaseNotesDialog } from '../dialogs/ReleaseNotesDialog';
import { WhatsNewDialog } from '../dialogs/WhatsNewDialog';
import { AnnouncementBanner } from '../announcements/AnnouncementBanner';
import { AnnouncementDialog } from '../announcements/AnnouncementDialog';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useBoardStore } from '../../stores/board-store';
import { useSessionStore } from '../../stores/session-store';
import { ToastContainer } from './ToastContainer';
import { WindowLayer, useWindowStore } from '../../window-manager';
import { useSidebarResize, COLLAPSED_STRIP_WIDTH } from '../../hooks/useSidebarResize';
import { useTerminalResize, COLLAPSED_HEIGHT } from '../../hooks/useTerminalResize';
import { shouldForceCollapseTerminal } from '../../utils/terminal-force-collapse';
import { derivePanelSessions } from '../../utils/panel-sessions';
import { useCommandBar } from '../../hooks/useCommandBar';
import { useSearchPalette } from '../../hooks/useSearchPalette';
import { useViewToggle } from '../../hooks/useViewToggle';
import { useFocusedSessionsSync } from '../../hooks/useFocusedSessionsSync';
import { useRemoteDetailOwnersSync } from '../../hooks/useRemoteDetailOwnersSync';
import { useMobileTerminalStreamsSync } from '../../hooks/useMobileTerminalStreamsSync';
import { useMonitorDetailOwnership } from '../monitor/useMonitorDetailOwnership';
import { useDictation } from '../../hooks/useDictation';
import { DictationSurface } from '../dictation/DictationSurface';
import { useKeybinding } from '../../hooks/useKeybinding';
import { StatsPage } from '../stats/StatsPage';
import { MonitorPage } from '../monitor/MonitorPage';
import { warmStatsDashboardOnIdle } from '../stats/LazyStatsDashboard';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { useMonitorStore } from '../../stores/monitor-store';
import { usePopOut } from '../../pop-out/usePopOut';
import type { OnboardingStepKey } from '../../../shared/types';

export function AppLayout() {
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const statsOpen = useUsageDashboardStore((s) => s.statsOpen);
  const statsPopOut = usePopOut('stats', {});
  const monitorOpen = useMonitorStore((s) => s.monitorOpen);
  const monitorPopOut = usePopOut('monitor', {});
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const openProjectSettings = useConfigStore((s) => s.openProjectSettings);
  const config = useConfigStore((s) => s.config);
  const currentProject = useProjectStore((s) => s.currentProject);
  const projects = useProjectStore((s) => s.projects);
  const hydrated = useProjectStore((s) => s.hydrated);
  const activeView = useBoardStore((s) => s.activeView);
  const requestBoardSearchFocus = useBoardStore((s) => s.requestBoardSearchFocus);
  const onboardingChecklistOpen = useConfigStore((s) => s.onboardingChecklistOpen);
  const setOnboardingChecklistOpen = useConfigStore((s) => s.setOnboardingChecklistOpen);
  const onboardedProjectIds = useConfigStore((s) => s.config.onboardedProjectIds);
  const walkthroughStep = useConfigStore((s) => s.walkthroughStep);
  const setWalkthroughStep = useConfigStore((s) => s.setWalkthroughStep);
  const boardManagerOpen = useBoardStore((s) => s.boardManagerOpen);
  const markProjectOnboarded = useConfigStore((s) => s.markProjectOnboarded);
  const markOnboardingStepCompleted = useConfigStore((s) => s.markOnboardingStepCompleted);
  // Every window in the board window manager is a task-detail surface, so any open window
  // means the user has opened a task. Stamped here, in the one place that already owns the
  // onboarding effects, rather than inside useOnboardingProgress - a read hook that writes
  // would fire from each of its several consumers.
  const taskDetailWindowOpen = useWindowStore((s) => Object.keys(s.windows).length > 0);
  const onboardingProgress = useOnboardingProgress();
  const { startStep } = useWalkthroughActivation();
  // The New Task dialog's open state lives in KanbanBoard, so the only signal available
  // here is the dialog itself. Polled by the effect below via its test id.
  const [newTaskDialogOpen, setNewTaskDialogOpen] = useState(false);
  useEffect(() => {
    if (!walkthroughStep) return;
    let frameId: number | undefined;
    const check = () => {
      setNewTaskDialogOpen(!!document.querySelector('[data-testid="new-task-dialog"]'));
      frameId = requestAnimationFrame(check);
    };
    frameId = requestAnimationFrame(check);
    return () => {
      if (frameId !== undefined) cancelAnimationFrame(frameId);
    };
  }, [walkthroughStep]);

  const sidebar = useSidebarResize(config);
  // The bottom panel drops a task's tab whenever its detail is open (a board window, the in-app
  // Agent Monitor, or the detached monitor), and collapses once no tab is left - see
  // `derivePanelSessions` / `shouldForceCollapseTerminal`. Derived inside ONE selector returning a
  // boolean so `Object.is` gates this root's re-render: subscribing to the session list itself
  // would re-render the whole app on every activity push.
  const currentProjectId = currentProject?.id ?? null;
  const everyTerminalDetached = useSessionStore((s) => {
    const panelSessions = derivePanelSessions({
      sessions: s.sessions,
      currentProjectId,
      dialogSessionIds: s.dialogSessionIds,
      remoteDetailTaskIds: s.remoteDetailTaskIds,
      mobileTerminalStreamedSessionIds: s.mobileTerminalStreamedSessionIds,
    });
    return shouldForceCollapseTerminal({
      activeSessionCount: panelSessions.active.length,
      visibleSessionCount: panelSessions.visible.length,
      pendingDetailWindowsProjectId: s.pendingDetailWindowsProjectId,
      currentProjectId,
    });
  });
  // Releasing that arm is a restore step, not a user action. A project whose restored
  // detail windows leave OTHER sessions behind now ends up expanded rather than
  // collapsed, so without this the panel would slide open a second or two after
  // arrival - motion on a restore path. Folding the arm into the switch key makes
  // `useTerminalResize` suppress the height transition for its settle window, so the
  // panel snaps to its steady state instead (.claude/rules/restore-no-animation-replay.md).
  const detailWindowRestorePending = useSessionStore(
    (s) => s.pendingDetailWindowsProjectId !== null && s.pendingDetailWindowsProjectId === currentProjectId,
  );
  const terminal = useTerminalResize(
    config,
    everyTerminalDetached,
    `${currentProjectId ?? 'none'}:${detailWindowRestorePending ? 'restoring' : 'settled'}`,
  );
  const commandBar = useCommandBar();
  // Destructured for the callback's dep list: `open`/`close` are stable, `isOpen` changes;
  // depending on the fresh `commandBar` object would rebuild the callback every render.
  const { isOpen: commandBarIsOpen, open: openCommandBar, close: closeCommandBar } = commandBar;
  // Live count of Command Terminal windows (the store is a module singleton that
  // outlives the layer's mount), so the title-bar "New terminal" button disables
  // at the cap without needing the layer mounted.
  const commandWindowCount = commandWindowManager.store((state) => Object.keys(state.windows).length);
  // The title-bar terminal button is a plain open/close toggle, so there is always
  // a discoverable one-click way to hide the layer even when a window is maximized
  // over the backdrop. "Spawn another terminal" is a separate, adjacent title-bar
  // button (only rendered while the layer is open) so the two actions are never
  // overloaded onto one control again.
  const handleCommandTerminalButton = useCallback(() => {
    if (commandBarIsOpen) closeCommandBar();
    else openCommandBar();
  }, [commandBarIsOpen, openCommandBar, closeCommandBar]);
  // Plain Ctrl+F focuses the board search on the board view; otherwise it falls
  // back to the global search palette (resolved inside useSearchPalette).
  const handlePlainFindKey = useCallback(() => {
    if (activeView !== 'board') return false;
    requestBoardSearchFocus();
    return true;
  }, [activeView, requestBoardSearchFocus]);
  const searchPalette = useSearchPalette({ onPlainFindKey: handlePlainFindKey });
  useViewToggle();
  // `terminal.showContent` is what actually gates whether TerminalPanel mounts a
  // TerminalTab, so it is the honest answer to "is there an xterm to receive bytes".
  useFocusedSessionsSync(terminal.showContent);
  useRemoteDetailOwnersSync();
  useMobileTerminalStreamsSync();
  // The monitor's ownership half, mounted here rather than in `MonitorDetailLayer`
  // because that layer unmounts whenever the monitor is closed or detached while its
  // window store survives - see `useMonitorDetailOwnership`.
  useMonitorDetailOwnership();
  useDictation();

  // Idle-warm the lazy stats chunk (recharts) once per session, off the
  // startup path: the first stats open then resolves from the module cache
  // with no skeleton, without recharts parse/eval competing with the initial
  // board load and session sync. AppLayout mounts only in the main window;
  // StrictMode's double-invoke is harmless (module-scope once-guard).
  useEffect(() => {
    warmStatsDashboardOnIdle();
  }, []);

  // Strict mutual exclusivity: the usage stats overlay and its pop-out window
  // never coexist. When the pop-out opens, close the in-app overlay so reopening
  // it (title bar / keybinding) later starts from a clean closed state; the
  // render guard below is belt-and-suspenders against the one-frame race before
  // this effect runs.
  useEffect(() => {
    if (statsPopOut.isOpen) useUsageDashboardStore.getState().close();
  }, [statsPopOut.isOpen]);

  // Same contract for the agent monitor's pop-out.
  useEffect(() => {
    if (monitorPopOut.isOpen) useMonitorStore.getState().close();
  }, [monitorPopOut.isOpen]);

  // The monitor and the stats dashboard are both full-bleed overlays sharing one
  // z-slot, so they are mutually exclusive with EACH OTHER as well: opening one
  // closes the other rather than stacking two full-screen surfaces.
  useEffect(() => {
    if (monitorOpen) useUsageDashboardStore.getState().close();
  }, [monitorOpen]);

  // ...and with the Command Terminal layer, which sits ABOVE both of them in the
  // ladder (45 vs 42). Without this the monitor opens UNDERNEATH the terminal and
  // its backdrop: the surface is there but covered, and its rows are unclickable,
  // which reads as the Command Terminal refusing to go away. Hiding keeps every
  // Command Terminal PTY alive, so reopening the layer reattaches them.
  useEffect(() => {
    if (monitorOpen) useSessionStore.getState().requestHideCommandBar();
  }, [monitorOpen]);
  useEffect(() => {
    if (statsOpen) useMonitorStore.getState().close();
  }, [statsOpen]);

  // App-level shortcuts wired here, where the layout owns the relevant state and
  // resize controllers. Combos come from the central keybinding registry.
  // Settings toggle mirrors the title-bar gear's behavior.
  useKeybinding('settings.toggle', () => {
    if (settingsOpen) setSettingsOpen(false);
    else if (currentProject) openProjectSettings(currentProject.path, currentProject.name);
    else setSettingsOpen(true);
  });
  useKeybinding('stats.toggle', () => (statsPopOut.isOpen ? statsPopOut.focus() : useUsageDashboardStore.getState().toggle()));
  useKeybinding('monitor.toggle', () => (monitorPopOut.isOpen ? monitorPopOut.focus() : useMonitorStore.getState().toggle()));
  useKeybinding('view.toggleSidebar', () => sidebar.toggle());
  useKeybinding('view.toggleTerminalPanel', () => terminal.onToggleCollapse());
  useKeybinding('task.create', () => useBoardStore.getState().requestNewTask(), {
    enabled: activeView === 'board' && !!currentProject,
  });

  // Bring the checklist back once the user is done with the surface a step sent them to.
  //
  // Without this the flow simply ends: you click "Choose your defaults", change what you
  // want, close Settings - and nothing brings you back, so there is no next step. Worse,
  // dismissing the New Task dialog by clicking outside it used to leave a dimmed board
  // with a ring and no way forward. The checklist returning IS the "next" affordance: it
  // reappears with that step ticked and the following one obvious.
  //
  // Only fires for a step that actually opened something, and only after that something
  // has been open and then closed - so it can never reopen on top of the surface it just
  // sent the user to.
  const returnStepRef = useRef<OnboardingStepKey | null>(null);
  const surfaceWasOpenRef = useRef(false);
  useEffect(() => {
    if (!walkthroughStep) {
      returnStepRef.current = null;
      surfaceWasOpenRef.current = false;
      return;
    }
    // Reset the memory on EVERY step change, not just on exit. "Next step" goes straight from
    // one step to the next, and between closing the old surface and the new one mounting there
    // is a frame where nothing is open - carrying the previous step's "a surface was open"
    // across that gap made the checklist pop up mid-advance.
    if (returnStepRef.current !== walkthroughStep) surfaceWasOpenRef.current = false;
    returnStepRef.current = walkthroughStep;
  }, [walkthroughStep]);

  const activeStepDone = walkthroughStep ? onboardingProgress[walkthroughStep] : false;
  useEffect(() => {
    const step = returnStepRef.current;
    if (!step || onboardingChecklistOpen) return;

    // The surface THIS step sent the user to, and only that. Counting any open surface armed
    // the return on a leftover one: advancing from the create-a-task step to the drag step
    // closes the New Task dialog, and since that dialog is detected by polling, the step that
    // opens nothing saw it as briefly open and then closed - and bounced back to the checklist
    // mid-advance. The task-detail window is likewise scoped to the step that asks for it, so
    // a window left open from earlier work does not block the return on every other step.
    const stepOpensDialog = WALKTHROUGH_STEPS.some(
      (candidate) => candidate.key === step && candidate.opensDialog,
    );
    const surfaceOpen = (stepOpensDialog && (settingsOpen || boardManagerOpen || newTaskDialogOpen))
      || (step === 'taskDetailOpened' && taskDetailWindowOpen);

    // DONE: carry straight on to the next step, exactly as the callout's Next button does.
    // Doing the real thing is the strongest possible signal that the user is following the
    // flow, so dropping them back on the list to find their own place in it is the last thing
    // to do with it - creating a task used to land here, and step 4 then had to be clicked by
    // hand. Not while the step's surface is still up, though: changing one default ticks
    // step 1 instantly, and moving them on out of a Settings panel they are still working in
    // would be worse than not moving them at all.
    if (activeStepDone && !surfaceOpen) {
      surfaceWasOpenRef.current = false;
      returnStepRef.current = null;
      const next = resolveNextStep(onboardingProgress, step);
      if (next) {
        startStep(next);
        return;
      }
      // Nothing left. Same as Finish: clear up and get out of the way rather than putting a
      // completed list on screen to be dismissed.
      setWalkthroughStep(null);
      return;
    }

    // BACKED OUT: closed the surface without doing the thing. That is not a completion, so
    // the checklist comes back rather than pushing them forward.
    if (surfaceOpen) {
      surfaceWasOpenRef.current = true;
      return;
    }
    if (!surfaceWasOpenRef.current) return;
    surfaceWasOpenRef.current = false;
    returnStepRef.current = null;
    setWalkthroughStep(null);
    setOnboardingChecklistOpen(true);
  }, [
    walkthroughStep, activeStepDone, settingsOpen, boardManagerOpen, newTaskDialogOpen,
    taskDetailWindowOpen, onboardingChecklistOpen, setOnboardingChecklistOpen, setWalkthroughStep,
    onboardingProgress, startStep,
  ]);

  // Stamp "this project has had a task detail open", the sticky signal step 5 reads. Live
  // window state would un-tick the step the moment the window closed.
  //
  // Only a false -> true transition observed under the SAME project counts. A project switch
  // tears the outgoing project's windows down asynchronously, so for a frame `currentProject`
  // is already the destination while the window count still reflects the project we left -
  // stamping there would tick step 5 for a project nobody has opened anything in, and since
  // finishing all five retires onboarding, it could retire it outright. The cost is that a
  // project whose detail windows RESTORE on arrival is not stamped by the restore alone,
  // which errs the safe way: the tick returns the moment the user opens a task there.
  const detailWindowWatchRef = useRef<{ projectId: string | null; open: boolean }>({ projectId: null, open: false });
  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    const previous = detailWindowWatchRef.current;
    detailWindowWatchRef.current = { projectId, open: taskDetailWindowOpen };
    if (previous.projectId !== projectId) return;
    if (previous.open || !taskDetailWindowOpen || !projectId) return;
    markOnboardingStepCompleted(projectId, 'taskDetailOpened');
  }, [taskDetailWindowOpen, currentProject, markOnboardingStepCompleted]);

  // Finishing all five retires onboarding for this project. Only an explicit dismissal
  // writes `onboardedProjectIds` otherwise, so a user who completed the whole flow and
  // simply carried on working would be met by the checklist again on the next launch.
  useEffect(() => {
    if (onboardingProgress.complete && currentProject) markProjectOnboarded(currentProject.id);
  }, [onboardingProgress.complete, currentProject, markProjectOnboarded]);

  // Show the onboarding checklist on the genuine first run of this INSTALL.
  //
  // Precisely: while `onboardedProjectIds` is empty, at most once per project per session.
  // "Once per install" is the intent rather than a hard invariant - a user who opens the
  // checklist, clicks a step (which does NOT dismiss) and then adds a second project is still
  // inside their first run and gets it there too. It stops for good once the list is non-empty.
  //
  // The walkthrough teaches the app, not a repo - every step ("Create a task", "Drag it to
  // Planning", "Open the task") is app-generic - so the auto-open decision is install-scoped.
  // It used to be keyed on `onboardedProjectIds.includes(...)`, which meant a newly added
  // project, having a brand-new id, was by definition un-dismissed: adding a 17th project to
  // an established install replayed the whole walkthrough.
  //
  // Emptiness of that same list is the install-scoped signal, and it is non-empty by exactly
  // three routes, all of which mean "not a first run": App.tsx's one-time backfill finding at
  // least one project the user already had, a real dismissal, or all five steps completed.
  // The per-project `includes` check is gone rather than kept alongside this - it is strictly
  // subsumed (a member implies a non-empty list), so leaving it would be dead code inviting a
  // future reader to restore per-project scoping.
  //
  // Two guards remain, each load-bearing. `onboardedProjectIds === undefined` means the
  // backfill has not run yet, and opening before it does would flash the checklist at existing
  // users on projects they have used for months; it also covers cold start, where the backfill
  // waits on `loadConfig()` and `loadProjects()` together (App.tsx) while `loadCurrent()` races
  // ahead un-awaited, so `currentProject` can land first. The session-scoped ref covers the
  // other direction: clicking a step closes the dialog WITHOUT marking the project onboarded
  // (the user is engaging, not dismissing), so without it this effect would immediately reopen
  // the dialog over the screen it just sent them to. It stays keyed by project id rather than
  // collapsing to a plain boolean because the empty-list window is not necessarily one project
  // long: while the list is still empty, arriving at a DIFFERENT project earns its own single
  // auto-open, and a boolean would swallow it.
  //
  // Only config-backed, monotonic values belong here: the ref is a one-way latch, so a single
  // frame reading a stale value latches irreversibly. `projects.length` is NOT such a value
  // (App.tsx's --cwd auto-open sets `currentProject` before its `loadProjects()` resolves).
  //
  // Accepted trade-off: this forecloses a per-project "reset onboarding" (removing one id from
  // a list that still holds others reads as retired). That is coherent with onboarding being
  // install-scoped, and the dev-only title-bar button already reopens the checklist by hand.
  const autoOpenedProjectIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!currentProject || onboardedProjectIds === undefined) return;
    if (onboardedProjectIds.length > 0) return;
    if (autoOpenedProjectIdsRef.current.has(currentProject.id)) return;
    autoOpenedProjectIdsRef.current.add(currentProject.id);
    setOnboardingChecklistOpen(true);
  }, [currentProject, onboardedProjectIds, setOnboardingChecklistOpen]);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <TitleBar
        onQuickSession={handleCommandTerminalButton}
        onOpenSearch={searchPalette.open}
        commandBarOpen={commandBar.isOpen}
        onSpawnAdditionalTerminal={spawnAdditionalCommandTerminal}
        canSpawnMoreTerminals={commandWindowCount < MAX_COMMAND_TERMINALS}
      />

      {/* `data-dismiss-layer`: the board layer owns this whole subtree, so a clean click on
          any dead space in it light-dismisses an open task window (see
          `useClickOutsideToClose.ts`). The marker declares OWNERSHIP, not dismissibility -
          it answers whose window closes, not whether one closes. Placing it here rather
          than on the root above is what keeps the overlay block below (settings, stats,
          search palette, command terminal, walkthrough, toasts, dictation, dialogs) OUT of
          the dismiss surface: those mount as siblings, resolve to no scope, and are inert
          on arrival. Do not hoist it to the root, and mount new overlays as siblings.
          A clickable child added inside here must carry `cursor-pointer` (or
          `data-no-dismiss` if it shows some other action cursor), or a click on it will
          dismiss instead of acting - and its hover state would then be a lie. */}
      <div className="flex flex-1 min-h-0" data-dismiss-layer="board">
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
                A plain click is a no-op (collapse is the PROJECTS-panel chevron only).
                `data-no-dismiss`: it shows `cursor-col-resize` and lights up on hover, so
                it reads as interactive - and it is, as a drag target. Without the marker a
                click would light-dismiss a task window instead, making that hover state a
                promise the click does not keep. Its cursor is not `pointer`, so the cursor
                check in `useClickOutsideToClose.ts` cannot exclude it. */}
            <div
              data-testid="sidebar-resize-handle"
              className="flex-shrink-0 cursor-col-resize transition-colors w-1 bg-edge hover:bg-fg-faint"
              onMouseDown={sidebar.onResizeStart}
              data-no-dismiss
            />
          </>
        )}

        <div className="flex-1 flex flex-col min-w-0" ref={terminal.contentColRef}>
          <AnnouncementBanner />
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
                      {/* Resize handle - hidden when collapsed.
                          `data-no-dismiss` for the same reason as the sidebar handle above:
                          a drag target whose cursor is not `pointer`, which also lights up
                          on hover (twice over - `hover:bg-fg-faint` here plus
                          `.resize-handle:hover` in index.css). */}
                      {!terminal.collapsed && (
                        <div
                          data-testid="terminal-resize-handle"
                          className="resize-handle h-1 bg-edge flex-shrink-0 cursor-row-resize hover:bg-fg-faint transition-colors"
                          onMouseDown={terminal.onResizeStart}
                          data-no-dismiss
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
      {statsOpen && !statsPopOut.isOpen && <StatsPage />}
      {monitorOpen && !monitorPopOut.isOpen && <MonitorPage />}
      {settingsOpen && <SettingsPanel />}
      {commandBar.isOpen && <CommandTerminalLayer onHide={commandBar.close} />}
      {searchPalette.isOpen && <SearchPalette onClose={searchPalette.close} />}
      <ProjectPathMissingDialog />
      <ReleaseNotesDialog />
      <WhatsNewDialog />
      <AnnouncementDialog />
      {onboardingChecklistOpen && <WelcomeChecklistDialog />}
      <WalkthroughLayer />
      <ToastContainer />
      <DictationSurface />
      <WindowLayer />
    </div>
  );
}

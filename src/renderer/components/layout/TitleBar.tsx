import React from 'react';
import { ChartColumn, CloudDownload, Command, Compass, Minus, Settings, Square, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useUpdaterStore } from '../../stores/updater-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { warmStatsDashboard } from '../stats/LazyStatsDashboard';
import { usePopOut } from '../../pop-out/usePopOut';
import { selectCommandTerminalSummary } from '../../stores/session-store/transient-session-slice';
import { CommandTerminalIcon } from '../command-bar/CommandTerminalIcon';
import { isWorktreePath } from '../../../shared/git-utils';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import { BrandMark } from '../BrandMark';

const isMac = window.electronAPI.platform === 'darwin';

interface TitleBarProps {
  /** Toggles the Command Terminal layer: opens it when closed, hides it when open. */
  onQuickSession?: () => void;
  onOpenSearch?: () => void;
  commandBarOpen?: boolean;
  /** Spawns another Command Terminal (up to the cap). Only called while the
   *  layer is open; the button that triggers it renders only then. */
  onSpawnAdditionalTerminal?: () => void;
  /** Whether another Command Terminal can be opened (below the cap). Disables
   *  the "New terminal" button without unmounting it. */
  canSpawnMoreTerminals?: boolean;
}

export function TitleBar({
  onQuickSession,
  onOpenSearch,
  commandBarOpen,
  onSpawnAdditionalTerminal,
  canSpawnMoreTerminals,
}: TitleBarProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const onboardingChecklistOpen = useConfigStore((s) => s.onboardingChecklistOpen);
  const setOnboardingChecklistOpen = useConfigStore((s) => s.setOnboardingChecklistOpen);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const openProjectSettings = useConfigStore((s) => s.openProjectSettings);

  const pendingUpdate = useUpdaterStore((s) => s.pendingUpdate);
  const openUpdateModal = useUpdaterStore((s) => s.openModal);

  // Aggregate activity across THIS project's Command Terminal sessions, surfaced
  // as the title-bar terminal icon's COLOR (the same active/idle language as the
  // task-detail / per-terminal controls, no separate dot). The shared selector is
  // the same one each project sidebar row uses, so the title bar and the sidebar
  // can never disagree about a project's terminal activity. Selecting the tone
  // string (not the summary object) keeps Zustand's default Object.is equality.
  const transientActivityTone = useSessionStore(
    (state) => selectCommandTerminalSummary(state.sessions, state.sessionActivity, currentProject?.id ?? null).tone,
  );

  // Tooltips read the live effective combo so they update when the user rebinds.
  const quickFindCombo = useFormattedCombo('search.togglePalette');
  const commandTerminalCombo = useFormattedCombo('commandBar.toggle');
  const settingsCombo = useFormattedCombo('settings.toggle');
  const statsCombo = useFormattedCombo('stats.toggle');

  // Store-direct like the Settings gear (statsOpen is dashboard-store state).
  const statsOpen = useUsageDashboardStore((state) => state.statsOpen);
  const toggleStats = useUsageDashboardStore((state) => state.toggle);
  const prefetchStats = useUsageDashboardStore((state) => state.prefetch);
  // Hover intent warms BOTH halves of a stats open: the payload cache (store
  // prefetch, 5s-throttled) and the lazy recharts chunk (once-guarded), so a
  // click that follows the hover opens with data and no skeleton.
  const handleStatsHover = () => {
    prefetchStats();
    warmStatsDashboard();
  };
  // When the stats dashboard is detached into its own window, this button
  // focuses that window instead of toggling the (suppressed) in-app overlay.
  const statsPopOut = usePopOut('stats', {});

  const isWorktree = currentProject?.path ? isWorktreePath(currentProject.path) : false;

  const handleGearClick = () => {
    if (settingsOpen) {
      setSettingsOpen(false);
    } else if (currentProject) {
      openProjectSettings(currentProject.path, currentProject.name);
    } else {
      setSettingsOpen(true);
    }
  };

  return (
    // The title bar is intentionally NOT a `data-dismiss-surface`: it is the OS
    // window-drag region (`-webkit-app-region: drag`), so the OS swallows clicks here
    // to move the window before the renderer ever sees them. A click cannot dismiss.
    <div className={`relative h-10 bg-surface border-b border-edge flex items-center select-none flex-shrink-0 ${isMac ? 'pl-20 pr-3' : 'px-3'}`}
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Branding -- logo + app name */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <BrandMark className="w-5 h-5 text-fg-secondary" />
        <span className="text-sm font-semibold text-fg-secondary">Kangentic</span>
        {/*
          Dev-only (preview): the original task's title after the wordmark, in a muted
          pill (raised surface + edge border) so it stands out without the low-contrast
          of a colored fill, so each preview window is identifiable when several are open
          ("Project N" still tells the two clones apart). Shown in full (no truncation,
          by request). Surface/edge/fg tokens re-color across all themes. Built out of
          prod by __KANGENTIC_DEV__; previewTaskTitle is non-null only in `/preview`, so
          its truthiness gates the render.
        */}
        {__KANGENTIC_DEV__ && window.electronAPI.dev?.previewTaskTitle && (
          <span
            className="ml-1 px-2.5 py-0.5 rounded-full bg-surface-raised border border-edge text-fg-secondary text-sm font-semibold whitespace-nowrap"
            title={window.electronAPI.dev.previewTaskTitle}
          >
            {window.electronAPI.dev.previewTaskTitle}
          </span>
        )}
      </div>

      {/* Centered project name */}
      {currentProject && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="max-w-[50%] flex items-center gap-2">
            <span className="text-base font-semibold text-fg truncate">
              {currentProject.name}
            </span>
            {isWorktree && (
              <span className="text-xs text-amber-500/70 flex-shrink-0">(worktree)</span>
            )}
          </div>
        </div>
      )}

      {/* Spacer to push right-aligned controls to the edge */}
      <div className="flex-1" />

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Update-available indicator: LEFT-MOST of all conditionally-mounted
            controls in this row, for the same reason "New terminal" is (see
            the comment on that pair below) - this row is right-anchored, so
            an element's on-screen position is fixed by what comes AFTER it.
            Placing this first means it appearing/disappearing (when an
            update lands / is installed) never shifts the "New terminal" /
            Command Terminal pair or anything to their right. */}
        {pendingUpdate && (
          <button
            onClick={openUpdateModal}
            className="p-1.5 hover:bg-surface-hover rounded text-attention transition-colors"
            title={`Version ${pendingUpdate.version} is ready to install`}
            aria-label="Update available"
            data-testid="update-available-button"
          >
            <CloudDownload size={20} />
          </button>
        )}
        {/* "New terminal" + the Command Terminal toggle are the LEFT-MOST icons
            in this row on purpose: this row is right-anchored (the flex-1
            spacer eats the space to its left), so an element's on-screen
            position is fixed by whatever comes AFTER it, not before it. Keeping
            this pair first means the conditional "New terminal" button
            mounting/unmounting as the layer opens/closes never shifts Quick
            Find / stats / settings / the window controls - only this
            pair's own position moves. "New terminal" sits to the LEFT of the
            toggle (reads outward from the toggle as the layer gains a spawn
            affordance) and reuses the same terminal glyph with the center `+`
            variant, rather than a bare plus icon, so it still reads as "add a
            Command Terminal" and not a generic add action. */}
        {currentProject && commandBarOpen && onSpawnAdditionalTerminal && (
          <>
            <button
              onClick={onSpawnAdditionalTerminal}
              disabled={!canSpawnMoreTerminals}
              className="relative p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted disabled:cursor-not-allowed"
              title={canSpawnMoreTerminals ? 'New Command Terminal' : 'Command Terminal limit reached'}
              aria-label="New Command Terminal"
              data-testid="quick-session-new-terminal"
            >
              {/* Uncolored/unanimated on purpose: the activity glyph communicates
                  "an existing terminal needs you", which doesn't apply to a fresh
                  terminal that doesn't exist yet. Only the toggle button carries
                  the aggregate activity tone. */}
              <CommandTerminalIcon tone="rest" showPlus testId="quick-session-new-terminal-icon" />
            </button>
            {/* Separates the transient "New terminal" action from the permanent
                icon cluster to its right (mounts/unmounts together with the
                button above, so it never leaves an orphan divider). */}
            <div className="w-px h-4 bg-edge mx-1" data-testid="quick-session-new-terminal-divider" />
          </>
        )}
        {currentProject && onQuickSession && (
          <button
            onClick={onQuickSession}
            className="relative p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
            title={commandBarOpen ? 'Hide Command Terminal' : `Command Terminal (${commandTerminalCombo})`}
            aria-label={commandBarOpen ? 'Hide Command Terminal' : 'Command Terminal'}
            data-testid="quick-session-button"
          >
            {/* The activity color lives IN the glyph (stroke color = aggregate
                activity), so there is no separate corner badge to clash or clutter. */}
            <CommandTerminalIcon tone={transientActivityTone} />
          </button>
        )}
        {onOpenSearch && (
          <button
            onClick={onOpenSearch}
            className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
            title={`Quick Find (${quickFindCombo})`}
            aria-label="Quick Find"
            // testid kept as "open-search" for selector stability; UI label is "Quick Find"
            data-testid="open-search-button"
          >
            <Command size={20} />
          </button>
        )}
        <button
          onClick={() => (statsPopOut.isOpen ? statsPopOut.focus() : toggleStats())}
          onMouseEnter={handleStatsHover}
          className={`p-1.5 hover:bg-surface-hover rounded transition-colors ${
            statsOpen || statsPopOut.isOpen ? 'text-fg bg-surface-hover' : 'text-fg-muted hover:text-fg'
          }`}
          title={statsPopOut.isOpen ? 'Focus usage stats window' : `Usage Stats (${statsCombo})`}
          aria-label="Usage Stats"
          data-testid="usage-stats-button"
        >
          <ChartColumn size={20} />
        </button>
        {/* Dev only, and deliberately so. Onboarding is a first-run experience: it shows once
            per project and then retires itself, and a permanent re-entry button in the title
            bar of a shipped app is clutter for a thing the user has already done (or already
            chose to skip). Anyone who wants it again has the docs. It stays in dev builds
            because re-running the flow is exactly what preview testing needs.

            Build-time gate per dev-tooling-build-exclusion.md: esbuild drops the whole block
            in production, so this is not a hidden button, it is an absent one. Disabled rather
            than unmounted without a project - this row is right-anchored, so a button that
            mounts and unmounts shifts everything after it (the gear, the OS controls). */}
        {__KANGENTIC_DEV__ && (
          <button
            onClick={() => currentProject && setOnboardingChecklistOpen(true)}
            disabled={!currentProject}
            className={`p-1.5 rounded transition-colors ${
              onboardingChecklistOpen ? 'text-fg bg-surface-hover' : 'text-fg-muted'
            } ${currentProject ? 'hover:bg-surface-hover hover:text-fg cursor-pointer' : 'opacity-40'}`}
            title="Get started (dev only)"
            aria-label="Get started"
            data-testid="get-started-button"
          >
            <Compass size={20} />
          </button>
        )}
        <button
          onClick={handleGearClick}
          className={`p-1.5 hover:bg-surface-hover rounded transition-colors ${
            settingsOpen ? 'text-fg bg-surface-hover' : 'text-fg-muted hover:text-fg'
          }`}
          title={`Settings (${settingsCombo})`}
          data-testid="settings-button"
        >
          <Settings size={20} />
        </button>
        {!isMac && (
          <>
            <div className="w-px h-4 bg-edge mx-1" />
            <button
              onClick={() => window.electronAPI.window.minimize()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Minimize"
            >
              <Minus size={16} />
            </button>
            <button
              onClick={() => window.electronAPI.window.maximize()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Maximize"
            >
              <Square size={14} />
            </button>
            <button
              onClick={() => window.electronAPI.window.close()}
              className="p-1.5 hover:bg-red-600 rounded text-fg-muted hover:text-white transition-colors"
              title="Close"
            >
              <X size={16} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

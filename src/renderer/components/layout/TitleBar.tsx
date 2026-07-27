import React from 'react';
import { ChartColumn, CloudDownload, Command, Compass, Mic, Minus, Settings, Square, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useDictationStore } from '../../stores/dictation-store';
import { useSessionStore } from '../../stores/session-store';
import { useUpdaterStore } from '../../stores/updater-store';
import { useUsageDashboardStore } from '../../stores/usage-dashboard-store';
import { warmStatsDashboard } from '../stats/LazyStatsDashboard';
import { usePopOut } from '../../pop-out/usePopOut';
import { selectCurrentProjectTransientSessionIds } from '../../stores/session-store/transient-session-slice';
import { isWorktreePath } from '../../../shared/git-utils';
import { requiresUserInteraction, isActive } from '../../../shared/activity-state';
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

/**
 * The title-bar Command Terminal glyph: a custom terminal icon whose state lives
 * IN the glyph rather than in a separate corner badge. The stroke color is the
 * aggregate activity of the project's terminals (green while working / warm amber
 * when one needs you / muted rest, via the --kng-active / --kng-attention tokens),
 * and the working border MARCHES (a dash flows around the perimeter). The center
 * morphs from the shell prompt to a `+` when rendered for the "New terminal"
 * button, so that button reads as a terminal glyph (not a bare plus). 24 viewBox
 * at strokeWidth 2 to match the neighbouring lucide icons.
 */
function CommandTerminalIcon({
  tone,
  showPlus = false,
  testId = 'quick-session-icon',
}: {
  tone: 'rest' | 'thinking' | 'idle';
  showPlus?: boolean;
  testId?: string;
}): React.ReactNode {
  // `tone` is a derived PRESENTATIONAL union (rest | thinking | idle); the idle-vs-active
  // bucketing already happened upstream via isActive / requiresUserInteraction when this
  // tone was computed, so these are per-tone affordances, not a hand-rolled ActivityState bucket.
  const isWorking = tone === 'thinking'; // activity-state-ok: presentational tone, not an ActivityState
  const needsAttention = tone === 'idle'; // activity-state-ok: presentational tone, not an ActivityState
  const colorClass = isWorking ? 'text-active' : needsAttention ? 'text-attention' : '';
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={colorClass}
      data-testid={testId}
      data-activity={tone}
      data-plus={showPlus ? 'true' : 'false'}
      aria-hidden="true"
    >
      {/* Terminal screen border. While an agent works it marches (a dash flows
          around the perimeter); pathLength normalizes the dash math to 100. */}
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="3"
        pathLength={100}
        strokeDasharray={isWorking ? '65 35' : undefined}
        className={isWorking ? 'animate-march-border' : undefined}
      />
      {showPlus ? (
        // The add affordance, centered in the terminal (replaces the prompt).
        <>
          <path d="M12 8.5 V15.5" />
          <path d="M8.5 12 H15.5" />
        </>
      ) : (
        // The shell prompt: chevron + caret line.
        <>
          <path d="M7.5 9.5 L10.5 12 L7.5 14.5" />
          <path d="M12.5 14.5 H16.5" />
        </>
      )}
    </svg>
  );
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
  const openSettingsToTab = useConfigStore((s) => s.openSettingsToTab);

  const pendingUpdate = useUpdaterStore((s) => s.pendingUpdate);
  const openUpdateModal = useUpdaterStore((s) => s.openModal);

  // Voice dictation mic button: shown only when dictation is enabled; its color
  // reflects whether a push-to-talk session is live (active token), matching the
  // command-terminal glyph's activity language.
  const dictationEnabled = useConfigStore((s) => s.globalConfig.dictation?.enabled ?? false);
  const dictationStatus = useDictationStore((s) => s.status);
  const dictationActive = dictationStatus === 'recording' || dictationStatus === 'finalizing';

  // Aggregate activity across THIS project's Command Terminal sessions, surfaced
  // as the title-bar terminal icon's COLOR (the same active/idle language as the
  // task-detail / per-terminal controls, no separate dot). WORKING (active) wins:
  // if any terminal is active the icon is active-green, else attention-amber if any needs you,
  // else rest. Classified only via the shared helpers (activity-state rule).
  const transientActivityTone = useSessionStore((state) => {
    const ids = selectCurrentProjectTransientSessionIds(state.transientSessions, currentProject?.id ?? null);
    let anyIdle = false;
    for (const sessionId of ids) {
      const activity = state.sessionActivity[sessionId];
      if (isActive(activity)) return 'thinking';
      if (requiresUserInteraction(activity)) anyIdle = true;
    }
    return anyIdle ? 'idle' : 'rest';
  });

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

  // Push-to-talk is the primary trigger; clicking the mic opens settings directly
  // to the Dictation tab (works with or without a project, since it is global).
  const handleMicClick = () => {
    if (currentProject) {
      openProjectSettings(currentProject.path, currentProject.name, 'dictation');
    } else {
      openSettingsToTab('dictation');
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
            Find / mic / stats / settings / the window controls - only this
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
        {dictationEnabled && (
          <button
            onClick={handleMicClick}
            className={`p-1.5 hover:bg-surface-hover rounded transition-colors ${
              dictationActive ? 'text-active' : 'text-fg-muted hover:text-fg'
            }`}
            title={dictationActive ? 'Listening...' : 'Voice dictation'}
            aria-label={dictationActive ? 'Listening' : 'Voice dictation'}
            data-testid="dictation-mic-button"
          >
            <Mic size={20} />
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

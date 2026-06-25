import React from 'react';
import { Command, Minus, Settings, Square, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { selectCurrentProjectTransientSessionIds } from '../../stores/session-store/transient-session-slice';
import { isWorktreePath } from '../../../shared/git-utils';
import { requiresUserInteraction, isActive } from '../../../shared/activity-state';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import logoSrc from '../../assets/logo-32.png';

const isMac = window.electronAPI.platform === 'darwin';

interface TitleBarProps {
  /** Context-aware: opens the Command Terminal layer when closed, or spawns
   *  another terminal when already open. */
  onQuickSession?: () => void;
  onOpenSearch?: () => void;
  commandBarOpen?: boolean;
  /** Whether another Command Terminal can be opened (below the cap). Drives the
   *  `+` affordance shown while the layer is open. */
  canSpawnMore?: boolean;
}

/**
 * The title-bar Command Terminal glyph: a custom terminal icon whose state lives
 * IN the glyph rather than in a separate corner badge. The stroke color is the
 * aggregate activity of the project's terminals (green while working / warm amber
 * when one needs you / muted rest, via the --kng-active / --kng-attention tokens),
 * and the working border MARCHES (a dash flows around the
 * perimeter). The center morphs from the shell prompt to a `+` when the layer is
 * open and another terminal can be spawned, so the add affordance reads as part of
 * the icon (no clashing blue corner dot). 24 viewBox at strokeWidth 2 to match the
 * neighbouring lucide icons.
 */
function CommandTerminalIcon({
  tone,
  showPlus,
}: {
  tone: 'rest' | 'thinking' | 'idle';
  showPlus: boolean;
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
      data-testid="quick-session-icon"
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

export function TitleBar({ onQuickSession, onOpenSearch, commandBarOpen, canSpawnMore }: TitleBarProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const openProjectSettings = useConfigStore((s) => s.openProjectSettings);

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

  // While the layer is open and below the cap, the button spawns ANOTHER terminal.
  const spawnsAnother = !!commandBarOpen && !!canSpawnMore;

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
        <img src={logoSrc} alt="Kangentic" className="w-5 h-5" />
        <span className="text-sm font-semibold text-fg-secondary">Kangentic</span>
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
        {currentProject && onQuickSession && (
          <button
            onClick={onQuickSession}
            className="relative p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
            title={spawnsAnother ? 'New command terminal' : `Command Terminal (${commandTerminalCombo})`}
            aria-label={spawnsAnother ? 'New command terminal' : 'Command Terminal'}
            data-testid="quick-session-button"
          >
            {/* The activity color and the `+` add affordance both live IN the
                glyph (color = activity, center = `+` when another can be spawned),
                so there is no separate corner badge to clash or clutter. */}
            <CommandTerminalIcon tone={transientActivityTone} showPlus={spawnsAnother} />
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

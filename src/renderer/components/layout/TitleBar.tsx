import React from 'react';
import { Command, Minus, Settings, Square, TerminalSquare, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { isWorktreePath } from '../../../shared/git-utils';
import { requiresUserInteraction } from '../../../shared/activity-state';
import { useFormattedCombo } from '../../hooks/useKeybinding';
import logoSrc from '../../assets/logo-32.png';

const isMac = window.electronAPI.platform === 'darwin';

interface TitleBarProps {
  onQuickSession?: () => void;
  onOpenSearch?: () => void;
  commandBarOpen?: boolean;
}

export function TitleBar({ onQuickSession, onOpenSearch, commandBarOpen }: TitleBarProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const openProjectSettings = useConfigStore((s) => s.openProjectSettings);
  const transientSessionId = useSessionStore((s) => s.transientSessionId);
  const transientActivity = useSessionStore((s) =>
    s.transientSessionId ? s.sessionActivity[s.transientSessionId] : undefined,
  );
  // Tooltips read the live effective combo so they update when the user rebinds.
  const quickFindCombo = useFormattedCombo('search.togglePalette');
  const commandTerminalCombo = useFormattedCombo('commandBar.toggle');
  const settingsCombo = useFormattedCombo('settings.toggle');

  const hasBackgroundSession = !!transientSessionId && !commandBarOpen;
  const transientIsIdle = hasBackgroundSession && requiresUserInteraction(transientActivity);

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
            title={`Command Terminal (${commandTerminalCombo})`}
            aria-label="Command Terminal"
            data-testid="quick-session-button"
          >
            <TerminalSquare size={20} />
            {hasBackgroundSession && (
              <span
                className={`absolute top-1 right-1 w-2 h-2 rounded-full animate-pulse ${
                  transientIsIdle ? 'bg-yellow-400' : 'bg-green-400'
                }`}
                data-testid="transient-session-indicator"
              />
            )}
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

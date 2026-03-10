import React from 'react';
import { Minus, Settings, Square, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import logoSrc from '../../assets/logo-32.png';

const isMac = window.electronAPI.platform === 'darwin';

export function TitleBar() {
  const currentProject = useProjectStore((s) => s.currentProject);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);

  const isWorktree = currentProject?.path
    ? currentProject.path.replace(/\\/g, '/').includes('.kangentic/worktrees/')
    : false;

  return (
    <div className={`h-10 bg-surface border-b border-edge flex items-center select-none flex-shrink-0 ${isMac ? 'pl-20 pr-3' : 'px-3'}`}
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {/* Branding -- logo + app name */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <img src={logoSrc} alt="Kangentic" className="w-5 h-5" />
        <span className="text-sm font-semibold text-fg-secondary">Kangentic</span>
      </div>

      {/* Divider + project name */}
      {currentProject && (
        <div className="flex items-center gap-2 ml-2 min-w-0">
          <div className="w-px h-4 bg-edge flex-shrink-0" />
          <span className="text-sm font-medium text-fg truncate">
            {currentProject.name}
          </span>
          {isWorktree && (
            <span className="text-xs text-amber-500/70 flex-shrink-0">(worktree)</span>
          )}
        </div>
      )}

      {/* Spacer to push right-aligned controls to the edge */}
      <div className="flex-1" />

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className={`p-1.5 hover:bg-surface-hover rounded transition-colors ${
            settingsOpen ? 'text-fg bg-surface-hover' : 'text-fg-muted hover:text-fg'
          }`}
          title="App Settings"
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

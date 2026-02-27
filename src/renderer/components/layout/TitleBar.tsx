import React from 'react';
import { Menu, Minus, Settings, Square, X } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';

interface TitleBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

const isMac = navigator.platform.toUpperCase().includes('MAC');

export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);

  const isWorktree = currentProject?.path
    ? currentProject.path.replace(/\\/g, '/').includes('.kangentic/worktrees/')
    : false;

  return (
    <div className="h-10 bg-zinc-900 border-b border-zinc-700 flex items-center px-3 select-none flex-shrink-0"
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      {!sidebarOpen && (
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={onToggleSidebar}
            className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
            title="Show sidebar"
          >
            <Menu size={20} />
          </button>
        </div>
      )}

      <div className="flex-1 text-center text-sm text-zinc-400">
        <span className="font-semibold text-zinc-200">Kangentic</span>
        {currentProject && (
          <span className="ml-2 text-zinc-500">
            &mdash; {currentProject.name}
            {isWorktree && (
              <span className="ml-1.5 text-xs text-amber-500/70">(worktree)</span>
            )}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className={`p-1.5 hover:bg-zinc-700 rounded transition-colors ${
            settingsOpen ? 'text-zinc-100 bg-zinc-700' : 'text-zinc-400 hover:text-zinc-100'
          }`}
          title="Settings"
        >
          <Settings size={20} />
        </button>
        {!isMac && (
          <>
            <div className="w-px h-4 bg-zinc-700 mx-1" />
            <button
              onClick={() => window.electronAPI.window.minimize()}
              className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
              title="Minimize"
            >
              <Minus size={16} />
            </button>
            <button
              onClick={() => window.electronAPI.window.maximize()}
              className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
              title="Maximize"
            >
              <Square size={14} />
            </button>
            <button
              onClick={() => window.electronAPI.window.close()}
              className="p-1.5 hover:bg-red-600 rounded text-zinc-400 hover:text-white transition-colors"
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

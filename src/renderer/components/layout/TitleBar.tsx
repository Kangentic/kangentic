import React from 'react';
import { Menu, Settings } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';

interface TitleBarProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function TitleBar({ sidebarOpen, onToggleSidebar }: TitleBarProps) {
  const currentProject = useProjectStore((s) => s.currentProject);
  const setSettingsOpen = useConfigStore((s) => s.setSettingsOpen);
  const settingsOpen = useConfigStore((s) => s.settingsOpen);

  return (
    <div className="h-10 bg-zinc-900 border-b border-zinc-700 flex items-center px-3 select-none flex-shrink-0"
         style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={onToggleSidebar}
          className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <Menu size={20} />
        </button>
      </div>

      <div className="flex-1 text-center text-sm text-zinc-400">
        <span className="font-semibold text-zinc-200">Kangentic</span>
        {currentProject && (
          <span className="ml-2 text-zinc-500">
            &mdash; {currentProject.name}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          onClick={() => setSettingsOpen(!settingsOpen)}
          className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-zinc-100 transition-colors"
          title="Settings"
        >
          <Settings size={20} />
        </button>
      </div>
    </div>
  );
}

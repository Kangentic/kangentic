import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { ChartColumn, GitBranch, Globe, Minus, Square, X } from 'lucide-react';
import { POP_OUT_SURFACES } from '../../shared/pop-out';
import type { PopOutKind } from '../../shared/pop-out';

const isMac = window.electronAPI.platform === 'darwin';

const SURFACE_ICONS: Record<PopOutKind, typeof ChartColumn> = {
  stats: ChartColumn,
  changes: GitBranch,
  browser: Globe,
};

/**
 * Shared frameless chrome for every pop-out window, matching the main window's
 * custom title bar (TitleBar.tsx): a draggable header (`-webkit-app-region: drag`)
 * with the surface's icon + title, and on Windows/Linux custom minimize/maximize/
 * close controls (macOS gets native traffic-light insets via
 * `trafficLightPosition`, set when the window is created). The close button routes
 * through `window.electronAPI.window.close()`, which the main process resolves to
 * THIS window (BrowserWindow.fromWebContents(event.sender)), not the main window.
 *
 * `title` overrides the surface's generic name (task-scoped surfaces pass the task
 * title so the detached window is associable to its task); it also drives the OS
 * window / taskbar title via document.title.
 */
export function PopOutWindowFrame({ kind, title, children }: { kind: PopOutKind; title?: string; children: ReactNode }) {
  const meta = POP_OUT_SURFACES[kind];
  const Icon = SURFACE_ICONS[kind];
  const displayTitle = title ?? meta.title;

  useEffect(() => {
    document.title = displayTitle;
  }, [displayTitle]);

  return (
    <div className="h-screen flex flex-col bg-surface">
      <div
        className={`relative h-10 border-b border-edge flex items-center gap-3 select-none flex-shrink-0 ${isMac ? 'pl-20 pr-3' : 'px-3'}`}
        style={{ WebkitAppRegion: 'drag' } as CSSProperties}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Icon size={16} className="text-fg-muted flex-shrink-0" aria-hidden />
          <span className="text-sm font-semibold text-fg-secondary truncate" title={displayTitle}>{displayTitle}</span>
        </div>
        {!isMac && (
          <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as CSSProperties}>
            <button
              type="button"
              onClick={() => window.electronAPI.window.minimize()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Minimize"
            >
              <Minus size={16} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.window.maximize()}
              className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
              title="Maximize"
            >
              <Square size={14} />
            </button>
            <button
              type="button"
              onClick={() => window.electronAPI.window.close()}
              className="p-1.5 hover:bg-red-600 rounded text-fg-muted hover:text-white transition-colors"
              title="Close"
              data-testid="popout-close"
            >
              <X size={16} />
            </button>
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}

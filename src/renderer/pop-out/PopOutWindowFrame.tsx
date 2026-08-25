import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Activity, ChartColumn, FileDiff, GitBranch, Globe, Minus, Square, X } from 'lucide-react';
import { POP_OUT_SURFACES } from '../../shared/pop-out';
import type { PopOutKind } from '../../shared/pop-out';

const isMac = window.electronAPI.platform === 'darwin';

const SURFACE_ICONS: Record<PopOutKind, typeof ChartColumn> = {
  stats: ChartColumn,
  changes: GitBranch,
  browser: Globe,
  monitor: Activity,
  'changes-file': FileDiff,
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
 * window / taskbar title via document.title. `documentTitle`, when set, replaces
 * `title` for document.title only, so a surface can show one string in the header
 * (a file's full repo-relative path) and a shorter one in the taskbar (its
 * basename, via resolveSurfaceTitle - the same value main gave the BrowserWindow).
 */
export function PopOutWindowFrame({ kind, title, documentTitle, children }: { kind: PopOutKind; title?: string; documentTitle?: string; children: ReactNode }) {
  const meta = POP_OUT_SURFACES[kind];
  const Icon = SURFACE_ICONS[kind];
  const displayTitle = title ?? meta.title;
  const osTitle = documentTitle ?? displayTitle;

  useEffect(() => {
    document.title = osTitle;
  }, [osTitle]);

  // Escape closes this OS window - structural dismissal, like BaseDialog's own
  // Escape (the keybindings-registry rule's structural-Escape exception: Escape
  // is registered display-only as `dialog.dismiss` and adds no entry here).
  // Registered on `window` in the BUBBLE phase so every document-level closer
  // (dialogs, context menus, popovers, the monitor pop-out's DOM windows) sees
  // the keystroke first; none of them cancel the event, so the guards below -
  // checked while the just-dismissed overlay is still in the DOM during this
  // same dispatch - are what keep one Escape from closing both the overlay and
  // the whole window. `defaultPrevented` covers Monaco's keybinding service
  // (which preventDefaults keys it handled, e.g. closing the find widget).
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A focused text field owns its Escape (cancelling an edit - the browser
      // pop-out's URL bar, the Changes file filter): closing the whole OS
      // window mid-typing would discard both the edit and the window.
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA' || activeElement.isContentEditable)
      ) return;
      // An open dialog / context menu / popover owns this Escape.
      if (document.querySelector('[data-dismissable-layer]')) return;
      // A DOM window (task detail in the detached Agent Monitor) owns this Escape.
      for (const host of document.querySelectorAll('[data-window-layer-root]')) {
        if (host.childElementCount > 0) return;
      }
      // Belt-and-braces for Monaco's find widget, should its Escape ever
      // bubble. '.find-widget' alone (not qualified by Monaco's editor root
      // class): the build's lazy-monaco assertion scans entry chunks for that
      // class name as a marker string, and this frame is in the entry closure.
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest('.find-widget')) return;
      window.electronAPI.window.close();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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

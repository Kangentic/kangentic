import type { ReactNode } from 'react';
import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import { useLingui } from '@lingui/react/macro';
import { PanelErrorBoundary } from '../PanelErrorBoundary';

/**
 * The surfaces of the main window that each get a boundary of their own, so one
 * render throw costs that surface and not the whole window. Before this they all
 * fell back to the root `ErrorBoundary`, which unmounts every terminal and every
 * Browser pane guest in the window.
 *
 * `panel` is the English name the report and the Aptabase event carry; `message`
 * is the failure line the user reads, translated. `layout` is where the fallback
 * sits:
 * - `fill`: the surface has a sized box of its own, which the fallback fills.
 * - `bar`: a row in the window's full-height column. A filling fallback there
 *   takes the whole window and leaves the board no height, so it is one row.
 * - `overlay`: an overlay over the window, whose own close key went with it, so
 *   the fallback floats as a card with a Close button.
 */
type SurfaceLayout = 'fill' | 'bar' | 'overlay';

const SURFACES = {
  sidebar: { panel: 'sidebar', layout: 'fill', message: msg`Failed to load the sidebar` },
  'title-bar': { panel: 'title bar', layout: 'bar', message: msg`Failed to load the title bar` },
  board: { panel: 'board', layout: 'fill', message: msg`Failed to load the board` },
  'terminal-panel': { panel: 'terminal panel', layout: 'fill', message: msg`Failed to load the terminal panel` },
  backlog: { panel: 'backlog', layout: 'fill', message: msg`Failed to load the backlog` },
  'status-bar': { panel: 'status bar', layout: 'bar', message: msg`Failed to load the status bar` },
  settings: { panel: 'settings', layout: 'overlay', message: msg`Failed to load settings` },
  'command-terminal': { panel: 'Command Terminal layer', layout: 'overlay', message: msg`Failed to load the Command Terminal panel` },
  search: { panel: 'search', layout: 'overlay', message: msg`Failed to load search` },
} as const satisfies Record<string, { panel: string; layout: SurfaceLayout; message: MessageDescriptor }>;

export type SurfaceName = keyof typeof SURFACES;

const FALLBACK_CLASS: Record<SurfaceLayout, string | undefined> = {
  fill: undefined,
  bar: 'flex min-h-9 w-full flex-shrink-0 items-center justify-center gap-3 bg-surface px-3 py-1 text-center',
  overlay: 'fixed left-1/2 top-24 z-50 flex w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 flex-col items-center gap-2 rounded-lg border border-edge bg-surface-raised p-4 text-center shadow-lg',
};

interface SurfaceBoundaryProps {
  surface: SurfaceName;
  /** Closes an overlay surface from its fallback. */
  onDismiss?: () => void;
  children: ReactNode;
}

export function SurfaceBoundary({ surface, onDismiss, children }: SurfaceBoundaryProps) {
  const { i18n } = useLingui();
  const { panel, layout, message } = SURFACES[surface];
  return (
    <PanelErrorBoundary
      panel={panel}
      message={i18n._(message)}
      fallbackClassName={FALLBACK_CLASS[layout]}
      onDismiss={layout === 'overlay' ? onDismiss : undefined}
    >
      {children}
    </PanelErrorBoundary>
  );
}

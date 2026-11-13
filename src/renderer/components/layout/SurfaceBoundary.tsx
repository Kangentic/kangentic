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
 * is the failure line the user reads, translated.
 */
const SURFACES = {
  sidebar: { panel: 'sidebar', message: msg`Failed to load the sidebar` },
  'title-bar': { panel: 'title bar', message: msg`Failed to load the title bar` },
  board: { panel: 'board', message: msg`Failed to load the board` },
  'terminal-panel': { panel: 'terminal panel', message: msg`Failed to load the terminal panel` },
  backlog: { panel: 'backlog', message: msg`Failed to load the backlog` },
  'status-bar': { panel: 'status bar', message: msg`Failed to load the status bar` },
  settings: { panel: 'settings', message: msg`Failed to load settings` },
  'command-terminal': { panel: 'Command Terminal layer', message: msg`Failed to load the Command Terminal panel` },
  search: { panel: 'search', message: msg`Failed to load search` },
} as const satisfies Record<string, { panel: string; message: MessageDescriptor }>;

export type SurfaceName = keyof typeof SURFACES;

export function SurfaceBoundary({ surface, children }: { surface: SurfaceName; children: ReactNode }) {
  const { i18n } = useLingui();
  const { panel, message } = SURFACES[surface];
  return (
    <PanelErrorBoundary panel={panel} message={i18n._(message)}>
      {children}
    </PanelErrorBoundary>
  );
}

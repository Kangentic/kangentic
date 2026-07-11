import type { ReactNode } from 'react';
import { PopOutButton } from './PopOutButton';
import type { PopOutKind, PopOutParamsByKind } from '../../shared/pop-out';

/**
 * The single, shared header row for every detachable surface (Stats, Changes,
 * Browser). It gives the pop-out control ONE predictable home so the user learns
 * it once: the `PanelRightOpen` icon at the top-right of the surface, same icon and
 * same position everywhere. Surface-specific tools (git/diff tools, browser
 * navigation, stats filters) live BELOW this header, never mixed into it.
 *
 * - `children` is the surface identity (icon + context) on the left.
 * - `actions` are other panel-level controls (e.g. Changes' expand/collapse),
 *   rendered immediately left of the pop-out button.
 * - `trailing` is surface chrome that outranks the pop-out (e.g. the Stats overlay
 *   close button); embedded panels pass nothing.
 *
 * Because every surface renders the pop-out through this one component, its icon
 * and placement cannot drift between surfaces.
 */
export function DetachableSurfaceHeader<K extends PopOutKind>({
  kind,
  params,
  children,
  actions,
  trailing,
  className,
}: {
  kind: K;
  params: PopOutParamsByKind[K];
  children: ReactNode;
  actions?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex items-center gap-2 border-b border-edge flex-shrink-0 ${className ?? 'px-3 py-1.5'}`}
      data-testid={`surface-header-${kind}`}
    >
      <div className="flex items-center gap-1.5 min-w-0 flex-1">{children}</div>
      {actions}
      <PopOutButton kind={kind} params={params} />
      {trailing}
    </div>
  );
}

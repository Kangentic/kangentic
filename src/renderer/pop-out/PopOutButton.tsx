import { SquareArrowOutUpRight } from 'lucide-react';
import { usePopOut } from './usePopOut';
import type { PopOutKind, PopOutParamsByKind } from '../../shared/pop-out';

/** Always-visible pop-out control for a surface's in-app header. Opens the surface's
 *  detached window, or focuses it if already open. */
export function PopOutButton<K extends PopOutKind>({ kind, params, title }: {
  kind: K;
  params: PopOutParamsByKind[K];
  title?: string;
}) {
  const { isOpen, open, focus } = usePopOut(kind, params);
  return (
    <button
      type="button"
      onClick={() => (isOpen ? focus() : open())}
      className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
      title={title ?? (isOpen ? 'Focus detached window' : 'Open in new window')}
      aria-label={title ?? 'Open in new window'}
      data-testid={`pop-out-button-${kind}`}
    >
      <SquareArrowOutUpRight size={16} />
    </button>
  );
}

import { SquareArrowOutUpRight } from 'lucide-react';
import { usePopOut } from './usePopOut';
import { Tooltip } from '../components/Tooltip';
import type { PopOutKind, PopOutParamsByKind } from '../../shared/pop-out';

/** Always-visible pop-out control for a surface's in-app header. Opens the surface's
 *  detached window, or focuses it if already open. */
export function PopOutButton<K extends PopOutKind>({ kind, params, label }: {
  kind: K;
  params: PopOutParamsByKind[K];
  /** The button's name and tip, when it should not follow the window's state. */
  label?: string;
}) {
  const { isOpen, open, focus } = usePopOut(kind, params);
  const name = label ?? (isOpen ? 'Focus detached window' : 'Open in new window');
  return (
    <Tooltip label={name}>
      <button
        type="button"
        onClick={() => (isOpen ? focus() : open())}
        className="p-1.5 hover:bg-surface-hover rounded text-fg-muted hover:text-fg transition-colors"
        aria-label={name}
        data-testid={`pop-out-button-${kind}`}
      >
        <SquareArrowOutUpRight size={16} />
      </button>
    </Tooltip>
  );
}

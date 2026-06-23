/**
 * Window title bar: a drag handle plus two ALWAYS-VISIBLE controls
 * (maximize/restore, close). No hover-only controls (ui-conventions rule). The
 * maximize control reuses the shared `MaximizeToggleButton` so it carries the
 * `panel.maximize` tooltip; double-clicking the handle also toggles maximize.
 */

import { X } from 'lucide-react';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import { useLayerStore } from '../context';

interface WindowTitleBarProps {
  title: string;
  windowId: string;
  isMaximized: boolean;
  /** Pointer-down on the drag handle; starts the title-bar drag. */
  onHandlePointerDown: (event: React.PointerEvent) => void;
  /** Animated close (routes through the overlay-phase exit). */
  onRequestClose: () => void;
}

const CONTROL_CLASS =
  'p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0';

export function WindowTitleBar({
  title,
  windowId,
  isMaximized,
  onHandlePointerDown,
  onRequestClose,
}: WindowTitleBarProps) {
  const toggleMaximizeWindow = useLayerStore()((state) => state.toggleMaximizeWindow);

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-edge flex-shrink-0 select-none">
      <div
        className="flex-1 min-w-0 cursor-grab active:cursor-grabbing"
        onPointerDown={onHandlePointerDown}
        onDoubleClick={() => toggleMaximizeWindow(windowId)}
      >
        <span className="text-sm font-semibold text-fg truncate">{title}</span>
      </div>
      {/* Raised above the corner resize handles (z-20) so the controls stay
          clickable at the top corners. */}
      <div className="relative z-30 flex items-center gap-1">
        <MaximizeToggleButton
          isMaximized={isMaximized}
          onToggle={() => toggleMaximizeWindow(windowId)}
          testId={`window-maximize-${windowId}`}
        />
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close window"
          title="Close"
          className={CONTROL_CLASS}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}

import { Maximize2, Minimize2 } from 'lucide-react';
import { useFormattedCombo } from '../../hooks/useKeybinding';

/**
 * Shared layout + toggle button for maximizable surfaces (#184).
 * `MaximizeToggleButton` is the generic control (used by the task-detail and
 * conversation windows, the window title bar, and the sentinel dialogs below).
 * `maximizedDialogLayout` pairs with the session store's `maximizedTasks` set,
 * which is keyed by a non-task sentinel id and holds only the create dialogs
 * (New Task, New Backlog Task) and the Edit Columns dialog. (The task-detail and
 * Command Terminal windows maximize through the window manager, not this set.)
 */

export interface MaximizedDialogLayout {
  /** Sizing class for the dialog content (BaseDialog `className`). */
  dialogClassName: string;
  /** Backdrop position class (BaseDialog `backdropPositionClass`). */
  backdropPositionClass: string;
  /** Backdrop padding class (BaseDialog `backdropClassName`). */
  backdropClassName: string;
  /** Content corner-radius class (BaseDialog `contentRadiusClass`). */
  contentRadiusClass: string;
}

/**
 * Resolve the BaseDialog sizing/backdrop/radius props for the maximize toggle.
 * When maximized, the content fills the area between the app title bar (h-10 =
 * 40px) and status bar (h-9 = 36px) so the window controls and live stats stay
 * visible and clickable, the backdrop padding is dropped so the dialog fills
 * that region, and the corners are squared so the border meets the screen edges
 * flush. When windowed, the caller's `windowedClassName` is used with the
 * default full-window backdrop and rounded corners.
 */
export function maximizedDialogLayout(isMaximized: boolean, windowedClassName: string): MaximizedDialogLayout {
  // `dialog-maximize-anim` transitions the content's width/height/border-radius
  // so the box smoothly grows/shrinks when the maximize toggle flips between
  // these two sizes (see index.css). It is present in both states so the
  // transition applies in either direction.
  if (isMaximized) {
    return {
      dialogClassName: 'w-full h-full dialog-maximize-anim',
      backdropPositionClass: 'inset-x-0 top-10 bottom-9',
      backdropClassName: '',
      contentRadiusClass: 'rounded-none',
    };
  }
  return {
    dialogClassName: `${windowedClassName} dialog-maximize-anim`,
    backdropPositionClass: 'inset-0',
    backdropClassName: 'p-6',
    contentRadiusClass: 'rounded-lg',
  };
}

interface MaximizeToggleButtonProps {
  isMaximized: boolean;
  onToggle: () => void;
  testId?: string;
}

/** Header maximize/restore button shared by the dialogs above. */
export function MaximizeToggleButton({ isMaximized, onToggle, testId = 'dialog-maximize' }: MaximizeToggleButtonProps) {
  const maximizeCombo = useFormattedCombo('panel.maximize');
  return (
    <button
      type="button"
      onClick={onToggle}
      data-testid={testId}
      aria-label={isMaximized ? 'Restore dialog' : 'Maximize dialog'}
      title={`${isMaximized ? 'Restore' : 'Maximize'} (${maximizeCombo})`}
      className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
    >
      {isMaximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  );
}

import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { BaseDialog } from './BaseDialog';

interface ConfirmDialogProps {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  showDontAskAgain?: boolean;
  dontAskAgainLabel?: string;
  /** `data-testid` for the dialog, forwarded to BaseDialog, so one confirm among several open
   *  dialogs is addressable by name rather than by its title text. */
  testId?: string;
  onConfirm: (dontAskAgain: boolean) => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  showDontAskAgain = false,
  dontAskAgainLabel = "Don't ask again",
  testId,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [dontAskAgainChecked, setDontAskAgainChecked] = useState(false);

  // Enter to confirm - disabled for danger variant to prevent accidental
  // destructive actions (e.g. worktree deletion while user is typing elsewhere).
  useEffect(() => {
    if (variant === 'danger') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onConfirm(dontAskAgainChecked);
      }
    };
    // Capture phase so dnd-kit's bubble-phase KeyboardSensor never sees the event
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [variant, onConfirm, dontAskAgainChecked]);
  const confirmStyles = {
    danger: 'bg-red-600 hover:bg-red-500 text-white',
    warning: 'bg-yellow-600 hover:bg-yellow-500 text-white',
    default: 'bg-accent-emphasis hover:bg-accent text-accent-on',
  };

  const iconStyles = {
    danger: 'text-red-400',
    warning: 'text-yellow-400',
    default: 'text-accent-fg',
  };

  return (
    <BaseDialog
      onClose={onCancel}
      title={title}
      icon={<AlertTriangle size={16} className={iconStyles[variant]} />}
      zIndex="z-[60]"
      testId={testId}
      trapFocus
      footer={
        <div className="flex items-center">
          {showDontAskAgain && (
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={dontAskAgainChecked}
                onChange={(event) => setDontAskAgainChecked(event.target.checked)}
                className="accent-accent rounded border-edge-input bg-surface"
              />
              <span className="text-xs text-fg-muted">{dontAskAgainLabel}</span>
            </label>
          )}
          <div className="flex justify-end gap-3 ml-auto">
            <button
              onClick={onCancel}
              className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            >
              {cancelLabel}
            </button>
            <button
              onClick={() => onConfirm(dontAskAgainChecked)}
              className={`px-4 py-1.5 text-xs rounded transition-colors ${confirmStyles[variant]}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      }
    >
      <div className="text-sm text-fg-muted space-y-2">
        {typeof message === 'string'
          ? <p>{message}</p>
          : message
        }
      </div>
    </BaseDialog>
  );
}

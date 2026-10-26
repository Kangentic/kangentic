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
  /** Replaces the variant's warning triangle, for a confirmation that is not a warning (a
   *  restart). Color it the way the variant would, e.g. `text-accent-fg` for `default`. */
  icon?: React.ReactNode;
  /** An icon before the confirm button's label, for an action that has one (Start workflow's Play). */
  confirmIcon?: React.ReactNode;
  /**
   * A third choice between cancel and confirm, such as the unsaved-edits prompt's Discard beside
   * its Save. With it, the confirm button takes initial focus and Enter activates whichever button
   * has focus, so Tab to Discard then Enter discards.
   */
  secondaryAction?: { label: string; onClick: () => void; testId?: string };
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
  icon,
  confirmIcon,
  secondaryAction,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [dontAskAgainChecked, setDontAskAgainChecked] = useState(false);
  const hasSecondaryAction = secondaryAction !== undefined;

  // Enter to confirm - disabled for danger variant to prevent accidental
  // destructive actions (e.g. worktree deletion while user is typing elsewhere).
  // With a third button, Enter on a focused button is left to the browser, which
  // clicks it. Firing confirm there would turn Tab to Discard then Enter into a
  // Save. The confirm button holds initial focus then, so a plain Enter still
  // confirms.
  useEffect(() => {
    if (variant === 'danger') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return;
      if (hasSecondaryAction && event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onConfirm(dontAskAgainChecked);
    };
    // Capture phase so dnd-kit's bubble-phase KeyboardSensor never sees the event
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [variant, onConfirm, dontAskAgainChecked, hasSecondaryAction]);
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
      icon={icon ?? <AlertTriangle size={16} className={iconStyles[variant]} />}
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
            {secondaryAction && (
              <button
                onClick={secondaryAction.onClick}
                className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
                data-testid={secondaryAction.testId}
              >
                {secondaryAction.label}
              </button>
            )}
            <button
              onClick={() => onConfirm(dontAskAgainChecked)}
              // BaseDialog's focus trap moves focus here on open. Not autoFocus,
              // which would land first and leave the trap nothing to restore.
              data-initial-focus={hasSecondaryAction || undefined}
              className={`px-4 py-1.5 text-xs rounded transition-colors ${confirmIcon ? 'inline-flex items-center gap-1.5' : ''} ${confirmStyles[variant]}`}
            >
              {confirmIcon}
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

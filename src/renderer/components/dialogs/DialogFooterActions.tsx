import type { ReactNode } from 'react';

interface DialogFooterActionsProps {
  onCancel: () => void;
  submitLabel: string;
  /** Replaces `submitLabel` while the submit is in flight. */
  busyLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  /**
   * Omit for a submit button inside a `<form>` (NewTaskDialog), which submits
   * via the form's own onSubmit. Pass a handler for a footer with no form
   * (the task-detail window).
   */
  onSubmit?: () => void;
  /** Left-aligned slot, e.g. a Delete button. Absent leaves the pair right-aligned. */
  leading?: ReactNode;
  /**
   * Test id for the submit button. Only the backlog dialog needs one - its specs
   * target the button directly rather than by role and text.
   */
  submitTestId?: string;
}

/**
 * Cancel + submit for a dialog footer, with an optional leading slot.
 *
 * The two hosts had drifted: NewTaskDialog used `px-4` and
 * `disabled:opacity-50`, the task-detail window used `px-3` and a ternary
 * producing `bg-accent-emphasis/50` - same two buttons, two different disabled
 * treatments. They also differ structurally, which is why `onSubmit` is
 * optional: one is a `type="submit"` inside a `<form>`, the other is a plain
 * click handler with no form anywhere above it.
 */
export function DialogFooterActions({
  onCancel,
  submitLabel,
  busyLabel,
  busy = false,
  disabled = false,
  onSubmit,
  leading,
  submitTestId,
}: DialogFooterActionsProps) {
  return (
    <div className={`flex items-center ${leading ? 'justify-between' : 'justify-end'}`}>
      {leading}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-edge-input px-4 py-1.5 text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg-secondary"
        >
          Cancel
        </button>
        <button
          type={onSubmit ? 'button' : 'submit'}
          onClick={onSubmit}
          disabled={disabled || busy}
          className="rounded bg-accent-emphasis px-4 py-1.5 text-xs text-accent-on transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          data-testid={submitTestId}
        >
          {busy && busyLabel ? busyLabel : submitLabel}
        </button>
      </div>
    </div>
  );
}

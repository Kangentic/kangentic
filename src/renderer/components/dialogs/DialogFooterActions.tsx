import type { ReactNode } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';

interface DialogFooterActionsProps {
  onCancel: () => void;
  submitLabel: string;
  /**
   * The submit is in flight: the button disables and keeps its label. It used
   * to swap in a "Saving..." label, which grew the button and shifted Cancel
   * for the length of the round trip, so the footer changed shape on every
   * press. A control must not change shape when pressed.
   */
  busy?: boolean;
  disabled?: boolean;
  /**
   * Why the submit is disabled, as its tip: a workflow task's Save while the
   * workflow agent works ("Available when the workflow agent finishes").
   */
  disabledReason?: string | null;
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
  busy = false,
  disabled = false,
  disabledReason = null,
  onSubmit,
  leading,
  submitTestId,
}: DialogFooterActionsProps) {
  // Hookless on purpose (tests/unit/dialog-form-primitives.test.ts calls this as a plain
  // function), so the text resolves with i18n._ at render time, after the catalog loads.
  const cancelText = i18n._(msg`Cancel`);
  return (
    <div className={`flex items-center ${leading ? 'justify-between' : 'justify-end'}`}>
      {leading}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-edge-input px-4 py-1.5 text-xs text-fg-muted transition-colors hover:border-fg-faint hover:text-fg-secondary"
        >
          {cancelText}
        </button>
        <Tooltip label={tipLabel({ disabled, disabledReason })}>
          <button
            type={onSubmit ? 'button' : 'submit'}
            onClick={onSubmit}
            disabled={disabled || busy}
            className="rounded bg-accent-emphasis px-4 py-1.5 text-xs text-accent-on transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            data-testid={submitTestId}
          >
            {submitLabel}
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

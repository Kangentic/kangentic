import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * The shared shell for a single-line form control inside a dialog: 34px tall
 * (`py-1.5` + `text-sm` + 1px borders), `rounded`, on the `surface` token.
 *
 * 34px is the scale because `Select` (settings/shared.tsx) and `Combobox` are
 * both already this height and are used across settings, the board manager, and
 * the task run-mode card - changing THEM ripples app-wide, so everything else
 * comes up to meet them. Height stays padding-derived rather than a fixed
 * `h-[34px]` so the box keeps growing with the font if the text scale changes.
 */
const FIELD_CONTROL_BASE =
  'w-full bg-surface border border-edge-input rounded py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent';

export const FIELD_CONTROL_CLASS = `${FIELD_CONTROL_BASE} px-3`;

/**
 * `FIELD_CONTROL_CLASS` for the shared `Select`, whose chevron is overlaid
 * absolutely and needs the room reserved on the right.
 *
 * Spelled `pl-3 pr-10` rather than `px-3 pr-10` on purpose: Tailwind resolves
 * conflicting utilities by CSS source order, not by the order they appear in the
 * class attribute, so an override that happens to work is not one you can rely
 * on when the utility ordering changes.
 */
export const FIELD_SELECT_CLASS = `${FIELD_CONTROL_BASE} appearance-none pl-3 pr-10 disabled:cursor-not-allowed`;

interface FieldProps {
  /** Usually a string; a fragment is allowed for a label that needs an icon. */
  label: ReactNode;
  children: ReactNode;
  /**
   * Explanatory line under the control, rendered with a leading info icon.
   * Suppressed while `error` is set - a field cannot be both wrong and merely
   * informative, and showing two lines there shifts everything below it.
   */
  hint?: ReactNode;
  /** Validation message. Wins over `hint`. */
  error?: string;
  /** Applied to the wrapper, e.g. `flex-1` for a field in a row. */
  className?: string;
}

/**
 * Label + control + hint/error, the shape every dialog field already hand-rolled.
 *
 * The exact string `text-xs text-fg-muted mb-1 block` appeared ten times across
 * the five dialog files that consume this, which is what makes one component
 * worth having rather than a convention nobody can enforce. `font-medium` is
 * new: at plain weight the labels read as text floating above the controls
 * rather than as part of them.
 *
 * Lives here beside Pill / CountBadge / ToggleCard rather than in
 * `settings/shared.tsx`. Dialogs already reach into the settings module for
 * `Select`; a shared form primitive should not widen that dependency.
 */
export function Field({ label, children, hint, error, className }: FieldProps) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-fg-muted">{label}</label>
      {children}
      {error ? (
        <p className="mt-1 text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className="mt-1 flex items-center gap-1 text-xs text-fg-disabled">
          <Info size={12} className="shrink-0" />
          {hint}
        </p>
      ) : null}
    </div>
  );
}

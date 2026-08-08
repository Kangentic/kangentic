import type { ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * The shared shell for a single-line form control: 34px tall (`py-1.5` +
 * `text-sm` + 1px borders), `rounded`, on the `surface-control` token.
 *
 * 34px is the scale because `Select` (settings/shared.tsx) and `Combobox` are
 * both already this height and are used across settings, the board manager, and
 * the task run-mode card - changing THEM ripples app-wide, so everything else
 * comes up to meet them. Height stays padding-derived rather than a fixed
 * `h-[34px]` so the box keeps growing with the font if the text scale changes.
 *
 * `--kng-surface-control` is a DEDICATED token, not a borrowed one, and that is
 * the point. Inputs, comboboxes, and `ToggleCard` all reference it, so a card
 * and the dropdown beside it read as one family - and re-tuning the control fill
 * is one value per theme rather than a sweep across ~19 files. Each theme's
 * value is tuned to a ~1.3:1 step against `surface-raised` (the ground under
 * BaseDialog, the task-detail window, and the settings panel), extrapolated
 * along the theme's own raised-to-hover hue ray. The first cut sat 60% of the
 * way from `surface-raised` to `surface-hover` and did not register (1.09-1.22:1
 * against that ground): the compressed themes' whole raised-to-hover span falls
 * short of that same ~1.3:1 step, which is why the fill now sits at or PAST
 * `surface-hover` where it must. That collapse is safe because nothing grounds a control on
 * full-strength `surface-hover` - the fill's real neighbours are `surface-raised`
 * and the segmented track's `surface`, and the fill carrying the separation also
 * means `edge-input` is now redundant-by-design against the fill in the
 * compressed themes (the border's job is the ground side, where it stays
 * legible). `tests/unit/theme-contrast.test.ts` enforces the separation floors.
 *
 * Text ON this fill has to be chosen against the WHOLE theme set, not the
 * default one - that mistake cost several rounds. Worst-case ratios across all
 * 10 themes: `fg` 8.49:1, `fg-tertiary` 4.63:1, `fg-muted` 3.19:1. So anything a
 * user must read stays at `fg-tertiary` or brighter; `fg-muted` and `fg-faint`
 * are for hint text and decoration. Value text is `fg-tertiary`, placeholders
 * are `fg-muted` (deliberately sub-AA: a placeholder must read dimmer than the
 * value it stands in for). `tests/unit/theme-contrast.test.ts` enforces this.
 */
const FIELD_CONTROL_BASE =
  'w-full bg-surface-control border border-edge-input rounded py-1.5 text-sm text-fg-tertiary placeholder-fg-muted focus:outline-none focus:border-accent';

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

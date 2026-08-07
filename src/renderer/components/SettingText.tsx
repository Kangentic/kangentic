import type { ReactNode } from 'react';

/**
 * The one definition of a setting's label + description pair.
 *
 * This existed four times with four different treatments - `ToggleCard`
 * (`fg-secondary` / `fg-tertiary`), `SettingRow` (`fg-secondary` / `fg-faint`),
 * `CompactToggleList` (`fg-secondary` with no weight / `fg-faint`), and the
 * board manager's `SettingField` (`fg-muted` / `fg-faint`) - so the same pair of
 * strings rendered differently depending on which surface it landed on, and a
 * toggle's title was the same colour as its own description.
 *
 * The hierarchy is: the TITLE is the content and reads at full strength; the
 * description supports it and recedes.
 *
 * The description is `fg-tertiary`, NOT `fg-muted`, and that is a contrast
 * decision measured across all 10 themes rather than eyeballed in the default
 * one. `fg-muted` on `surface-hover` clears AA (4.5:1) in only two themes: it is
 * 4.07:1 in the default, 3.85:1 in ember, 3.58:1 in moon, and 3.34:1 in forest,
 * and in moon and forest it fails on the panel ground too. `fg-tertiary` is
 * 4.84:1 at its worst (forest) and passes everywhere, while still sitting a
 * clear step below the title (8.88:1 at ITS worst).
 *
 * The general rule this encodes: on a `surface-hover` fill only `fg`,
 * `fg-secondary`, and `fg-tertiary` are reliably legible across the theme set.
 * `fg-muted` and `fg-faint` are for decoration and hint text, never for a line
 * the user has to read.
 *
 * Both the component and the raw classes are exported. Use `SettingText` when
 * the pair stacks normally; use the classes directly when a caller owns a
 * bespoke row layout it cannot give up (the board manager's `SettingField`
 * right-aligns a Reset control on the title line).
 */
export const SETTING_LABEL_CLASS = 'text-sm font-medium text-fg';
export const SETTING_DESCRIPTION_CLASS = 'text-xs text-fg-tertiary';

interface SettingTextProps {
  label: string;
  /** Omit for a bare title with no supporting line. */
  description?: string;
  /**
   * Rendered inline after the title (an info icon, a badge). Kept on the title
   * line rather than the description so it reads as qualifying the setting's
   * name, not its explanation.
   */
  labelTrailing?: ReactNode;
  /** Extra classes on the wrapper, e.g. `leading-tight` for a dense list. */
  className?: string;
}

export function SettingText({ label, description, labelTrailing, className = '' }: SettingTextProps) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="flex items-center gap-1.5">
        <span className={SETTING_LABEL_CLASS}>{label}</span>
        {labelTrailing}
      </div>
      {description && <p className={`${SETTING_DESCRIPTION_CLASS} mt-0.5`}>{description}</p>}
    </div>
  );
}

import type React from 'react';
import { Info } from 'lucide-react';

interface ToggleCardProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Optional left-side icon. */
  icon?: React.ReactNode;
  /** Override the announced label. Defaults to `label`. */
  ariaLabel?: string;
  /**
   * Optional longer explanation surfaced as a hover tooltip on an info icon
   * beside the label, so a verbose "how it works" note need not occupy layout.
   */
  info?: string;
}

/**
 * Aria-hidden visual indicator for an interactive toggle. The interactive
 * element (with `role="switch"` + `aria-checked`) is the parent; this is just
 * pixels. Used by `ToggleCard` and `CompactToggleList`.
 */
export function ToggleIndicator({ checked, className = '' }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-accent' : 'bg-edge-input'
      } ${className}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </span>
  );
}

/**
 * Click-anywhere toggle row. The whole card is the click target; the visual
 * switch on the right is just an indicator. Converts the wide gap between
 * label and switch from "empty space next to a small control" into "interior
 * of one large control."
 *
 * Use this for any standalone boolean setting that has a label + description.
 * For dense lists of toggles, use `CompactToggleList` instead.
 */
export function ToggleCard({ label, description, checked, onChange, icon, ariaLabel, info }: ToggleCardProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      onClick={() => onChange(!checked)}
      className="flex items-start justify-between gap-3 w-full text-left cursor-pointer bg-surface/40 hover:bg-surface/70 border border-edge/40 hover:border-edge rounded-md px-3.5 py-2.5 transition-colors focus:outline-none focus-visible:border-accent"
    >
      {icon && <span className="flex-shrink-0 mt-0.5 text-fg-muted">{icon}</span>}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-fg-secondary">{label}</span>
          {info && (
            // Non-interactive span (nesting a button inside the card button is
            // invalid); stopPropagation keeps a click on the icon from toggling.
            <span
              title={info}
              aria-hidden="true"
              onClick={(event) => event.stopPropagation()}
              className="flex-shrink-0 text-fg-faint hover:text-fg-tertiary cursor-help"
            >
              <Info size={13} />
            </span>
          )}
        </div>
        <p className="text-xs text-fg-faint mt-0.5">{description}</p>
      </div>
      <ToggleIndicator checked={checked} className="mt-0.5" />
    </button>
  );
}

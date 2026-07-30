import type { ReactNode } from 'react';

interface ButtonGroupOption<T extends string> {
  value: T;
  label: string;
}

interface ButtonGroupProps<T extends string> {
  options: ButtonGroupOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  /**
   * Optional leading glyph rendered INSIDE the group's own border, fenced off by
   * a rule.
   *
   * An ICON rather than a text caption, deliberately. A word caption sits at the
   * same size and register as the options beside it, so "GROUP Status Project"
   * reads as one run of words and the control is hard to pick out at a glance -
   * raising its contrast did not fix that, because the problem is that it looks
   * like another option. A glyph cannot be misread as a choice.
   */
  icon?: ReactNode;
  /** Names the control for assistive tech and the icon's tooltip. */
  label?: string;
  ariaLabel?: string;
}

export function ButtonGroup<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  icon,
  label,
  ariaLabel,
}: ButtonGroupProps<T>) {
  const padding = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm';

  return (
    <div
      className="flex items-center gap-0.5 bg-surface/50 rounded-lg p-0.5 border border-edge/30"
      role="group"
      aria-label={ariaLabel ?? label}
    >
      {icon && (
        <>
          <span
            className="pl-2 flex items-center text-fg-muted flex-shrink-0"
            title={label}
            aria-hidden
          >
            {icon}
          </span>
          <span className="mx-2 h-4 w-px bg-edge flex-shrink-0" aria-hidden />
        </>
      )}
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          className={`${padding} font-medium rounded-md transition-colors ${
            value === option.value
              ? 'bg-surface-raised text-fg shadow-sm'
              : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';

/**
 * A small whole-number control: minus, the typable value, plus. For a count a
 * person nudges one at a time and sometimes types (an automation's Maximum
 * runs), where a full-width number field reads heavier than the value and a
 * preset row offers numbers nobody asked for.
 *
 * Fills match the other field controls (`surface-control`, `edge-input`), and
 * the 32px height matches `FIELD_CONTROL_CLASS`, so it sits in a row beside them.
 * Never goes below `min`; the value commits on every step and on blur or Enter
 * for a typed one, so a half-typed "" never reaches the caller.
 */
export interface NumberStepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}

export function NumberStepper({ value, onChange, min = 1, max = 999, disabled = false, ariaLabel, testId }: NumberStepperProps) {
  const { t } = useLingui();
  // What is being typed, while it is being typed. Null shows the committed value.
  const [typed, setTyped] = useState<string | null>(null);
  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.round(next)));
  // The typed text as a number; NaN when nothing, or nothing numeric, is typed.
  const typedNumber = (): number => (typed === null ? Number.NaN : Number.parseInt(typed, 10));

  const commitTyped = (): void => {
    if (typed === null) return;
    const parsed = typedNumber();
    setTyped(null);
    if (Number.isFinite(parsed)) onChange(clamp(parsed));
  };

  // An arrow key steps from what is typed, when something is, and commits it:
  // stepping from the committed value would leave the typed text showing, and
  // the blur would then commit it over the step.
  const stepBy = (delta: number): void => {
    const parsed = typedNumber();
    setTyped(null);
    onChange(clamp((Number.isFinite(parsed) ? parsed : value) + delta));
  };

  const stepButtonClass = 'flex h-[30px] w-[30px] cursor-pointer select-none items-center justify-center text-fg-muted '
    + 'transition-colors hover:text-fg-secondary disabled:cursor-default disabled:text-fg-disabled';

  return (
    <span
      data-testid={testId}
      className={`inline-flex h-8 flex-shrink-0 items-center rounded border border-edge-input bg-surface-control text-sm text-fg-tertiary ${disabled ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        aria-label={t`Fewer: ${ariaLabel}`}
        data-testid={testId ? `${testId}-decrement` : undefined}
        disabled={disabled || value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className={stepButtonClass}
      >
        <Minus size={14} />
      </button>
      <input
        type="text"
        inputMode="numeric"
        aria-label={ariaLabel}
        data-testid={testId ? `${testId}-value` : undefined}
        disabled={disabled}
        value={typed ?? String(value)}
        onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commitTyped}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commitTyped();
          if (event.key === 'ArrowUp') { event.preventDefault(); stepBy(1); }
          if (event.key === 'ArrowDown') { event.preventDefault(); stepBy(-1); }
        }}
        className="h-[30px] w-9 border-x border-edge-input bg-transparent text-center tabular-nums text-fg-secondary focus:outline-none disabled:cursor-default"
      />
      <button
        type="button"
        aria-label={t`More: ${ariaLabel}`}
        data-testid={testId ? `${testId}-increment` : undefined}
        disabled={disabled || value >= max}
        onClick={() => onChange(clamp(value + 1))}
        className={stepButtonClass}
      >
        <Plus size={14} />
      </button>
    </span>
  );
}

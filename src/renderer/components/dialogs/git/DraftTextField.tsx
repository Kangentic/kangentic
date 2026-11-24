import { useCallback, useLayoutEffect, useRef } from 'react';
import { Sparkle } from 'lucide-react';
import { Tooltip } from '../../Tooltip';
import { FIELD_CONTROL_CLASS } from '../../Field';

const MIN_ROWS = 6;
const MAX_ROWS = 14;
/** `text-sm` line height, and the field's own vertical padding and border. */
const LINE_PX = 20;
const CHROME_PX = 18;

interface DraftTextFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** A draft is being written: the field is blocked under the working sparkle. */
  drafting: boolean;
  draftingLabel: string;
  /** Write a new draft. Absent hides the sparkle: no Automation agent is set up. */
  onDraft?: () => void;
  draftTip: string;
  disabled?: boolean;
  testId: string;
}

/**
 * A long text an agent drafts and the user edits: a commit message, a pull
 * request description. It opens at 6 rows, grows with its text to 14 and then
 * scrolls, and its grip resizes it past either. Once the user has sized it, the
 * text no longer does.
 */
export function DraftTextField({
  label, value, onChange, placeholder, drafting, draftingLabel, onDraft, draftTip, disabled = false, testId,
}: DraftTextFieldProps) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const ownHeightRef = useRef<number | null>(null);
  const sizedByUserRef = useRef(false);

  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field || sizedByUserRef.current) return;
    if (ownHeightRef.current !== null && Math.abs(field.offsetHeight - ownHeightRef.current) > 2) {
      sizedByUserRef.current = true;
      return;
    }
    field.style.height = 'auto';
    const wanted = Math.min(Math.max(field.scrollHeight + 2, MIN_ROWS * LINE_PX + CHROME_PX), MAX_ROWS * LINE_PX + CHROME_PX);
    field.style.height = `${wanted}px`;
    ownHeightRef.current = field.offsetHeight;
  }, [value]);

  const handleChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => onChange(event.target.value), [onChange]);

  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-fg-muted">{label}</span>
      <span className="relative block">
        <textarea
          ref={fieldRef}
          value={value}
          onChange={handleChange}
          placeholder={placeholder}
          // Read-only, not disabled, while a draft is written: a disabled field cannot hold the dialog's focus.
          readOnly={drafting}
          disabled={disabled}
          rows={MIN_ROWS}
          spellCheck
          data-initial-focus
          data-testid={testId}
          className={`${FIELD_CONTROL_CLASS} block min-h-[138px] resize-y leading-5 ${onDraft ? 'pr-10' : ''} ${drafting ? 'opacity-60' : ''} disabled:opacity-60`}
        />
        {onDraft && (
          <Tooltip label={draftTip}>
            <button
              type="button"
              onClick={(event) => { event.preventDefault(); onDraft(); }}
              disabled={drafting || disabled}
              aria-label={draftTip}
              data-testid={`${testId}-draft`}
              className="absolute right-2 top-2 inline-flex size-6 items-center justify-center rounded border border-edge bg-surface-hover text-fg-secondary transition-colors hover:border-edge-input hover:text-fg disabled:cursor-default disabled:opacity-50"
            >
              <Sparkle size={13} />
            </button>
          </Tooltip>
        )}
        {drafting && (
          <span
            className="pointer-events-none absolute inset-0 flex select-none items-center justify-center gap-2 text-xs text-fg-secondary"
            role="status"
            data-testid={`${testId}-drafting`}
          >
            <span aria-hidden="true" className="kng-twinkle flex"><Sparkle size={14} /></span>
            {draftingLabel}
          </span>
        )}
      </span>
    </label>
  );
}

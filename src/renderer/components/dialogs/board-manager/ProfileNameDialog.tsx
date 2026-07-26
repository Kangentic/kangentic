import { useEffect, useRef } from 'react';
import { Info } from 'lucide-react';
import { BaseDialog } from '../BaseDialog';

const TITLES: Record<'new' | 'duplicate' | 'rename', string> = {
  new: 'New profile',
  duplicate: 'Duplicate profile',
  rename: 'Rename profile',
};

/**
 * Naming the SOURCE says more in fewer words than describing the mechanism.
 * A new profile carries no overrides, so every column resolves to the board's
 * own settings - which is exactly what "Default" means here. Duplicate names
 * the profile it copies instead.
 */
function describe(mode: 'new' | 'duplicate' | 'rename', sourceName: string): string {
  if (mode === 'rename') return 'Only the label changes. Tasks already using this profile stay on it.';
  return `Inherits every column's settings from ${sourceName}.`;
}

/**
 * Name prompt for creating, duplicating, or renaming a Board Profile.
 *
 * A profile requires a unique name because the name is how it is picked in the
 * task context bar. Uniqueness is enforced here rather than at save time so the
 * user finds out while they are still typing.
 */
export function ProfileNameDialog({
  mode,
  value,
  existingNames,
  sourceName,
  onChange,
  onConfirm,
  onCancel,
}: {
  mode: 'new' | 'duplicate' | 'rename';
  value: string;
  /** Names already taken, excluding the profile being renamed. */
  existingNames: string[];
  /** Profile the new one inherits from: "Default" for New, the copied profile's name for Duplicate. */
  sourceName: string;
  onChange: (value: string) => void;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const trimmed = value.trim();
  const isDuplicateName = existingNames.some(
    (name) => name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  const canConfirm = trimmed.length > 0 && !isDuplicateName;

  return (
    <BaseDialog title={TITLES[mode]} onClose={onCancel}>
      <div className="space-y-3">
        {/* The name field leads: naming the profile is the task, and the
            explanation below is support for it. Leading with prose made the
            user read an paragraph before reaching the one control. */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          maxLength={60}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canConfirm) {
              event.preventDefault();
              onConfirm(trimmed);
            }
          }}
          // A profile varies agent, model, and effort, so the axis users pick
          // along is task complexity (and the cost that follows from it), not
          // an abstract quality tier.
          placeholder="e.g. Simple or Complex"
          className="w-full px-3 py-2 bg-surface border border-edge rounded text-sm text-fg
            focus:outline-none focus:border-accent"
          data-testid="profile-name-input"
        />

        {isDuplicateName && (
          <p className="text-sm text-warning" data-testid="profile-name-error">
            A profile named &quot;{trimmed}&quot; already exists.
          </p>
        )}

        <div className="flex items-center gap-2 px-3 py-2 rounded bg-surface/60 border border-edge/50">
          <Info size={14} className="flex-shrink-0 text-fg-faint" />
          <span className="text-sm text-fg-muted">{describe(mode, sourceName)}</span>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            data-testid="profile-name-cancel"
            className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg rounded hover:bg-surface-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(trimmed)}
            disabled={!canConfirm}
            className="px-3 py-1.5 text-sm rounded bg-accent text-on-accent
              disabled:opacity-40 disabled:pointer-events-none"
            data-testid="profile-name-confirm"
          >
            {mode === 'rename' ? 'Rename' : 'Create'}
          </button>
        </div>
      </div>
    </BaseDialog>
  );
}

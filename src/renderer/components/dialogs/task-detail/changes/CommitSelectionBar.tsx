import { X } from 'lucide-react';
import { Tooltip } from '../../../Tooltip';

/**
 * The selected commit, in the slot the Working / Staged / Branch control holds
 * while no commit is selected: its hash and subject, and an x that goes back
 * (Escape does too). Tinted like the selected History row, so the two read as
 * one selection. 30px with its border, the scope control's own height, inside
 * the same wrapper, so closing it moves nothing below.
 *
 * The hash and subject sit on one baseline, which centers their ink on the bar
 * within half a pixel (measured on the rendered bar; a flex `items-center` on
 * two font sizes left the hash 0.8px high and the subject 0.8px low).
 */
export function CommitSelectionBar({ shortHash, subject, backLabel, onClose }: {
  shortHash: string;
  /** Null while a restored selection's subject is not known yet. */
  subject: string | null;
  /** Where the x goes: "Back to Working", "Back to all changes". */
  backLabel: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex h-[30px] min-w-0 items-center gap-1.5 rounded border border-accent/45 bg-accent/10 pl-2 pr-1 text-xs"
      data-testid="commit-selection-bar"
    >
      <Tooltip label={subject ? `${shortHash} ${subject}` : ''}>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5 leading-4">
          <span className="flex-shrink-0 font-mono text-[11px] text-accent-fg" data-testid="commit-selection-hash">{shortHash}</span>
          {subject && <span className="min-w-0 truncate text-fg" data-testid="commit-selection-subject">{subject}</span>}
        </span>
      </Tooltip>
      <Tooltip label={backLabel}>
        <button
          type="button"
          onClick={onClose}
          aria-label="Deselect commit"
          className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-accent-fg transition-colors hover:bg-accent/25 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          data-testid="commit-selection-close"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      </Tooltip>
    </div>
  );
}

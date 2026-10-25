/**
 * Add terminal, the Command Terminal's main action: "Add", as "Add task" and
 * "Add column" are, because "New terminal" read as replacing the one already
 * open. Drawn two ways while both places are tried: an icon in the panel's header beside its window controls
 * (and in the detached window's title bar the same way), a short trip from the
 * title-bar toggle that opens the panel; and a labelled button at the top of
 * the rail, at the head of the list it starts. Off with its reason while every
 * slot is taken.
 */

import { SquarePlus } from 'lucide-react';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';

interface NewTerminalButtonProps {
  /** `icon` sits among the header's window controls; `rail` fills the rail's width. */
  variant: 'icon' | 'rail';
  onNewTerminal: () => void;
  /** Why it is off right now (every slot taken), or null when it is on. */
  disabledReason: string | null;
}

export function NewTerminalButton({ variant, onNewTerminal, disabledReason }: NewTerminalButtonProps) {
  const disabled = disabledReason !== null;
  if (variant === 'icon') {
    return (
      <Tooltip label={tipLabel({ disabled, disabledReason, tip: 'Start another terminal' })}>
        <button
          type="button"
          onClick={onNewTerminal}
          disabled={disabled}
          className="p-1.5 text-fg-muted hover:text-fg hover:bg-surface-hover rounded transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
          aria-label="Add terminal"
          data-testid="command-terminal-new"
        >
          <SquarePlus size={15} />
        </button>
      </Tooltip>
    );
  }
  return (
    <Tooltip label={tipLabel({ disabled, disabledReason })}>
      <button
        type="button"
        onClick={onNewTerminal}
        disabled={disabled}
        className="flex h-[38px] w-full items-center justify-center gap-2 rounded-lg border border-accent/30 bg-accent/15 px-3 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/15"
        data-testid="command-terminal-rail-new"
      >
        <SquarePlus size={16} strokeWidth={2.25} />
        {/* Trimmed to its cap height so it centers on the plus, as Pill's text does. */}
        <span className="[text-box:trim-both_cap_alphabetic]">Add terminal</span>
      </button>
    </Tooltip>
  );
}

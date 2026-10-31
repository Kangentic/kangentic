/**
 * Add terminal, the Command Terminal's main action: "Add", as "Add task" and
 * "Add column" are, because "New terminal" read as replacing the one already
 * open. A labelled button at the top of the rail, at the head of the list it
 * starts, in the panel and in the detached window alike. It was also tried as an
 * icon among the panel header's window controls, and dropped to keep that row to
 * the window controls. Off with its reason while every slot is taken.
 */

import { SquarePlus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Tooltip } from '../Tooltip';
import { tipLabel } from '../../utils/tooltip';

interface NewTerminalButtonProps {
  onNewTerminal: () => void;
  /** Why it is off right now (every slot taken), or null when it is on. */
  disabledReason: string | null;
  /** The collapsed rail's form: the plus alone, centred on the open button's row. */
  compact?: boolean;
}

export function NewTerminalButton({ onNewTerminal, disabledReason, compact = false }: NewTerminalButtonProps) {
  const { t } = useLingui();
  const disabled = disabledReason !== null;
  if (compact) {
    return (
      <Tooltip label={tipLabel({ disabled, disabledReason, tip: t`Add terminal` })}>
        <button
          type="button"
          onClick={onNewTerminal}
          disabled={disabled}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-accent/30 bg-accent/15 text-accent-fg transition-colors hover:bg-accent/25 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent/15"
          aria-label={t`Add terminal`}
          data-testid="command-terminal-new"
        >
          <SquarePlus size={16} strokeWidth={2.25} />
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
        data-testid="command-terminal-new"
      >
        <SquarePlus size={16} strokeWidth={2.25} />
        {/* Trimmed to its cap height so it centers on the plus, as Pill's text does. */}
        <span className="[text-box:trim-both_cap_alphabetic]"><Trans>Add terminal</Trans></span>
      </button>
    </Tooltip>
  );
}

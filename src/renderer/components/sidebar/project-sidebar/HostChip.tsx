import { CircleExclamationPoint, Loader2, Server } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { IconSlot } from '../../IconSlot';
import { Tooltip } from '../../Tooltip';
import { useSshStore } from '../../../stores/ssh-store';

/**
 * A 20 by 20 square after a remote project's name (#913): a server icon while its host is connected, a
 * grey spinner while the link comes back, a red warning when the host cannot be reached. The host and its
 * state are in the hover tip. Amber is not used here: it is reserved for "an agent needs you".
 *
 * The glyph changes element type with the state, inside a row that is itself a button, so it renders
 * through `IconSlot` (`.claude/rules/activity-marks.md`) or a push that swapped it mid-click would drop the
 * row's click.
 */
export function HostChip({ hostId }: { hostId: string }) {
  const { t } = useLingui();
  const status = useSshStore((state) => state.hosts.find((candidate) => candidate.host.id === hostId));
  // A host the store has not listed yet, or one removed from under its projects: nothing to say.
  if (!status) return null;

  const hostName = status.host.name;
  const state = status.state;
  // The same words the SSH tab and the Add project chooser use for each state.
  const stateLabel = state === 'connected'
    ? t`Connected`
    : state === 'unreachable'
      ? t`Unreachable`
      : state === 'stopped'
        ? t`Stopped`
        : state === 'connecting'
          ? t`Connecting…`
          : t`Reconnecting…`;
  const unreachable = state === 'unreachable';
  const waiting = state === 'connecting' || state === 'reconnecting';

  return (
    <Tooltip label={t`${hostName}: ${stateLabel}`}>
      <IconSlot
        size={20}
        className={`shrink-0 rounded border ${unreachable ? 'border-danger/50 text-danger' : 'border-edge text-fg-faint'}`}
        data-testid="project-host-chip"
        data-host-state={state}
      >
        {unreachable
          ? <CircleExclamationPoint size={12} aria-hidden="true" />
          : waiting
            ? <Loader2 size={12} className="animate-spin" aria-hidden="true" />
            : <Server size={12} aria-hidden="true" />}
      </IconSlot>
    </Tooltip>
  );
}

import { useState } from 'react';
import { CircleAlert, Loader2, RefreshCw } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { Project } from '../../../shared/types';
import { useSshStore } from '../../stores/ssh-store';

/**
 * A strip above the board, only while the open project's host is not connected (#913). The board is a
 * local database, so it keeps working; what stops is anything that needs the host. The strip says that
 * the agents on the host keep running, and offers Reconnect while the host is unreachable. It is neutral
 * while the link comes back by itself and red once it has not: amber stays reserved for "an agent needs
 * you". A connected host, or a project on this computer, draws nothing.
 */
export function HostDegradedStrip({ project }: { project: Project }) {
  const { t } = useLingui();
  const hostId = project.remote?.hostId ?? null;
  const status = useSshStore((state) => (hostId ? state.hosts.find((candidate) => candidate.host.id === hostId) : undefined));
  const reconnectHost = useSshStore((state) => state.reconnectHost);
  const [reconnecting, setReconnecting] = useState(false);

  if (!status || status.state === 'connected') return null;

  const hostName = status.host.name;
  const unreachable = status.state === 'unreachable';
  const waiting = status.state === 'connecting' || status.state === 'reconnecting';

  async function handleReconnect(): Promise<void> {
    setReconnecting(true);
    try {
      await reconnectHost(status?.host.id ?? '');
    } catch {
      // The host's row in Settings shows the reason; the strip stays until the state changes.
    } finally {
      setReconnecting(false);
    }
  }

  return (
    <div
      role="status"
      data-testid="host-degraded-strip"
      data-host-state={status.state}
      className={`flex items-center gap-2 border-b px-4 py-1.5 text-xs ${
        unreachable ? 'border-danger/40 bg-danger/10 text-danger' : 'border-edge bg-surface-hover/40 text-fg-muted'
      }`}
    >
      {waiting ? <Loader2 size={13} className="shrink-0 animate-spin" aria-hidden="true" /> : <CircleAlert size={13} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">
        {unreachable
          ? <Trans>{hostName} is unreachable. Its agents keep running.</Trans>
          : <Trans>Reconnecting to {hostName}. Its agents keep running.</Trans>}
      </span>
      {unreachable ? (
        <button
          type="button"
          disabled={reconnecting}
          onClick={() => void handleReconnect()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-current/40 px-2 py-0.5 hover:bg-surface-hover/60 disabled:opacity-50"
          data-testid="host-degraded-reconnect"
          aria-label={t`Reconnect to ${hostName}`}
        >
          <RefreshCw size={12} aria-hidden="true" />
          <Trans>Reconnect</Trans>
        </button>
      ) : null}
    </div>
  );
}

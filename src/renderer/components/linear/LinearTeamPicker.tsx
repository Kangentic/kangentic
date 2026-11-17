import { useEffect, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { ArtifactPlatformLogo } from '../VendorMark';
import { reportRendererFailure } from '../../utils/renderer-failure';
import type { SourcePickerProps } from '../backlog/import-providers';
import type { LinearTeamSummary } from '../../../shared/types';

/**
 * The team step of Add Source for Linear: the teams the saved sign-in can see,
 * each a button that adds it as a source. A team already saved says Added and
 * opens it. Replaces the URL field the other providers show.
 */
export function LinearTeamPicker({
  existingSources,
  onPick,
  onOpenExisting,
  onBack,
  onAuthFailed,
  busy,
  error,
}: SourcePickerProps) {
  const [teams, setTeams] = useState<LinearTeamSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.backlog.linear.listTeams().then((result) => {
      if (cancelled) return;
      if (result.error) {
        onAuthFailed(result.error);
        return;
      }
      setTeams(result.teams);
    }).catch((listError: unknown) => {
      // A rejection is not Linear refusing the sign-in (that comes back as
      // `result.error`): no network, or a defect. Show it here rather than
      // sending the user to Connect again.
      reportRendererFailure('linear', 'list-teams', listError);
      if (!cancelled) setLoadError(listError instanceof Error ? listError.message : String(listError));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list loads once per mount; onAuthFailed is a fresh closure each render of the popover
  }, []);

  const savedSourceFor = (team: LinearTeamSummary) =>
    existingSources.find((source) => source.source === 'linear' && source.repository === team.key);

  return (
    <div data-testid="linear-team-picker">
      <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-1.5">
        <span className="w-5 flex justify-center text-fg-muted shrink-0">
          <ArtifactPlatformLogo platformId="linear" size={16} />
        </span>
        <span className="text-xs font-medium text-fg"><Trans>Choose a team</Trans></span>
        {busy && <LoaderCircle size={12} className="animate-spin text-fg-faint ml-auto" />}
      </div>

      {teams === null && loadError === null && (
        <div className="flex justify-center py-4" data-testid="linear-team-picker-loading">
          <LoaderCircle size={16} className="animate-spin text-fg-faint" />
        </div>
      )}

      {loadError !== null && (
        <p className="px-3 py-3 text-xs text-danger" data-testid="linear-team-picker-load-error">{loadError}</p>
      )}

      {teams !== null && teams.length === 0 && (
        <div className="px-3 py-3 text-sm text-fg-faint" data-testid="linear-team-picker-empty">
          <Trans>No teams are visible to this sign-in.</Trans>
        </div>
      )}

      {teams !== null && teams.length > 0 && (
        <div className="max-h-[216px] overflow-y-auto">
          {teams.map((team) => {
            const savedSource = savedSourceFor(team);
            return (
              <button
                key={team.id}
                type="button"
                disabled={busy}
                onClick={() => (savedSource ? onOpenExisting(savedSource) : onPick(team.url))}
                className="flex items-center gap-2.5 w-full px-3 py-2 text-left hover:bg-surface-hover/40 transition-colors disabled:opacity-50"
                data-testid={`linear-team-${team.key}`}
              >
                <span className="w-9 shrink-0 font-mono text-xs text-fg-faint">{team.key}</span>
                <span className="flex-1 min-w-0 truncate text-sm text-fg">{team.name}</span>
                {savedSource && (
                  <span className="text-[11px] text-fg-faint shrink-0"><Trans context="import source">Added</Trans></span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-danger" data-testid="import-source-error">{error}</p>}

      <div className="px-3 py-2 border-t border-edge/50">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg transition-colors"
          data-testid="linear-team-picker-back-btn"
        >
          <ArrowLeft size={12} />
          <Trans context="button">Back</Trans>
        </button>
      </div>
    </div>
  );
}

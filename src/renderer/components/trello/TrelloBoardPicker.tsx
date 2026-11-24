import { useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { ArrowLeft, LoaderCircle } from 'lucide-react';
import { ArtifactPlatformLogo } from '../VendorMark';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { rejectionMessage } from '../../lib/ipc-error';
import type { SourcePickerProps } from '../backlog/import-providers';
import type { TrelloBoardSummary } from '../../../shared/types';
import { groupBoardsByWorkspace } from './group-boards';

/**
 * The board step of Add Source for Trello: the open boards the saved token can see, under their
 * Workspace, each a button that adds it as a source. A board already saved says Added and opens
 * it. Replaces the URL field the other providers show.
 */
export function TrelloBoardPicker({
  existingSources,
  onPick,
  onOpenExisting,
  onBack,
  onAuthFailed,
  busy,
  error,
}: SourcePickerProps) {
  const [boards, setBoards] = useState<TrelloBoardSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.backlog.trello.listBoards().then((result) => {
      if (cancelled) return;
      if (result.error) {
        onAuthFailed(result.error);
        return;
      }
      setBoards(result.boards);
    }).catch((listError: unknown) => {
      // A rejection is not Trello refusing the token (that comes back as `result.error`): no
      // network, or a defect. Show it here rather than sending the user to Connect again.
      reportRendererFailure('trello', 'list-boards', listError);
      if (!cancelled) setLoadError(rejectionMessage(listError));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the list loads once per mount; onAuthFailed is a fresh closure each render of the popover
  }, []);

  const groups = useMemo(() => (boards ? groupBoardsByWorkspace(boards) : []), [boards]);

  const savedSourceFor = (board: TrelloBoardSummary) =>
    existingSources.find((source) => source.source === 'trello' && source.repository === board.shortLink);

  return (
    <div data-testid="trello-board-picker">
      <div className="flex items-center gap-2.5 px-3 pt-2.5 pb-1.5">
        <span className="w-5 flex justify-center text-fg-muted shrink-0">
          <ArtifactPlatformLogo platformId="trello" size={15} />
        </span>
        <span className="text-xs font-medium text-fg"><Trans>Choose a board</Trans></span>
        {busy && <LoaderCircle size={12} className="animate-spin text-fg-faint ml-auto" />}
      </div>

      {boards === null && loadError === null && (
        <div className="flex justify-center py-4" data-testid="trello-board-picker-loading">
          <LoaderCircle size={16} className="animate-spin text-fg-faint" />
        </div>
      )}

      {loadError !== null && (
        <p className="px-3 py-3 text-xs text-danger" data-testid="trello-board-picker-load-error">{loadError}</p>
      )}

      {boards !== null && boards.length === 0 && (
        <div className="px-3 py-3 text-sm text-fg-faint" data-testid="trello-board-picker-empty">
          <Trans>No open boards are visible to this token.</Trans>
        </div>
      )}

      {groups.length > 0 && (
        <div className="max-h-[320px] overflow-y-auto">
          {groups.map((group) => (
            <div key={group.name ?? ''} data-testid="trello-workspace-group">
              <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-faint truncate">
                {group.name ?? <Trans>Other boards</Trans>}
              </div>
              {group.boards.map((board) => {
                const savedSource = savedSourceFor(board);
                return (
                  <button
                    key={board.id}
                    type="button"
                    disabled={busy}
                    onClick={() => (savedSource ? onOpenExisting(savedSource) : onPick(board.url))}
                    className="flex items-center gap-2.5 w-full pl-5 pr-3 py-1.5 text-left hover:bg-surface-hover/40 transition-colors disabled:opacity-50"
                    data-testid={`trello-board-${board.shortLink}`}
                  >
                    <span className="flex-1 min-w-0 truncate text-sm text-fg">{board.name}</span>
                    {savedSource && (
                      <span className="text-[11px] text-fg-faint shrink-0"><Trans context="import source">Added</Trans></span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {error && <p className="px-3 pb-2 text-xs text-danger" data-testid="import-source-error">{error}</p>}

      <div className="px-3 py-2 border-t border-edge/50">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-fg-faint hover:text-fg transition-colors"
          data-testid="trello-board-picker-back-btn"
        >
          <ArrowLeft size={12} />
          <Trans context="button">Back</Trans>
        </button>
      </div>
    </div>
  );
}

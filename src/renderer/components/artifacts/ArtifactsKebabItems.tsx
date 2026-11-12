import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Shapes } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { useLinkOpener } from '../../hooks/useLinkOpener';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { KebabMenuItem } from '../KebabMenu';
import { ArtifactPlatformLogo } from '../VendorMark';
import { ARTIFACT_ROW_LAYOUT_CLASS, ArtifactRowContent } from './ArtifactsMenu';
import { listArtifacts } from '../../../shared/task-artifacts';
import type { Task } from '../../../shared/types';

/**
 * A task's artifacts in the task window's actions menu, so the menu stays the
 * complete action set when the header's Artifacts button folds into it. One
 * artifact is one item that opens it. Several are an "Artifacts" flyout, built
 * like Move to: hover or click opens it, and each row opens its link.
 *
 * A row opens the way the header button does: the chosen browser on a click,
 * the other on Ctrl or Cmd click. Nothing for a task with no artifacts.
 */
export function ArtifactsKebabItems({ task, close }: { task: Pick<Task, 'id' | 'artifacts'>; close: () => void }) {
  const { t } = useLingui();
  const items = useMemo(() => listArtifacts(task.artifacts ?? []), [task.artifacts]);
  const opener = useLinkOpener(task.id);
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const { placement } = usePopoverPosition(triggerRef, flyoutRef, flyoutOpen, { mode: 'flyout' });

  if (items.length === 0) return null;

  if (items.length === 1) {
    const only = items[0];
    return (
      <KebabMenuItem
        icon={<ArtifactPlatformLogo platformId={only.platformId} size={14} />}
        label={only.name}
        onClick={(event) => { close(); opener.open(only.artifact.url, event); }}
        data-testid="kebab-artifact"
      />
    );
  }

  return (
    <div
      ref={triggerRef}
      className="relative"
      onMouseEnter={() => setFlyoutOpen(true)}
      onMouseLeave={() => setFlyoutOpen(false)}
    >
      <button
        onClick={() => setFlyoutOpen(!flyoutOpen)}
        className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${flyoutOpen ? 'bg-surface-hover text-fg' : ''}`}
        aria-expanded={flyoutOpen}
        data-testid="kebab-artifacts-button"
      >
        <Shapes size={14} />
        <span className="flex-1">{t`Artifacts`}</span>
        {placement.horizontal === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>
      {flyoutOpen && (
        <div
          ref={flyoutRef}
          style={{ transformOrigin: placement.horizontal === 'left' ? 'right center' : 'left center' }}
          className="absolute z-50 flex max-h-[256px] w-[260px] flex-col overflow-y-auto rounded-md border border-edge-input bg-surface-raised py-1 shadow-xl overlay-popover-in"
          data-testid="kebab-artifacts-flyout"
        >
          {items.map((item) => (
            <button
              key={item.artifact.url}
              onClick={(event) => { close(); opener.open(item.artifact.url, event); }}
              className={ARTIFACT_ROW_LAYOUT_CLASS}
              data-artifact-url={item.artifact.url}
            >
              <ArtifactRowContent item={item} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

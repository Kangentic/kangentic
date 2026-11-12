import { useCallback, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ChevronDown, ChevronUp, ExternalLink, Shapes } from 'lucide-react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { useLinkOpener } from '../../hooks/useLinkOpener';
import { HeaderActionButton } from '../HeaderActionButton';
import { Pill } from '../Pill';
import { Tooltip } from '../Tooltip';
import { ArtifactPlatformLogo } from '../VendorMark';
import { listArtifacts } from '../../../shared/task-artifacts';
import type { Task } from '../../../shared/types';
import { ArtifactsMenu } from './ArtifactsMenu';
import { countStepShowsWord, useArtifactCountStep } from './useArtifactCountStep';

/**
 * Where a task's artifacts show (#1056):
 * - `card`: the chip on a board card, alone or beside the PR pill. It fills the
 *   slot the card's link row gives it (`task-card-view.tsx`).
 * - `header`: an icon button in the task window's header.
 * - `metric`: the count in a completed task's strip.
 */
export type ArtifactsChipVariant = 'card' | 'header' | 'metric';

interface ArtifactsChipProps {
  task: Pick<Task, 'id' | 'artifacts'>;
  variant: ArtifactsChipVariant;
  /** Opens the task's edit form at Artifacts, from the menu's last row. Absent where the task cannot be edited. */
  onEdit?: () => void;
  testId: string;
}

/** The chip at rest, and while its menu is open: the same shape, pressed. */
const CARD_REST_CLASS = 'bg-surface-hover/50 text-fg-muted ring-1 ring-fg-muted/20 hover:brightness-125';
const CARD_PRESSED_CLASS = 'bg-surface-hover text-fg ring-1 ring-fg-muted/35';
const METRIC_CLASS = 'inline-flex items-center gap-[5px] rounded text-fg hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-accent';

/**
 * A task's artifacts as one control. Nothing for a task with none.
 *
 * One artifact: the control opens it, and its tip names it, says where it goes
 * and what each click does. Several: the control opens the menu, which lists
 * them. A click and Ctrl or Cmd click open the two browsers the same way a PR
 * pill and a terminal link do (`useLinkOpener`).
 *
 * On a card the control sits inside the card's own click and drag target, so
 * its click stops there.
 */
export function ArtifactsChip({ task, variant, onEdit, testId }: ArtifactsChipProps) {
  const { t } = useLingui();
  const items = useMemo(() => listArtifacts(task.artifacts ?? []), [task.artifacts]);
  const opener = useLinkOpener(task.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const chipRef = useRef<HTMLElement>(null);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const count = items.length;
  const countLabel = t`${plural(count, { one: '# artifact', other: '# artifacts' })}`;
  const countStep = useArtifactCountStep(chipRef, countLabel, variant === 'card' && count > 1);

  if (count === 0) return null;

  const only = count === 1 ? items[0] : null;

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    if (only) opener.open(only.artifact.url, event);
    else setMenuOpen((open) => !open);
  };

  const menu = only ? null : (
    <ArtifactsMenu
      open={menuOpen}
      onClose={closeMenu}
      anchorRef={anchorRef}
      items={items}
      opener={opener}
      onEdit={onEdit}
      testId={`${testId}-menu`}
    />
  );

  if (variant === 'header') {
    return (
      <span ref={anchorRef} className="relative flex flex-shrink-0">
        <HeaderActionButton
          icon={Shapes}
          onClick={handleClick}
          active={menuOpen}
          expanded={only ? undefined : menuOpen}
          tip={only ? `${only.name}, ${only.tool}` : countLabel}
          linkTip={only ? { rows: opener.rows, destination: only.artifact.url } : undefined}
          tipEnabled={!menuOpen}
          ariaLabel={only ? t`Open artifact` : t`Artifacts`}
          testId={testId}
        />
        {menu}
      </span>
    );
  }

  if (variant === 'metric') {
    return (
      <span ref={anchorRef} className="relative inline-flex">
        <Tooltip
          label={only ? `${only.name}, ${only.tool}` : countLabel}
          destination={only?.artifact.url}
          rows={only ? opener.rows : undefined}
          enabled={!menuOpen}
        >
          <button
            type="button"
            onClick={handleClick}
            aria-expanded={only ? undefined : menuOpen}
            aria-label={only ? t`Open artifact` : t`Artifacts`}
            className={METRIC_CLASS}
            data-testid={testId}
          >
            <Shapes size={14} aria-hidden="true" />
            {count}
          </button>
        </Tooltip>
        {menu}
      </span>
    );
  }

  // One artifact: its name and tool. A count: nothing while its word shows, the
  // word once a step hides it. An empty label holds the tip shut.
  const cardTipLabel = only
    ? `${only.name}, ${only.tool}`
    : countStepShowsWord(countStep) ? '' : countLabel;
  // The chevron's classes: hidden on the two steps that drop it. The step names
  // here and on the two spans below match `countStepShowsWord` and
  // `countStepShowsChevron` (`useArtifactCountStep.ts`).
  const chevronClass = 'flex-shrink-0 opacity-60 group-data-[count-step=word]/count:hidden group-data-[count-step=number]/count:hidden';
  return (
    // Fills its slot: the whole row alone, the rest of it beside a PR pill, or
    // half of it beside a PR pill when it is a count.
    <span ref={anchorRef} className="relative flex min-w-0 flex-1">
      <Tooltip
        label={cardTipLabel}
        destination={only?.artifact.url}
        rows={only ? opener.rows : undefined}
        enabled={!menuOpen}
        // The chip's aria-label already names the count.
        describe={only ? undefined : false}
      >
        <Pill
          ref={chipRef}
          shape="square"
          size="xs"
          justify="start"
          onClick={handleClick}
          aria-expanded={only ? undefined : menuOpen}
          // The count's word can be hidden (below), so the name is said here.
          aria-label={only ? undefined : countLabel}
          className={`group/count w-full min-w-0 transition-colors ${menuOpen ? CARD_PRESSED_CLASS : CARD_REST_CLASS}`}
          data-testid={testId}
          data-artifact-count={count}
          data-count-step={only ? undefined : countStep}
        >
          {only ? (
            <>
              <ArtifactPlatformLogo platformId={only.platformId} size={13} />
              <span className="min-w-0 truncate">{only.name}</span>
              <ExternalLink size={11} className="flex-shrink-0 opacity-60" aria-hidden="true" />
            </>
          ) : (
            <>
              <Shapes size={13} className="flex-shrink-0" aria-hidden="true" />
              {/* Never two lines: the label wrapped inside the chip at Narrow
                  and made the chip taller than the PR pill beside it. */}
              <span
                className="min-w-0 truncate group-data-[count-step=number-chevron]/count:hidden group-data-[count-step=number]/count:hidden"
              >
                {countLabel}
              </span>
              <span
                className="hidden group-data-[count-step=number-chevron]/count:inline group-data-[count-step=number]/count:inline"
                aria-hidden="true"
              >
                {count}
              </span>
              {menuOpen
                ? <ChevronUp size={11} className={chevronClass} aria-hidden="true" />
                : <ChevronDown size={11} className={chevronClass} aria-hidden="true" />}
            </>
          )}
        </Pill>
      </Tooltip>
      {menu}
    </span>
  );
}

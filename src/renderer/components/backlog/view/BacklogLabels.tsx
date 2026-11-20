import { useMemo } from 'react';
import { useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { Pill, labelPillLook } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { measureTextWidth } from '../../../utils/text-measure';
import { layoutLabels } from './column-widths';

/**
 * A backlog row's labels on one line (task #1142). As many as fit the cell show in order; the rest
 * fold into a "+N" chip whose tip lists them. The chip takes Tab focus, so the tip opens from the
 * keyboard too. A first label wider than its room ends in an ellipsis, with its name in a tip.
 * The fit is computed from the label text, so it holds for rows the virtualizer has not mounted.
 */
export function BacklogLabels({ labels, labelColors, fontFamily }: {
  labels: readonly string[];
  labelColors: Record<string, string>;
  /** The body's font family, read once by the column hook. */
  fontFamily: string;
}) {
  const { t } = useLingui();

  const layout = useMemo(
    () => layoutLabels(labels, labelColors, measureTextWidth, fontFamily),
    [labels, labelColors, fontFamily],
  );

  const shown = labels.slice(0, layout.shownCount);
  const hidden = labels.slice(layout.shownCount);
  const hiddenCount = hidden.length;

  return (
    <div className="flex flex-nowrap items-center gap-1 min-w-0 overflow-hidden" data-testid="backlog-labels">
      {shown.map((label, index) => {
        const look = labelPillLook(labelColors[label]);
        const truncates = index === 0 && layout.firstTruncates;
        const pill = (
          <Pill
            key={label}
            as="span"
            size="sm"
            justify={truncates ? 'start' : 'center'}
            className={`${truncates ? 'min-w-0 shrink' : 'shrink-0'} ${look.className}`}
            style={look.style}
          >
            {truncates ? <span className="truncate min-w-0">{label}</span> : label}
          </Pill>
        );
        return truncates ? <Tooltip key={label} label={label}>{pill}</Tooltip> : pill;
      })}
      {hiddenCount > 0 && (
        <Tooltip label={hidden.join(', ')}>
          {/* role="img" gives the chip a name a screen reader reads ("2 more labels"), as the
              priority pill does; a plain span may not carry an aria-label. The ring is inset
              because the row's overflow-hidden clips anything drawn outside the chip. */}
          <Pill
            as="span"
            size="sm"
            role="img"
            tabIndex={0}
            className={`shrink-0 ${labelPillLook(undefined).className} focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent`}
            aria-label={t`${plural(hiddenCount, { one: '# more label', other: '# more labels' })}`}
            data-testid="backlog-labels-more"
          >
            {`+${hiddenCount}`}
          </Pill>
        </Tooltip>
      )}
    </div>
  );
}

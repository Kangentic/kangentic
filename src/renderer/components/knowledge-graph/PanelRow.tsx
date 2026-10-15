/**
 * The Knowledge Graph's panel row: a label on the left, its value on the right.
 *
 * Shared by the left panel's Index section and the detail panel's metadata,
 * because both hit the same failure independently. Both started as icon + value
 * with no label, and both read as a loose pile of glyphs and text: an icon has to
 * carry the entire meaning of the row, so `#` in front of
 * `drains / pending / bytes` left the user to guess that it was the map region
 * the conversation sits in, and a mismatched glyph actively misleads.
 *
 * Naming the field removes the guess, aligns the values into a scannable column,
 * and leaves the explanation (when there is one) to a hint rather than to
 * iconography.
 */

import { Info } from 'lucide-react';
import { Tooltip } from '../Tooltip';

/**
 * A hint behind an icon rather than a paragraph in the layout. Prose in the
 * layout was the alternative, and it reflowed the panel every time a selection
 * changed.
 *
 * The same info button as the settings cards' `InfoTip`: a real button, so a
 * keyboard user opens the hint by focus, named for what it is about, with the
 * hint as its tip and its description, read without hovering. Tooltip portals
 * the tip to the body, so the panel cannot clip it.
 */
export function InfoHint({ about, text }: { about: string; text: string }) {
  return (
    <Tooltip label={text}>
      <button
        type="button"
        aria-label={`About ${about}`}
        className="inline-flex flex-shrink-0 rounded text-fg-faint hover:text-fg-muted transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent cursor-help"
      >
        <Info size={11} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

export interface PanelRowProps {
  label: string;
  value: React.ReactNode;
  /** `problem` is the attention tone, `ok` is the active accent. Default is plain. */
  tone?: 'neutral' | 'ok' | 'problem';
  hint?: string;
  /** Numeric values align on their digits; prose should not. */
  numeric?: boolean;
}

export function PanelRow({ label, value, tone = 'neutral', hint, numeric = false }: PanelRowProps) {
  // The theme's attention token: a fixed amber shade was unreadable on a
  // light theme.
  const toneClass = tone === 'problem' ? 'text-attention' : tone === 'ok' ? 'text-active' : 'text-fg';
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
        <span>{label}</span>
        {hint ? <InfoHint about={label} text={hint} /> : null}
      </dt>
      <dd className={`min-w-0 truncate text-right text-xs font-medium ${numeric ? 'tabular-nums' : ''} ${toneClass}`}>
        {value}
      </dd>
    </div>
  );
}

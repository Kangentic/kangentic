/**
 * The Memory Graph's panel row: a label on the left, its value on the right.
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

/**
 * A hint behind an icon rather than a paragraph in the layout.
 *
 * Native `title` deliberately: it needs no portal, cannot be clipped by the
 * panel, and costs nothing. `popover-escapes-clipping` governs choice-presenting
 * popovers, not hints, so a custom floating layer would be new machinery for no
 * gain here. Prose in the layout was the alternative and it reflowed the panel
 * every time a selection changed.
 */
export function InfoHint({ text }: { text: string }) {
  return (
    <span
      className="inline-flex cursor-help text-fg-faint hover:text-fg-muted transition-colors"
      title={text}
      aria-label={text}
      role="img"
    >
      <Info size={11} aria-hidden />
    </span>
  );
}

export interface PanelRowProps {
  label: string;
  value: React.ReactNode;
  /** `problem` is amber, `ok` is the active accent. Default is plain. */
  tone?: 'neutral' | 'ok' | 'problem';
  hint?: string;
  /** Numeric values align on their digits; prose should not. */
  numeric?: boolean;
}

export function PanelRow({ label, value, tone = 'neutral', hint, numeric = false }: PanelRowProps) {
  const toneClass = tone === 'problem' ? 'text-amber-300' : tone === 'ok' ? 'text-active' : 'text-fg';
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="flex flex-shrink-0 items-center gap-1.5 text-[11px] text-fg-muted">
        <span>{label}</span>
        {hint ? <InfoHint text={hint} /> : null}
      </dt>
      <dd className={`min-w-0 truncate text-right text-xs font-medium ${numeric ? 'tabular-nums' : ''} ${toneClass}`}>
        {value}
      </dd>
    </div>
  );
}

/** Bytes as the size a person would say out loud. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const megabytes = bytes / 1024 / 1024;
  if (megabytes < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (megabytes < 1024) return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
  return `${(megabytes / 1024).toFixed(2)} GB`;
}

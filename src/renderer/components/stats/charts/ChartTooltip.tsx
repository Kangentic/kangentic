import type { ReactNode } from 'react';

export interface ChartTooltipRow {
  /** Series/category name (secondary in the hierarchy). */
  label: string;
  /** Formatted value (leads, high-contrast). */
  value: string;
  /** CSS custom property name for the series line key; null hides the swatch. */
  colorVar: string | null;
}

/**
 * Shared HTML tooltip body for every dashboard chart (rendered through
 * Recharts' `content` prop). Dataviz conventions: the VALUE leads in primary
 * ink, the label follows muted, and series identity is a short line key of
 * the series color, never a filled box. All strings render via JSX text
 * (React escapes them), so agent/model names from the DB are inert.
 */
export function ChartTooltip({ title, rows }: { title: string; rows: ChartTooltipRow[] }): ReactNode {
  if (rows.length === 0) return null;
  return (
    // bg-surface (the page level), NOT bg-surface-raised: the tooltip floats
    // over raised chart cards, so the card token would melt into its own
    // background. The page token + border + shadow reads as a distinct panel
    // on every theme.
    <div className="bg-surface border border-edge rounded-md shadow-xl px-2.5 py-1.5 text-xs pointer-events-none">
      <div className="text-fg-faint text-[11px] mb-0.5">{title}</div>
      {rows.map((row, index) => (
        <div key={`${row.label}-${index}`} className="flex items-center gap-1.5">
          {row.colorVar && (
            <span
              aria-hidden
              className="inline-block w-2.5 rounded-full flex-shrink-0"
              style={{ height: 2, backgroundColor: `var(${row.colorVar})` }}
            />
          )}
          <span className="text-fg font-medium tabular-nums">{row.value}</span>
          <span className="text-fg-muted">{row.label}</span>
        </div>
      ))}
    </div>
  );
}

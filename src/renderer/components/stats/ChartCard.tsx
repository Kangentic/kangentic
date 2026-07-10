import type { ReactNode } from 'react';
import { Loader } from 'lucide-react';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  headerRight?: ReactNode;
  /** Cold load (no data for this card yet). Charts stay mounted otherwise. */
  loading?: boolean;
  /** Nothing recorded for this card in the selected range. */
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  /** Body height (the chart area). */
  bodyClassName?: string;
  testId?: string;
  children: ReactNode;
}

/** Shared dashboard card chrome. Background refreshes never unmount children
 *  (data swaps animate in place); a spinner appears only on a true cold load. */
export function ChartCard({
  title,
  subtitle,
  headerRight,
  loading = false,
  empty = false,
  emptyMessage = 'No usage recorded yet',
  className = '',
  bodyClassName = 'h-48',
  testId,
  children,
}: ChartCardProps) {
  return (
    <div className={`bg-surface-raised border border-edge rounded-lg p-4 ${className}`} data-testid={testId}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <div className="text-xs text-fg-muted font-medium">{title}</div>
          {subtitle && <div className="text-[11px] text-fg-faint mt-0.5">{subtitle}</div>}
        </div>
        {headerRight && <div className="flex-shrink-0">{headerRight}</div>}
      </div>
      <div className={bodyClassName}>
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <Loader size={16} className="animate-spin text-fg-faint" />
          </div>
        ) : empty ? (
          <div className="h-full flex items-center justify-center text-sm text-fg-faint">
            {emptyMessage}
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

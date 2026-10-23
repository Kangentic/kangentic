/** Suspense fallback for the lazy ChangesPanel chunk: a two-pane shell
 *  (file rail + diff area) that mirrors the panel's real layout, so a cold
 *  open (chunk not yet warmed) paints instantly instead of a bare spinner
 *  that gives no sense of what's loading. Its own module, so a host can show
 *  it without importing the chunk it stands in for. */
export function ChangesPanelSkeleton() {
  return (
    <div className="flex h-full" data-testid="changes-panel-skeleton">
      {/* Mirrors ChangesPanel's RAIL_DEFAULT_WIDTH_CLAMP (kept literal here so
          the skeleton never imports the lazy chunk it stands in for). */}
      <div className="flex-shrink-0 border-r border-edge p-2 space-y-1.5" style={{ width: 'clamp(160px, clamp(220px, 25%, 420px), calc(100% - 244px))' }}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-4 rounded bg-surface-hover animate-pulse" style={{ opacity: 1 - index * 0.1 }} />
        ))}
      </div>
      <div className="flex-1 min-w-0 p-3 space-y-2">
        {Array.from({ length: 10 }, (_, index) => (
          <div key={index} className="h-3.5 rounded bg-surface-hover animate-pulse" style={{ width: `${60 + (index * 13) % 35}%` }} />
        ))}
      </div>
    </div>
  );
}

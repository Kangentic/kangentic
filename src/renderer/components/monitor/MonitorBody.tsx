import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { SquareActivity } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { MonitorSessionRow } from '../../../shared/types';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../../../shared/notification-constants';
import { useMonitorStore } from '../../stores/monitor-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { MonitorToolbar } from './MonitorToolbar';
import { MonitorSummaryCards } from './MonitorSummaryCards';
import { MonitorCard } from './MonitorCard';
import { CountBadge } from '../CountBadge';
import { MonitorTable } from './MonitorTable';
import { MonitorRowContextMenu } from './MonitorRowContextMenu';
import { requestMonitorDetail } from './MonitorDetailLayer';
import { useMonitorPeekSubscription } from './useMonitorPeekSubscription';
import { bucketOf, filterRows, groupRows, sortRows, toRenderUnits } from './monitor-view-model';

/**
 * The monitor's body. Reads purely from stores and returns a bare fragment, so it
 * renders identically in the in-app overlay and in the detached pop-out window
 * (the host supplies its own `flex flex-col` box) - the same split
 * StatsDashboardBody uses.
 *
 * Width behavior is driven by a CONTAINER query, not a viewport breakpoint. That
 * is correctness rather than taste: the pop-out is its own OS window at its own
 * width, so a viewport breakpoint would size the detached monitor by the wrong
 * box. It also means the app has no need for the xl:/2xl: breakpoints it
 * currently lacks entirely.
 */

/** Estimated heights for the virtualizer's initial measure (real heights are
 *  measured on mount; these only need to be close enough to avoid a jump). */
const ESTIMATED_UNIT_HEIGHT = 148;
const ESTIMATED_DENSE_UNIT_HEIGHT = 40;
const ESTIMATED_HEADER_HEIGHT = 32;

/**
 * Column count must agree with what the container query actually rendered, so it
 * is measured rather than guessed. Thresholds mirror the grid classes below and
 * MUST be kept in step with them: this function chunks rows for the virtualizer,
 * so a mismatch lays out a different number of cards than CSS draws.
 *
 * Tuned to keep a card near a board column's width (~440px) rather than to fill
 * the row with as few cards as possible. The first ladder topped out at 3, so a
 * 1780px surface drew two ~830px cards - a card that wide is mostly whitespace,
 * since its content (title, one description clamp, labels, a context bar) is the
 * same at any width.
 */
function columnsForWidth(width: number): number {
  if (width >= 2200) return 5;
  if (width >= 1750) return 4;
  if (width >= 1300) return 3;
  if (width >= 850) return 2;
  return 1;
}

export function MonitorBody() {
  const { rows, loading, loaded, view } = useMonitorStore(
    useShallow((state) => ({
      rows: state.rows,
      loading: state.loading,
      loaded: state.loaded,
      view: state.view,
    })),
  );
  const setView = useMonitorStore((state) => state.setView);
  const closeMonitor = useMonitorStore((state) => state.close);

  // Live terminal output for every row, for as long as this body is mounted.
  // Mounted HERE rather than in the page shell so both hosts (in-app overlay and
  // detached window) get it from the one component they share.
  useMonitorPeekSubscription();

  // Memoized so LabelPills' own React.memo is not defeated by a fresh object
  // identity on every render (the trap TaskCard documents).
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors);
  const resolvedLabelColors = useMemo(() => labelColors ?? {}, [labelColors]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);

  // Measure the grid container, not the window: in the pop-out these differ.
  //
  // The column count is resolved BOTH synchronously on every layout change and on
  // subsequent resizes. The synchronous pass is load-bearing, not belt-and-braces:
  // switching layout does not change the container's SIZE, so a ResizeObserver
  // alone has nothing new to report and the count would stay stuck at whatever the
  // previous layout set (compact pins it to 1, so returning to cards stayed
  // single-column on a 2560px screen).
  useEffect(() => {
    const element = gridRef.current;
    if (!element) return;

    const resolve = (width: number) => {
      const next = view.layout === 'cards' ? columnsForWidth(width) : 1;
      setColumns((current) => (next === current ? current : next));
    };

    resolve(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      resolve(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [view.layout]);

  /**
   * Positions are held stable WITHIN an attention bucket, and re-sorted whenever a
   * row's bucket actually changes.
   *
   * The first cut froze positions against every activity change, which stopped the
   * jumping but made the ordering dishonest: a card that flipped from waiting to
   * working kept its old slot, so an "Attention first" list could show a working
   * agent above one that needed you. Bucket changes are the ones that MUST
   * re-order; everything finer (a new tool starting, a reason detail changing)
   * leaves the card where it is. Paired with the visible bucket separators below,
   * the movement that remains is explained rather than arbitrary.
   */
  const orderRef = useRef<string[]>([]);
  const signatureRef = useRef<string>('');

  // ONE derived pass produces the whole view model. No component below this
  // re-derives an aggregate of its own.
  const units = useMemo(() => {
    const filtered = filterRows(rows, view);
    const freshlySorted = sortRows(filtered, view.sort);

    // Re-sort when the SET of sessions changes or when any row's attention bucket
    // changes; hold positions for anything finer. Keying on the bucket (not just
    // the id set) is what keeps "Attention first" honest - freezing through a
    // bucket change let a working agent sit above one that needed the user.
    const signature = freshlySorted.map((row) => `${row.sessionId}:${bucketOf(row)}`).join('|');
    const changed = signature !== signatureRef.current;
    if (changed) {
      signatureRef.current = signature;
      orderRef.current = freshlySorted.map((row) => row.sessionId);
    }

    const slotOf = new Map(orderRef.current.map((id, index) => [id, index]));
    const sorted = changed
      ? freshlySorted
      : [...freshlySorted].sort(
        (left, right) => (slotOf.get(left.sessionId) ?? 0) - (slotOf.get(right.sessionId) ?? 0),
      );

    const groups = groupRows(sorted, view.groupBy);
    return {
      list: toRenderUnits(groups, columns),
      groups,
      visibleCount: filtered.length,
    };
  }, [rows, view, columns]);

  const virtualizer = useVirtualizer({
    count: units.list.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      if (units.list[index].kind === 'header') return ESTIMATED_HEADER_HEIGHT;
      return view.layout === 'list' ? ESTIMATED_DENSE_UNIT_HEIGHT : ESTIMATED_UNIT_HEIGHT;
    },
    overscan: 6,
    getItemKey: (index) => units.list[index].key,
  });

  /**
   * Open the row's task detail. WHERE it opens is main's decision, not this
   * component's: it focuses one that is already open, mounts it in this pop-out
   * when the board is on a different project, or hands it to the board. One rule,
   * one place (src/main/task-detail/detail-owner-registry.ts), so the in-app and
   * detached hosts cannot drift.
   */
  const openRow = useCallback((row: MonitorSessionRow) => {
    // A Command Terminal has no task detail to open, so it keeps the deep-link
    // route: switch project if needed and raise the Command Terminal layer.
    // Reuses the sentinel taskId the desktop notifier already uses for exactly
    // this, so both paths stay in step.
    if (row.isCommandTerminal) {
      if (window.electronAPI?.popOut?.descriptor) {
        void window.electronAPI.monitor.revealTask(
          row.projectId,
          COMMAND_TERMINAL_NOTIFICATION_TASK_ID,
        );
        return;
      }
      const alreadyActive = useProjectStore.getState().currentProject?.id === row.projectId;
      useSessionStore.getState().setPendingOpenCommandTerminal(true);
      if (!alreadyActive) void useProjectStore.getState().openProject(row.projectId);
      closeMonitor();
      return;
    }

    // A click always opens the detail HERE, in the monitor. The monitor stays
    // open behind it, so you keep watching every other agent while driving this
    // one - which is the whole point of operating from this surface.
    //
    // "Open on board" is the explicit override (right-click), and opening the
    // task on the project board takes it back and closes this copy. Main
    // arbitrates both directions; the rule is not restated here.
    requestMonitorDetail(row.projectId, row.taskId);
  }, [closeMonitor]);

  /**
   * The explicit "put it on the board" override, from the row's context menu.
   * Unlike `openRow` this bypasses the ownership arbiter's placement choice and
   * always deep-links to the board, switching project if needed - which is what
   * the user asked for by choosing this item over a plain click.
   */
  const openOnBoard = useCallback((row: MonitorSessionRow) => {
    const targetTaskId = row.isCommandTerminal
      ? COMMAND_TERMINAL_NOTIFICATION_TASK_ID
      : row.taskId;

    if (window.electronAPI?.popOut?.descriptor) {
      void window.electronAPI.monitor.revealTask(row.projectId, targetTaskId);
      return;
    }

    const alreadyActive = useProjectStore.getState().currentProject?.id === row.projectId;
    if (row.isCommandTerminal) {
      useSessionStore.getState().setPendingOpenCommandTerminal(true);
    } else if (alreadyActive) {
      useSessionStore.getState().setDetailTaskId(row.taskId);
    } else {
      useSessionStore.getState().setPendingOpenTaskId(row.taskId);
    }
    if (!alreadyActive) void useProjectStore.getState().openProject(row.projectId);
    closeMonitor();
  }, [closeMonitor]);

  const [rowMenu, setRowMenu] = useState<
    { row: MonitorSessionRow; position: { x: number; y: number } } | null
  >(null);
  const handleRowContextMenu = useCallback(
    (row: MonitorSessionRow, position: { x: number; y: number }) => setRowMenu({ row, position }),
    [],
  );

  if (loading && !loaded) {
    return (
      <div className="flex-1 min-h-0 p-4 space-y-2" data-testid="monitor-skeleton">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-28 rounded-lg bg-surface-hover animate-pulse"
            style={{ opacity: 1 - index * 0.15 }}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      {/* Summary ABOVE the controls, deliberately. These counts are over every
          session regardless of the filters below, so leading with them says
          "here is the whole machine" before the controls narrow what is listed.
          (The usage dashboard puts its tiles under its toolbar because there the
          controls change what the tiles measure; here they do not.) */}
      {/* Dropped entirely when nothing is running: four tiles reading 0 with a
          blank line under each, stacked above a zero-state that already says "no
          agents running", is four restatements of one fact. */}
      {rows.length > 0 && <MonitorSummaryCards rows={rows} />}
      <MonitorToolbar view={view} rows={rows} visibleCount={units.visibleCount} setView={setView} />

      {/* `pt-3` belongs HERE, not on the group header. With grouping switched off
          there is no header, and the first card sat flush against the filter
          bar's rule with no breathing room at all. */}
      {/* The monitor's light-dismiss scope is declared once, on MonitorPage's root
          (`data-dismiss-layer="monitor"`), so it covers this scroller AND the header,
          summary cards, and toolbar above it. It used to live on this element alone,
          which meant dead space in the monitor's own chrome dismissed nothing. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 pt-3 pb-4"
        data-testid="monitor-scroll"
      >
        {/* @container is what makes the card grid reflow by THIS box's width
            rather than the viewport's, so the pop-out lays out by its own size. */}
        <div
          ref={gridRef}
          className="@container"
          data-testid="monitor-grid"
          data-layout={view.layout}
          data-columns={columns}
        >
          {view.layout === 'table' ? (
            /* One table PER GROUP rather than a single flat one. A <table> cannot
               interleave section headers into its own rows, but nothing stops us
               stacking a header and a table per group - so grouping works here
               exactly as it does for cards, instead of being silently disabled. */
            units.groups.length === 0 ? (
              <EmptyState hasRows={rows.length > 0} />
            ) : units.groups.map((group) => (
              <div key={group.key} className="mb-4 last:mb-0">
                {group.label && (
                  <div className="flex items-center gap-2 pb-2" data-testid="monitor-group-header">
                    <span className="text-[11px] uppercase tracking-wider text-fg-muted flex-shrink-0">
                      {group.label}
                    </span>
                    <CountBadge count={group.rows.length} variant="muted" size="sm" />
                    <span className="h-px flex-1 bg-edge/60" aria-hidden />
                  </div>
                )}
                <MonitorTable
                  rows={group.rows}
                  onOpen={openRow}
                  hideProjectColumn={view.groupBy === 'project'}
                />
              </div>
            ))
          ) : units.list.length === 0 ? (
            <EmptyState hasRows={rows.length > 0} />
          ) : (
            <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              {virtualizer.getVirtualItems().map((virtualItem) => {
                const unit = units.list[virtualItem.index];
                return (
                  <div
                    key={virtualItem.key}
                    ref={virtualizer.measureElement}
                    data-index={virtualItem.index}
                    className="absolute left-0 w-full"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    {unit.kind === 'header' ? (
                      /* A real separator, not just a label: the rule carries the
                         eye across the full width so "waiting on you" and
                         "working" read as genuinely different blocks rather than
                         one continuous grid of cards. */
                      /* Index-based, not a `:first-child` selector: the
                         virtualizer wraps every unit in its own absolutely
                         positioned div, so a header is ALWAYS its wrapper's first
                         child and the CSS form would silently never match. */
                      <div
                        className={`flex items-center gap-2 pb-2 ${virtualItem.index === 0 ? 'pt-0' : 'pt-5'}`}
                        data-testid="monitor-group-header"
                      >
                        <span className="text-[11px] uppercase tracking-wider text-fg-muted flex-shrink-0">
                          {unit.label}
                        </span>
                        <CountBadge count={unit.count} variant="muted" size="sm" />
                        <span className="h-px flex-1 bg-edge/60" aria-hidden />
                      </div>
                    ) : (
                      /* The template must follow the LAYOUT, not just the chunk
                         size. Compact chunks one card per row, but leaving the
                         3-column template applied made that card occupy a third
                         of the width and stranded ~1900px of empty space beside
                         it on a wide screen. */
                      /* Cards STRETCH to the row height (the grid default). Letting
                         them size to content instead was tried and reverted: ragged
                         bottom edges across a row read as untidy, and the footer's
                         context bars stopped forming a scannable line. The
                         whitespace that stretching used to bank above the footer is
                         gone anyway, because the peek well now grows to absorb it
                         (see OutputPeek). */
                      <div
                        className={`grid gap-2 pb-2 ${view.layout === 'cards'
                          ? 'grid-cols-1 @[850px]:grid-cols-2 @[1300px]:grid-cols-3 @[1750px]:grid-cols-4 @[2200px]:grid-cols-5'
                          : 'grid-cols-1'}`}
                      >
                        {unit.rows.map((row) => (
                          <MonitorCard
                            key={row.sessionId}
                            row={row}
                            labelColors={resolvedLabelColors}
                            dense={view.layout === 'list'}
                            onOpen={openRow}
                            onContextMenu={handleRowContextMenu}
                            hideProject={view.groupBy === 'project'}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {rowMenu && (
        <MonitorRowContextMenu
          row={rowMenu.row}
          position={rowMenu.position}
          onOpenOnBoard={openOnBoard}
          onClose={() => setRowMenu(null)}
        />
      )}
    </>
  );
}

/**
 * Two distinct empty treatments, matching BacklogView's convention: a real
 * zero-state when nothing is running anywhere, and a quieter line when the user's
 * own filters excluded everything.
 */
function EmptyState({ hasRows }: { hasRows: boolean }) {
  if (hasRows) {
    return (
      <div className="px-3 py-8 text-center text-fg-disabled text-sm" data-testid="monitor-empty-filtered">
        No sessions match the current filters.
      </div>
    );
  }
  return (
    <div
      className="flex flex-col items-center justify-center py-16 text-fg-faint gap-4"
      data-testid="monitor-empty"
    >
      {/* The feature's identity glyph at illustration scale, thin-stroked so it
          reads as a watermark. Deliberately not a branding activity mark: this is
          the EMPTY state, and every mark means a live agent state. */}
      <SquareActivity size={48} strokeWidth={1} />
      <div className="text-center">
        <div className="text-lg font-medium text-fg-muted">No agents running</div>
        <div className="text-sm mt-1">
          Sessions from every project appear here as soon as an agent starts.
        </div>
      </div>
    </div>
  );
}

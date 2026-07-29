import React, { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import { Check, Loader2, Paperclip, Search, AlertCircle, RefreshCw, EyeOff, Eye } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { formatRelativeTime } from '../../lib/datetime';
import { BaseDialog } from '../dialogs/BaseDialog';
import { Pill } from '../Pill';
import { MultiSelectDropdown } from '../MultiSelectDropdown';
import { ButtonGroup } from '../ButtonGroup';
import { useBacklogStore } from '../../stores/backlog-store';
import { useToastStore } from '../../stores/toast-store';
import { getProviderLabel, getSourceIcon } from './import-providers';
import type { ExternalIssue, ImportSource } from '../../../shared/types';

interface ImportDialogProps {
  source: ImportSource;
  onClose: () => void;
}

type StateFilter = 'open' | 'closed' | 'all';

// Internal fetch chunk size. The dialog has no "page" concept in the UI - every
// item is loaded automatically - this is purely how many items are requested
// per round-trip to the adapter.
const FETCH_CHUNK_SIZE = 30;
const ESTIMATED_ROW_HEIGHT = 64;

function sortByCreatedDesc(list: ExternalIssue[]): ExternalIssue[] {
  return list.slice().sort(
    (itemA, itemB) => new Date(itemB.createdAt).getTime() - new Date(itemA.createdAt).getTime(),
  );
}

/** For project items, extract the linked issue number from the external URL if available. */
function displayId(issue: ExternalIssue): string {
  if (issue.externalSource === 'github_projects') {
    const issueNumberMatch = /\/issues\/(\d+)$/.exec(issue.externalUrl);
    if (issueNumberMatch) return `#${issueNumberMatch[1]}`;
    return '';
  }
  return `#${issue.externalId}`;
}

// Lowercased searchable blob per issue, so a keystroke costs one substring scan per
// row rather than rebuilding that blob for every row on every keystroke.
// Keyed by object identity, which can never go stale: a streamed page appends
// without recreating prior items, so it only builds haystacks for its new issues;
// a refetch (state filter switch, Retry, Refresh) arrives over IPC as fresh objects,
// so the old entries are garbage-collected with their issues and the new ones build
// once.
// hmr-safe: a lost cache is rebuilt on demand.
const searchHaystackCache = new WeakMap<ExternalIssue, string>();

/**
 * The searchable text for one issue: exactly the fields `ImportIssueRow` prints, so
 * every hit is explainable from the row itself. The ID comes from the same
 * `displayId` the row renders, so what the user sees is what the search matches.
 *
 * `body` is deliberately EXCLUDED even though it is the richest field. No row renders
 * it, so a body hit looks like a phantom match, and the damage is worst for the ID
 * search this predicate exists to serve: issue bodies cross-reference each other by
 * number constantly ("Fixed by #332", "Blocked by #123"), so including body made a
 * number query return every issue that merely MENTIONS that number alongside the one
 * that IS it.
 *
 * Also excluded, though the row does print them: the relative timestamp and the
 * attachment count. Both render as formatted numbers, and matching digits against
 * them would reintroduce the same numeric noise from the other direction.
 *
 * The `\n` separators keep a query from spanning two fields.
 */
function searchHaystack(issue: ExternalIssue): string {
  const cached = searchHaystackCache.get(issue);
  if (cached !== undefined) return cached;
  const haystack = [
    displayId(issue),
    issue.title,
    issue.workItemType ?? '',
    // The row hides the placeholder 'unknown' state, so the search does too.
    issue.state === 'unknown' ? '' : issue.state,
    // Every label, not just the 4 the row shows before collapsing to "+N": the
    // overflow count tells the user more exist, and the Label dropdown lists them all.
    ...issue.labels,
    // Matches the row's rendering, so both 'ryan' and '@ryan' hit.
    issue.assignee ? `@${issue.assignee}` : '',
  ].join('\n').toLowerCase();
  searchHaystackCache.set(issue, haystack);
  return haystack;
}

export function ImportDialog({ source, onClose }: ImportDialogProps) {
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [importing, setImporting] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [error, setError] = useState<string | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);

  // Client-side filters, evaluated live over the full (unbounded) issue set
  const [filterText, setFilterText] = useState('');
  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set());
  const [filterAssignees, setFilterAssignees] = useState<Set<string>>(new Set());
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [hideImported, setHideImported] = useState(true);

  const fetchSequenceRef = useRef(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadBacklog = useBacklogStore((state) => state.loadBacklog);
  const addToast = useToastStore((state) => state.addToast);

  const isProjectsSource = source.source === 'github_projects';

  // Stop any in-flight background paging once the dialog unmounts.
  useEffect(() => {
    return () => {
      // Bumping the LIVE ref value at unmount is the cancellation signal for any
      // in-flight loadAllIssues loop, so we intentionally read/write current here
      // rather than a copied-in snapshot (which is what the rule would suggest).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      fetchSequenceRef.current++;
    };
  }, []);

  // Fetches every page for the given state filter, streaming each page into
  // `issues` as it lands so rows and filter facets fill in progressively.
  // `fetchSequenceRef` supersedes any older in-flight loop (e.g. a rapid state
  // filter change) so a stale page can never append to a newer query's list.
  const loadAllIssues = useCallback(async (state: StateFilter) => {
    const token = ++fetchSequenceRef.current;
    setError(null);
    setLoading(true);
    setLoadingMore(false);

    let pageNumber = 1;
    let isFirstPage = true;
    try {
      while (true) {
        let result;
        try {
          result = await window.electronAPI.backlog.importFetch({
            source: source.source,
            repository: source.repository,
            page: pageNumber,
            perPage: FETCH_CHUNK_SIZE,
            state,
          });
        } catch (fetchError: unknown) {
          if (fetchSequenceRef.current !== token) return;
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to fetch issues');
          return;
        }
        if (fetchSequenceRef.current !== token) return;

        // Capture into a per-iteration const before mutating `isFirstPage` below:
        // the updater closure is invoked by React at flush time, not at call
        // time, so referencing the outer mutable `isFirstPage` directly would
        // have it read as already-`false` for every page, including the first -
        // silently turning the intended "replace" into an "append" and leaking
        // the previous state filter's stale data into the new one.
        const wasFirstPage = isFirstPage;
        const sorted = sortByCreatedDesc(result.issues);
        setIssues((previous) => {
          const merged = wasFirstPage ? sorted : [...previous, ...sorted];
          // Dedupe by externalId: a source can return the same item on two pages
          // when its ordering shifts between sequential fetches, which would
          // otherwise collide the virtualizer's item key and double-submit the row
          // on import. Keep the first occurrence.
          const seenIds = new Set<string>();
          return merged.filter((issue) => {
            if (seenIds.has(issue.externalId)) return false;
            seenIds.add(issue.externalId);
            return true;
          });
        });
        if (isFirstPage) setLoading(false);
        isFirstPage = false;

        if (!result.hasNextPage) return;
        setLoadingMore(true);
        pageNumber += 1;
      }
    } catch (unexpectedError: unknown) {
      // Guards against a malformed adapter response (e.g. a non-array `issues`)
      // throwing after a successful fetch, which would otherwise surface only
      // as a silent unhandled rejection with no error banner shown.
      if (fetchSequenceRef.current === token) {
        setError(unexpectedError instanceof Error ? unexpectedError.message : 'Failed to process issues');
      }
    } finally {
      if (fetchSequenceRef.current === token) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [source.source, source.repository]);

  // Check CLI on mount
  useEffect(() => {
    window.electronAPI.backlog.importCheckCli(source.source).then((result) => {
      if (!result.available || !result.authenticated) {
        setCliError(result.error ?? 'CLI not available');
        setLoading(false);
      } else {
        loadAllIssues(stateFilter);
      }
    }).catch((fetchError: unknown) => {
      setCliError(fetchError instanceof Error ? fetchError.message : 'CLI check failed');
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStateFilterChange = (newState: StateFilter) => {
    setStateFilter(newState);
    setSelectedIds(new Set());
    loadAllIssues(newState);
  };

  // Derive unique filter values from the full (unbounded) fetched set. Because
  // this is a useMemo over `issues`, every streamed page recomputes it - a
  // filter option that only exists on a later page appears as soon as that
  // page lands, with no user action required.
  const uniqueStatuses = useMemo(() =>
    [...new Set(issues.map((issue) => issue.state).filter((state): state is string => Boolean(state) && state !== 'unknown'))].sort(),
    [issues],
  );

  const uniqueAssignees = useMemo(() =>
    [...new Set(issues.map((issue) => issue.assignee).filter((assignee): assignee is string => Boolean(assignee)))].sort(),
    [issues],
  );

  const uniqueTypes = useMemo(() =>
    [...new Set(issues.map((issue) => issue.workItemType).filter((type): type is string => Boolean(type)))].sort(),
    [issues],
  );

  const uniqueLabels = useMemo(() =>
    [...new Set(issues.flatMap((issue) => issue.labels))].sort(),
    [issues],
  );

  // Defer the search input so typing stays responsive even with a large loaded set.
  const deferredFilterText = useDeferredValue(filterText);
  // Trimmed so a pasted ID still matches. Both '276' and the '#276' the row prints
  // already match by plain substring, so dropping a LEADING '#' is what additionally
  // lets an ID-style '#276' query hit a bare '276' in the title or body. Only the
  // leading one: an internal '#' stays, so a query like 'c#' still means 'c#'.
  const searchTermLower = deferredFilterText.trim().replace(/^#/, '').toLowerCase();

  // Client-side filtering over the full loaded set (pre-sorted by createdAt desc
  // on fetch). This recomputes on every streamed page, so a filter applied
  // early keeps picking up matching items that arrive later.
  const filteredIssues = useMemo(() => {
    return issues.filter((issue) => {
      if (hideImported && issue.alreadyImported) return false;
      if (searchTermLower && !searchHaystack(issue).includes(searchTermLower)) return false;
      if (filterStatuses.size > 0 && (!issue.state || !filterStatuses.has(issue.state))) return false;
      if (filterAssignees.size > 0 && (!issue.assignee || !filterAssignees.has(issue.assignee))) return false;
      if (filterTypes.size > 0 && (!issue.workItemType || !filterTypes.has(issue.workItemType))) return false;
      if (filterLabels.size > 0 && !issue.labels.some((label) => filterLabels.has(label))) return false;
      return true;
    });
  }, [issues, searchTermLower, filterStatuses, filterAssignees, filterTypes, filterLabels, hideImported]);

  const selectableIssues = useMemo(
    () => filteredIssues.filter((issue) => !issue.alreadyImported),
    [filteredIssues],
  );
  const allImported = useMemo(
    () => issues.length > 0 && issues.every((issue) => issue.alreadyImported),
    [issues],
  );
  // Reads the normalized term, not the raw input: a query of only whitespace or a
  // lone '#' narrows nothing, so it must not flip the footer to "N of M" or let the
  // empty state claim a filter excluded everything when none did.
  const hasActiveFilters = searchTermLower !== '' || filterStatuses.size > 0 || filterAssignees.size > 0 || filterTypes.size > 0 || filterLabels.size > 0;

  const virtualizer = useVirtualizer({
    count: filteredIssues.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    // Key measurements by issue identity, not position: filtering can remove an
    // item mid-list and shift every later index, which would otherwise apply a
    // stale cached height (from whatever used to be at that index) to the wrong row.
    getItemKey: (index) => filteredIssues[index].externalId,
    overscan: 10,
  });

  const handleToggleSelect = useCallback((externalId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else {
        next.add(externalId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = () => {
    if (selectedIds.size === selectableIssues.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableIssues.map((issue) => issue.externalId)));
    }
  };

  const clearFilters = () => {
    setFilterText('');
    setFilterStatuses(new Set());
    setFilterAssignees(new Set());
    setFilterTypes(new Set());
    setFilterLabels(new Set());
  };

  const toggleFilterStatus = (status: string) => {
    setFilterStatuses((previous) => {
      const next = new Set(previous);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  const toggleFilterAssignee = (assignee: string) => {
    setFilterAssignees((previous) => {
      const next = new Set(previous);
      if (next.has(assignee)) next.delete(assignee);
      else next.add(assignee);
      return next;
    });
  };

  const toggleFilterType = (type: string) => {
    setFilterTypes((previous) => {
      const next = new Set(previous);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleFilterLabel = (label: string) => {
    setFilterLabels((previous) => {
      const next = new Set(previous);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const handleImport = async () => {
    const selectedIssues = issues.filter((issue) => selectedIds.has(issue.externalId));
    if (selectedIssues.length === 0) return;

    setImporting(true);
    try {
      const result = await window.electronAPI.backlog.importExecute({
        source: source.source,
        repository: source.repository,
        issues: selectedIssues.map((issue) => ({
          externalId: issue.externalId,
          externalUrl: issue.externalUrl,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          assignee: issue.assignee,
          fileAttachments: issue.fileAttachments,
        })),
      });

      const parts: string[] = [];
      parts.push(`Imported ${result.imported} item${result.imported !== 1 ? 's' : ''}`);
      if (result.skippedDuplicates > 0) {
        parts.push(`${result.skippedDuplicates} already imported`);
      }
      if (result.skippedAttachments > 0) {
        parts.push(`${result.skippedAttachments} attachment${result.skippedAttachments !== 1 ? 's' : ''} skipped`);
      }
      addToast({ message: parts.join(', '), variant: 'success' });
      loadBacklog();
      onClose();
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : 'Import failed');
      setImporting(false);
    }
  };

  const sourceTypeLabel = getProviderLabel(source.source);

  const header = (
    <div className="flex items-center gap-3 px-4 py-3 border-b border-edge">
      <span className="text-fg-muted">{getSourceIcon(source.source, 16)}</span>
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-sm text-fg">{source.label}</span>
        <span className="text-xs text-fg-faint">{sourceTypeLabel}</span>
      </div>
      <div className="flex-1" />
      {/* Server-side state toggle (controls what's fetched from API) */}
      {!isProjectsSource && (
        <ButtonGroup
          size="sm"
          options={[
            { value: 'open' as StateFilter, label: 'Open' },
            { value: 'closed' as StateFilter, label: 'Closed' },
            { value: 'all' as StateFilter, label: 'All' },
          ]}
          value={stateFilter}
          onChange={handleStateFilterChange}
        />
      )}
    </div>
  );

  const importButtonLabel = importing
    ? 'Importing...'
    : selectedIds.size > 0
      ? `Import (${selectedIds.size})`
      : 'Import';

  // Whether background paging is still in progress is communicated by the
  // dedicated streaming indicator below the list, not repeated here.
  const showingSubset = hasActiveFilters || hideImported;
  const footerCountLabel = showingSubset
    ? `${filteredIssues.length} of ${issues.length} items`
    : `${issues.length} items loaded`;

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-xs text-fg-faint">
        {selectedIds.size > 0 ? `${selectedIds.size} selected` : footerCountLabel}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleImport}
          disabled={selectedIds.size === 0 || importing}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
          data-testid="import-execute-btn"
        >
          {importing && <Loader2 size={12} className="animate-spin" />}
          {importButtonLabel}
        </button>
      </div>
    </div>
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <BaseDialog
      onClose={onClose}
      header={header}
      footer={footer}
      rawBody
      className="w-[900px] h-[80vh]"
      preventBackdropClose={importing}
      testId="import-dialog"
    >
      {/* Universal filter toolbar - live client-side over the full loaded set */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-edge/50">
        {/* Text search */}
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            type="text"
            value={filterText}
            onChange={(event) => setFilterText(event.target.value)}
            placeholder="Filter by ID, title, label, or assignee..."
            className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled pl-8 pr-3 py-1.5 outline-none focus:border-edge-input"
            data-testid="import-search"
          />
        </div>

        {/* Type filter (Azure DevOps work item types) */}
        {uniqueTypes.length > 0 && (
          <MultiSelectDropdown
            label="Type"
            options={uniqueTypes}
            selected={filterTypes}
            onToggle={toggleFilterType}
            onClear={() => setFilterTypes(new Set())}
          />
        )}

        {/* Status filter */}
        {uniqueStatuses.length > 0 && (
          <MultiSelectDropdown
            label="Status"
            options={uniqueStatuses}
            selected={filterStatuses}
            onToggle={toggleFilterStatus}
            onClear={() => setFilterStatuses(new Set())}
          />
        )}

        {/* Assignee filter */}
        {uniqueAssignees.length > 0 && (
          <MultiSelectDropdown
            label="Assignee"
            options={uniqueAssignees}
            selected={filterAssignees}
            onToggle={toggleFilterAssignee}
            onClear={() => setFilterAssignees(new Set())}
            prefix="@"
          />
        )}

        {/* Label filter */}
        {uniqueLabels.length > 0 && (
          <MultiSelectDropdown
            label="Label"
            options={uniqueLabels}
            selected={filterLabels}
            onToggle={toggleFilterLabel}
            onClear={() => setFilterLabels(new Set())}
          />
        )}

        {/* Hide imported toggle */}
        <button
          type="button"
          onClick={() => setHideImported(!hideImported)}
          className={`flex items-center gap-1 px-2 py-1.5 text-xs border rounded transition-colors whitespace-nowrap ${
            hideImported
              ? 'text-accent-fg border-accent/50 bg-accent-bg/10'
              : 'text-fg-muted border-edge/50 hover:text-fg hover:bg-surface-hover/40'
          }`}
          title={hideImported ? 'Show imported items' : 'Hide imported items'}
        >
          {hideImported ? <EyeOff size={10} /> : <Eye size={10} />}
          Imported
        </button>

      </div>

      {/* CLI error */}
      {cliError && (
        <div className="px-4 py-3 m-3 rounded bg-danger/10 border border-danger/20">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="text-danger mt-0.5 shrink-0" />
            <div className="text-xs text-danger whitespace-pre-wrap">{cliError}</div>
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 m-3 rounded bg-danger/10 border border-danger/20">
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-danger shrink-0" />
            <span className="text-xs text-danger">{error}</span>
            <button
              type="button"
              onClick={() => loadAllIssues(stateFilter)}
              className="ml-auto text-xs text-accent-fg hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Select-all header - lives outside the virtualized scroll region so it
          never participates in the virtualizer's offset math. Gated on !loading
          too, so a state-filter switch doesn't show a stale select-all against
          the outgoing filter's items while the new filter's first page loads. */}
      {!cliError && !loading && selectableIssues.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-1.5 border-b border-edge/30 bg-surface-hover/20 flex-shrink-0">
          <input
            type="checkbox"
            checked={selectedIds.size === selectableIssues.length}
            onChange={handleSelectAll}
            className="accent-accent-emphasis"
            data-testid="import-select-all"
          />
          <span className="text-xs text-fg-faint">Select all</span>
        </div>
      )}

      <div ref={scrollContainerRef} className="overflow-y-auto flex-1 min-h-0">
        {!cliError && !loading && filteredIssues.length > 0 && (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualItems.map((virtualRow) => {
              const issue = filteredIssues[virtualRow.index];
              return (
                <div
                  key={issue.externalId}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <ImportIssueRow
                    issue={issue}
                    selected={selectedIds.has(issue.externalId)}
                    onToggle={handleToggleSelect}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Loading state (first page only - subsequent pages stream in via the loading-more indicator below the list) */}
        {loading && (
          <div
            data-testid="import-loading"
            className="flex items-center justify-center h-full min-h-[400px]"
          >
            <Loader2 size={48} className="animate-spin text-fg-faint" />
          </div>
        )}

        {/* Empty state - suppressed while background pages are still streaming, so
            a transient empty result never asserts a definitive state (e.g. "All
            items have been imported") that a later page would contradict. */}
        {!loading && !loadingMore && !cliError && filteredIssues.length === 0 && !error && (
          <div
            data-testid="import-empty-state"
            className="flex flex-col items-center justify-center flex-1 min-h-[200px] text-fg-faint gap-2"
          >
            {allImported && !hasActiveFilters ? (
              <>
                <Check size={24} className="text-success" />
                <span className="text-sm">All items have been imported</span>
                <button
                  type="button"
                  onClick={() => loadAllIssues(stateFilter)}
                  className="flex items-center gap-1.5 mt-1 text-xs text-accent-fg hover:underline"
                >
                  <RefreshCw size={12} />
                  Refresh to check for new items
                </button>
              </>
            ) : hasActiveFilters ? (
              <>
                <span data-testid="import-empty-state-message" className="text-sm">No items match your filters</span>
                <button
                  type="button"
                  onClick={clearFilters}
                  data-testid="import-clear-filters-btn"
                  className="text-xs text-accent-fg hover:underline"
                >
                  Clear filters
                </button>
              </>
            ) : (
              <span className="text-sm">No items found</span>
            )}
          </div>
        )}
      </div>

      {/* Streaming indicator - persistent while background pages continue loading,
          independent of scroll position. */}
      {loadingMore && (
        <div
          data-testid="import-loading-more"
          className="flex items-center justify-center gap-2 py-2 border-t border-edge/30 text-xs text-fg-faint flex-shrink-0"
        >
          <Loader2 size={12} className="animate-spin" />
          Loading more items...
        </div>
      )}
    </BaseDialog>
  );
}

// --- Individual issue row ---

const ImportIssueRow = React.memo(function ImportIssueRow({
  issue,
  selected,
  onToggle,
}: {
  issue: ExternalIssue;
  selected: boolean;
  onToggle: (externalId: string) => void;
}) {
  const isImported = issue.alreadyImported;
  const isProject = issue.externalSource === 'github_projects';
  const issueDisplayId = displayId(issue);

  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-2.5 border-b border-edge/20 transition-colors select-none ${
        isImported ? 'opacity-50 bg-surface-hover/10' : 'hover:bg-surface-hover/30 cursor-pointer'
      }`}
      onClick={() => { if (!isImported) onToggle(issue.externalId); }}
      data-testid={`import-issue-${issue.externalId}`}
    >
      <div className="pt-0.5">
        {isImported ? (
          <div className="w-4 h-4 flex items-center justify-center">
            <Check size={14} className="text-success" />
          </div>
        ) : (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(issue.externalId)}
            onClick={(event) => event.stopPropagation()}
            className="accent-accent-emphasis"
          />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {issueDisplayId && (
            <span className="text-xs text-fg-faint font-mono shrink-0">{issueDisplayId}</span>
          )}
          <span className={`text-sm ${isImported ? 'text-fg-muted' : 'text-fg'} truncate`}>
            {issue.title}
          </span>
          {isImported && (
            <span className="text-[11px] text-fg-faint bg-surface-hover/50 px-1.5 py-0.5 rounded shrink-0">
              imported
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1">
          {issue.workItemType && (
            <Pill size="sm" className="bg-accent-bg/20 text-accent-fg border border-accent/20">{issue.workItemType}</Pill>
          )}
          {issue.state && issue.state !== 'unknown' && (
            <span className="text-[11px] text-fg-muted bg-surface-hover/40 px-1.5 py-0.5 rounded shrink-0">
              {issue.state}
            </span>
          )}
          {issue.labels.slice(0, 4).map((label) => (
            <Pill key={label} size="sm" className="border border-edge/40 text-fg-muted">{label}</Pill>
          ))}
          {issue.labels.length > 4 && (
            <span className="text-[11px] text-fg-faint">+{issue.labels.length - 4}</span>
          )}
          {issue.assignee && (
            <span className="text-[11px] text-fg-faint shrink-0">@{issue.assignee}</span>
          )}
          {issue.attachmentCount > 0 && (
            <span className="flex items-center gap-0.5 text-[11px] text-fg-faint shrink-0">
              <Paperclip size={10} />
              {issue.attachmentCount}
            </span>
          )}
          {!isProject && issue.createdAt && (
            <span className="text-[11px] text-fg-faint ml-auto shrink-0">
              {formatRelativeTime(issue.createdAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

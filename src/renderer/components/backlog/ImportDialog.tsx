import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Check, Loader2, Paperclip, Search, AlertCircle, X, RefreshCw, EyeOff, Eye } from 'lucide-react';
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

const PER_PAGE = 30;

export function ImportDialog({ source, onClose }: ImportDialogProps) {
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [serverSearchQuery, setServerSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);

  // Client-side filters (universal, source-agnostic)
  const [filterText, setFilterText] = useState('');
  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set());
  const [filterAssignees, setFilterAssignees] = useState<Set<string>>(new Set());
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [hideImported, setHideImported] = useState(true);

  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadBacklog = useBacklogStore((state) => state.loadBacklog);
  const addToast = useToastStore((state) => state.addToast);

  const isProjectsSource = source.source === 'github_projects';

  // Clean up search debounce on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, []);

  // Check CLI on mount
  useEffect(() => {
    window.electronAPI.backlog.importCheckCli(source.source).then((result) => {
      if (!result.available || !result.authenticated) {
        setCliError(result.error ?? 'CLI not available');
        setLoading(false);
      } else {
        fetchIssues(1, stateFilter, '');
      }
    }).catch((fetchError: unknown) => {
      setCliError(fetchError instanceof Error ? fetchError.message : 'CLI check failed');
      setLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchIssues = useCallback(async (
    fetchPage: number,
    state: StateFilter,
    search: string,
    append = false,
  ) => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.importFetch({
        source: source.source,
        repository: source.repository,
        page: fetchPage,
        perPage: PER_PAGE,
        searchQuery: search || undefined,
        state,
      });
      const sortedResult = result.issues.slice().sort(
        (itemA, itemB) => new Date(itemB.createdAt).getTime() - new Date(itemA.createdAt).getTime(),
      );
      setIssues((previous) => append ? [...previous, ...sortedResult] : sortedResult);
      setHasNextPage(result.hasNextPage);
      setPage(fetchPage);
    } catch (fetchError: unknown) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to fetch issues');
    } finally {
      setLoading(false);
    }
  }, [source.source, source.repository]);

  const handleStateFilterChange = (newState: StateFilter) => {
    setStateFilter(newState);
    setSelectedIds(new Set());
    fetchIssues(1, newState, serverSearchQuery);
  };

  const handleServerSearchChange = (value: string) => {
    setServerSearchQuery(value);
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      setSelectedIds(new Set());
      fetchIssues(1, stateFilter, value);
    }, 400);
  };

  const handleLoadMore = () => {
    fetchIssues(page + 1, stateFilter, serverSearchQuery, true);
  };

  // Derive unique filter values from fetched data
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

  // Client-side filtering (issues are pre-sorted by createdAt desc on fetch)
  const filteredIssues = useMemo(() => {
    return issues.filter((issue) => {
      if (hideImported && issue.alreadyImported) return false;
      if (filterText && !issue.title.toLowerCase().includes(filterText.toLowerCase())) return false;
      if (filterStatuses.size > 0 && (!issue.state || !filterStatuses.has(issue.state))) return false;
      if (filterAssignees.size > 0 && (!issue.assignee || !filterAssignees.has(issue.assignee))) return false;
      if (filterTypes.size > 0 && (!issue.workItemType || !filterTypes.has(issue.workItemType))) return false;
      if (filterLabels.size > 0 && !issue.labels.some((label) => filterLabels.has(label))) return false;
      return true;
    });
  }, [issues, filterText, filterStatuses, filterAssignees, filterTypes, filterLabels, hideImported]);

  const selectableIssues = filteredIssues.filter((issue) => !issue.alreadyImported);
  const allImported = issues.length > 0 && issues.every((issue) => issue.alreadyImported);
  const hasActiveFilters = filterText !== '' || filterStatuses.size > 0 || filterAssignees.size > 0 || filterTypes.size > 0 || filterLabels.size > 0;

  const handleToggleSelect = (externalId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(externalId)) {
        next.delete(externalId);
      } else {
        next.add(externalId);
      }
      return next;
    });
  };

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

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-xs text-fg-faint">
        {selectedIds.size > 0
          ? `${selectedIds.size} selected`
          : hasActiveFilters || hideImported
            ? `${filteredIssues.length} of ${issues.length} items`
            : `${issues.length} items loaded`}
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
      {/* Universal filter toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-edge/50">
        {/* Text search */}
        <div className="relative flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            type="text"
            value={isProjectsSource ? filterText : serverSearchQuery}
            onChange={(event) => isProjectsSource
              ? setFilterText(event.target.value)
              : handleServerSearchChange(event.target.value)
            }
            placeholder="Filter by title..."
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
              onClick={() => fetchIssues(1, stateFilter, serverSearchQuery)}
              className="ml-auto text-xs text-accent-fg hover:underline"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Issue list */}
      <div className="overflow-y-auto flex-1">
        {!cliError && selectableIssues.length > 0 && (
          <div className="flex items-center gap-2 px-4 py-1.5 border-b border-edge/30 bg-surface-hover/20">
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

        {filteredIssues.map((issue) => (
          <ImportIssueRow
            key={issue.externalId}
            issue={issue}
            selected={selectedIds.has(issue.externalId)}
            onToggle={() => handleToggleSelect(issue.externalId)}
          />
        ))}

        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center h-full min-h-[400px]">
            <Loader2 size={48} className="animate-spin text-fg-faint" />
          </div>
        )}

        {/* Empty state */}
        {!loading && !cliError && filteredIssues.length === 0 && !error && (
          <div className="flex flex-col items-center justify-center flex-1 min-h-[200px] text-fg-faint gap-2">
            {allImported && !hasActiveFilters ? (
              <>
                <Check size={24} className="text-success" />
                <span className="text-sm">All items have been imported</span>
                <button
                  type="button"
                  onClick={() => fetchIssues(1, stateFilter, serverSearchQuery)}
                  className="flex items-center gap-1.5 mt-1 text-xs text-accent-fg hover:underline"
                >
                  <RefreshCw size={12} />
                  Refresh to check for new items
                </button>
              </>
            ) : hasActiveFilters ? (
              <>
                <span className="text-sm">No items match your filters</span>
                <button
                  type="button"
                  onClick={clearFilters}
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

        {/* Load more */}
        {hasNextPage && !loading && (
          <div className="flex justify-center py-3 border-t border-edge/30">
            <button
              type="button"
              onClick={handleLoadMore}
              className="text-xs text-accent-fg hover:underline"
              data-testid="import-load-more"
            >
              Load more items
            </button>
          </div>
        )}
      </div>
    </BaseDialog>
  );
}

// --- Individual issue row ---

/** For project items, extract the linked issue number from the external URL if available. */
function displayId(issue: ExternalIssue): string {
  if (issue.externalSource === 'github_projects') {
    const issueNumberMatch = /\/issues\/(\d+)$/.exec(issue.externalUrl);
    if (issueNumberMatch) return `#${issueNumberMatch[1]}`;
    return '';
  }
  return `#${issue.externalId}`;
}

function ImportIssueRow({
  issue,
  selected,
  onToggle,
}: {
  issue: ExternalIssue;
  selected: boolean;
  onToggle: () => void;
}) {
  const isImported = issue.alreadyImported;
  const isProject = issue.externalSource === 'github_projects';
  const issueDisplayId = displayId(issue);

  return (
    <div
      className={`flex items-start gap-2.5 px-4 py-2.5 border-b border-edge/20 transition-colors select-none ${
        isImported ? 'opacity-50 bg-surface-hover/10' : 'hover:bg-surface-hover/30 cursor-pointer'
      }`}
      onClick={() => { if (!isImported) onToggle(); }}
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
            onChange={onToggle}
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
}

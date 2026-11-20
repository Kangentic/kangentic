import React, { useState, useEffect, useCallback, useRef, useMemo, useDeferredValue } from 'react';
import { Check, LoaderCircle, Paperclip, Search, CircleExclamationPoint, RefreshCw, EyeOff, Eye } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { formatRelativeTime } from '../../lib/datetime';
import { BaseDialog } from '../dialogs/BaseDialog';
import { Pill } from '../Pill';
import { MultiSelectDropdown } from '../MultiSelectDropdown';
import { ButtonGroup } from '../ButtonGroup';
import { Tooltip } from '../Tooltip';
import { useBacklogStore } from '../../stores/backlog-store';
import { useProjectStore } from '../../stores/project-store';
import { useToastStore } from '../../stores/toast-store';
import { getProviderForSource, getProviderLabel, getSourceIcon, getSourceTypeOption } from './import-providers';
import { translateText } from '../../i18n/translate';
import { reportRendererFailure } from '../../utils/renderer-failure';
import { describeIpcError } from '../../lib/ipc-error';
import type { BoardConnectPrefill, ExternalIssue, ImportSource } from '../../../shared/types';

interface ImportDialogProps {
  source: ImportSource;
  onClose: () => void;
  /** A folder source's Choose folder saved a new source in place of this one. */
  onSourceReplaced?: (source: ImportSource) => void;
}

type StateFilter = 'open' | 'closed' | 'all';

const ESTIMATED_ROW_HEIGHT = 64;

/**
 * Status filter order: the provider's board order first (a state with none sorts
 * after every state that has one), then alphabetical, which is the whole order
 * for a provider that sets no `stateOrder`.
 */
function compareStatesByBoardOrder(
  [stateA, orderA]: [string, number],
  [stateB, orderB]: [string, number],
): number {
  if (orderA !== orderB) return orderA < orderB ? -1 : 1;
  if (stateA === stateB) return 0;
  return stateA < stateB ? -1 : 1;
}

function sortByCreatedDesc(list: ExternalIssue[]): ExternalIssue[] {
  return list.slice().sort(
    (itemA, itemB) => new Date(itemB.createdAt).getTime() - new Date(itemA.createdAt).getTime(),
  );
}

/**
 * The id a row prints. A provider whose people know an issue by another id than
 * its `externalId` sets `displayId` (Linear's `ENG-214`). For project items,
 * extract the linked issue number from the external URL if available.
 */
function displayId(issue: ExternalIssue): string {
  if (issue.displayId) return issue.displayId;
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

export function ImportDialog({ source, onClose, onSourceReplaced }: ImportDialogProps) {
  const { t, i18n } = useLingui();
  const [issues, setIssues] = useState<ExternalIssue[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  // Starts true because a reconcile always runs on a successful open. Keeping it
  // true through the cache paint stops the all-imported empty state from flashing
  // in the frame between painting the cache and the reconcile marking itself busy.
  const [syncing, setSyncing] = useState(true);
  const [importing, setImporting] = useState(false);
  const [stateFilter, setStateFilter] = useState<StateFilter>('open');
  const [error, setError] = useState<string | null>(null);
  const [cliError, setCliError] = useState<string | null>(null);
  // The provider's Connect dialog, opened from the error banner when the saved
  // sign-in no longer works (a revoked key, an expired sign-in).
  const [setupDialogOpen, setSetupDialogOpen] = useState(false);
  // What Connect fills in again, for a provider whose sign-in belongs to a site (Jira's site and email).
  const [setupDialogPrefill, setSetupDialogPrefill] = useState<BoardConnectPrefill | undefined>(undefined);
  const providerAuth = getProviderForSource(source.source)?.auth;
  const sourceTypeOption = getSourceTypeOption(source.source);
  // A source added by folder (an Obsidian vault) whose folder can move away.
  const folderSource = sourceTypeOption?.folder;
  // Items with no open or closed state (a repository folder's) need no Open/Closed toggle.
  const itemsHaveNoState = Boolean(sourceTypeOption?.itemsHaveNoState);
  const bodyListsPaths = Boolean(sourceTypeOption?.bodyListsPaths);
  const sourceTaskLabel = source.taskLabel?.trim() || undefined;
  const [choosingFolder, setChoosingFolder] = useState(false);

  // Client-side filters, evaluated live over the full (unbounded) issue set
  const [filterText, setFilterText] = useState('');
  const [filterStatuses, setFilterStatuses] = useState<Set<string>>(new Set());
  const [filterAssignees, setFilterAssignees] = useState<Set<string>>(new Set());
  const [filterTypes, setFilterTypes] = useState<Set<string>>(new Set());
  const [filterLabels, setFilterLabels] = useState<Set<string>>(new Set());
  const [hideImported, setHideImported] = useState(true);

  const fetchSequenceRef = useRef(0);
  // Pinned once, at mount. Every cache read and reconcile this dialog issues names
  // the project it was opened for, so a project switch between the call and the
  // main process dispatching it cannot point the per-project cache at another
  // project's database.
  const projectIdRef = useRef(useProjectStore.getState().currentProject?.id);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadBacklog = useBacklogStore((state) => state.loadBacklog);
  const addToast = useToastStore((state) => state.addToast);

  const isProjectsSource = source.source === 'github_projects';

  // Stop any in-flight background paging once the dialog unmounts.
  useEffect(() => {
    return () => {
      // Bumping the LIVE ref value at unmount is the cancellation signal for any
      // in-flight reconcile, so we intentionally read/write current here
      // rather than a copied-in snapshot (which is what the rule would suggest).
      // eslint-disable-next-line react-hooks/exhaustive-deps
      fetchSequenceRef.current++;
    };
  }, []);

  // Reconcile against the remote in the background: fetch items changed since the
  // cache's high-water mark (or everything, in 'full' mode), merge them into the
  // cache, prune deleted items, and swap in the merged set. `fetchSequenceRef`
  // supersedes any older in-flight reconcile (rapid Refresh, unmount) so a stale
  // result can never overwrite a newer one.
  const reconcile = useCallback(async (mode: 'incremental' | 'full') => {
    const token = ++fetchSequenceRef.current;
    setSyncing(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.importReconcile({
        source: source.source,
        repository: source.repository,
        projectId: projectIdRef.current,
        mode,
      });
      if (fetchSequenceRef.current !== token) return;
      setIssues(sortByCreatedDesc(result.issues));
    } catch (reconcileError: unknown) {
      if (fetchSequenceRef.current !== token) return;
      setError(describeIpcError(reconcileError, t`Failed to sync issues`));
      // A sign-in that stopped working mid-session (a token revoked since the
      // open) fails the sync, not the open's check: ask again, so the banner
      // offers Connect instead of a Retry that would fail the same way.
      if (providerAuth) {
        try {
          const cli = await window.electronAPI.backlog.importCheckCli(source.source, source.repository);
          if (fetchSequenceRef.current === token && cli.available && !cli.authenticated) {
            setError(null);
            setCliError(cli.error ?? t`CLI not available`);
          }
        } catch (checkError) {
          reportRendererFailure('backlog', 'import-recheck-sign-in', checkError);
        }
      }
    } finally {
      if (fetchSequenceRef.current === token) {
        setSyncing(false);
        setLoading(false);
      }
    }
  }, [source.source, source.repository, t, providerAuth]);

  // Check the CLI or sign-in, then reconcile once `afterCache` (the cached paint)
  // has landed, so the reconcile's result never races ahead of it and gets
  // overwritten by a slower cache read. A failed check shows the error banner.
  const checkThenReconcile = useCallback((afterCache: Promise<unknown>) => {
    const token = fetchSequenceRef.current;
    // The repository scopes the check for a provider whose sign-ins are per site (Jira),
    // and lets a folder source (an Obsidian vault) say its folder moved.
    window.electronAPI.backlog.importCheckCli(source.source, source.repository).then(async (cli) => {
      if (fetchSequenceRef.current !== token) return;
      if (!cli.available || !cli.authenticated) {
        setCliError(cli.error ?? t`CLI not available`);
        setLoading(false);
        setSyncing(false);
        return;
      }
      await afterCache;
      if (fetchSequenceRef.current !== token) return;
      void reconcile('incremental');
    }).catch((cliError: unknown) => {
      if (fetchSequenceRef.current !== token) return;
      setCliError(cliError instanceof Error ? cliError.message : t`CLI check failed`);
      setLoading(false);
      setSyncing(false);
    });
  }, [source.source, source.repository, reconcile, t]);

  // On mount: check the CLI, paint the persistent cache instantly, then reconcile
  // in the background. First-ever open has an empty cache, so the spinner stays up
  // until the reconcile lands.
  useEffect(() => {
    const token = fetchSequenceRef.current;
    // Start both round trips together. The cache read needs no CLI, so gating it
    // behind the availability check would put an `az`/`gh` process launch in front
    // of the paint this cache exists to make instant.
    const cachedPromise = window.electronAPI.backlog.importGetCached({
      source: source.source,
      repository: source.repository,
      projectId: projectIdRef.current,
    }).then((cached) => {
      if (fetchSequenceRef.current !== token) return;
      const cachedIssues = sortByCreatedDesc(cached.issues);
      setIssues(cachedIssues);
      if (cachedIssues.length > 0) setLoading(false);
    }).catch(() => {
      // A cache-read failure is non-fatal; the reconcile below will populate.
    });

    checkThenReconcile(cachedPromise);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A folder source whose folder is gone: pick where it went. The new folder is
  // added as a source, this one is removed, and the dialog opens on the new one.
  // Item ids are vault-relative, so what was imported still reads as imported.
  const handleChooseFolder = async () => {
    if (!folderSource || choosingFolder) return;
    setChoosingFolder(true);
    let replacement: ImportSource;
    try {
      const folder = await window.electronAPI.dialog.selectFolder({ title: translateText(folderSource.dialogTitle) });
      if (!folder) return;
      // The replacement keeps this source's Label.
      replacement = await window.electronAPI.backlog.importSourcesAdd({
        source: source.source,
        url: folder,
        ...(sourceTaskLabel ? { taskLabel: sourceTaskLabel } : {}),
      });
    } catch (chooseError: unknown) {
      // A refused folder (not in a vault) is a rejection main saw, which the reporter skips.
      reportRendererFailure('backlog', 'import-choose-folder', chooseError);
      setCliError(describeIpcError(chooseError, t`Failed to add source`));
      return;
    } finally {
      setChoosingFolder(false);
    }
    if (replacement.id === source.id) {
      // The same folder, back where it was (a drive plugged in again): check it again here.
      handleReconnected();
      return;
    }
    try {
      await window.electronAPI.backlog.importSourcesRemove(source.id);
    } catch (removeError: unknown) {
      // The new source is saved either way; the old one stays listed until removed by hand.
      reportRendererFailure('backlog', 'import-remove-replaced-source', removeError);
    }
    onSourceReplaced?.(replacement);
  };

  // Open the provider's Connect from the banner. A sign-in that belongs to a site
  // (Jira) reopens with that site and the email or username filled in.
  const openSetupDialog = async () => {
    let prefill: BoardConnectPrefill | undefined;
    if (providerAuth?.checksPastedLink) {
      try {
        prefill = (await providerAuth.getStatus(source.repository)).prefill;
      } catch (statusError) {
        reportRendererFailure('backlog', 'import-connect-prefill', statusError);
      }
    }
    setSetupDialogPrefill(prefill);
    setSetupDialogOpen(true);
  };

  // After the banner's Connect saved a working credential: check again and sync.
  const handleReconnected = () => {
    setSetupDialogOpen(false);
    setCliError(null);
    setSyncing(true);
    if (issues.length === 0) setLoading(true);
    checkThenReconcile(Promise.resolve());
  };

  // The open/closed/all toggle is a client-side filter over the single cache
  // bucket (every item carries a normalized stateCategory), so it never refetches.
  const handleStateFilterChange = (newState: StateFilter) => {
    setStateFilter(newState);
    setSelectedIds(new Set());
  };

  // Derive unique filter values from the full (unbounded) fetched set. Because
  // this is a useMemo over `issues`, every streamed page recomputes it - a
  // filter option that only exists on a later page appears as soon as that
  // page lands, with no user action required.
  // In the provider's board order when its issues carry `stateOrder` (Linear),
  // so the menu reads like the board's columns; alphabetical otherwise.
  const uniqueStatuses = useMemo(() => {
    const boardOrderByState = new Map<string, number>();
    for (const issue of issues) {
      if (!issue.state || issue.state === 'unknown') continue;
      const order = issue.stateOrder ?? Number.POSITIVE_INFINITY;
      const known = boardOrderByState.get(issue.state);
      if (known === undefined || order < known) boardOrderByState.set(issue.state, order);
    }
    return [...boardOrderByState.entries()].sort(compareStatesByBoardOrder).map(([state]) => state);
  }, [issues]);

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
      if (stateFilter !== 'all' && issue.stateCategory !== stateFilter) return false;
      if (searchTermLower && !searchHaystack(issue).includes(searchTermLower)) return false;
      if (filterStatuses.size > 0 && (!issue.state || !filterStatuses.has(issue.state))) return false;
      if (filterAssignees.size > 0 && (!issue.assignee || !filterAssignees.has(issue.assignee))) return false;
      if (filterTypes.size > 0 && (!issue.workItemType || !filterTypes.has(issue.workItemType))) return false;
      if (filterLabels.size > 0 && !issue.labels.some((label) => filterLabels.has(label))) return false;
      return true;
    });
  }, [issues, stateFilter, searchTermLower, filterStatuses, filterAssignees, filterTypes, filterLabels, hideImported]);

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
        sourceId: source.id,
        issues: selectedIssues.map((issue) => ({
          externalId: issue.externalId,
          externalUrl: issue.externalUrl,
          title: issue.title,
          body: issue.body,
          labels: issue.labels,
          assignee: issue.assignee,
          fileAttachments: issue.fileAttachments,
          priority: issue.priority,
          itemType: issue.workItemType,
          dueDate: issue.dueDate,
        })),
      });

      // Each part is a whole message with its own plural, joined as a list for the
      // session's language (English reads "a, b, c").
      const importedCount = result.imported;
      const duplicateCount = result.skippedDuplicates;
      const skippedAttachmentCount = result.skippedAttachments;
      const detailUnavailableCount = result.detailUnavailable ?? 0;
      const parts: string[] = [];
      parts.push(t`${importedCount} imported`);
      if (duplicateCount > 0) {
        parts.push(t`${duplicateCount} already in the backlog`);
      }
      if (skippedAttachmentCount > 0) {
        parts.push(t`${plural(skippedAttachmentCount, { one: '# attachment skipped', other: '# attachments skipped' })}`);
      }
      if (detailUnavailableCount > 0) {
        parts.push(t`comments unavailable for ${plural(detailUnavailableCount, { one: '# item', other: '# items' })}`);
      }
      const summary = new Intl.ListFormat(i18n.locale, { type: 'unit', style: 'short' }).format(parts);
      addToast({ title: t`Issues imported`, message: t`${summary}.`, variant: 'success' });
      loadBacklog();
      onClose();
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : t`Import failed`);
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
      {!isProjectsSource && !itemsHaveNoState && (
        <ButtonGroup
          size="sm"
          options={[
            { value: 'open' as StateFilter, label: t({ message: 'Open', context: 'import state filter' }) },
            { value: 'closed' as StateFilter, label: t({ message: 'Closed', context: 'import state filter' }) },
            { value: 'all' as StateFilter, label: t({ message: 'All', context: 'import state filter' }) },
          ]}
          value={stateFilter}
          onChange={handleStateFilterChange}
        />
      )}
    </div>
  );

  const selectedCount = selectedIds.size;
  const importButtonLabel = importing
    ? t`Importing...`
    : selectedCount > 0
      ? t`Import (${selectedCount})`
      : t({ message: 'Import', context: 'button' });

  // Whether background paging is still in progress is communicated by the
  // dedicated streaming indicator below the list, not repeated here.
  const showingSubset = hasActiveFilters || hideImported;
  const shownCount = filteredIssues.length;
  const loadedCount = issues.length;
  const footerCountLabel = showingSubset
    ? t`${shownCount} of ${plural(loadedCount, { one: '# item', other: '# items' })}`
    : t`${plural(loadedCount, { one: '# item loaded', other: '# items loaded' })}`;

  const footer = (
    <div className="flex items-center justify-between">
      <span className="text-xs text-fg-faint">
        {selectedCount > 0 ? t`${selectedCount} selected` : footerCountLabel}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1 text-xs text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
        >
          <Trans context="button">Cancel</Trans>
        </button>
        <button
          type="button"
          onClick={handleImport}
          disabled={selectedIds.size === 0 || importing}
          className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
          data-testid="import-execute-btn"
        >
          {importing && <LoaderCircle size={12} className="animate-spin" />}
          {importButtonLabel}
        </button>
      </div>
    </div>
  );

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <>
    <BaseDialog
      onClose={onClose}
      header={header}
      footer={footer}
      rawBody
      className="w-[900px] h-[80vh]"
      preventBackdropClose={importing}
      // The Connect dialog over this one owns Escape while it is open.
      suppressEscape={setupDialogOpen}
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
            placeholder={t`Filter by ID, title, label, or assignee...`}
            className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-muted pl-8 pr-3 py-1.5 outline-none focus:border-edge-input"
            data-testid="import-search"
          />
        </div>

        {/* Type filter (Azure DevOps work item types) */}
        {uniqueTypes.length > 0 && (
          <MultiSelectDropdown
            label={t({ message: 'Type', context: 'import filter' })}
            testIdKey="type"
            options={uniqueTypes}
            selected={filterTypes}
            onToggle={toggleFilterType}
            onClear={() => setFilterTypes(new Set())}
          />
        )}

        {/* Status filter */}
        {uniqueStatuses.length > 0 && (
          <MultiSelectDropdown
            label={t({ message: 'Status', context: 'import filter' })}
            testIdKey="status"
            options={uniqueStatuses}
            selected={filterStatuses}
            onToggle={toggleFilterStatus}
            onClear={() => setFilterStatuses(new Set())}
          />
        )}

        {/* Assignee filter */}
        {uniqueAssignees.length > 0 && (
          <MultiSelectDropdown
            label={t({ message: 'Assignee', context: 'import filter' })}
            testIdKey="assignee"
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
            label={t({ message: 'Label', context: 'import filter' })}
            testIdKey="label"
            options={uniqueLabels}
            selected={filterLabels}
            onToggle={toggleFilterLabel}
            onClear={() => setFilterLabels(new Set())}
          />
        )}

        {/* Hide imported toggle */}
        <Tooltip label={hideImported ? t`Show imported items` : t`Hide imported items`}>
          <button
            type="button"
            onClick={() => setHideImported(!hideImported)}
            className={`flex items-center gap-1 px-2 py-1.5 text-xs border rounded transition-colors whitespace-nowrap ${
              hideImported
                ? 'text-accent-fg border-accent/50 bg-accent-bg/10'
                : 'text-fg-muted border-edge/50 hover:text-fg hover:bg-surface-hover/40'
            }`}
          >
            {hideImported ? <EyeOff size={10} /> : <Eye size={10} />}
            <Trans context="import filter">Imported</Trans>
          </button>
        </Tooltip>

      </div>

      {/* CLI error */}
      {cliError && (
        <div className="px-4 py-3 m-3 rounded bg-danger/10 border border-danger/20" data-testid="import-cli-error">
          <div className={`flex gap-2 ${providerAuth || folderSource ? 'items-center' : 'items-start'}`}>
            <CircleExclamationPoint size={14} className={`text-danger shrink-0 ${providerAuth || folderSource ? '' : 'mt-0.5'}`} />
            <div className="flex-1 min-w-0 text-xs text-danger whitespace-pre-wrap break-words">{cliError}</div>
            {folderSource && (
              <button
                type="button"
                onClick={() => void handleChooseFolder()}
                disabled={choosingFolder}
                className="shrink-0 px-3 py-1 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors whitespace-nowrap disabled:opacity-50"
                data-testid="import-choose-folder-btn"
              >
                <Trans context="import error banner">Choose folder</Trans>
              </button>
            )}
            {providerAuth && (
              <button
                type="button"
                onClick={() => void openSetupDialog()}
                className="shrink-0 px-3 py-1 text-xs font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors whitespace-nowrap"
                data-testid="import-connect-provider-btn"
              >
                {t({ message: `Connect ${sourceTypeLabel}`, context: 'import error banner' })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="px-4 py-2 m-3 rounded bg-danger/10 border border-danger/20">
          <div className="flex items-center gap-2">
            <CircleExclamationPoint size={14} className="text-danger shrink-0" />
            <span className="text-xs text-danger">{error}</span>
            <button
              type="button"
              onClick={() => reconcile('incremental')}
              disabled={syncing}
              className="ml-auto text-xs text-accent-fg hover:underline disabled:opacity-50 disabled:no-underline"
            >
              <Trans>Retry</Trans>
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
          <span className="text-xs text-fg-faint"><Trans>Select all</Trans></span>
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
                    sourceTaskLabel={sourceTaskLabel}
                    showsBodyPaths={bodyListsPaths}
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
            <LoaderCircle size={48} className="animate-spin text-fg-faint" />
          </div>
        )}

        {/* Empty state - suppressed while a background reconcile is still running,
            so a transient empty cache never asserts a definitive state (e.g. "All
            items have been imported") that the reconcile would contradict. */}
        {!loading && !syncing && !cliError && filteredIssues.length === 0 && !error && (
          <div
            data-testid="import-empty-state"
            className="flex flex-col items-center justify-center flex-1 min-h-[200px] text-fg-faint gap-2"
          >
            {allImported && !hasActiveFilters ? (
              <>
                <Check size={24} className="text-success" />
                <span className="text-sm"><Trans>All items have been imported</Trans></span>
                <button
                  type="button"
                  onClick={() => reconcile('full')}
                  disabled={syncing}
                  className="flex items-center gap-1.5 mt-1 text-xs text-accent-fg hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  <RefreshCw size={12} />
                  <Trans>Refresh to check for new items</Trans>
                </button>
              </>
            ) : hasActiveFilters ? (
              <>
                <span data-testid="import-empty-state-message" className="text-sm"><Trans>No items match your filters</Trans></span>
                <button
                  type="button"
                  onClick={clearFilters}
                  data-testid="import-clear-filters-btn"
                  className="text-xs text-accent-fg hover:underline"
                >
                  <Trans>Clear filters</Trans>
                </button>
              </>
            ) : (
              <span className="text-sm"><Trans>No items found</Trans></span>
            )}
          </div>
        )}
      </div>

      {/* Background reconcile indicator - shown while the silent sync runs, once
          the cached list is already on screen. */}
      {syncing && !loading && (
        <div
          data-testid="import-syncing"
          className="flex items-center justify-center gap-2 py-2 border-t border-edge/30 text-xs text-fg-faint flex-shrink-0"
        >
          <LoaderCircle size={12} className="animate-spin" />
          <Trans>Syncing...</Trans>
        </div>
      )}
    </BaseDialog>

    {/* A sibling, not a child: the dialog's content box would clip a fixed overlay. */}
    {setupDialogOpen && providerAuth && (
      <providerAuth.SetupDialog
        onClose={() => setSetupDialogOpen(false)}
        onSaved={handleReconnected}
        initialError={cliError}
        prefill={setupDialogPrefill}
      />
    )}
    </>
  );
}

// --- Individual issue row ---

/**
 * The names a path-list body lists (`- a/b/proposal.md`, `- a/b/specs/`), as
 * `proposal.md, specs/`: what a repository folder item holds.
 */
function pathNamesOf(body: string): string {
  const names: string[] = [];
  for (const line of body.split('\n')) {
    const match = /^- (.+)$/.exec(line.trim());
    if (!match) continue;
    const isFolder = match[1].endsWith('/');
    const segments = match[1].split('/').filter((segment) => segment !== '');
    const name = segments[segments.length - 1];
    if (name) names.push(isFolder ? `${name}/` : name);
  }
  return names.join(', ');
}

const ImportIssueRow = React.memo(function ImportIssueRow({
  issue,
  selected,
  onToggle,
  sourceTaskLabel,
  showsBodyPaths,
}: {
  issue: ExternalIssue;
  selected: boolean;
  onToggle: (externalId: string) => void;
  /** The saved source's Label, which the import adds to every item. */
  sourceTaskLabel?: string;
  /** The body is a path list, shown as names under the title. */
  showsBodyPaths: boolean;
}) {
  const isImported = issue.alreadyImported;
  const isProject = issue.externalSource === 'github_projects';
  const rowDisplayId = displayId(issue);
  // An id that only repeats the title (a repository folder item's name) is not printed twice.
  const issueDisplayId = rowDisplayId === issue.title ? '' : rowDisplayId;
  const labels = sourceTaskLabel && !issue.labels.some((label) => label.toLowerCase() === sourceTaskLabel.toLowerCase())
    ? [sourceTaskLabel, ...issue.labels]
    : issue.labels;
  const pathNames = showsBodyPaths ? pathNamesOf(issue.body) : '';

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
              <Trans context="import row badge">imported</Trans>
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
          {labels.slice(0, 4).map((label) => (
            <Pill key={label} size="sm" className="border border-edge/40 text-fg-muted">{label}</Pill>
          ))}
          {labels.length > 4 && (
            <span className="text-[11px] text-fg-faint">+{labels.length - 4}</span>
          )}
          {pathNames && (
            <span className="text-[11px] text-fg-faint truncate min-w-0" data-testid="import-issue-paths">{pathNames}</span>
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

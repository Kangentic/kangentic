import { useState, useEffect, useRef, useMemo, useCallback, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { GitBranch, Search, Loader2, ChevronDown, CornerDownLeft } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { Tooltip } from '../Tooltip';
import { Pill } from '../Pill';
import { fetchGitBranches } from '../../utils/git-branches';
import { resolveBaseRef, shortRefLabel, useBaseRefKind } from '../../hooks/useBaseRefKind';
import type { GitBranchChoice, GitResolveRefFailure } from '../../../shared/types';
import { BaseKindIcon } from './task-detail/changes/BaseKindIcon';

// Stable empty list so the filtered-branches memo keeps a referentially
// constant input before the first fetch lands.
// hmr-safe: never mutated; a referential-identity sentinel for "no branches".
const EMPTY_BRANCHES: GitBranchChoice[] = [];

/** The typed ref being checked, or the error git gave for it. Keyed by the query it was for. */
type TypedRefCheck =
  | { query: string; status: 'checking' }
  | { query: string; status: 'error'; reason: GitResolveRefFailure; error: string };

interface BranchPickerProps {
  value: string;
  defaultBranch: string;
  onChange: (branch: string) => void;
  /**
   * 'chip' = small pill (the Command Terminal header's pill row)
   * 'input' = full-width field (Settings > Git)
   * 'segment' = flush segment inside a composed field (the task dialogs' Branch row)
   */
  variant?: 'chip' | 'input' | 'segment';
  className?: string;
  /** Controlled open state. When provided, the parent owns open/close (e.g. to
   *  re-open the picker from an overflow kebab after the chip has folded). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Render NO trigger chip - just the dropdown, positioned against `anchorRef`.
   *  Used for the kebab fallback when the inline chip is hidden by overflow. */
  hideTrigger?: boolean;
  /** Element the dropdown positions against (defaults to the chip's own wrapper).
   *  When set, the dropdown is portaled + fixed so it escapes the header clip. */
  anchorRef?: RefObject<HTMLElement | null>;
  /** The project whose branches to list (a workflow's planned task on another board); omitted, the open one. */
  projectId?: string | null;
  /**
   * The search box also takes a tag or a commit: a query that names no listed
   * branch offers a "Use" row, checked by git before it is taken. Only a task's
   * base sets it. A project default and the Command Terminal's checkout stay
   * branches.
   */
  acceptsTypedRef?: boolean;
}

export function BranchPicker({
  value,
  defaultBranch,
  onChange,
  variant = 'chip',
  className,
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
  anchorRef,
  projectId = null,
  acceptsTypedRef = false,
}: BranchPickerProps) {
  const { t } = useLingui();
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  // The branch list is stored with the open it was fetched for, and `loading`
  // is derived: the dropdown is open and no list has arrived for THIS open.
  // Derived rather than a flag an effect sets, which the compiler rules forbid.
  const [openGeneration, setOpenGeneration] = useState(0);
  const [fetched, setFetched] = useState<{ openGeneration: number; branches: GitBranchChoice[] } | null>(null);
  const branches = fetched?.branches ?? EMPTY_BRANCHES;
  const loading = open && fetched?.openGeneration !== openGeneration;
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Every variant portals + fixed. The chip lives inside headers and dialogs that
  // clip overflow; the 'input' variant lives in the Settings > Git panel, whose
  // body is an overflow-y-auto scroller, so an in-flow absolute dropdown there
  // was clipped exactly like the comboboxes were. The input variant stretches to
  // its container's full width via the hook's `matchTriggerWidth` (applied before
  // the hook measures) rather than an in-flow left/right 0; the chip and segment
  // variants keep their `w-64` class, which an inline width would override.
  const positionAnchor = anchorRef ?? containerRef;
  const { style: dropdownStyle } = usePopoverPosition(
    positionAnchor,
    dropdownRef,
    open,
    { mode: 'dropdown', strategy: 'fixed', preferRight: false, matchTriggerWidth: variant === 'input' },
  );

  const displayBranch = value || defaultBranch || 'main';

  // Whenever the dropdown opens (chip click OR a controlled open from the kebab),
  // reset the query, fetch branches, and focus the search box. The query reset
  // and the open generation are render-time adjustments on the open transition
  // (React's "adjusting state when a prop changes" pattern), so the search box
  // never paints the previous query for a frame; the fetch and the focus stay
  // in the effect, which keys on the generation so each open fetches once.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setQuery('');
      setOpenGeneration(openGeneration + 1);
    }
  }
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      let result: GitBranchChoice[];
      try {
        result = await fetchGitBranches(projectId);
      } catch {
        result = [];
      }
      if (!cancelled) setFetched({ openGeneration, branches: result });
    })();
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => { cancelled = true; };
  }, [open, openGeneration, projectId]);

  // Close on click outside (consider both the position anchor and the dropdown).
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const inAnchor = positionAnchor.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      if (!inAnchor && !inDropdown) setOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    return () => document.removeEventListener('mousedown', handleMouseDown, true);
  }, [open, positionAnchor, setOpen]);

  // Close on Escape (without closing the parent dialog)
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, setOpen]);

  const filtered = useMemo(() => {
    if (!query.trim()) return branches;
    const lowerQuery = query.toLowerCase();
    return branches.filter((branch) => branch.name.toLowerCase().includes(lowerQuery));
  }, [branches, query]);

  const handleSelect = (branch: string) => {
    if (variant === 'input') {
      // Settings mode: always pass the concrete branch name
      onChange(branch);
    } else {
      // Chip mode: clear value when selecting the default (avoids redundant override)
      onChange(branch === defaultBranch ? '' : branch);
    }
    setOpen(false);
  };

  // A typed tag or commit. The check is keyed by the query it was for, so
  // typing again drops a stale "Checking" or error without an effect, and the
  // generation stops a stale answer from committing a query no longer typed.
  // A check still in flight is dropped when the query is edited (below), when
  // the menu closes by any path, or when the picker unmounts, so a slow answer
  // never commits a base the user moved on from.
  const trimmedQuery = query.trim();
  const [typedRefCheck, setTypedRefCheck] = useState<TypedRefCheck | null>(null);
  const checkGenerationRef = useRef(0);
  useEffect(() => {
    if (!open) checkGenerationRef.current += 1;
  }, [open]);
  useEffect(() => {
    const generations = checkGenerationRef;
    return () => { generations.current += 1; };
  }, []);
  const activeCheck = typedRefCheck?.query === trimmedQuery ? typedRefCheck : null;
  const isChecking = activeCheck?.status === 'checking';
  const exactMatch = branches.some((branch) => branch.name === trimmedQuery);
  const showUseRow = acceptsTypedRef && trimmedQuery !== '' && !exactMatch && !loading;

  const commitTypedRef = async () => {
    if (!showUseRow || isChecking) return;
    const typed = trimmedQuery;
    const generation = ++checkGenerationRef.current;
    setTypedRefCheck({ query: typed, status: 'checking' });
    let failure: Extract<TypedRefCheck, { status: 'error' }>;
    try {
      // The one reader that may fetch: a tag only on origin is one worktree
      // creation would fetch too, so the picker accepts it.
      const result = await resolveBaseRef(typed, projectId, { fetchTag: true });
      if (generation !== checkGenerationRef.current) return;
      if (result.ok) {
        setTypedRefCheck(null);
        handleSelect(typed);
        return;
      }
      failure = { query: typed, status: 'error', reason: result.reason, error: result.error };
    } catch (caught) {
      if (generation !== checkGenerationRef.current) return;
      failure = { query: typed, status: 'error', reason: 'git', error: caught instanceof Error ? caught.message : String(caught) };
    }
    setTypedRefCheck(failure);
  };

  // Git's own stderr is shown as git wrote it; every other miss is ours to word.
  const describeRefFailure = (check: Extract<TypedRefCheck, { status: 'error' }>): { text: string; fromGit: boolean } => {
    switch (check.reason) {
      case 'empty': return { text: t`Type a branch, tag or commit`, fromGit: false };
      case 'option-shaped': return { text: t`Starts with a dash, so git would read it as an option`, fromGit: false };
      case 'not-a-repo': return { text: t`This project is not a git repository`, fromGit: false };
      case 'not-a-base': return { text: t`Not a branch, tag or commit SHA`, fromGit: false };
      case 'git': return { text: check.error, fromGit: true };
    }
  };
  const refFailure = activeCheck?.status === 'error' ? describeRefFailure(activeCheck) : null;

  const handleSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!acceptsTypedRef || event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (exactMatch) handleSelect(trimmedQuery);
    else void commitTypedRef();
  };

  // What the current base names, for the segment's icon and tip. Only a typed
  // base can be a tag or a commit; the default is always a branch.
  const baseRef = useBaseRefKind(value, projectId, acceptsTypedRef && value.trim() !== '');

  const chipButton = (
    <Pill
      onClick={() => setOpen(!open)}
      className={`border transition-colors ${
        open
          ? 'border-accent text-accent-fg bg-accent/10'
          : 'border-edge-input text-fg-muted hover:text-fg-secondary hover:border-fg-faint'
      }`}
      data-testid="branch-picker-chip"
    >
      <GitBranch size={16} />
      {displayBranch}
    </Pill>
  );

  // The base-branch segment of the composed Branch field. Flush (no radius, no
  // border of its own - the field shell draws the dividers via `divide-x`) so the
  // field reads as a single control, and width-capped: with no cap a long
  // base-branch name pushed the branch-name input to its min-w-0 and collapsed
  // the row. `truncate` keeps the full name in textContent, so assertions on the
  // branch name still hold.
  //
  // Keeps the `branch-picker-chip` test id even though it is no longer a chip:
  // four specs drive it, and renaming buys nothing.
  //
  // Three things carry "this is a button" now that the pill outline is gone, and
  // all three are needed: a chevron (this opens a picker - the same signal
  // `Combobox` and this component's own `input` variant use), a tinted
  // background marking the segment zone as distinct from the text field beside
  // it, and `cursor-pointer`. The cursor is not optional - Tailwind v4's
  // preflight gives `button` `cursor: default`, and the `Pill` this replaced was
  // adding `cursor-pointer` for us.
  // The tip names the field and the full base the segment's width may cut
  // short (a commit's whole SHA). Shut while the menu is open, which already
  // lists it. A tag or a commit draws its own icon, and a commit its short SHA.
  const baseKind = baseRef?.kind ?? 'branch';
  const baseCommitSha = baseRef?.sha ?? '';
  let segmentTip: string;
  switch (baseKind) {
    case 'commit': segmentTip = t`Base commit: ${baseCommitSha}`; break;
    case 'tag': segmentTip = t`Base tag: ${displayBranch}`; break;
    case 'branch': segmentTip = t`Base branch: ${displayBranch}`; break;
  }
  const segmentLabel = shortRefLabel(displayBranch, baseKind);
  const segmentButton = (
    <Tooltip label={segmentTip} enabled={!open}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        // An INSET focus ring, not the default outline: the field shell is
        // `overflow-hidden` (for its rounded corners) and this button is flush to
        // its edge, so an outline is clipped on every side. Without the ring the
        // shell's `focus-within:border-accent` lights up identically for the name
        // input and this button alike, so a keyboard user cannot tell which has
        // focus.
        className={`flex w-full max-w-[170px] shrink-0 cursor-pointer items-center gap-1.5 bg-surface-control/40 px-3 text-xs transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
          open ? 'text-accent-fg' : 'text-fg-secondary'
        }`}
        data-testid="branch-picker-chip"
        data-base-kind={baseKind}
      >
        <BaseKindIcon kind={baseKind} size={14} showBranch />
        <span className={`truncate ${baseKind === 'commit' ? 'font-mono' : ''}`}>{segmentLabel}</span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
    </Tooltip>
  );

  const inputButton = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-fg border border-edge-input rounded bg-surface-control hover:border-fg-faint transition-colors ${className || ''}`}
      data-testid="branch-picker-input"
    >
      <GitBranch size={14} className="text-fg-faint flex-shrink-0" />
      <span className="flex-1 text-left truncate">{displayBranch}</span>
      <ChevronDown size={14} className={`text-fg-faint flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );

  // The Use row: dimmed while git checks, plain after a miss, and highlighted
  // while Enter takes it.
  const useRowTone = isChecking
    ? 'text-fg-muted'
    : refFailure
      ? 'text-fg-tertiary hover:bg-surface-hover hover:text-fg'
      : 'bg-surface-hover text-fg';

  const dropdownContent = (
    <>
      {/* Search input. With a typed ref, git's own error for it sits under the
          box, as written, and the menu stays open. */}
      <div className="p-2 border-b border-edge shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => {
              checkGenerationRef.current += 1;
              setQuery(event.target.value);
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder={acceptsTypedRef ? t`Search, or type a tag or commit` : t`Search branches...`}
            aria-invalid={refFailure ? true : undefined}
            className={`w-full bg-surface/50 border rounded text-xs text-fg-tertiary placeholder-fg-muted pl-7 pr-2 py-1.5 outline-none ${
              refFailure ? 'border-danger' : 'border-edge/50 focus:border-edge-input'
            }`}
            data-testid="branch-picker-search"
          />
        </div>
        {refFailure && (
          <p
            role="alert"
            className={`mt-1.5 px-0.5 text-xs leading-snug text-danger break-words select-text ${refFailure.fromGit ? 'font-mono' : ''}`}
            data-testid="branch-picker-ref-error"
          >
            {/* i18n-ok: translated above, or git's own stderr shown as git wrote it */}
            {refFailure.text}
          </p>
        )}
      </div>

      {/* Branch list */}
      <div className="max-h-[200px] min-h-0 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-fg-faint">
            <Loader2 size={14} className="animate-spin" />
            <Trans>Loading branches...</Trans>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-4 text-center text-xs text-fg-faint">
            {branches.length === 0
              ? <Trans>No branches found</Trans>
              : <Trans>No branches match "{query}"</Trans>}
          </div>
        ) : (
          filtered.map((branch) => (
            <button
              key={branch.name}
              type="button"
              onClick={() => handleSelect(branch.name)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                branch.name === displayBranch
                  ? 'text-accent-fg bg-accent/10'
                  : 'text-fg-tertiary hover:bg-surface-hover hover:text-fg'
              }`}
            >
              <GitBranch size={12} className="flex-shrink-0" />
              <span className="min-w-0 truncate">{branch.name}</span>
              {branch.local && (
                <span
                  className="ml-auto shrink-0 rounded-sm border border-edge-input px-1 text-[11px] leading-[15px] text-fg-muted"
                  data-testid="branch-picker-local"
                >
                  {t({ message: 'local', context: 'a branch only this machine has' })}
                </span>
              )}
            </button>
          ))
        )}
      </div>

      {/* The typed ref, below the list rather than in it, so the list keeps
          its rows only. Highlighted while Enter takes it. */}
      {showUseRow && (
        <button
          type="button"
          onClick={() => void commitTypedRef()}
          disabled={isChecking}
          className={`flex w-full shrink-0 items-center gap-2 border-t border-edge px-3 py-2 text-left text-xs transition-colors ${useRowTone}`}
          data-testid="branch-picker-use-typed"
        >
          {isChecking
            ? <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
            : <CornerDownLeft size={12} className="shrink-0" aria-hidden />}
          <span className="min-w-0 truncate">
            {isChecking
              ? <Trans>Checking <span className="font-mono">{trimmedQuery}</span>...</Trans>
              : <Trans>Use <span className="font-mono">{trimmedQuery}</span></Trans>}
          </span>
          {/* Enter still takes the row after a miss, so the hint stays. */}
          {!isChecking && (
            <span className="ml-auto shrink-0 rounded-sm border border-edge-input bg-surface-raised px-1 text-[11px] leading-[15px] text-fg-muted">
              <Trans>Enter</Trans>
            </span>
          )}
        </button>
      )}
    </>
  );

  // The segment wrapper is `flex shrink-0`, not `contents`: a display-contents
  // box has an empty bounding rect, and `containerRef` is what the popover
  // positions against. As a flex child of the field shell it still stretches to
  // the shell's full height, which is the point of the segment.
  const wrapperClass = hideTrigger
    ? 'contents'
    : variant === 'segment'
      ? 'flex shrink-0 min-w-0'
      : `relative ${variant === 'input' ? 'w-full' : 'inline-block'}`;

  const trigger = variant === 'input' ? inputButton : variant === 'segment' ? segmentButton : chipButton;

  return (
    <div className={wrapperClass} ref={containerRef}>
      {!hideTrigger && trigger}
      <OverlayPopover
        open={open}
        popoverRef={dropdownRef}
        style={dropdownStyle}
        portal
        transformOrigin="top left"
        // A flex column capped to the room on its side: the branch list loads
        // after the popover opens and is measured, so in a short window it
        // shrinks and scrolls rather than spilling past the window edge.
        className={`fixed z-[2147483646] flex flex-col max-h-[var(--popover-available-height,none)] bg-surface-raised border border-edge-input rounded-md shadow-xl overflow-hidden ${
          variant === 'input' ? '' : 'w-64'
        }`}
        data-testid="branch-picker-dropdown"
      >
        {dropdownContent}
      </OverlayPopover>
    </div>
  );
}

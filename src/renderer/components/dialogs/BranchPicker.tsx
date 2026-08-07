import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback, type RefObject } from 'react';
import { GitBranch, Search, Loader2, ChevronDown } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { OverlayPopover } from '../OverlayPopover';
import { Pill } from '../Pill';
import { fetchGitBranches } from '../../utils/git-branches';

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
}: BranchPickerProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = useCallback((next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  }, [isControlled, onOpenChange]);

  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [triggerWidth, setTriggerWidth] = useState<number>();
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Every variant portals + fixed. The chip lives inside headers and dialogs that
  // clip overflow; the 'input' variant lives in the Settings > Git panel, whose
  // body is an overflow-y-auto scroller, so an in-flow absolute dropdown there
  // was clipped exactly like the comboboxes were. It stretches to its container's
  // full width via a measured `width` (below) rather than an in-flow left/right 0.
  const positionAnchor = anchorRef ?? containerRef;
  const { style: dropdownStyle } = usePopoverPosition(
    positionAnchor,
    dropdownRef,
    open,
    { mode: 'dropdown', strategy: 'fixed', preferRight: false },
  );

  // Input variant: match the trigger's full width. A fixed-strategy popover is
  // detached from the container, so `left-0 right-0` no longer stretches it.
  useLayoutEffect(() => {
    if (open && variant === 'input' && positionAnchor.current) {
      setTriggerWidth(positionAnchor.current.getBoundingClientRect().width);
    }
  }, [open, variant, positionAnchor]);

  const displayBranch = value || defaultBranch || 'main';

  const fetchBranches = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchGitBranches();
      setBranches(result);
    } catch {
      setBranches([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Whenever the dropdown opens (chip click OR a controlled open from the kebab),
  // reset the query, fetch branches, and focus the search box.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    fetchBranches();
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, fetchBranches]);

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
    const q = query.toLowerCase();
    return branches.filter(b => b.toLowerCase().includes(q));
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
  const segmentButton = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      // An INSET focus ring, not the default outline: the field shell is
      // `overflow-hidden` (for its rounded corners) and this button is flush to
      // its edge, so an outline is clipped on every side. Without the ring the
      // shell's `focus-within:border-accent` lights up identically for the name
      // input, this button, and the worktree toggle, so a keyboard user cannot
      // tell which of the three has focus. Same pattern as `CompactToggleList`.
      className={`flex w-full max-w-[170px] shrink-0 cursor-pointer items-center gap-1.5 bg-surface-control/40 px-3 text-xs transition-colors hover:bg-surface-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
        open ? 'text-accent-fg' : 'text-fg-secondary'
      }`}
      title={`Base branch: ${displayBranch}`}
      data-testid="branch-picker-chip"
    >
      <GitBranch size={14} className="shrink-0" />
      <span className="truncate">{displayBranch}</span>
      <ChevronDown
        size={12}
        className={`shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
      />
    </button>
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

  const dropdownContent = (
    <>
      {/* Search input */}
      <div className="p-2 border-b border-edge">
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-disabled" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search branches..."
            className="w-full bg-surface/50 border border-edge/50 rounded text-xs text-fg-tertiary placeholder-fg-muted pl-7 pr-2 py-1.5 outline-none focus:border-edge-input"
          />
        </div>
      </div>

      {/* Branch list */}
      <div className="max-h-[200px] overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-4 text-xs text-fg-faint">
            <Loader2 size={14} className="animate-spin" />
            Loading branches...
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-4 text-center text-xs text-fg-faint">
            {branches.length === 0
              ? 'No branches found'
              : `No branches match "${query}"`}
          </div>
        ) : (
          filtered.map(branch => (
            <button
              key={branch}
              type="button"
              onClick={() => handleSelect(branch)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                branch === displayBranch
                  ? 'text-accent-fg bg-accent/10'
                  : 'text-fg-tertiary hover:bg-surface-hover hover:text-fg'
              }`}
            >
              <GitBranch size={12} className="flex-shrink-0" />
              {branch}
            </button>
          ))
        )}
      </div>
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
        style={variant === 'input' ? { ...dropdownStyle, width: triggerWidth } : dropdownStyle}
        portal
        transformOrigin="top left"
        className={`fixed z-[2147483646] bg-surface-raised border border-edge-input rounded-md shadow-xl overflow-hidden ${
          variant === 'input' ? '' : 'w-64'
        }`}
        data-testid="branch-picker-dropdown"
      >
        {dropdownContent}
      </OverlayPopover>
    </div>
  );
}

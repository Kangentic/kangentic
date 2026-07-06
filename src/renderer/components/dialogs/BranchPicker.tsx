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
  /** 'chip' = small pill (dialogs), 'input' = full-width field (settings) */
  variant?: 'chip' | 'input';
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
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // The inline chip lives inside headers and dialogs that clip overflow, so its
  // dropdown always portals + fixed to escape the clip (as the kebab fallback,
  // hideTrigger / anchorRef, already does). Only the 'input' variant stays inline +
  // absolute, because it stretches to its container's full width.
  const usePortal = hideTrigger || anchorRef !== undefined || variant === 'chip';
  const positionAnchor = anchorRef ?? containerRef;
  const { style: dropdownStyle } = usePopoverPosition(
    positionAnchor,
    dropdownRef,
    open,
    usePortal
      ? { mode: 'dropdown', strategy: 'fixed', preferRight: false }
      : { mode: 'dropdown', preferRight: false },
  );

  // Input variant: override horizontal positioning to stretch full width
  useLayoutEffect(() => {
    if (!open || variant !== 'input' || !dropdownRef.current) return;
    dropdownRef.current.style.left = '0';
    dropdownRef.current.style.right = '0';
  }, [open, variant]);

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

  const inputButton = (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-fg border border-edge-input rounded bg-surface hover:border-fg-faint transition-colors ${className || ''}`}
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
            className="w-full bg-surface/50 border border-edge/50 rounded text-xs text-fg-tertiary placeholder-fg-disabled pl-7 pr-2 py-1.5 outline-none focus:border-edge-input"
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

  return (
    <div className={hideTrigger ? 'contents' : `relative ${variant === 'input' ? 'w-full' : 'inline-block'}`} ref={containerRef}>
      {!hideTrigger && (variant === 'input' ? inputButton : chipButton)}
      <OverlayPopover
        open={open}
        popoverRef={dropdownRef}
        style={dropdownStyle}
        portal={usePortal}
        transformOrigin="top left"
        className={`${usePortal ? 'fixed z-[2147483646]' : 'absolute z-50'} bg-surface-raised border border-edge-input rounded-md shadow-xl overflow-hidden ${
          variant === 'input' ? 'left-0 right-0' : 'w-64'
        }`}
      >
        {dropdownContent}
      </OverlayPopover>
    </div>
  );
}

import { useState, useRef, useEffect, useMemo } from 'react';
import { Filter, X } from 'lucide-react';
import { OverlayPopover } from './OverlayPopover';
import { usePopoverPosition } from '../hooks/usePopoverPosition';

/**
 * A bare string is both value and label (the original shape). The object form
 * exists for callers whose stored value is an id but whose rendered text is a
 * display name - the monitor's Projects filter stores project ids. Keys and
 * testids use the value; only the rendered text uses the label.
 */
export type MultiSelectOption = string | { value: string; label: string };

interface MultiSelectDropdownProps {
  label: string;
  /**
   * Trigger button text. Defaults to `label`, which also keys the testids -
   * pass this when the trigger should read as live state (the monitor's
   * "All projects" / "2 of 5 projects") without changing the testid family.
   */
  triggerText?: string;
  /**
   * Which trigger edge the menu anchors to. `right` (default) aligns trailing
   * edges - the Import dialog's filter cluster sits at the dialog's right edge,
   * so its menus hang left. Pass `left` for a trigger in a left-to-right
   * toolbar: there the LEFT edge is the stable one (a live-state trigger text
   * changes width as selections toggle, and the position is computed once at
   * open, so a right-anchored menu visibly detaches from the moving edge).
   */
  align?: 'left' | 'right';
  options: MultiSelectOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear?: () => void;
  prefix?: string;
}

export function MultiSelectDropdown({
  label,
  triggerText,
  align = 'right',
  options,
  selected,
  onToggle,
  onClear,
  prefix = '',
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const hasActiveFilter = selected.size > 0;
  const normalizedOptions = useMemo(
    () => options.map((option) =>
      typeof option === 'string' ? { value: option, label: option } : option,
    ),
    [options],
  );

  // Portal + fixed: the Import dialog's filter toolbar sits under BaseDialog's
  // rawBody `overflow-hidden`, which clipped the in-flow absolute menu.
  const { style: menuStyle, placement } = usePopoverPosition(containerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferRight: align !== 'left',
  });

  useEffect(() => {
    if (!open) return;
    // The menu is portaled OUT of containerRef, so a click inside it must also
    // count as "inside" - otherwise this capture-phase listener closes the menu
    // before a checkbox toggle registers.
    const handleClick = (event: MouseEvent) => {
      if (
        containerRef.current && !containerRef.current.contains(event.target as Node) &&
        (!menuRef.current || !menuRef.current.contains(event.target as Node))
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open]);

  const handleClear = () => {
    if (onClear) {
      onClear();
    } else {
      // Clear all by toggling each selected item off
      for (const value of selected) {
        onToggle(value);
      }
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs border rounded transition-colors whitespace-nowrap ${
          hasActiveFilter
            ? 'text-accent-fg border-accent/50 bg-accent-bg/10'
            : 'text-fg-muted border-edge/50 hover:text-fg hover:bg-surface-hover/40'
        }`}
      >
        {triggerText ?? label}
        <Filter size={10} />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={menuStyle}
        portal
        // From the RESOLVED placement, not the requested alignment, so the grow
        // animation originates at the anchored corner even on an overflow flip.
        transformOrigin={`${placement.vertical === 'above' ? 'bottom' : 'top'} ${placement.horizontal}`}
        className="fixed z-[2147483646] w-max min-w-[140px] bg-surface border border-edge rounded-lg shadow-xl"
        data-testid={`filter-menu-${label.toLowerCase()}`}
      >
        {normalizedOptions.map((option) => (
          <label
            key={option.value}
            data-testid={`filter-option-${label.toLowerCase()}-${option.value}`}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-fg hover:bg-surface-hover/40 cursor-pointer whitespace-nowrap"
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={() => onToggle(option.value)}
              className="accent-accent-emphasis"
            />
            {prefix}{option.label}
          </label>
        ))}
        <div className="border-t border-edge" />
        <button
          type="button"
          onClick={handleClear}
          disabled={!hasActiveFilter}
          className={`flex items-center gap-1.5 w-full px-3 py-2 text-sm transition-colors ${
            hasActiveFilter
              ? 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
              : 'text-fg-disabled cursor-default'
          }`}
        >
          <X size={14} />
          Clear
        </button>
      </OverlayPopover>
    </div>
  );
}

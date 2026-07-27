import { useState, useRef, useEffect } from 'react';
import { Filter, X } from 'lucide-react';
import { OverlayPopover } from './OverlayPopover';
import { usePopoverPosition } from '../hooks/usePopoverPosition';

interface MultiSelectDropdownProps {
  label: string;
  options: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear?: () => void;
  prefix?: string;
}

export function MultiSelectDropdown({
  label,
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

  // Portal + fixed: the Import dialog's filter toolbar sits under BaseDialog's
  // rawBody `overflow-hidden`, which clipped the in-flow absolute menu.
  // `preferRight` keeps the old `right-0` trailing-edge alignment.
  const { style: menuStyle, placement } = usePopoverPosition(containerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferRight: true,
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
        {label}
        <Filter size={10} />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={menuStyle}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom right' : 'top right'}
        className="fixed z-[2147483646] w-max min-w-[140px] bg-surface border border-edge rounded-lg shadow-xl"
        data-testid={`filter-menu-${label.toLowerCase()}`}
      >
        {options.map((option) => (
          <label
            key={option}
            data-testid={`filter-option-${label.toLowerCase()}-${option}`}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-fg hover:bg-surface-hover/40 cursor-pointer whitespace-nowrap"
          >
            <input
              type="checkbox"
              checked={selected.has(option)}
              onChange={() => onToggle(option)}
              className="accent-accent-emphasis"
            />
            {prefix}{option}
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

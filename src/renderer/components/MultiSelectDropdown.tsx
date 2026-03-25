import React, { useState, useRef, useEffect } from 'react';
import { Filter, X } from 'lucide-react';

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
  const hasActiveFilter = selected.size > 0;

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-max min-w-[140px] bg-surface border border-edge rounded-lg shadow-xl">
          {options.map((option) => (
            <label
              key={option}
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
        </div>
      )}
    </div>
  );
}

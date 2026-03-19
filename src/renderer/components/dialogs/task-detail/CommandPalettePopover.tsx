import React, { useState, useRef, useEffect, useMemo, type RefObject } from 'react';
import { Loader2, Search } from 'lucide-react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import type { ClaudeCommand } from '../../../../shared/types';

export interface CommandPalettePopoverProps {
  triggerRef: RefObject<HTMLElement | null>;
  cwd?: string;
  onSelect: (command: ClaudeCommand) => void;
  onClose: () => void;
}

export function CommandPalettePopover({ triggerRef, cwd, onSelect, onClose }: CommandPalettePopoverProps) {
  const [commands, setCommands] = useState<ClaudeCommand[]>([]);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, { mode: 'dropdown' });

  // Fetch commands on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.claude.listCommands(cwd);
        if (!cancelled) {
          setCommands(result);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  // Auto-focus search input
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  // Click-outside closes
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [onClose]);

  const filteredCommands = useMemo(() => {
    if (!searchFilter) return commands;
    const lower = searchFilter.toLowerCase();
    return commands.filter((command) =>
      command.name.toLowerCase().includes(lower)
      || command.description.toLowerCase().includes(lower)
    );
  }, [commands, searchFilter]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchFilter]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-command-item]');
    const selectedItem = items[selectedIndex];
    if (selectedItem) {
      selectedItem.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((previous) => Math.min(previous + 1, filteredCommands.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((previous) => Math.max(previous - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (filteredCommands[selectedIndex]) {
        onSelect(filteredCommands[selectedIndex]);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      ref={popoverRef}
      style={popoverStyle}
      className="absolute w-[280px] max-h-[300px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 flex flex-col overflow-hidden"
      data-testid="command-palette-popover"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-edge">
        <Search size={14} className="text-fg-faint flex-shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search commands & skills..."
          value={searchFilter}
          onChange={(event) => setSearchFilter(event.target.value)}
          className="flex-1 bg-transparent text-sm text-fg placeholder-fg-faint outline-none"
          data-testid="command-search-input"
        />
      </div>
      <div ref={listRef} className="overflow-y-auto flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={16} className="text-fg-faint animate-spin" />
          </div>
        ) : filteredCommands.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-fg-faint">
            No commands or skills found
          </div>
        ) : (
          filteredCommands.map((command, index) => (
            <button
              key={command.name}
              data-command-item
              onClick={() => onSelect(command)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`w-full text-left px-3 py-2 transition-colors ${
                index === selectedIndex ? 'bg-surface-hover' : ''
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-fg truncate">{command.displayName}</span>
                {command.argumentHint && (
                  <span className="text-[10px] font-mono text-fg-disabled truncate">{command.argumentHint}</span>
                )}
              </div>
              {command.description && (
                <p className="text-[11px] text-fg-faint truncate mt-0.5">{command.description}</p>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

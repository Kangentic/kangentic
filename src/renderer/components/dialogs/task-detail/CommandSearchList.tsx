import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Loader2, Search } from 'lucide-react';
import type { AgentCommand } from '../../../../shared/types';

interface CommandSearchListProps {
  cwd?: string;
  onSelect: (command: AgentCommand) => void;
  /** Dismiss request (Escape). The host decides what closes. */
  onClose: () => void;
}

/**
 * The searchable command / skill list: a filter input plus a keyboard-navigable
 * result list. Owns the command fetch and the search / selection state but NOT
 * positioning, so the same UI is hosted by both the header pill's
 * `CommandPalettePopover` and the kebab "Commands" flyout. It fills its parent
 * box; the host sets the width / max-height and the surface chrome.
 */
export function CommandSearchList({ cwd, onSelect, onClose }: CommandSearchListProps) {
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [searchFilter, setSearchFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.agent.listCommands(cwd);
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

  // Auto-focus the search input when the list opens.
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const filteredCommands = useMemo(() => {
    if (!searchFilter) return commands;
    const lower = searchFilter.toLowerCase();
    return commands.filter((command) =>
      command.name.toLowerCase().includes(lower)
      || command.description.toLowerCase().includes(lower)
    );
  }, [commands, searchFilter]);

  // Reset selection when the filter changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchFilter]);

  // Keep the selected item in view.
  useEffect(() => {
    if (!listRef.current) return;
    const items = listRef.current.querySelectorAll('[data-command-item]');
    items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
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
      if (filteredCommands[selectedIndex]) onSelect(filteredCommands[selectedIndex]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="flex flex-col min-h-0 h-full" onKeyDown={handleKeyDown}>
      <div className="flex items-center gap-2 px-2.5 py-2 border-b border-edge flex-shrink-0">
        <Search size={14} className="text-fg-faint flex-shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          placeholder="Search commands & skills..."
          value={searchFilter}
          onChange={(event) => setSearchFilter(event.target.value)}
          className="flex-1 min-w-0 bg-transparent text-sm text-fg placeholder-fg-faint outline-none"
          data-testid="command-search-input"
        />
      </div>
      <div ref={listRef} className="overflow-y-auto flex-1 min-h-0">
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
              <div className="flex items-center gap-1.5 min-w-0">
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

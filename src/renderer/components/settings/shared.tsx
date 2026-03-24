import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useSettingVisible, useSettingsSearch } from './settings-search';
import { Pill } from '../Pill';

// Re-export scope primitives so consumers can import everything from './shared'.
export { SettingsPanelProvider, useScopedUpdate } from './setting-scope';
export type { SettingScope } from './setting-scope';

type Phase = 'entering' | 'visible' | 'exiting';

/* ── Tab Definition ── */

export interface SettingsTabDefinition {
  id: string;
  label: string;
  icon: React.ElementType;
  /** Render a horizontal divider above this tab in the sidebar. */
  separator?: boolean;
  /** Tooltip shown on hover (e.g. "Applies to all projects"). */
  tooltip?: string;
}

/* ── Settings Content Props ── */

/** Props passed from SettingsPanel to the unified content component. */
export interface SettingsContentProps {
  activeTab: string;
  isSearching: boolean;
  searchQuery: string;
  matchingTabs: SettingsTabDefinition[];
  navigateToTab: (tabId: string) => void;
  shells: Array<{ name: string; path: string }>;
}

/* ── Panel Shell ── */

interface SettingsPanelShellProps {
  onClose: () => void;
  children: React.ReactNode;
  /** Optional project switcher rendered in the header row. */
  projectSwitcher?: React.ReactNode;
  tabs?: SettingsTabDefinition[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  tabMatchCounts?: Map<string, number>;
  isSearching?: boolean;
}

export function SettingsPanelShell({ onClose, children, projectSwitcher, tabs, activeTab, onTabChange, searchQuery, onSearchChange, tabMatchCounts, isSearching }: SettingsPanelShellProps) {
  const [phase, setPhase] = useState<Phase>('entering');
  const backdropMouseDown = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const requestClose = useCallback(() => {
    if (phase !== 'exiting') setPhase('exiting');
  }, [phase]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Ctrl+F / Cmd+F focuses search input
      if ((event.ctrlKey || event.metaKey) && event.key === 'f' && onSearchChange) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key === 'Escape') {
        // If searching, clear search first instead of closing
        if (isSearching && onSearchChange) {
          onSearchChange('');
          return;
        }
        requestClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [requestClose, isSearching, onSearchChange]);

  const handleBackdropAnimationEnd = () => {
    if (phase === 'entering') setPhase('visible');
    if (phase === 'exiting') onClose();
  };

  const backdropAnimation = phase === 'entering'
    ? 'dialog-backdrop-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'dialog-backdrop-out 150ms ease-in forwards'
      : 'none';

  const panelAnimation = phase === 'entering'
    ? 'settings-panel-in 200ms ease-out forwards'
    : phase === 'exiting'
      ? 'settings-panel-out 150ms ease-in forwards'
      : 'none';

  const sectionHeaderClass = 'text-[10px] uppercase tracking-widest text-fg-faint font-semibold px-4';
  const hasProjectTabs = tabs && !tabs[0]?.separator;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50"
      style={{ animation: backdropAnimation }}
      onAnimationEnd={handleBackdropAnimationEnd}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        className="fixed top-10 right-0 bottom-0 w-[720px] bg-surface-raised border-l border-edge shadow-2xl flex flex-col"
        style={{ animation: panelAnimation }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex-shrink-0 border-b border-edge">
          <div className="flex items-center justify-between px-6 py-4">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-semibold text-fg">Settings</h2>
              {projectSwitcher}
            </div>
            <button
              onClick={requestClose}
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Search bar */}
        {onSearchChange && (
          <div className="flex-shrink-0 px-6 py-3 border-b border-edge">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
              <input
                ref={searchInputRef}
                type="text"
                value={searchQuery || ''}
                onChange={(event) => onSearchChange(event.target.value)}
                placeholder="Search settings..."
                data-testid="settings-search"
                className="w-full bg-surface-hover border border-edge-input rounded pl-9 pr-9 py-1.5 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
              />
              {searchQuery && (
                <button
                  onClick={() => onSearchChange('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-fg-faint hover:text-fg-tertiary rounded transition-colors"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Content */}
        {tabs && activeTab && onTabChange ? (
          <div className="flex-1 flex overflow-hidden">
            {/* Tab sidebar */}
            <div className="w-44 flex-shrink-0 border-r border-edge py-3 space-y-0.5 overflow-y-auto">
              {tabs.map((tab, index) => {
                const Icon = tab.icon;
                const isActive = tab.id === activeTab;
                const matchCount = isSearching && tabMatchCounts ? tabMatchCounts.get(tab.id) : undefined;
                const hasNoMatches = isSearching && (matchCount === undefined || matchCount === 0);
                return (
                  <React.Fragment key={tab.id}>
                    {index === 0 && hasProjectTabs && (
                      <div className={`${sectionHeaderClass} pt-1 pb-1`}>Project</div>
                    )}
                    {tab.separator && (
                      <div className={`${sectionHeaderClass} pt-3 pb-1`}>System</div>
                    )}
                    <button
                      onClick={() => { if (!hasNoMatches) onTabChange(tab.id); }}
                      title={tab.tooltip}
                      className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                        hasNoMatches
                          ? 'opacity-40 cursor-default text-fg-muted'
                          : isActive
                            ? 'text-fg bg-surface-hover font-medium'
                            : 'text-fg-muted hover:text-fg-secondary hover:bg-surface-hover/50'
                      }`}
                    >
                      <Icon size={16} className={isActive && !hasNoMatches ? 'text-accent' : ''} />
                      <span className="flex-1 text-left">{tab.label}</span>
                      {isSearching && matchCount !== undefined && matchCount > 0 && (
                        <Pill size="sm" className="bg-surface-hover text-fg-faint min-w-[1.25rem] text-center">
                          {matchCount}
                        </Pill>
                      )}
                    </button>
                  </React.Fragment>
                );
              })}
            </div>
            {/* Tab content */}
            <div className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
                {children}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Search Tab Group Header ── */

/** Tab icon + name as a section divider in search results mode. */
export function SearchTabGroupHeader({ tab, first, onNavigate }: { tab: SettingsTabDefinition; first?: boolean; onNavigate?: (tabId: string) => void }) {
  const Icon = tab.icon;
  return (
    <div className={first ? 'pb-3' : 'pt-4 pb-3 mt-4 -mx-6 px-6 border-t border-edge'}>
      <Pill size="lg" onClick={() => onNavigate?.(tab.id)} className="bg-accent/10 hover:bg-accent/20 transition-colors">
        <Icon size={16} className="text-accent" />
        <span className="text-sm font-semibold text-accent">{tab.label}</span>
      </Pill>
    </div>
  );
}

/* ── No Search Results ── */

export function NoSearchResults({ query }: { query: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <Search size={32} className="text-fg-disabled mb-3" />
      <p className="text-sm text-fg-muted">No settings found for &ldquo;{query}&rdquo;</p>
      <p className="text-xs text-fg-faint mt-1">Try a different search term</p>
    </div>
  );
}

/* ── Section Header ── */

interface SectionHeaderProps {
  label: string;
  description?: string;
  /** Adds a stronger top border for visual separation (e.g. Project Defaults). */
  prominent?: boolean;
  /** Setting IDs in this section. When searching, hides if none match. */
  searchIds?: string[];
}

export function SectionHeader({ label, description, prominent, searchIds }: SectionHeaderProps) {
  const { isSearching, matchingIds } = useSettingsSearch();

  // When searching with searchIds, hide if none of the listed IDs match.
  if (isSearching && searchIds && searchIds.length > 0) {
    const anyVisible = searchIds.some((id) => matchingIds.has(id));
    if (!anyVisible) return null;
  }

  return (
    <div className={prominent ? 'pt-4 mt-4 border-t-2 border-edge' : 'pt-3 mt-2'}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-faint">{label}</h3>
      {description && <p className="text-xs text-fg-disabled mt-0.5">{description}</p>}
    </div>
  );
}

/* ── Setting Row ── */

interface SettingRowProps {
  label: string;
  description: string;
  children: React.ReactNode;
  /** Registry ID for search filtering. */
  searchId?: string;
}

export function SettingRow({ label, description, children, searchId }: SettingRowProps) {
  const visible = useSettingVisible(searchId);

  // Search filtering.
  if (!visible) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-fg-secondary">{label}</div>
          <div className="text-xs text-fg-faint">{description}</div>
        </div>
      </div>
      {children}
    </div>
  );
}

/* ── Select ── */

export function Select({ children, className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={className ?? "appearance-none bg-surface-hover border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"}
      >
        {children}
      </select>
      <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none" />
    </div>
  );
}

/* ── Toggle Switch ── */

export function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-edge-input'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/* ── Compact Toggle List ── */

export interface CompactToggleItem {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Registry ID for search filtering. */
  searchId?: string;
}

/**
 * Single-column list of label + toggle pairs. Material Design-style compact
 * rows for dense boolean groups (e.g. context bar visibility toggles).
 */
export function CompactToggleList({ items }: { items: CompactToggleItem[] }) {
  const { isSearching, matchingIds } = useSettingsSearch();

  // When searching, filter items to those with matching searchIds.
  const visibleItems = isSearching
    ? items.filter((item) => !item.searchId || matchingIds.has(item.searchId))
    : items;

  if (visibleItems.length === 0) return null;

  return (
    <div className="space-y-1">
      {visibleItems.map((item) => (
        <div key={item.label} className="flex items-center justify-between gap-4 py-1.5">
          <div className="min-w-0">
            <div className="text-sm text-fg-secondary leading-tight">{item.label}</div>
            {item.description && (
              <div className="text-xs text-fg-faint leading-tight">{item.description}</div>
            )}
          </div>
          <ToggleSwitch checked={item.checked} onChange={item.onChange} />
        </div>
      ))}
    </div>
  );
}

/** Standard input class for text/number inputs. */
export const INPUT_CLASS = 'bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent';

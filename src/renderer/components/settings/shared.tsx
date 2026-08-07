import React, { useEffect, useRef } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import { useAnySettingVisible, useSettingVisible, useSettingsSearch } from './settings-search';
import { TIER_LABELS } from './settings-tabs';
import type { SettingsTabTier } from './settings-tabs';
import { Pill } from '../Pill';
import { ToggleCard, ToggleIndicator } from '../ToggleCard';

// Re-export scope primitives so consumers can import everything from './shared'.
export { SettingsPanelProvider, useScopedUpdate } from './setting-scope';
export type { SettingScope } from './setting-scope';

/* ── Tab Definition ── */

export interface SettingsTabDefinition {
  id: string;
  label: string;
  icon: React.ElementType;
  /** 'project' tabs save to the project's override file; 'system' tabs are
   *  shared across all projects and must render with no project open. See
   *  settings-tabs.ts and .claude/rules/settings-tab-scope.md. */
  category: 'project' | 'system';
  /** Tooltip shown on hover (e.g. "Applies to all projects"). */
  tooltip?: string;
  /** Sidebar sub-grouping within the System group. See SettingsTabTier. */
  tier?: SettingsTabTier;
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
  fonts: string[];
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
  const { requestClose, backdropClassName, contentClassName, onAnimationEnd } = useOverlayPhase(
    onClose,
    { variant: 'panel' },
  );
  const backdropMouseDown = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

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

  const sectionHeaderClass = 'text-[10px] uppercase tracking-widest text-fg-faint font-semibold px-4';
  const hasProjectTabs = Boolean(tabs?.some((tab) => tab.category === 'project'));

  return (
    <div
      className={`fixed inset-0 bg-black/50 z-50 ${backdropClassName}`}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
    >
      <div
        className={`fixed top-10 right-0 bottom-0 w-[720px] bg-surface-raised border-l border-edge shadow-2xl flex flex-col ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
        onMouseDown={(event) => event.stopPropagation()}
        data-testid="settings-panel"
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
            <div data-testid="settings-tab-list" className="w-44 flex-shrink-0 border-r border-edge py-3 space-y-0.5 overflow-y-auto">
              {tabs.map((tab, index) => {
                const Icon = tab.icon;
                const isActive = tab.id === activeTab;
                const matchCount = isSearching && tabMatchCounts ? tabMatchCounts.get(tab.id) : undefined;
                const hasNoMatches = isSearching && (matchCount === undefined || matchCount === 0);
                const isFirstSystemTab = tab.category === 'system' && tabs[index - 1]?.category !== 'system';
                // 'core' is the first, unlabeled tier directly under the System
                // header (mirrors the unsectioned-first-group convention used
                // within individual tabs). Only later tiers get their own header.
                const isNewTier = tab.category === 'system' && tab.tier && tab.tier !== 'core'
                  && tab.tier !== tabs[index - 1]?.tier;
                return (
                  <React.Fragment key={tab.id}>
                    {index === 0 && hasProjectTabs && (
                      <div className={`${sectionHeaderClass} pt-1 pb-1`}>Project</div>
                    )}
                    {isFirstSystemTab && (
                      <>
                        {/* Full-bleed divider: the Project/System boundary is
                            load-bearing (System tabs must work with no project
                            open), so it gets a stronger visual break than the
                            tier headers below. */}
                        <div className="border-t border-edge mt-2" />
                        <div className={`${sectionHeaderClass} pt-2 pb-1`}>System</div>
                      </>
                    )}
                    {isNewTier && (
                      <div className={`${sectionHeaderClass} pt-3 pb-1`}>{TIER_LABELS[tab.tier as Exclude<SettingsTabTier, 'core'>]}</div>
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
  // Shared with the section BODIES that sit under a header (see
  // useAnySettingVisible's own comment): a header and its body must apply the
  // same any-of-these-ids rule, or the header hides while the body renders on
  // (or the reverse, orphaning the heading).
  const visible = useAnySettingVisible(searchIds);
  if (!visible) return null;

  return (
    <div className={prominent ? 'pt-4 mt-4 border-t-2 border-edge first:pt-0 first:mt-0' : 'pt-3 mt-2 first:pt-0 first:mt-0'}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-faint">{label}</h3>
      {description && <p className="text-xs text-fg-disabled mt-0.5">{description}</p>}
    </div>
  );
}

/* ── Setting Row ── */

interface SettingRowProps {
  /** Usually a string; a caller may pass a fragment (e.g. label text + a
   *  small `Pill` tag like "Optional") for a row that needs inline markup. */
  label: React.ReactNode;
  description: string;
  children: React.ReactNode;
  /** Registry ID for search filtering. */
  searchId?: string;
  /** Optional content rendered right-aligned in the label row. */
  trailing?: React.ReactNode;
}

export function SettingRow({ label, description, children, searchId, trailing }: SettingRowProps) {
  const visible = useSettingVisible(searchId);

  // Search filtering.
  if (!visible) return null;

  return (
    <div className="space-y-1.5" data-testid={searchId ? `setting-row-${searchId}` : undefined}>
      <div>
        <div className="text-sm font-medium text-fg-secondary">{label}</div>
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-fg-faint">{description}</div>
          {trailing}
        </div>
      </div>
      {children}
    </div>
  );
}

/* ── Select ── */

interface SelectExtraProps {
  /** Optional icon rendered at the left edge (absolute-positioned). */
  leadingIcon?: React.ReactNode;
  /** Override the chevron size. Defaults to 16. */
  chevronSize?: number;
  /** Override the chevron's right offset (Tailwind class, e.g. "right-2"). */
  chevronClassName?: string;
  /** Override the root wrapper className (defaults to "relative"). */
  wrapperClassName?: string;
}

export function Select({
  children,
  className,
  leadingIcon,
  chevronSize = 16,
  chevronClassName = 'right-3',
  wrapperClassName = 'relative',
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & SelectExtraProps) {
  return (
    <div className={`${wrapperClassName}${props.disabled ? ' opacity-60' : ''}`}>
      {leadingIcon}
      <select
        {...props}
        className={className ?? 'appearance-none bg-surface-hover border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent disabled:cursor-not-allowed'}
      >
        {children}
      </select>
      <ChevronDown size={chevronSize} className={`absolute ${chevronClassName} top-1/2 -translate-y-1/2 text-fg-muted pointer-events-none`} />
    </div>
  );
}

/* ── Download progress bar ── */

/** Thin filled progress bar for a model/asset download. Shared by the Dictation
 *  and Memory model-status cards so the two download indicators read identically. */
export function DownloadProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div
      className="mt-1 h-1 w-full overflow-hidden rounded-full bg-edge/40"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-300"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/* ── Toggle Switch ── */

export function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  /**
   * When true, the switch renders in its current `checked` state but does
   * not respond to clicks. Used for "always on / always off" settings
   * (e.g. crash capture) where visual consistency with neighbouring rows
   * matters but the user is not allowed to change the value.
   */
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={disabled ? undefined : () => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        checked ? 'bg-accent' : 'bg-edge-input'
      } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
        }`}
      />
    </button>
  );
}

/* ── Setting Toggle Row ── */

interface SettingToggleRowProps {
  label: string;
  description: string;
  searchId?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Optional left-side icon. */
  icon?: React.ReactNode;
  /** When true, the row renders greyed and ignores clicks (prerequisite unmet). */
  disabled?: boolean;
}

/**
 * Settings-panel wrapper around `<ToggleCard>` that hides the row when the
 * settings search filter excludes its `searchId`.
 */
export function SettingToggleRow({ label, description, searchId, checked, onChange, icon, disabled }: SettingToggleRowProps) {
  const visible = useSettingVisible(searchId);
  if (!visible) return null;

  return (
    <ToggleCard
      label={label}
      description={description}
      checked={checked}
      onChange={onChange}
      icon={icon}
      disabled={disabled}
    />
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
 * rows for dense boolean groups (e.g. context bar visibility toggles). Each
 * row is a click-anywhere button so the whole row toggles, not just the
 * switch on the right.
 */
export function CompactToggleList({ items }: { items: CompactToggleItem[] }) {
  const { isSearching, matchingIds } = useSettingsSearch();

  // When searching, filter items to those with matching searchIds.
  const visibleItems = isSearching
    ? items.filter((item) => !item.searchId || matchingIds.has(item.searchId))
    : items;

  if (visibleItems.length === 0) return null;

  return (
    <div className="space-y-0.5">
      {visibleItems.map((item) => (
        <button
          key={item.label}
          type="button"
          role="switch"
          aria-checked={item.checked}
          aria-label={item.label}
          onClick={() => item.onChange(!item.checked)}
          className="flex items-center justify-between gap-4 w-full text-left cursor-pointer rounded px-2 py-1.5 hover:bg-surface/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <div className="min-w-0">
            <div className="text-sm text-fg-secondary leading-tight">{item.label}</div>
            {item.description && (
              <div className="text-xs text-fg-faint leading-tight">{item.description}</div>
            )}
          </div>
          <ToggleIndicator checked={item.checked} />
        </button>
      ))}
    </div>
  );
}

/** Standard input class for text/number inputs. */
export const INPUT_CLASS = 'bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent';

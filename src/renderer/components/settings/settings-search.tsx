import React, { createContext, useContext, useMemo } from 'react';
import type { SettingDefinition } from './settings-registry';
import { TAB_LABELS } from './settings-registry';

/* ── Search Result Types ── */

export interface SearchResults {
  matchingIds: Set<string>;
  tabMatchCounts: Map<string, number>;
}

/* ── Search Matching ── */

/** Compute which setting IDs match a search query. All tokens must appear in at least one searchable field. */
export function computeSearchResults(query: string, registry: SettingDefinition[]): SearchResults {
  const matchingIds = new Set<string>();
  const tabMatchCounts = new Map<string, number>();

  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) {
    return { matchingIds, tabMatchCounts };
  }

  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);

  for (const entry of registry) {
    const searchableFields = [
      entry.label.toLowerCase(),
      entry.description.toLowerCase(),
      (entry.section || '').toLowerCase(),
      (TAB_LABELS[entry.tabId] || '').toLowerCase(),
      ...(entry.keywords || []).map((keyword) => keyword.toLowerCase()),
    ].join(' ');

    const allTokensMatch = tokens.every((token) => searchableFields.includes(token));
    if (allTokensMatch) {
      matchingIds.add(entry.id);
      tabMatchCounts.set(entry.tabId, (tabMatchCounts.get(entry.tabId) || 0) + 1);
    }
  }

  return { matchingIds, tabMatchCounts };
}

/* ── React Context ── */

interface SettingsSearchContextValue {
  isSearching: boolean;
  matchingIds: Set<string>;
  query: string;
}

const SettingsSearchContext = createContext<SettingsSearchContextValue>({
  isSearching: false,
  matchingIds: new Set(),
  query: '',
});

export function SettingsSearchProvider({ query, matchingIds, children }: {
  query: string;
  matchingIds: Set<string>;
  children: React.ReactNode;
}) {
  const value = useMemo(() => ({
    isSearching: query.trim().length > 0,
    matchingIds,
    query,
  }), [query, matchingIds]);

  return (
    <SettingsSearchContext.Provider value={value}>
      {children}
    </SettingsSearchContext.Provider>
  );
}

/** Get search state from context. */
export function useSettingsSearch() {
  return useContext(SettingsSearchContext);
}

/** Returns true when this setting should be visible (not searching, or ID is in matches). */
export function useSettingVisible(searchId: string | undefined): boolean {
  const { isSearching, matchingIds } = useContext(SettingsSearchContext);
  if (!isSearching) return true;
  if (!searchId) return true;
  return matchingIds.has(searchId);
}

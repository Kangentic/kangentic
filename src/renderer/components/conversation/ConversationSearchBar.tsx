/**
 * In-viewer search bar hosted by ConversationView. Always visible (no
 * open/close state - Mod+F focuses it rather than toggling it) - client-side
 * lexical substring search over the reconciled rows' `searchText` (see
 * `display-rows.ts`). No semantic matching (SearchPalette owns that) and no
 * inline markdown highlight injection; navigating to a hit reuses
 * ConversationView's existing amber row-flash instead.
 *
 * Standard find-bar cursor model: `currentMatchIndex` starts at -1 (nothing
 * active yet). Next/Enter and Prev/Shift+Enter both wrap and always land on a
 * real match; clicking a specific result row jumps straight to it.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Search, ChevronUp, ChevronDown } from 'lucide-react';
import { HeaderActionButton } from '../HeaderActionButton';
import type { DisplayRow } from './display-rows';

interface ConversationSearchBarProps {
  rows: DisplayRow[];
  onNavigate: (uuid: string, options?: { flash?: boolean }) => boolean;
}

/** Imperative handle so the owning window's Mod+F keybinding can focus the
 *  (already-visible) input without this component owning any open/close state. */
export interface ConversationSearchBarHandle {
  focus: () => void;
}

interface SearchMatch {
  uuid: string;
  snippet: string;
  snippetMatchStart: number;
  snippetMatchEnd: number;
}

const DEBOUNCE_MS = 120;
const MAX_RESULTS = 200;
const SNIPPET_RADIUS = 40;

function buildSnippet(text: string, matchStart: number, matchEnd: number): { snippet: string; snippetMatchStart: number; snippetMatchEnd: number } {
  const start = Math.max(0, matchStart - SNIPPET_RADIUS);
  const end = Math.min(text.length, matchEnd + SNIPPET_RADIUS);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < text.length ? '...' : '';
  return {
    snippet: `${prefix}${text.slice(start, end)}${suffix}`,
    snippetMatchStart: matchStart - start + prefix.length,
    snippetMatchEnd: matchEnd - start + prefix.length,
  };
}

export const ConversationSearchBar = forwardRef<ConversationSearchBarHandle, ConversationSearchBarProps>(
  function ConversationSearchBar({ rows, onNavigate }, ref) {
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [currentMatchIndex, setCurrentMatchIndex] = useState(-1);
    const inputRef = useRef<HTMLInputElement>(null);

    useImperativeHandle(ref, () => ({
      focus: () => {
        inputRef.current?.focus();
        inputRef.current?.select();
      },
    }), []);

    useEffect(() => {
      const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
      return () => clearTimeout(timer);
    }, [query]);

    const matches = useMemo<SearchMatch[]>(() => {
      const needle = debouncedQuery.trim().toLowerCase();
      if (needle.length === 0) return [];
      const results: SearchMatch[] = [];
      for (const row of rows) {
        const haystack = row.searchText.toLowerCase();
        const matchIndex = haystack.indexOf(needle);
        if (matchIndex < 0) continue;
        const { snippet, snippetMatchStart, snippetMatchEnd } = buildSnippet(
          row.searchText,
          matchIndex,
          matchIndex + needle.length,
        );
        results.push({ uuid: row.uuid, snippet, snippetMatchStart, snippetMatchEnd });
        if (results.length >= MAX_RESULTS) break;
      }
      return results;
    }, [rows, debouncedQuery]);

    useEffect(() => {
      setCurrentMatchIndex(-1);
    }, [debouncedQuery]);

    const goToMatchIndex = useCallback(
      (index: number) => {
        setCurrentMatchIndex(index);
        onNavigate(matches[index].uuid);
      },
      [matches, onNavigate],
    );

    const goToNext = useCallback(() => {
      if (matches.length === 0) return;
      goToMatchIndex(currentMatchIndex < 0 ? 0 : (currentMatchIndex + 1) % matches.length);
    }, [matches.length, currentMatchIndex, goToMatchIndex]);

    const goToPrevious = useCallback(() => {
      if (matches.length === 0) return;
      goToMatchIndex(currentMatchIndex < 0 ? matches.length - 1 : (currentMatchIndex - 1 + matches.length) % matches.length);
    }, [matches.length, currentMatchIndex, goToMatchIndex]);

    const handleInputKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          // Dismiss focus (not the bar itself - it has no closed state) and
          // keep this from also reaching the window's structural Escape
          // handler, which would otherwise close the whole conversation window.
          event.stopPropagation();
          inputRef.current?.blur();
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.shiftKey) goToPrevious();
          else goToNext();
        }
      },
      [goToNext, goToPrevious],
    );

    const countLabel = matches.length === 0
      ? (debouncedQuery.trim().length > 0 ? 'No results' : '')
      : `${currentMatchIndex >= 0 ? currentMatchIndex + 1 : 0} of ${matches.length}`;

    return (
      <div
        className="flex flex-col border-b border-edge bg-surface-raised flex-shrink-0"
        data-testid="conversation-search-bar"
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <Search size={14} className="flex-shrink-0 text-fg-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder="Search this conversation"
            className="flex-1 min-w-0 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
            data-testid="conversation-search-input"
          />
          {countLabel.length > 0 && (
            <span className="text-[11px] text-fg-muted whitespace-nowrap" data-testid="conversation-search-count">
              {countLabel}
            </span>
          )}
          <HeaderActionButton
            icon={ChevronUp}
            onClick={goToPrevious}
            disabled={matches.length === 0}
            title="Previous match"
            ariaLabel="Previous match"
            size="small"
            testId="conversation-search-previous"
          />
          <HeaderActionButton
            icon={ChevronDown}
            onClick={goToNext}
            disabled={matches.length === 0}
            title="Next match"
            ariaLabel="Next match"
            size="small"
            testId="conversation-search-next"
          />
        </div>
        {matches.length > 0 && (
          <div className="max-h-48 overflow-y-auto border-t border-edge/60" data-testid="conversation-search-results">
            {matches.map((match, index) => (
              <button
                key={`${match.uuid}-${index}`}
                type="button"
                onClick={() => goToMatchIndex(index)}
                data-testid="conversation-search-result"
                data-highlighted={index === currentMatchIndex ? 'true' : undefined}
                className={`block w-full truncate px-3 py-1.5 text-left text-xs transition-colors ${
                  index === currentMatchIndex
                    ? 'bg-accent/15 text-fg'
                    : 'text-fg-muted hover:bg-surface-hover hover:text-fg-secondary'
                }`}
              >
                <SnippetText
                  text={match.snippet}
                  highlightStart={match.snippetMatchStart}
                  highlightEnd={match.snippetMatchEnd}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);

function SnippetText({ text, highlightStart, highlightEnd }: { text: string; highlightStart: number; highlightEnd: number }) {
  const before = text.slice(0, highlightStart);
  const match = text.slice(highlightStart, highlightEnd);
  const after = text.slice(highlightEnd);
  return (
    <>
      {before}
      <mark className="bg-amber-400/30 text-inherit rounded-sm">{match}</mark>
      {after}
    </>
  );
}

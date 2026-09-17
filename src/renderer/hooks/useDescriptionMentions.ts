import { useEffect, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent, type RefObject, type SyntheticEvent } from 'react';
import type { ProjectSearchEntry } from '../../shared/types';
import {
  detectDescriptionMentionTrigger,
  extendDescriptionMentionRangeForTrailingSpace,
  replaceDescriptionRange,
} from '../utils/description-mentions';

// Stable empty list so the derived items keep a referentially constant value
// when there is nothing to show.
// hmr-safe: never mutated; a referential-identity sentinel for "no results".
const EMPTY_RESULTS: ProjectSearchEntry[] = [];

interface UseDescriptionMentionsOptions {
  value: string;
  onChange: (value: string) => void;
  mentionSearchCwd?: string | null;
  disabled?: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

interface UseDescriptionMentionsResult {
  menuOpen: boolean;
  items: ProjectSearchEntry[];
  isLoading: boolean;
  helperText: string;
  activeIndex: number;
  handleTextareaChangeCapture: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  handleTextareaSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  handleTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  handleTextareaBlur: () => void;
  handleTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  setActiveIndex: (index: number) => void;
  selectItem: (item: ProjectSearchEntry) => void;
  reset: () => void;
}

export function useDescriptionMentions({
  value,
  onChange,
  mentionSearchCwd = null,
  disabled = false,
  textareaRef,
}: UseDescriptionMentionsOptions): UseDescriptionMentionsResult {
  const [mentionTrigger, setMentionTrigger] = useState<ReturnType<typeof detectDescriptionMentionTrigger>>(null);
  // The last search that settled, stored with the key (cwd + query) it was run
  // for. Loading, error, and the visible items are DERIVED from it against the
  // current key, so typing a new query reads as "loading" at once and an
  // unsettled search never needs an effect to set a flag (the cascading-render
  // shape React's compiler rules forbid). The previous results stay on screen
  // while the next search runs, as they did when the flag was state.
  const [mentionSearch, setMentionSearch] = useState<{ key: string; results: ProjectSearchEntry[]; error: boolean } | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [dismissedMentionKey, setDismissedMentionKey] = useState<string | null>(null);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = () => {
    setMentionTrigger(null);
    setMentionSearch(null);
    setActiveMentionIndex(0);
  };

  const syncMentionTrigger = (
    nextValue: string,
    selectionStart: number,
    selectionEnd = selectionStart,
  ) => {
    if (disabled || !mentionSearchCwd) {
      reset();
      return;
    }

    const nextTrigger = detectDescriptionMentionTrigger(nextValue, selectionStart, selectionEnd);
    if (!nextTrigger) {
      setDismissedMentionKey(null);
      reset();
      return;
    }

    const nextDismissedMentionKey = `${nextTrigger.rangeStart}:${nextTrigger.rangeEnd}:${nextTrigger.query}`;
    if (dismissedMentionKey === nextDismissedMentionKey) {
      reset();
      return;
    }

    if (dismissedMentionKey) {
      setDismissedMentionKey(null);
    }

    setMentionTrigger(nextTrigger);
  };

  const syncFromTextarea = (target: HTMLTextAreaElement) => {
    syncMentionTrigger(
      target.value,
      target.selectionStart ?? target.value.length,
      target.selectionEnd ?? target.value.length,
    );
  };

  const mentionQuery = mentionTrigger?.query ?? null;
  // A search runs for a non-empty query with a cwd to search in; an empty
  // query shows the "type to search" helper and no items.
  const searchKey = mentionQuery !== null && mentionQuery.length > 0 && mentionSearchCwd
    ? JSON.stringify([mentionSearchCwd, mentionQuery])
    : null;
  const mentionSettled = searchKey !== null && mentionSearch?.key === searchKey;
  const mentionLoading = searchKey !== null && !mentionSettled;
  const mentionError = mentionSettled && mentionSearch.error;
  const mentionResults: ProjectSearchEntry[] = searchKey === null ? EMPTY_RESULTS : (mentionSearch?.results ?? EMPTY_RESULTS);

  useEffect(() => {
    if (searchKey === null || mentionQuery === null || !mentionSearchCwd) return;
    let cancelled = false;
    // Calls window.electronAPI directly (not via a store) because this is a
    // stateless search query with no shared state to manage.
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      window.electronAPI.projects.searchEntries({
        cwd: mentionSearchCwd,
        query: mentionQuery,
        limit: 80,
      }).then((result) => {
        if (cancelled) return;
        setMentionSearch({ key: searchKey, results: result.entries, error: false });
        setActiveMentionIndex(0);
      }).catch(() => {
        if (cancelled) return;
        setMentionSearch({ key: searchKey, results: [], error: true });
        setActiveMentionIndex(0);
      });
    }, 120);

    return () => {
      cancelled = true;
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [searchKey, mentionQuery, mentionSearchCwd]);

  // Becoming disabled closes the menu. A render-time adjustment on the
  // transition (React's "adjusting state when a prop changes" pattern) rather
  // than an effect, so the menu never paints a frame after the field is
  // disabled.
  const [wasDisabled, setWasDisabled] = useState(disabled);
  if (disabled !== wasDisabled) {
    setWasDisabled(disabled);
    if (disabled) reset();
  }

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const menuOpen = !disabled && !!mentionTrigger;
  const activeMentionItem = mentionResults[activeMentionIndex] ?? null;
  const helperText = useMemo(() => {
    if (mentionError) return 'File search unavailable.';
    if (mentionTrigger?.query.length === 0) return 'Type to search files and folders.';
    if (mentionLoading) return 'Searching files and folders...';
    return 'No matching files or folders.';
  }, [mentionError, mentionLoading, mentionTrigger]);

  useEffect(() => {
    if (!menuOpen) return;

    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (mentionTrigger) {
        setDismissedMentionKey(`${mentionTrigger.rangeStart}:${mentionTrigger.rangeEnd}:${mentionTrigger.query}`);
      }
      reset();
    };

    document.addEventListener('keydown', handleDocumentKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleDocumentKeyDown, true);
    };
  }, [menuOpen, mentionTrigger]);

  const selectItem = (entry: ProjectSearchEntry) => {
    if (!mentionTrigger) return;

    const replacement = `@${entry.path} `;
    const rangeEnd = extendDescriptionMentionRangeForTrailingSpace(
      value,
      mentionTrigger.rangeEnd,
      replacement,
    );
    const next = replaceDescriptionRange(value, mentionTrigger.rangeStart, rangeEnd, replacement);
    setDismissedMentionKey(null);
    onChange(next.text);
    reset();

    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const handleTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!menuOpen) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      if (mentionResults.length > 0) {
        setActiveMentionIndex((previous) => (previous + 1) % mentionResults.length);
      }
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (mentionResults.length > 0) {
        setActiveMentionIndex((previous) => (previous - 1 + mentionResults.length) % mentionResults.length);
      }
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      if (activeMentionItem) {
        selectItem(activeMentionItem);
      }
      return;
    }

    // Escape is handled by the document-level capture listener (see useEffect above)
  };

  return {
    menuOpen,
    items: mentionResults,
    isLoading: mentionLoading,
    helperText,
    activeIndex: activeMentionIndex,
    handleTextareaChangeCapture: (event) => syncFromTextarea(event.currentTarget),
    handleTextareaSelect: (event) => syncFromTextarea(event.currentTarget),
    handleTextareaClick: (event) => syncFromTextarea(event.currentTarget),
    handleTextareaBlur: reset,
    handleTextareaKeyDown,
    setActiveIndex: setActiveMentionIndex,
    selectItem,
    reset,
  };
}

export type DescriptionMentionsState = ReturnType<typeof useDescriptionMentions>;

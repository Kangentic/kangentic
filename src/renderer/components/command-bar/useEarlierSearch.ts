/**
 * The Earlier list's search. The rows the query reaches by name or first prompt
 * come straight from the list (`matchEarlierEntries`); the rows it reaches by
 * conversation text come from main a beat after typing stops, and go below the
 * others, so a row on screen never moves when they land.
 *
 * Main's answer holds while the query extends the answered one, a new word
 * included, until main answers the longer query, so the text rows do not drop
 * out and come back on every keystroke. A query that does not extend it drops
 * it: those rows matched something else.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { matchEarlierEntries, type EarlierMatch } from './earlier-search';
import type { CommandTerminalHistoryEntry, CommandTerminalHistorySearchHit } from '../../../shared/types';

/** How long typing must stop before main is asked. */
const TEXT_SEARCH_DEBOUNCE_MS = 200;

interface TextAnswer {
  projectId: string;
  query: string;
  hits: CommandTerminalHistorySearchHit[];
  indexingOff: boolean;
}

export interface EarlierSearch {
  /** Something is typed. */
  active: boolean;
  /** The rows the name or first prompt reached; every row with nothing typed. */
  nameMatches: EarlierMatch[];
  /** The rows only the conversation text reached, best first. */
  textMatches: EarlierMatch[];
  /** Main has not answered this query yet. */
  textPending: boolean;
  /** Indexing is off, so no conversation text was searched. */
  indexingOff: boolean;
}

export function useEarlierSearch(
  projectId: string | null,
  entries: ReadonlyArray<CommandTerminalHistoryEntry>,
  query: string,
): EarlierSearch {
  const trimmed = query.trim();
  const [answer, setAnswer] = useState<TextAnswer | null>(null);
  // Numbers each read, so a slow answer never replaces a newer one.
  const readSequenceRef = useRef(0);

  useEffect(() => {
    const read = ++readSequenceRef.current;
    if (!projectId || !trimmed) return;
    const timer = setTimeout(() => {
      window.electronAPI.sessions.searchCommandTerminalHistory(projectId, trimmed)
        .then((result) => {
          if (read === readSequenceRef.current) setAnswer({ projectId, query: trimmed, ...result });
        })
        // The rail then shows its name matches alone.
        .catch(() => {
          if (read === readSequenceRef.current) setAnswer({ projectId, query: trimmed, hits: [], indexingOff: false });
        });
    }, TEXT_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, trimmed]);

  const nameMatches = useMemo(() => matchEarlierEntries(entries, trimmed), [entries, trimmed]);

  const heldAnswer = trimmed !== ''
    && answer?.projectId === projectId
    && trimmed.toLowerCase().startsWith(answer.query.toLowerCase()) ? answer : null;
  const textMatches = useMemo(() => {
    if (!heldAnswer) return [];
    const shownByName = new Set(nameMatches.map((match) => match.entry.agentSessionId));
    const entryById = new Map(entries.map((entry) => [entry.agentSessionId, entry]));
    const matches: EarlierMatch[] = [];
    for (const hit of heldAnswer.hits) {
      const entry = entryById.get(hit.agentSessionId);
      if (!entry || shownByName.has(hit.agentSessionId)) continue;
      matches.push({
        entry,
        nameMatch: null,
        snippet: { text: hit.snippet, matchStart: hit.matchStart, matchEnd: hit.matchEnd },
      });
    }
    return matches;
  }, [heldAnswer, nameMatches, entries]);

  return {
    active: trimmed !== '',
    nameMatches,
    textMatches,
    textPending: trimmed !== '' && heldAnswer?.query !== trimmed,
    indexingOff: heldAnswer?.query === trimmed && heldAnswer.indexingOff,
  };
}

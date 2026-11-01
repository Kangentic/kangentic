/**
 * The Earlier list's search over what the rail already holds: each conversation's
 * name and first prompt, matched as the user types with no call to main. Every
 * word of the query must appear in one or the other, as the text search's own
 * query requires every word (`escapeFtsMatchQuery`).
 */

import { commandTerminalHistoryName } from '../../../shared/command-terminal-name';
import type { CommandTerminalHistoryEntry } from '../../../shared/types';

/** Text with the stretch of it that matched. */
export interface HighlightedText {
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface EarlierMatch {
  entry: CommandTerminalHistoryEntry;
  /** Where the name matched, or null when it did not. */
  nameMatch: { matchStart: number; matchEnd: number } | null;
  /**
   * The passage that matched when the row's name does not show it: the first
   * prompt of a row that has a name, or the transcript around a text match.
   */
  snippet: HighlightedText | null;
}

/** Characters kept before a match in a prompt, so the row shows why it matched. */
const SNIPPET_LEAD_CHARS = 24;

function queryWords(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
}

/** The passage of a prompt around `matchStart`, cut at the front when it is far in. */
function promptSnippet(prompt: string, matchStart: number, matchLength: number): HighlightedText {
  const start = Math.max(0, matchStart - SNIPPET_LEAD_CHARS);
  const lead = start > 0 ? '…' : '';
  const shift = lead.length - start;
  return { text: `${lead}${prompt.slice(start)}`, matchStart: matchStart + shift, matchEnd: matchStart + matchLength + shift };
}

/** A row with no search on it: nothing to mark. */
function unmatched(entry: CommandTerminalHistoryEntry): EarlierMatch {
  return { entry, nameMatch: null, snippet: null };
}

/**
 * The entries a query's words reach, in list order, so a row keeps its place
 * among the others. A row whose name shows a word marks it there; one that
 * matched only in a prompt its name hides shows that passage instead.
 */
export function matchEarlierEntries(entries: ReadonlyArray<CommandTerminalHistoryEntry>, query: string): EarlierMatch[] {
  const words = queryWords(query);
  if (words.length === 0) return entries.map(unmatched);
  const matches: EarlierMatch[] = [];
  for (const entry of entries) {
    const name = commandTerminalHistoryName(entry) ?? '';
    const prompt = entry.firstPrompt ?? '';
    const lowerName = name.toLowerCase();
    const lowerPrompt = prompt.toLowerCase();
    if (!words.every((word) => lowerName.includes(word) || lowerPrompt.includes(word))) continue;

    const nameWord = words.find((word) => lowerName.includes(word));
    if (nameWord !== undefined) {
      const matchStart = lowerName.indexOf(nameWord);
      matches.push({ entry, nameMatch: { matchStart, matchEnd: matchStart + nameWord.length }, snippet: null });
      continue;
    }
    // Every word is in the prompt, since none is in the name.
    const promptWord = words[0];
    matches.push({ entry, nameMatch: null, snippet: promptSnippet(prompt, lowerPrompt.indexOf(promptWord), promptWord.length) });
  }
  return matches;
}

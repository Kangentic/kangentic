/**
 * The Earlier list's search over the rows the rail already holds
 * (src/renderer/components/command-bar/earlier-search.ts).
 */
import { describe, expect, it } from 'vitest';
import { matchEarlierEntries } from '../../src/renderer/components/command-bar/earlier-search';
import type { CommandTerminalHistoryEntry } from '../../src/shared/types';

function entry(agentSessionId: string, label: string | null, firstPrompt: string | null): CommandTerminalHistoryEntry {
  return { agentSessionId, label, firstPrompt, agentName: 'claude', endedAt: '2026-10-24T10:00:00.000Z' };
}

const ENTRIES = [
  entry('named', 'Did the Release Happen', 'check the nightly build'),
  entry('prompt-only', 'Translated READMEs', 'link each translation before the release tag'),
  entry('no-name', null, 'why does the release notes page scroll'),
  entry('untitled', null, null),
];

function ids(query: string): string[] {
  return matchEarlierEntries(ENTRIES, query).map((match) => match.entry.agentSessionId);
}

describe('matchEarlierEntries', () => {
  it('lists every row, unmarked, with nothing typed', () => {
    const matches = matchEarlierEntries(ENTRIES, '   ');
    expect(matches.map((match) => match.entry.agentSessionId)).toEqual(['named', 'prompt-only', 'no-name', 'untitled']);
    expect(matches.every((match) => match.nameMatch === null && match.snippet === null)).toBe(true);
  });

  it('keeps list order and ignores case', () => {
    expect(ids('RELEASE')).toEqual(['named', 'prompt-only', 'no-name']);
  });

  it('marks the word in a name it shows', () => {
    const [match] = matchEarlierEntries(ENTRIES, 'release');
    expect(match.nameMatch).toEqual({ matchStart: 8, matchEnd: 15 });
    expect(match.snippet).toBeNull();
  });

  it('marks a row with no name in its first prompt, which is the name it shows', () => {
    const match = matchEarlierEntries(ENTRIES, 'release')[2];
    expect(match.entry.agentSessionId).toBe('no-name');
    expect(match.nameMatch).toEqual({ matchStart: 13, matchEnd: 20 });
    expect(match.snippet).toBeNull();
  });

  it('shows the passage of a prompt the name hides, cut at the front, with its range on the cut text', () => {
    const match = matchEarlierEntries(ENTRIES, 'release')[1];
    expect(match.nameMatch).toBeNull();
    const snippet = match.snippet;
    expect(snippet?.text.startsWith('…')).toBe(true);
    expect(snippet?.text.slice(snippet.matchStart, snippet.matchEnd)).toBe('release');
  });

  it('leaves a short prompt whole', () => {
    const [match] = matchEarlierEntries([entry('short', 'Named', 'the release tag')], 'release');
    expect(match.snippet).toEqual({ text: 'the release tag', matchStart: 4, matchEnd: 11 });
  });

  it('needs every word, in the name or the prompt, as the text search does', () => {
    expect(ids('release nightly')).toEqual(['named']);
    expect(ids('release translation')).toEqual(['prompt-only']);
    expect(ids('release absent')).toEqual([]);
  });

  it('matches nothing in a row with neither name nor prompt', () => {
    expect(ids('untitled')).toEqual([]);
  });
});

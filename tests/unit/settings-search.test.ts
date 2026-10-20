/**
 * Guards the Hotkeys/Shortcuts search-bleed fix (see the task that disentangled
 * "Hotkeys" from the "Shortcuts" custom-commands feature). Searching "shortcut"
 * must surface only the Shortcuts (custom commands) tab, never the Hotkeys tab -
 * the two are separate features that happen to share vocabulary.
 */

import { describe, it, expect, vi } from 'vitest';

// `useAnySettingVisible` is a hook (it calls `useContext` internally), so
// calling it directly outside a React render trips React's "invalid hook
// call" guard. Following the established pattern in
// tests/unit/activity-mark-render.test.ts (this project's vitest config has
// no jsdom environment and no @testing-library/react dependency, so hooks
// under test are stubbed rather than reconciled): stub `useContext` to read
// a test-controlled value, then call the hook as a plain function. This is
// sound because every assertion below is about `useAnySettingVisible`'s own
// branching over that context value, not about how it is wired into
// `SettingsCard` or the DOM - that integration is covered at the UI tier by
// the "search matching only one section id" regression test in
// tests/ui/mobile-devices-settings.spec.ts.
let mockSearchContextValue: { isSearching: boolean; matchingIds: Set<string>; query: string };

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useContext: () => mockSearchContextValue,
  };
});

import { computeSearchResults, useAnySettingVisible } from '../../src/renderer/components/settings/settings-search';
import { SETTINGS_REGISTRY, type SettingDefinition } from '../../src/renderer/components/settings/settings-registry';

describe('settings search: hotkeys/shortcuts disentanglement', () => {
  it('matches the Shortcuts tab but not the Hotkeys tab on "shortcut"', () => {
    const { matchingIds } = computeSearchResults('shortcut', SETTINGS_REGISTRY);
    expect(matchingIds.has('shortcuts')).toBe(true);
    expect(matchingIds.has('hotkeys')).toBe(false);
  });

  it.each(['hotkey', 'keybind', 'keyboard'])('still matches the Hotkeys tab on "%s"', (query) => {
    const { matchingIds } = computeSearchResults(query, SETTINGS_REGISTRY);
    expect(matchingIds.has('hotkeys')).toBe(true);
  });
});

describe('settings search: mobileBridge.getApp rename back-compat', () => {
  // The Mobile Devices "Get the App" section was renamed to "Kangentic
  // Mobile", so that literal string no longer appears anywhere it renders.
  // 'get the app' is kept as a deliberate keyword alias so a user searching
  // Settings from muscle memory (the old label) still finds the entry. This
  // is invisible in the UI tier (nothing renders the old string to assert
  // against) and easy to prune as "stray" cruft, so pin it here.
  it('still matches mobileBridge.getApp on the old "get the app" label', () => {
    const { matchingIds } = computeSearchResults('get the app', SETTINGS_REGISTRY);
    expect(matchingIds.has('mobileBridge.getApp')).toBe(true);
  });
});

describe('settings search: hosted relay preset rename back-compat', () => {
  // The same shape as the getApp aliases above, for the relay row: the hosted
  // preset was relabelled "Kangentic Cloud" -> "Kangentic Relay". Settings
  // search indexes registry fields only, never the rendered <option> text (see
  // settings-search.tsx), so BOTH names have to be carried as keywords on
  // mobileBridge.relayMode or the row becomes unfindable by the only name the
  // user has ever seen. Neither direction is visible in the UI tier, and the
  // old-name keywords in particular read as stray cruft to a future reader, so
  // pin both here.
  it.each(['kangentic relay', 'official'])('matches the relay row on the new name "%s"', (query) => {
    const { matchingIds } = computeSearchResults(query, SETTINGS_REGISTRY);
    expect(matchingIds.has('mobileBridge.relayMode')).toBe(true);
  });

  it.each(['kangentic cloud', 'cloud'])('still matches the relay row on the old name "%s"', (query) => {
    const { matchingIds } = computeSearchResults(query, SETTINGS_REGISTRY);
    expect(matchingIds.has('mobileBridge.relayMode')).toBe(true);
  });
});

describe('settings search: sentence punctuation around a word', () => {
  // Dictation into the search box commits the refinement model's text, which closes the
  // sentence: saying "push to talk" types "Push to talk.". Every word must still match, so a
  // period, comma, question or exclamation mark, colon or semicolon at either end of a word is
  // not part of it. The bug this pins: "talk." is a substring of no entry, so the panel switched
  // to No results the moment the key was let go.
  it('matches a dictated "Push to talk." exactly as it matches "push to talk"', () => {
    const plain = computeSearchResults('push to talk', SETTINGS_REGISTRY).matchingIds;
    const dictated = computeSearchResults('Push to talk.', SETTINGS_REGISTRY).matchingIds;
    expect(plain.has('dictation.releaseBufferMs')).toBe(true);
    expect([...dictated].sort()).toEqual([...plain].sort());
  });

  it.each(['release, buffer', 'release buffer?', '"release buffer"!', 'release: buffer;'])('ignores the marks in %j', (query) => {
    expect(computeSearchResults(query, SETTINGS_REGISTRY).matchingIds.has('dictation.releaseBufferMs')).toBe(true);
  });

  it('keeps a mark inside a word', () => {
    // A dot inside a token is part of the word (a file name, a version, "e.g."), so it still
    // has to match as written. Only the first entry holds the file name; the second holds both
    // words apart, which a search that dropped the inner dot would match too.
    const registry: SettingDefinition[] = [
      { id: 'file', tabId: 'board', label: 'Shared board file', description: 'Writes kangentic.json beside the project.', scope: 'project' },
      { id: 'words', tabId: 'board', label: 'Export', description: 'Saves the kangentic board as json.', scope: 'project' },
    ];
    expect([...computeSearchResults('kangentic.json', registry).matchingIds]).toEqual(['file']);
    expect([...computeSearchResults('kangentic json', registry).matchingIds].sort()).toEqual(['file', 'words']);
  });

  it('matches nothing for a query that is only punctuation', () => {
    expect(computeSearchResults(' . ? ', SETTINGS_REGISTRY).matchingIds.size).toBe(0);
  });
});

describe('useAnySettingVisible', () => {
  // The four branches straight from the function's own JSDoc contract
  // (settings-search.tsx): not searching -> visible; searching with no/empty
  // ids -> visible; searching with ids -> visible if ANY id matches, hidden
  // otherwise. `SettingsCard` and MobileDevicesTab's Relay/Mobile section
  // bodies both apply this same rule to keep a header and its body from
  // disagreeing about a search - see the JSDoc on the hook itself.

  it('is visible when not searching, even if none of the given ids would match', () => {
    mockSearchContextValue = { isSearching: false, matchingIds: new Set(['relay']), query: '' };
    expect(useAnySettingVisible(['unrelated'])).toBe(true);
  });

  it('is visible while searching when searchIds is undefined (PrivacyTab/HotkeysTab/ShortcutsTab shape)', () => {
    mockSearchContextValue = { isSearching: true, matchingIds: new Set(['relay']), query: 'relay' };
    expect(useAnySettingVisible(undefined)).toBe(true);
  });

  it('is visible while searching when searchIds is an empty array', () => {
    mockSearchContextValue = { isSearching: true, matchingIds: new Set(['relay']), query: 'relay' };
    expect(useAnySettingVisible([])).toBe(true);
  });

  it('is visible while searching when only ONE of several ids matches (any-of, not all-of)', () => {
    mockSearchContextValue = {
      isSearching: true,
      matchingIds: new Set(['mobileBridge.getApp']),
      query: 'get',
    };
    expect(useAnySettingVisible(['mobileBridge.relayMode', 'mobileBridge.getApp'])).toBe(true);
  });

  it('is hidden while searching when none of the given ids match', () => {
    mockSearchContextValue = {
      isSearching: true,
      matchingIds: new Set(['somethingElse']),
      query: 'x',
    };
    expect(useAnySettingVisible(['mobileBridge.relayMode', 'mobileBridge.getApp'])).toBe(false);
  });
});

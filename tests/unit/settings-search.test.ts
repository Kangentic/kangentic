/**
 * Guards the Hotkeys/Shortcuts search-bleed fix (see the task that disentangled
 * "Hotkeys" from the "Shortcuts" custom-commands feature). Searching "shortcut"
 * must surface only the Shortcuts (custom commands) tab, never the Hotkeys tab -
 * the two are separate features that happen to share vocabulary.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { compileMessage } from '@lingui/message-utils/compileMessage';

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
import { translateText } from '../../src/renderer/i18n/translate';
import type { LocalizedText } from '../../src/shared/i18n/text';

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

describe('settings search: matches the text as translated', () => {
  // A row's label, description, section and tab name are matched as the user reads them, in the
  // session's language, while the keywords stay English. Every other case in this file runs in
  // English, where a search that matched the English source text would pass just the same.
  // These load a German catalog into the global i18n the way the renderer does for a session
  // language, and search for words that exist only in the translation.
  function messageIdOf(text: LocalizedText | undefined, field: string): string {
    if (text === undefined || typeof text === 'string' || !text.id) {
      throw new Error(`the ${field} is no longer a message descriptor, so this test has nothing to translate`);
    }
    return text.id;
  }

  function activateGerman(translations: Record<string, string>): void {
    const messages: Record<string, ReturnType<typeof compileMessage>> = {};
    for (const [messageId, translation] of Object.entries(translations)) messages[messageId] = compileMessage(translation);
    i18n.loadAndActivate({ locale: 'de', messages });
  }

  function matchingEntryIds(query: string, registry: SettingDefinition[]): string[] {
    return [...computeSearchResults(query, registry).matchingIds].sort();
  }

  afterEach(() => {
    // The vitest setup file activates English for every test; put it back for the ones after.
    i18n.activate('en');
  });

  describe("the Language row (registry entry 'displayLanguage')", () => {
    function languageRow(): SettingDefinition {
      const row = SETTINGS_REGISTRY.find((candidate) => candidate.id === 'displayLanguage');
      if (!row) throw new Error("the settings registry has no 'displayLanguage' entry");
      return row;
    }

    function activateGermanLanguageRow(): void {
      const row = languageRow();
      activateGerman({
        [messageIdOf(row.label, "displayLanguage's label")]: 'Sprache',
        [messageIdOf(row.description, "displayLanguage's description")]: 'Gilt nach einem Neustart und aendert keine Agentenausgabe.',
        [messageIdOf(row.section, "displayLanguage's section")]: 'Anzeigesprache',
      });
    }

    it('finds the row by its translated label, description and section, and still by an English keyword', () => {
      activateGermanLanguageRow();
      // The fixture took effect: these are the strings the search reads.
      expect(translateText(languageRow().label)).toBe('Sprache');
      expect(translateText(languageRow().section ?? '')).toBe('Anzeigesprache');

      expect(matchingEntryIds('sprache', SETTINGS_REGISTRY)).toContain('displayLanguage');
      expect(matchingEntryIds('neustart', SETTINGS_REGISTRY)).toContain('displayLanguage');
      expect(matchingEntryIds('anzeigesprache', SETTINGS_REGISTRY)).toContain('displayLanguage');
      // Keywords stay English, so a user who types the English word still finds the row ...
      expect(matchingEntryIds('translation', SETTINGS_REGISTRY)).toContain('displayLanguage');
      // ... including in one query beside a translated word, since every token must match somewhere.
      expect(matchingEntryIds('sprache translation', SETTINGS_REGISTRY)).toContain('displayLanguage');
    });

    it('does not find the row by a translated word while the session is English', () => {
      activateGermanLanguageRow();
      i18n.activate('en');
      expect(translateText(languageRow().label)).toBe('Language');

      expect(matchingEntryIds('neustart', SETTINGS_REGISTRY)).not.toContain('displayLanguage');
      expect(matchingEntryIds('anzeigesprache', SETTINGS_REGISTRY)).not.toContain('displayLanguage');
      // The English words still do.
      expect(matchingEntryIds('language', SETTINGS_REGISTRY)).toContain('displayLanguage');
      expect(matchingEntryIds('translation', SETTINGS_REGISTRY)).toContain('displayLanguage');
    });
  });

  describe('each field on its own', () => {
    // The Language row cannot isolate the label: its tab is the Language tab, whose name is the
    // same message (the same ID) as the row's label, so a translated label word would still match
    // through the tab name if the label alone stopped being translated. These entries carry one
    // translated field each, with every other field a plain string, so a word from the translation
    // can be matched only by the field that holds it.
    const labelEntry: SettingDefinition = {
      id: 'translated.label', tabId: 'general', label: msg`Zebra setting`, description: 'Plain.', scope: 'global',
    };
    const descriptionEntry: SettingDefinition = {
      id: 'translated.description', tabId: 'general', label: 'Plain', description: msg`Zebra details`, scope: 'global',
    };
    const sectionEntry: SettingDefinition = {
      id: 'translated.section', tabId: 'general', label: 'Plain', description: 'Plain.', section: msg`Zebra group`, scope: 'global',
    };
    // Its tab, 'language', is the one tab whose name is a message. Nothing else on the entry is.
    const tabEntry: SettingDefinition = {
      id: 'translated.tab', tabId: 'language', label: 'Plain', description: 'Plain.', scope: 'global',
    };
    const registry = [labelEntry, descriptionEntry, sectionEntry, tabEntry];

    function activateGermanFixtures(): void {
      activateGerman({
        [messageIdOf(labelEntry.label, 'label fixture')]: 'Zebraeinstellung',
        [messageIdOf(descriptionEntry.description, 'description fixture')]: 'Zebradetails',
        [messageIdOf(sectionEntry.section, 'section fixture')]: 'Zebragruppe',
        [messageIdOf(msg`Language`, 'tab name')]: 'Sprache',
      });
    }

    it.each([
      ['label', 'zebraeinstellung', 'translated.label'],
      ['description', 'zebradetails', 'translated.description'],
      ['section', 'zebragruppe', 'translated.section'],
      ['tab name', 'sprache', 'translated.tab'],
    ])('matches a word from the translated %s, on the entry that holds it and no other', (_field, query, expectedEntryId) => {
      activateGermanFixtures();
      expect(matchingEntryIds(query, registry)).toEqual([expectedEntryId]);
    });

    it.each([
      ['label', 'zebraeinstellung'],
      ['description', 'zebradetails'],
      ['section', 'zebragruppe'],
      ['tab name', 'sprache'],
    ])('does not match the translated %s while the session is English', (_field, query) => {
      activateGermanFixtures();
      i18n.activate('en');
      expect(matchingEntryIds(query, registry)).toEqual([]);
    });
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

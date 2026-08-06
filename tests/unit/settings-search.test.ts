/**
 * Guards the Hotkeys/Shortcuts search-bleed fix (see the task that disentangled
 * "Hotkeys" from the "Shortcuts" custom-commands feature). Searching "shortcut"
 * must surface only the Shortcuts (custom commands) tab, never the Hotkeys tab -
 * the two are separate features that happen to share vocabulary.
 */

import { describe, it, expect } from 'vitest';
import { computeSearchResults } from '../../src/renderer/components/settings/settings-search';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';

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

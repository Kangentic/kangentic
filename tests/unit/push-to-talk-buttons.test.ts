/**
 * Which mouse buttons push-to-talk holds.
 *
 * `useDictation` and `useBrowserMouseNavigation` split the back and forward
 * buttons by `pushToTalkMouseButtons`: push-to-talk arbitrates tap-vs-hold for
 * the buttons in the set, and plain navigation owns the rest. A wrong answer
 * either navigates twice or not at all, and a set that is not empty while
 * dictation is off is the bug that left both buttons dead with dictation off.
 */
import { describe, expect, it, vi } from 'vitest';

// The hook half of the module reads the config store; only the pure function
// is under test here.
vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: vi.fn() }));

import { pushToTalkMouseButtons } from '../../src/renderer/utils/push-to-talk-buttons';

function buttons(options: { enabled: boolean; combo: string }): string[] {
  return [...pushToTalkMouseButtons(options)].sort();
}

describe('pushToTalkMouseButtons', () => {
  // Every window answers the same way, a pop-out included: each window runs its
  // own push-to-talk, so a bound button is held there too. A pop-out that held
  // nothing would navigate on the press and never dictate with the default
  // Mouse:Back binding.
  it('holds the bound mouse button while dictation is on', () => {
    expect(buttons({ enabled: true, combo: 'Mouse:Back' })).toEqual(['back']);
    expect(buttons({ enabled: true, combo: 'Mouse:Forward' })).toEqual(['forward']);
    expect(buttons({ enabled: true, combo: 'Mouse:Back+Mouse:Forward' })).toEqual(['back', 'forward']);
  });

  it('holds nothing while dictation is off, so both buttons navigate', () => {
    expect(buttons({ enabled: false, combo: 'Mouse:Back' })).toEqual([]);
  });

  it('holds nothing when push-to-talk is on a key or unbound', () => {
    expect(buttons({ enabled: true, combo: 'Mod+Shift+Space' })).toEqual([]);
    expect(buttons({ enabled: true, combo: '' })).toEqual([]);
  });

  it('holds only the navigation buttons a mouse combo names', () => {
    expect(buttons({ enabled: true, combo: 'Mouse:Middle' })).toEqual([]);
  });
});

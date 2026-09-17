/**
 * demo/boot.js hand-copies a mouse-button table for its held-hotkey boot step (MOUSE_BUTTONS),
 * mirroring the button code src/shared/keybindings.ts assigns each combo and the `buttons`
 * bitmask flag src/renderer/utils/keybindings.ts reads back off a pointerdown. Nothing ties the
 * copy to either source, so a table edited in one place silently drifts from the other. This is
 * the check demo/boot.js names next to the table ("tests/unit/demo-boot-mouse-buttons.test.ts
 * pins this table to the registry").
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { heldMouseTokens } from '../../src/renderer/utils/keybindings';
import { mouseComboToButton } from '../../src/shared/keybindings';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');

/** Every combo the registry could bind a mouse button to, so "the boot table's token set" can be
 *  compared against "the registry's bindable set" rather than a re-declared list of three. */
const CANDIDATE_MOUSE_COMBOS = ['Mouse:Middle', 'Mouse:Back', 'Mouse:Forward'];

interface BootMouseButtonEntry {
  token: string;
  button: number;
  flag: number;
}

function readBootMouseButtons(): BootMouseButtonEntry[] {
  const bootSource = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
  const tableMatch = bootSource.match(/var MOUSE_BUTTONS = \{([\s\S]*?)\};/);
  if (!tableMatch) throw new Error('MOUSE_BUTTONS not found in demo/boot.js');
  const entries = Array.from(
    tableMatch[1].matchAll(/'([^']+)':\s*\{\s*button:\s*(\d+),\s*flag:\s*(\d+)\s*\}/g),
    (entryMatch) => ({ token: entryMatch[1], button: Number(entryMatch[2]), flag: Number(entryMatch[3]) }),
  );
  if (entries.length === 0) throw new Error('MOUSE_BUTTONS in demo/boot.js has no parseable entries');
  return entries;
}

describe('demo/boot.js MOUSE_BUTTONS table', () => {
  const bootMouseButtons = readBootMouseButtons();

  it('is a plausible table', () => {
    // Vacuity guard: a regex that stopped matching and fell back to [] would pass every check
    // below vacuously.
    expect(bootMouseButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('maps every token to the button code the registry assigns it', () => {
    for (const entry of bootMouseButtons) {
      expect(mouseComboToButton(entry.token), entry.token).toBe(entry.button);
    }
  });

  it('sets every flag to the bit the renderer matcher reads back to that same token', () => {
    for (const entry of bootMouseButtons) {
      // Red-green: the table used to derive `buttons` as `1 << button`, which gives 2 for
      // Mouse:Middle (button 1). heldMouseTokens(2) is [], not ['Mouse:Middle'], because bit 2
      // is the right mouse button, which is never bindable. This assertion fails on that shape
      // and passes on the current flag column (4, 8, 16). See the report for the reverted value.
      expect(heldMouseTokens(entry.flag), entry.token).toEqual([entry.token]);
    }
  });

  it('carries exactly the bindable mouse combos the registry defines, no more and no fewer', () => {
    const registryBindableCombos = CANDIDATE_MOUSE_COMBOS.filter((combo) => mouseComboToButton(combo) !== null);
    const bootTokens = bootMouseButtons.map((entry) => entry.token);
    expect(bootTokens.slice().sort()).toEqual(registryBindableCombos.slice().sort());
  });
});

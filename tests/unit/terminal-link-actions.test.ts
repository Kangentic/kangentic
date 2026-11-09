/**
 * What a terminal link click does (src/renderer/utils/terminal-links/link-actions.ts) and how a
 * click combo is read (matchesClickCombo, clickComboFromEvent and formatComboSegments in
 * src/renderer/utils/keybindings.ts). What a user loses if this goes: a swapped pair of hotkeys
 * that still opens the old place, a tip whose rows disagree with the click, a bottom-panel link
 * that does nothing on Ctrl+Shift+click, or a rebind field that records a plain click.
 */
import { describe, expect, it, vi } from 'vitest';

// readLinkCombos reads the user's hotkey overrides from the config store.
const configState = vi.hoisted(() => ({ hotkeyOverrides: {} as Record<string, string> }));
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: { getState: () => ({ globalConfig: { hotkeyOverrides: configState.hotkeyOverrides } }) },
}));

import { planLinkActions, type LinkTarget } from '../../src/renderer/utils/terminal-links/link-actions';
import { createTerminalLinkTargets, readLinkCombos } from '../../src/renderer/utils/terminal-links/link-targets';
import { clickComboFromEvent, formatComboSegments, matchesClickCombo } from '../../src/renderer/utils/keybindings';
import { comboToAccelerator, detectConflicts, isModifiedClickCombo, KEYBINDINGS, normalizeCombo } from '../../src/shared/keybindings';

const DEFAULTS: Record<LinkTarget, string> = { 'default-browser': 'Mod+Mouse:Left', 'kangentic-browser': 'Mod+Shift+Mouse:Left' };
const SWAPPED: Record<LinkTarget, string> = { 'default-browser': 'Mod+Shift+Mouse:Left', 'kangentic-browser': 'Mod+Mouse:Left' };

function click(modifiers: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean }) {
  return { ctrlKey: modifiers.ctrl === true, metaKey: modifiers.meta === true, altKey: modifiers.alt === true, shiftKey: modifiers.shift === true };
}

describe('planLinkActions', () => {
  it('lists the default browser on Ctrl+click and the Kangentic browser on Ctrl+Shift+click', () => {
    const plan = planLinkActions(DEFAULTS, true, false);
    expect(plan.actions.map((action) => action.target)).toEqual(['default-browser', 'kangentic-browser']);
    expect(plan.targetFor(click({ ctrl: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('kangentic-browser');
    expect(plan.targetFor(click({}))).toBeNull();
    expect(plan.targetFor(click({ ctrl: true, alt: true }))).toBeNull();
  });

  it('swaps both the rows and the clicks when the user swaps the hotkeys', () => {
    const plan = planLinkActions(SWAPPED, true, false);
    expect(plan.actions.map((action) => action.target)).toEqual(['kangentic-browser', 'default-browser']);
    expect(plan.targetFor(click({ ctrl: true }))).toBe('kangentic-browser');
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('default-browser');
  });

  it('opens the default browser on either hotkey where the terminal has no Kangentic browser, showing the plainer one', () => {
    const plan = planLinkActions(SWAPPED, false, false);
    expect(plan.actions).toEqual([{ target: 'default-browser', combo: 'Mod+Mouse:Left' }]);
    expect(plan.targetFor(click({ ctrl: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('default-browser');
  });

  it('leaves out a hotkey the user unbound', () => {
    const plan = planLinkActions({ 'default-browser': 'Mod+Mouse:Left', 'kangentic-browser': '' }, true, false);
    expect(plan.actions.map((action) => action.target)).toEqual(['default-browser']);
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBeNull();
    expect(planLinkActions({ 'default-browser': '', 'kangentic-browser': '' }, true, false).actions).toEqual([]);
  });

  it('reads Cmd as the primary key on a Mac', () => {
    const plan = planLinkActions(DEFAULTS, true, true);
    expect(plan.targetFor(click({ meta: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true }))).toBeNull();
  });

  it('opens the default browser on the Kangentic hotkey alone where there is no Kangentic browser, and shows that combo', () => {
    const plan = planLinkActions({ 'default-browser': '', 'kangentic-browser': 'Mod+Shift+Mouse:Left' }, false, false);
    expect(plan.actions).toEqual([{ target: 'default-browser', combo: 'Mod+Shift+Mouse:Left' }]);
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true }))).toBeNull();
  });

  it('lists the default browser first when both hotkeys need the same number of modifiers', () => {
    const plan = planLinkActions({ 'default-browser': 'Mod+Alt+Mouse:Left', 'kangentic-browser': 'Mod+Shift+Mouse:Left' }, true, false);
    expect(plan.actions.map((action) => action.target)).toEqual(['default-browser', 'kangentic-browser']);
    expect(plan.targetFor(click({ ctrl: true, alt: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('kangentic-browser');
  });
});

describe('createTerminalLinkTargets reading the user hotkey overrides', () => {
  const KANGENTIC = { open: vi.fn() };
  const targets = () => createTerminalLinkTargets({ getBrowser: () => KANGENTIC, openExternal: vi.fn() });

  it('plans from the default combos when the user rebound nothing', () => {
    configState.hotkeyOverrides = {};
    expect(readLinkCombos()).toEqual(DEFAULTS);
    const plan = targets().plan();
    expect(plan.actions.map((action) => action.target)).toEqual(['default-browser', 'kangentic-browser']);
    expect(plan.targetFor(click({ ctrl: true }))).toBe('default-browser');
    expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('kangentic-browser');
  });

  it('follows a swapped override in the plan order and in which click names which browser', () => {
    configState.hotkeyOverrides = {
      'terminal.openLinkInDefaultBrowser': 'Mod+Shift+Mouse:Left',
      'terminal.openLinkInKangenticBrowser': 'Mod+Mouse:Left',
    };
    try {
      expect(readLinkCombos()).toEqual(SWAPPED);
      const plan = targets().plan();
      expect(plan.actions.map((action) => action.target)).toEqual(['kangentic-browser', 'default-browser']);
      expect(plan.targetFor(click({ ctrl: true }))).toBe('kangentic-browser');
      expect(plan.targetFor(click({ ctrl: true, shift: true }))).toBe('default-browser');
    } finally {
      configState.hotkeyOverrides = {};
    }
  });
});

describe('click combos', () => {
  it('matches the exact modifiers, with Mod as Ctrl off a Mac and Cmd on one', () => {
    expect(matchesClickCombo(click({ ctrl: true }), 'Mod+Mouse:Left', false)).toBe(true);
    expect(matchesClickCombo(click({ ctrl: true }), 'Ctrl+Mouse:Left', false)).toBe(true);
    expect(matchesClickCombo(click({ meta: true }), 'Mod+Mouse:Left', false)).toBe(false);
    expect(matchesClickCombo(click({ meta: true }), 'Mod+Mouse:Left', true)).toBe(true);
    expect(matchesClickCombo(click({ meta: true, ctrl: true }), 'Mod+Mouse:Left', true)).toBe(false);
    expect(matchesClickCombo(click({ alt: true }), 'Alt+Mouse:Left', false)).toBe(true);
    expect(matchesClickCombo(click({ ctrl: true }), 'Mod+B', false)).toBe(false);
  });

  it('round-trips Cmd+Ctrl on a Mac, where Cmd alone is a different combo', () => {
    const cmdCtrl = click({ meta: true, ctrl: true });
    expect(clickComboFromEvent(cmdCtrl, true)).toBe('Mod+Ctrl+Mouse:Left');
    expect(matchesClickCombo(cmdCtrl, 'Mod+Ctrl+Mouse:Left', true)).toBe(true);
    expect(matchesClickCombo(click({ meta: true }), 'Mod+Ctrl+Mouse:Left', true)).toBe(false);
    expect(matchesClickCombo(click({ ctrl: true }), 'Mod+Ctrl+Mouse:Left', true)).toBe(false);
  });

  it('matches a literal Ctrl combo against a Ctrl click off a Mac, and not against a Windows-key click', () => {
    expect(matchesClickCombo(click({ ctrl: true }), 'Ctrl+Mouse:Left', false)).toBe(true);
    expect(matchesClickCombo(click({ ctrl: true, meta: true }), 'Ctrl+Mouse:Left', false)).toBe(false);
    expect(matchesClickCombo(click({}), 'Ctrl+Mouse:Left', false)).toBe(false);
  });

  it('records the modifiers held with a click, and nothing for a plain click', () => {
    expect(clickComboFromEvent(click({ ctrl: true, shift: true }), false)).toBe('Mod+Shift+Mouse:Left');
    expect(clickComboFromEvent(click({ alt: true }), false)).toBe('Alt+Mouse:Left');
    expect(clickComboFromEvent(click({ meta: true, ctrl: true }), true)).toBe('Mod+Ctrl+Mouse:Left');
    expect(clickComboFromEvent(click({}), false)).toBeNull();
  });

  it('draws the click as its own chip after the modifiers', () => {
    expect(formatComboSegments('Mod+Shift+Mouse:Left', false)).toEqual(['Ctrl', 'Shift', 'Click']);
    expect(formatComboSegments('Mod+Shift+Mouse:Left', true)).toEqual(['⌘', '⇧', 'Click']);
  });

  it('never takes a bare left click, and is never an OS shortcut to probe', () => {
    expect(isModifiedClickCombo('Mouse:Left')).toBe(false);
    expect(isModifiedClickCombo('Mod+Mouse:Left')).toBe(true);
    expect(comboToAccelerator('Mod+Shift+Mouse:Left')).toBeNull();
  });
});

describe('the link hotkeys in the registry', () => {
  const linkHotkeys = KEYBINDINGS.filter((definition) => definition.input === 'click');

  it('are the two link actions, rebindable, each a canonical click combo', () => {
    expect(linkHotkeys.map((definition) => definition.id).sort()).toEqual(['terminal.openLinkInDefaultBrowser', 'terminal.openLinkInKangenticBrowser']);
    for (const definition of linkHotkeys) {
      expect(definition.rebindable).toBe(true);
      expect(isModifiedClickCombo(definition.defaultCombo)).toBe(true);
      expect(normalizeCombo(definition.defaultCombo)).toBe(definition.defaultCombo);
    }
  });

  it('flags the two bound to one click as a conflict', () => {
    const conflicts = detectConflicts({ 'terminal.openLinkInKangenticBrowser': 'Mod+Mouse:Left' });
    expect(conflicts).toContainEqual({ combo: 'Mod+Mouse:Left', ids: ['terminal.openLinkInDefaultBrowser', 'terminal.openLinkInKangenticBrowser'], severity: 'conflict' });
  });
});

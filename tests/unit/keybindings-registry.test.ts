import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  KEYBINDINGS,
  getKeybinding,
  normalizeCombo,
  scopesOverlap,
  detectConflicts,
  comboToAccelerator,
  isMouseCombo,
  mouseComboToButton,
} from '../../src/shared/keybindings';

// Enforces .claude/rules/keybindings-registry.md. The keybinding registry in
// src/shared/keybindings.ts is the single source of truth for every renderer
// shortcut. This suite locks: (1) every useKeybinding('id', ...) call site
// references a registered id, (2) registry hygiene (unique ids, canonical default
// combos), (3) the terminal-unsafe combo set stays in sync with what the embedded
// terminal actually consumes, and (4) the pure helpers behave.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('keybinding registry hygiene', () => {
  it('has unique action ids', () => {
    const ids = KEYBINDINGS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stores every default combo in canonical (normalized) form', () => {
    for (const definition of KEYBINDINGS) {
      expect(normalizeCombo(definition.defaultCombo)).toBe(definition.defaultCombo);
      if (definition.defaultComboAlt) {
        expect(normalizeCombo(definition.defaultComboAlt)).toBe(definition.defaultComboAlt);
      }
    }
  });

  it('marks all terminal-unsafe combos as non-rebindable', () => {
    for (const definition of KEYBINDINGS) {
      if (definition.terminalUnsafe) expect(definition.rebindable).toBe(false);
    }
  });

  it('keeps the terminal-unsafe set in sync with what the embedded terminal consumes', () => {
    // Cross-reference: these combos are handled in
    // src/renderer/utils/terminal-clipboard.ts. If that handler changes, update
    // both it and the registry's terminalUnsafe entries (defaultCombo + alt).
    const expected = new Set(['Mod+C', 'Mod+Shift+C', 'Mod+V', 'Mod+Shift+V', 'Mod+Enter', 'Ctrl+C']);
    const actual = new Set(
      KEYBINDINGS.filter((definition) => definition.terminalUnsafe).flatMap((definition) =>
        definition.defaultComboAlt ? [definition.defaultCombo, definition.defaultComboAlt] : [definition.defaultCombo],
      ),
    );
    expect(actual).toEqual(expected);
  });
});

describe('useKeybinding call sites reference registered ids', () => {
  it('every useKeybinding literal id exists in the registry', () => {
    const files = collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR));
    const callSite = /useKeybinding\(\s*['"]([^'"]+)['"]/g;
    const unknown: Array<{ file: string; id: string }> = [];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = callSite.exec(source)) !== null) {
        const id = match[1];
        if (!getKeybinding(id)) {
          unknown.push({ file: path.relative(REPO_ROOT, file), id });
        }
      }
    }
    expect(unknown).toEqual([]);
  });
});

describe('normalizeCombo', () => {
  it('orders modifiers and uppercases letters', () => {
    expect(normalizeCombo('shift+mod+p')).toBe('Mod+Shift+P');
    expect(normalizeCombo('Mod+Shift+P')).toBe('Mod+Shift+P');
  });

  it('leaves symbols, digits, and named keys as-is', () => {
    expect(normalizeCombo('Mod+=')).toBe('Mod+=');
    expect(normalizeCombo('Mod+0')).toBe('Mod+0');
    expect(normalizeCombo('F5')).toBe('F5');
  });
});

describe('scopesOverlap', () => {
  it('treats identical scopes as overlapping', () => {
    expect(scopesOverlap('global', 'global')).toBe(true);
  });

  it('overlaps global with board and task-dialog with browser-pane', () => {
    expect(scopesOverlap('global', 'board')).toBe(true);
    expect(scopesOverlap('task-dialog', 'browser-pane')).toBe(true);
  });

  it('overlaps the save key\'s dialog scope with the panel and task window keys live beside it', () => {
    expect(scopesOverlap('dialog', 'panel')).toBe(true);
    expect(scopesOverlap('dialog', 'task-dialog')).toBe(true);
  });

  it('does NOT overlap intentional-shadow scope pairs', () => {
    expect(scopesOverlap('board', 'task-dialog')).toBe(false);
    expect(scopesOverlap('task-dialog', 'command-bar')).toBe(false);
    // conversation.find intentionally shadows search.plainFind's Mod+F while a
    // Conversation window is focused - see the id's registry comment.
    expect(scopesOverlap('conversation', 'global')).toBe(false);
  });
});

describe('detectConflicts', () => {
  it('reports no conflicts for the default bindings', () => {
    expect(detectConflicts(undefined, { includeDevOnly: true })).toEqual([]);
  });

  it('flags two same-scope actions bound to the same combo', () => {
    const conflicts = detectConflicts({ 'view.toggleSidebar': 'Mod+Shift+P' });
    const real = conflicts.filter((entry) => entry.severity === 'conflict');
    expect(real).toHaveLength(1);
    expect(new Set(real[0].ids)).toEqual(new Set(['view.toggleSidebar', 'commandBar.toggle']));
  });

  it('flags the save key rebound onto a panel key, since New Task binds both', () => {
    const onMaximize = detectConflicts({ 'taskDetail.save': 'Mod+Shift+M' }).filter((entry) => entry.severity === 'conflict');
    expect(onMaximize.some((entry) => entry.ids.includes('taskDetail.save') && entry.ids.includes('panel.maximize'))).toBe(true);
    const onClose = detectConflicts({ 'taskDetail.save': 'Mod+Shift+W' }).filter((entry) => entry.severity === 'conflict');
    expect(onClose.some((entry) => entry.ids.includes('taskDetail.save') && entry.ids.includes('panel.close'))).toBe(true);
  });

  it('does not flag the intentional cross-scope shadow on Mod+Shift+B', () => {
    const conflicts = detectConflicts(undefined).filter((entry) => entry.severity === 'conflict');
    expect(conflicts).toEqual([]);
  });

  it('warns when a binding lands on a terminal-consumed combo', () => {
    const conflicts = detectConflicts({ 'settings.toggle': 'Mod+C' });
    const warn = conflicts.filter((entry) => entry.severity === 'terminal-warn');
    expect(warn.some((entry) => entry.ids.includes('settings.toggle'))).toBe(true);
  });

  it('warns when a binding lands on a terminal alt combo (Ctrl+Shift+C)', () => {
    const conflicts = detectConflicts({ 'settings.toggle': 'Mod+Shift+C' });
    const warn = conflicts.filter((entry) => entry.severity === 'terminal-warn');
    expect(warn.some((entry) => entry.ids.includes('settings.toggle'))).toBe(true);
  });

  it('reports no conflicts for the defaults when Mod and Ctrl are one key', () => {
    expect(detectConflicts(undefined, { includeDevOnly: true, modIsCtrl: true })).toEqual([]);
  });

  it('flags a rebind captured as Mod+Tab against the Ctrl+Tab default only when Mod is Ctrl', () => {
    // Off macOS, a physical Ctrl+Tab press is recorded as Mod+Tab.
    const overrides = { 'settings.toggle': 'Mod+Tab' };
    const folded = detectConflicts(overrides, { modIsCtrl: true }).filter((entry) => entry.severity === 'conflict');
    expect(folded.some((entry) => entry.ids.includes('settings.toggle') && entry.ids.includes('session.cycleNext'))).toBe(true);
    // On macOS Mod is Cmd, a different key.
    const apart = detectConflicts(overrides).filter((entry) => entry.severity === 'conflict');
    expect(apart).toEqual([]);
  });

  // The terminal-unsafe defaults are written with Mod (paste is Mod+V, the newline
  // key is Mod+Enter). Off macOS, Mod is Ctrl, so a rebind captured as a physical
  // Ctrl+V must still warn. `settings.toggle` is a rebindable global action, and the
  // terminal-warn pass never looks at scope, so it stands in for any rebindable id.
  // Ctrl+C is deliberately not used here: the terminal.interrupt default is a literal
  // Ctrl+C, which would warn whether or not the terminal set were folded.
  it.each(['Ctrl+V', 'Mod+V', 'Ctrl+Shift+V', 'Ctrl+Enter'])(
    'warns when a rebind to %s lands on a terminal key once Mod is Ctrl',
    (combo) => {
      const conflicts = detectConflicts({ 'settings.toggle': combo }, { modIsCtrl: true });
      const warn = conflicts.filter((entry) => entry.severity === 'terminal-warn');
      expect(warn.some((entry) => entry.ids.includes('settings.toggle'))).toBe(true);
    },
  );

  it('keeps Ctrl+V apart from the terminal paste key when Mod is Cmd (macOS)', () => {
    // On macOS the terminal pastes with Cmd+V, so a physical Ctrl+V is a different key.
    const ctrlV = detectConflicts({ 'settings.toggle': 'Ctrl+V' }).filter((entry) => entry.severity === 'terminal-warn');
    expect(ctrlV).toEqual([]);
    const ctrlEnter = detectConflicts({ 'settings.toggle': 'Ctrl+Enter' }).filter((entry) => entry.severity === 'terminal-warn');
    expect(ctrlEnter).toEqual([]);
    // Cmd+V is the terminal paste key there, so it still warns.
    const modV = detectConflicts({ 'settings.toggle': 'Mod+V' }).filter((entry) => entry.severity === 'terminal-warn');
    expect(modV.some((entry) => entry.ids.includes('settings.toggle'))).toBe(true);
  });

  it('never counts an unbound action as a conflict, even beside another unbound one', () => {
    expect(getKeybinding('session.cyclePrev')?.defaultCombo).toBe('');
    expect(getKeybinding('session.cycleAllPrev')?.defaultCombo).toBe('');
    const conflicts = detectConflicts(undefined, { includeDevOnly: true });
    expect(conflicts.some((entry) => entry.ids.includes('session.cyclePrev') || entry.ids.includes('session.cycleAllPrev'))).toBe(false);
  });

  it('flags a rebind onto a cycle key in the same scope', () => {
    const conflicts = detectConflicts({ 'view.toggleSidebar': 'Ctrl+Backquote' }).filter((entry) => entry.severity === 'conflict');
    expect(conflicts.some((entry) => entry.ids.includes('view.toggleSidebar') && entry.ids.includes('project.cycleNext'))).toBe(true);
  });
});

describe('cycle keys (GitHub #176)', () => {
  it('registers the six cycle actions in General, global and rebindable', () => {
    const expected: Record<string, string> = {
      'session.cycleNext': 'Ctrl+Tab',
      'session.cyclePrev': '',
      'session.cycleAllNext': 'Ctrl+Shift+Tab',
      'session.cycleAllPrev': '',
      'project.cycleNext': 'Ctrl+Backquote',
      'project.cyclePrev': 'Ctrl+Shift+Backquote',
    };
    for (const [id, combo] of Object.entries(expected)) {
      const definition = getKeybinding(id);
      expect(definition, id).toBeDefined();
      expect(definition?.group).toBe('General');
      expect(definition?.scope).toBe('global');
      expect(definition?.rebindable).toBe(true);
      expect(definition?.defaultCombo).toBe(combo);
    }
  });
});

describe('comboToAccelerator', () => {
  it('maps Mod to CommandOrControl and literal Ctrl to Control', () => {
    expect(comboToAccelerator('Mod+Shift+P')).toBe('CommandOrControl+Shift+P');
    expect(comboToAccelerator('Ctrl+C')).toBe('Control+C');
  });

  it('supports digits and function keys', () => {
    expect(comboToAccelerator('Mod+0')).toBe('CommandOrControl+0');
    expect(comboToAccelerator('F5')).toBe('F5');
  });

  it('supports Tab and Backquote, so the probe covers the cycle defaults', () => {
    expect(comboToAccelerator('Ctrl+Tab')).toBe('Control+Tab');
    expect(comboToAccelerator('Ctrl+Shift+Tab')).toBe('Control+Shift+Tab');
    expect(comboToAccelerator('Ctrl+Backquote')).toBe('Control+`');
    expect(comboToAccelerator('Ctrl+Shift+Backquote')).toBe('Control+Shift+`');
  });

  it('returns null for an unbound (empty) combo', () => {
    expect(comboToAccelerator('')).toBeNull();
  });

  it('returns null for combos that cannot be expressed as accelerators', () => {
    expect(comboToAccelerator('Mod+=')).toBeNull();
    expect(comboToAccelerator('Mod+Enter')).toBeNull();
    expect(comboToAccelerator('Escape')).toBeNull();
  });

  it('returns null for a mouse combo (never an OS global shortcut)', () => {
    expect(comboToAccelerator('Mouse:Middle')).toBeNull();
    expect(comboToAccelerator('Mouse:Back')).toBeNull();
  });
});

describe('mouse combos', () => {
  it('isMouseCombo distinguishes mouse bindings from keyboard chords', () => {
    expect(isMouseCombo('Mouse:Middle')).toBe(true);
    expect(isMouseCombo('Mouse:Forward')).toBe(true);
    expect(isMouseCombo('Mod+Shift+W')).toBe(false);
    expect(isMouseCombo('F5')).toBe(false);
  });

  it('mouseComboToButton maps each mouse combo to its DOM button code', () => {
    expect(mouseComboToButton('Mouse:Middle')).toBe(1);
    expect(mouseComboToButton('Mouse:Back')).toBe(3);
    expect(mouseComboToButton('Mouse:Forward')).toBe(4);
    expect(mouseComboToButton('Mod+W')).toBeNull();
  });

  it('normalizeCombo passes a mouse combo through unchanged', () => {
    expect(normalizeCombo('Mouse:Middle')).toBe('Mouse:Middle');
    expect(normalizeCombo('Mouse:Back')).toBe('Mouse:Back');
  });

  it('the panel.closeViaHeaderClick default is a canonical mouse combo', () => {
    const definition = getKeybinding('panel.closeViaHeaderClick');
    expect(definition?.defaultCombo).toBe('Mouse:Middle');
    expect(normalizeCombo(definition?.defaultCombo ?? '')).toBe('Mouse:Middle');
  });
});

describe('the shared save key', () => {
  // One action serves every dialog that opts in through BaseDialog's `save`
  // prop, so a user rebinds it once. Its id is also stored in user overrides, so
  // it is never renamed.
  it('is one rebindable Mod+S action in the dialog scope, listed under General', () => {
    const definition = getKeybinding('taskDetail.save');
    expect(definition).toBeDefined();
    expect(definition?.scope).toBe('dialog');
    expect(definition?.group).toBe('General');
    expect(definition?.defaultCombo).toBe('Mod+S');
    expect(definition?.rebindable).toBe(true);
  });

  it('has no entry of its own for the Column Manager, which shares the one action', () => {
    expect(getKeybinding('boardManager.save')).toBeUndefined();
  });
});

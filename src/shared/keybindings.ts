/**
 * Central keybinding registry: the single source of truth for every keyboard
 * shortcut in the renderer.
 *
 * Each shortcut is one `KeybindingDefinition` entry below. Handlers read their
 * effective combo from here (via the `useKeybinding` hook), the Hotkeys settings
 * tab lists and rebinds them, and conflict detection runs over the same array.
 * Add a new shortcut by appending one entry here and one `useKeybinding(id, ...)`
 * call at the consuming site; it then auto-appears in the settings panel and the
 * conflict checker with no further wiring.
 *
 * This module is intentionally pure (no `window`, no React) so it can be imported
 * by the renderer, the main-process accelerator converter, and unit tests alike.
 * Platform-aware matching/formatting lives in `src/renderer/utils/keybindings.ts`.
 *
 * Canonical combo format: modifier tokens then a single main key, joined by `+`.
 *   - `Mod` is the platform-primary modifier (Cmd on macOS, Ctrl elsewhere).
 *   - `Ctrl` (literal) is the control key on every platform; reserved for the
 *     terminal SIGINT combo, which is never Cmd on macOS.
 *   - Other modifiers: `Alt`, `Shift`. Order is normalized to [Mod, Ctrl, Alt, Shift].
 *   - Main key: a single uppercase letter (`P`), digit (`0`), symbol (`=`, `-`),
 *     or a named key verbatim (`Enter`, `Escape`, `F5`).
 *   Examples: `Mod+Shift+P`, `Mod+I`, `Mod+0`, `Ctrl+C`, `F5`.
 */

/** Mutually-exclusive activation contexts, used by conflict detection. Two
 *  actions sharing a combo only conflict if their scopes can be simultaneously
 *  active (see {@link scopesOverlap}). */
export type KeyScope =
  | 'global' // app-wide window listener (active whenever no modal owns the key)
  | 'board' // board / backlog view chrome (requires a project open)
  | 'task-dialog' // TaskDetailDialog open (capture phase, shadows global/board)
  | 'command-bar' // CommandBarOverlay open (capture phase, shadows global/board)
  | 'panel' // a maximizable dialog/overlay panel (command terminal or task detail)
  | 'browser-pane' // BrowserPane visible inside a task dialog
  | 'terminal' // xterm-owned combos; display-only
  | 'dialog' // generic dialog-local keys (Escape dismissal, Board Manager save)
  | 'conversation'; // a focused Conversation viewer window (capture phase, deliberately does NOT overlap 'global' - see conversation.find)

/** Display grouping in the settings panel. Cosmetic, independent of scope. */
export type KeyGroup =
  | 'General'
  | 'Dictation'
  | 'Task Detail'
  | 'Git Changes'
  | 'Windows'
  | 'Browser'
  | 'Terminal'
  | 'Developer';

/** Render order of groups in the Hotkeys settings tab. */
export const KEY_GROUP_ORDER: readonly KeyGroup[] = [
  'General',
  'Dictation',
  'Task Detail',
  'Git Changes',
  'Windows',
  'Browser',
  'Terminal',
  'Developer',
];

export interface KeybindingDefinition {
  /** Stable, dot-namespaced action id. NEVER renamed: user overrides key on it. */
  id: string;
  /** Human-readable action name shown in the settings panel. */
  label: string;
  /** Short description shown under the label. */
  description?: string;
  /** Panel section. */
  group: KeyGroup;
  /** Conflict-detection context. */
  scope: KeyScope;
  /** Canonical default combo (e.g. `Mod+Shift+P`). */
  defaultCombo: string;
  /** Optional secondary combo bound to the same action (e.g. F5 + Mod+R). */
  defaultComboAlt?: string;
  /** Whether the user may rebind it. Terminal/Escape combos are display-only. */
  rebindable: boolean;
  /** True for combos the embedded xterm consumes; feeds the terminal-warning. */
  terminalUnsafe?: boolean;
  /** Registered so the shortcut works, but not shown in the settings panel
   *  (e.g. pane-scoped, non-rebindable shortcuts that have their own UI buttons). */
  hidden?: boolean;
  /** Only listed/active when the developer overlay flag is enabled. */
  devOnly?: boolean;
}

/**
 * THE registry. One entry per shortcut. Order within a group is display order.
 */
export const KEYBINDINGS: readonly KeybindingDefinition[] = [
  // ── General ──
  {
    id: 'settings.toggle',
    label: 'Toggle Settings',
    description: 'Open or close the settings panel.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+S',
    rebindable: true,
  },
  {
    id: 'view.toggleBoardBacklog',
    label: 'Switch Board / Backlog',
    description: 'Toggle between the board and the backlog view.',
    group: 'General',
    scope: 'board',
    defaultCombo: 'Mod+Shift+B',
    rebindable: true,
  },
  {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    description: 'Show or hide the project sidebar.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+E',
    rebindable: true,
  },
  {
    id: 'view.toggleTerminalPanel',
    label: 'Toggle Terminal Panel',
    description: 'Collapse or expand the bottom terminal panel.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+J',
    rebindable: true,
  },
  {
    id: 'commandBar.toggle',
    label: 'Toggle Command Terminal',
    description: 'Open or close the command terminal overlay.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+P',
    rebindable: true,
  },
  {
    id: 'dictation.pushToTalk',
    label: 'Push-to-Talk (Hold)',
    description: 'Hold to dictate; release to populate the focused terminal.',
    group: 'Dictation',
    scope: 'global',
    defaultCombo: 'Mouse:Back',
    rebindable: true,
  },
  {
    id: 'search.togglePalette',
    label: 'Quick Find',
    description: 'Open the cross-project Quick Find palette.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+F',
    rebindable: true,
  },
  {
    id: 'search.plainFind',
    label: 'Find on Board',
    description: 'Focus the board search, or open Quick Find if not on the board.',
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+F',
    rebindable: true,
  },
  {
    id: 'conversation.find',
    label: 'Find in Conversation',
    description: 'Open in-viewer search inside the focused Conversation window.',
    group: 'General',
    // Deliberately shares Mod+F with search.plainFind: 'conversation' is NOT
    // in scopesOverlap's overlapping list, so this intentionally shadows the
    // global binding (same pattern as the documented task-dialog shadow) -
    // bound capture-phase + focus-gated, it wins over the board's bubble-phase
    // Mod+F while a Conversation window is focused, without a registry conflict.
    scope: 'conversation',
    defaultCombo: 'Mod+F',
    rebindable: true,
  },
  {
    id: 'task.create',
    label: 'New Task',
    description: 'Open the New Task dialog on the board.',
    group: 'General',
    scope: 'board',
    defaultCombo: 'Mod+N',
    rebindable: true,
  },
  {
    id: 'dialog.dismiss',
    label: 'Dismiss Dialog',
    description: 'Hidden universal closer: Escape closes any open modal. Always on, not rebindable, not shown in the list. The visible, rebindable close hotkey is panel.close.',
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Escape',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'boardManager.save',
    label: 'Save Board Configuration',
    description: 'Save changes in the Board Manager dialog. Fixed; has its own Save button.',
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+S',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'boardManager.nextColumn',
    label: 'Next Column',
    description: 'Select the next column (or the overview) in the Edit Columns dialog. Fixed.',
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+PageDown',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'boardManager.prevColumn',
    label: 'Previous Column',
    description: 'Select the previous column (or the overview) in the Edit Columns dialog. Fixed.',
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+PageUp',
    rebindable: false,
    hidden: true,
  },

  // ── Task Detail ──
  // Maximize / Close are the shared panel.* bindings: they act on whichever panel
  // is open (the task detail dialog or the command terminal overlay).
  {
    id: 'panel.maximize',
    label: 'Maximize',
    description: 'Maximize the open panel: the command terminal, the task detail dialog (view or edit mode), a create dialog (New Task / New Backlog Task), or the Edit Columns dialog.',
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+M',
    rebindable: true,
  },
  {
    id: 'panel.close',
    label: 'Close',
    description: 'Close the open panel: the command terminal, the task detail dialog, or a create dialog (New Task / New Backlog Task). Escape also closes any modal.',
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+W',
    rebindable: true,
  },
  {
    id: 'panel.closeViaHeaderClick',
    label: 'Close Window (Click Header)',
    description: 'Close the focused task detail window by clicking its title bar with this button (default middle mouse button). Rebind to any keyboard chord or mouse button (middle / side).',
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mouse:Middle',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleBrowser',
    label: 'Toggle Browser Pane',
    description: 'Show or hide the browser pane inside the task detail dialog.',
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+B',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleChanges',
    label: 'Toggle Changes Panel',
    description: 'Show or hide the changes (diff) panel inside the task detail dialog.',
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+G',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleDescription',
    label: 'Toggle Description Peek',
    description: 'Show or hide the description panel inside the task detail dialog.',
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+K',
    rebindable: true,
  },
  // Changes panel review navigation. Next/prev change steps through the diff
  // hunks and rolls into the adjacent file at a file's first/last change (F7 /
  // Shift+F7 is the VS Code / JetBrains diff-nav convention, offered as an alt).
  {
    id: 'changes.nextChange',
    label: 'Next Change',
    description: 'Jump to the next change in the diff. Past a file\'s last change, continues into the next file.',
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+ArrowDown',
    defaultComboAlt: 'F7',
    rebindable: true,
  },
  {
    id: 'changes.prevChange',
    label: 'Previous Change',
    description: 'Jump to the previous change in the diff. Before a file\'s first change, continues into the previous file.',
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+ArrowUp',
    defaultComboAlt: 'Shift+F7',
    rebindable: true,
  },
  {
    id: 'changes.nextFile',
    label: 'Next Changed File',
    description: 'Select the next file in the Changes panel.',
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+Shift+ArrowDown',
    rebindable: true,
  },
  {
    id: 'changes.prevFile',
    label: 'Previous Changed File',
    description: 'Select the previous file in the Changes panel.',
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+Shift+ArrowUp',
    rebindable: true,
  },
  // Not rebindable: Mod+C is terminal-consumed (terminal.copy), and a rebindable
  // entry on that combo would trip detectConflicts' terminal-warn. Mirrors
  // terminal.copy's own non-rebindable treatment; NOT terminalUnsafe (this
  // combo is handled by the diff editor, not the embedded terminal, so it must
  // stay out of the terminalUnsafe set the "in sync" test locks).
  {
    id: 'changes.copy',
    label: 'Copy Selection',
    description: 'Copy the selected diff text to the clipboard.',
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Mod+C',
    rebindable: false,
  },

  // ── Windows ──
  // Win11-style STATEFUL snap: each arrow's result depends on the window's current
  // zone (half / corner / maximized / floating), so half + up/down builds corners.
  // Bound capture-phase in TaskDetailWindow, gated on the focused window, so they
  // beat the embedded terminal and only the focused window reacts. Scope 'panel' (a
  // task window is a panel, beside panel.maximize / panel.close). Logic: snap-zones.ts.
  {
    id: 'window.snapLeft',
    label: 'Snap Window Left',
    description: 'Snap left: to the left half, or from a right corner to the matching left corner (Win11 stateful snap).',
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowLeft',
    rebindable: true,
  },
  {
    id: 'window.snapRight',
    label: 'Snap Window Right',
    description: 'Snap right: to the right half, or from a left corner to the matching right corner (Win11 stateful snap).',
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowRight',
    rebindable: true,
  },
  {
    id: 'window.snapUp',
    label: 'Snap Window Up',
    description: 'Snap up: maximize when floating, or move a half-snapped window to its top corner (Win11 stateful snap).',
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowUp',
    rebindable: true,
  },
  {
    id: 'window.snapDown',
    label: 'Snap Window Down',
    description: 'Snap down: restore when maximized, or move a half-snapped window to its bottom corner (Win11 stateful snap).',
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowDown',
    rebindable: true,
  },

  // ── Browser ──
  // Registered so the shortcuts work, but hidden from the panel: they are
  // pane-scoped, non-rebindable, and already surfaced as buttons in the browser
  // pane toolbar, so listing them here adds only clutter.
  {
    id: 'browser.inspect',
    label: 'Inspect Element',
    description: 'Pick an element from the embedded page.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+I',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.draw',
    label: 'Draw / Annotate',
    description: 'Toggle free-draw annotation on the embedded page.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+D',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomIn',
    label: 'Zoom In',
    description: 'Increase the embedded page zoom.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+=',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomOut',
    label: 'Zoom Out',
    description: 'Decrease the embedded page zoom.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+-',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomReset',
    label: 'Reset Zoom',
    description: 'Reset the embedded page zoom to 100%.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+0',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.reload',
    label: 'Reload Page',
    description: 'Reload the embedded page.',
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'F5',
    defaultComboAlt: 'Mod+R',
    rebindable: false,
    hidden: true,
  },

  // ── Terminal ──
  // Copy / Paste are Kangentic clipboard conveniences. Insert Newline and
  // Interrupt are hidden from the panel (a terminal-input convention and native
  // SIGINT, respectively) but stay registered so the conflict checker still warns
  // when a global shortcut lands on a terminal-consumed combo.
  {
    id: 'terminal.copy',
    label: 'Copy',
    description: 'Copy the selected terminal text (Ctrl+Shift+C always copies). With no selection, Ctrl+C cancels the running command instead.',
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+C',
    defaultComboAlt: 'Mod+Shift+C',
    rebindable: false,
    terminalUnsafe: true,
  },
  {
    id: 'terminal.paste',
    label: 'Paste',
    description: 'Paste text or an image into the terminal (Ctrl+Shift+V also pastes).',
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+V',
    defaultComboAlt: 'Mod+Shift+V',
    rebindable: false,
    terminalUnsafe: true,
  },
  {
    id: 'terminal.sendNewline',
    label: 'Insert Newline',
    description: 'Send a newline instead of submitting (Claude Code TUI). Handled by the terminal.',
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+Enter',
    rebindable: false,
    terminalUnsafe: true,
    hidden: true,
  },
  {
    id: 'terminal.interrupt',
    label: 'Interrupt (Cancel)',
    description: 'Cancel the running command (sends SIGINT). Native terminal behavior.',
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Ctrl+C',
    rebindable: false,
    terminalUnsafe: true,
    hidden: true,
  },

  // ── Developer ──
  {
    id: 'debug.toggleOverlay',
    label: 'Toggle Activity Debug Overlay',
    description: 'Show or hide the activity-engine debug overlay.',
    group: 'Developer',
    scope: 'global',
    defaultCombo: 'Mod+Shift+D',
    rebindable: true,
    devOnly: true,
  },
];

/** O(1) lookup by id. */
const KEYBINDINGS_BY_ID: Record<string, KeybindingDefinition> = Object.fromEntries(
  KEYBINDINGS.map((definition) => [definition.id, definition]),
);

/** Look up a definition by id, or `undefined` if unknown. */
export function getKeybinding(id: string): KeybindingDefinition | undefined {
  return KEYBINDINGS_BY_ID[id];
}

/** Canonical modifier ordering. */
const MODIFIER_TOKENS = ['Mod', 'Ctrl', 'Alt', 'Shift'] as const;

/** Normalize the main (non-modifier) key token: single letters uppercase,
 *  digits and symbols verbatim, named keys verbatim. */
function normalizeMainKey(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

/**
 * Mouse-button combos. A binding can be either a keyboard combo (`Mod+Shift+W`)
 * or a single mouse button, written as `Mouse:<Button>`. Only the three buttons
 * a user can reasonably bind without losing primary interaction are supported:
 * the middle button and the two side buttons. Left (DOM button 0) and right
 * (DOM button 2) are deliberately never bindable.
 *
 * The map values are DOM `MouseEvent.button` codes: middle = 1, back = 3,
 * forward = 4.
 */
const MOUSE_BUTTON_BY_COMBO: Record<string, number> = {
  'Mouse:Middle': 1,
  'Mouse:Back': 3,
  'Mouse:Forward': 4,
};

/** Whether a combo is a mouse-button binding (`Mouse:Middle`, or a multi-button
 *  chord like `Mouse:Back+Mouse:Forward`) rather than a keyboard chord. A combo
 *  is a mouse combo only when EVERY `+`-joined part is a mouse token (mixed
 *  modifier+mouse combos are not supported). */
export function isMouseCombo(combo: string): boolean {
  return combo.length > 0 && combo.split('+').every((part) => part.startsWith('Mouse:'));
}

/** The mouse button tokens of a (possibly chord) mouse combo, in canonical
 *  order. Returns [] for a non-mouse combo. */
export function mouseComboTokens(combo: string): string[] {
  return isMouseCombo(combo) ? combo.split('+') : [];
}

/** The DOM `MouseEvent.button` code a mouse combo targets, or `null` if the combo
 *  is not a recognized mouse binding. */
export function mouseComboToButton(combo: string): number | null {
  return MOUSE_BUTTON_BY_COMBO[combo] ?? null;
}

/**
 * Normalize a combo string to canonical form: modifiers sorted into
 * [Mod, Ctrl, Alt, Shift] order (case-insensitive, deduped), then the main key.
 * Two equivalent combos compare equal after normalization, which is what
 * conflict detection relies on.
 */
export function normalizeCombo(combo: string): string {
  // Mouse combos: dedupe and sort the chord buttons into canonical order so
  // `Mouse:Forward+Mouse:Back` and `Mouse:Back+Mouse:Forward` compare equal.
  if (isMouseCombo(combo)) {
    const tokens = Array.from(new Set(combo.split('+')));
    tokens.sort((a, b) => (MOUSE_BUTTON_BY_COMBO[a] ?? 99) - (MOUSE_BUTTON_BY_COMBO[b] ?? 99));
    return tokens.join('+');
  }
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  const orderedModifiers = MODIFIER_TOKENS.filter((token) =>
    modifiers.some((modifier) => modifier.toLowerCase() === token.toLowerCase()),
  );
  return [...orderedModifiers, normalizeMainKey(mainKey)].join('+');
}

/** Resolve the effective combo for an action: a rebindable action's override
 *  wins; otherwise the registry default. Overrides for non-rebindable actions
 *  are ignored. */
export function effectiveCombo(id: string, overrides?: Record<string, string> | null): string {
  const definition = getKeybinding(id);
  if (!definition) return '';
  if (definition.rebindable && overrides && overrides[id]) return overrides[id];
  return definition.defaultCombo;
}

/**
 * Whether two scopes can be active at the same instant. Only overlapping
 * scopes can produce a conflict; non-overlapping scopes (intentional shadowing,
 * e.g. board board-toggle vs task-dialog browser-toggle on the same combo) are
 * never flagged.
 */
export function scopesOverlap(a: KeyScope, b: KeyScope): boolean {
  if (a === b) return true;
  const overlapping: ReadonlyArray<readonly [KeyScope, KeyScope]> = [
    ['global', 'board'],
    ['task-dialog', 'browser-pane'],
  ];
  return overlapping.some(([first, second]) => (a === first && b === second) || (a === second && b === first));
}

export type ConflictSeverity = 'conflict' | 'terminal-warn';

export interface KeyConflict {
  /** Normalized combo at the center of the conflict. */
  combo: string;
  /** Action ids involved (1 for a terminal-warn, 2+ for a real conflict). */
  ids: string[];
  severity: ConflictSeverity;
}

interface DetectConflictsOptions {
  /** Include devOnly bindings (the developer overlay flag is on). Default false. */
  includeDevOnly?: boolean;
}

/**
 * Detect conflicts across all rebindable bindings given the current overrides.
 *
 * A `conflict` is two+ rebindable actions resolving to the same normalized combo
 * whose scopes overlap. A `terminal-warn` is a rebindable action resolving onto
 * a combo the embedded terminal consumes (so it would not fire while the terminal
 * is focused).
 */
export function detectConflicts(
  overrides?: Record<string, string> | null,
  options: DetectConflictsOptions = {},
): KeyConflict[] {
  const active = KEYBINDINGS.filter(
    (definition) => definition.rebindable && (!definition.devOnly || options.includeDevOnly),
  );
  const resolved = active.map((definition) => ({
    definition,
    combo: normalizeCombo(effectiveCombo(definition.id, overrides)),
  }));

  const conflicts: KeyConflict[] = [];

  // Same-combo, overlapping-scope pairs.
  const byCombo = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    const bucket = byCombo.get(entry.combo);
    if (bucket) bucket.push(entry);
    else byCombo.set(entry.combo, [entry]);
  }
  for (const [combo, bucket] of byCombo) {
    if (bucket.length < 2) continue;
    const clashing = new Set<string>();
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (scopesOverlap(bucket[i].definition.scope, bucket[j].definition.scope)) {
          clashing.add(bucket[i].definition.id);
          clashing.add(bucket[j].definition.id);
        }
      }
    }
    if (clashing.size > 0) {
      conflicts.push({ combo, ids: [...clashing], severity: 'conflict' });
    }
  }

  // Terminal-unsafe warnings.
  const terminalCombos = new Set(
    KEYBINDINGS.filter((definition) => definition.terminalUnsafe).flatMap((definition) =>
      definition.defaultComboAlt
        ? [normalizeCombo(definition.defaultCombo), normalizeCombo(definition.defaultComboAlt)]
        : [normalizeCombo(definition.defaultCombo)],
    ),
  );
  for (const entry of resolved) {
    if (terminalCombos.has(entry.combo)) {
      conflicts.push({ combo: entry.combo, ids: [entry.definition.id], severity: 'terminal-warn' });
    }
  }

  return conflicts;
}

/**
 * Convert a canonical combo to an Electron Accelerator string for the
 * global-shortcut availability probe, or `null` when the combo cannot be
 * expressed as an accelerator (symbols, named keys other than F-keys). A `null`
 * result tells the probe to skip the combo and report it as unsupported.
 *
 * Only modifier + single A-Z letter, 0-9 digit, or F1-F24 is supported, which
 * covers every rebindable global/dialog shortcut a user is likely to probe.
 */
export function comboToAccelerator(combo: string): string | null {
  // Mouse buttons are never OS global shortcuts; skip the accelerator probe.
  if (isMouseCombo(combo)) return null;
  const parts = combo.split('+');
  const mainKey = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1).map((modifier) => modifier.toLowerCase());

  const acceleratorModifiers: string[] = [];
  if (modifiers.includes('mod')) acceleratorModifiers.push('CommandOrControl');
  if (modifiers.includes('ctrl')) acceleratorModifiers.push('Control');
  if (modifiers.includes('alt')) acceleratorModifiers.push('Alt');
  if (modifiers.includes('shift')) acceleratorModifiers.push('Shift');

  let acceleratorKey: string | null = null;
  if (mainKey.length === 1 && /[a-z]/i.test(mainKey)) {
    acceleratorKey = mainKey.toUpperCase();
  } else if (mainKey.length === 1 && /[0-9]/.test(mainKey)) {
    acceleratorKey = mainKey;
  } else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(mainKey)) {
    acceleratorKey = mainKey;
  }
  if (!acceleratorKey) return null;

  return [...acceleratorModifiers, acceleratorKey].join('+');
}

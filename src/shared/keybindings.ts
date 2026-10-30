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
 *   - `Ctrl` (literal) is the control key on every platform. Used for the
 *     terminal SIGINT combo, which is never Cmd on macOS, and for a combo whose
 *     Cmd form macOS keeps for itself (Cmd+Tab, Cmd+`), so the default works the
 *     same on all three platforms.
 *   - Other modifiers: `Alt`, `Shift`. Order is normalized to [Mod, Ctrl, Alt, Shift].
 *   - Main key: a single uppercase letter (`P`), digit (`0`), symbol (`=`, `-`),
 *     or a named key verbatim (`Enter`, `Escape`, `F5`, `Tab`).
 *   - `Backquote` is the one main key matched by its physical position
 *     (`KeyboardEvent.code`) rather than the character it types, because that
 *     key types `` ` ``, `^`, `²` or a dead key depending on the layout.
 *   Examples: `Mod+Shift+P`, `Mod+I`, `Mod+0`, `Ctrl+C`, `F5`, `Ctrl+Backquote`.
 *
 * Main bundles this module with plain esbuild, so a label is a descriptor from
 * `@lingui/core/runtime-macro`, never the build-time macro (.claude/rules/i18n.md).
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

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
  | 'dialog' // generic dialog-local keys (Escape dismissal, the save key)
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
  /** Human-readable action name shown in the settings panel. Resolve it where it
   *  renders (`translateText`). A descriptor, never a string, so a new entry
   *  cannot ship untranslatable text. */
  label: MessageDescriptor;
  /** Short description shown in the row's info tip. A hidden entry never renders
   *  one, so it keeps its notes in a comment instead. */
  description?: MessageDescriptor;
  /** Panel section. */
  group: KeyGroup;
  /** Conflict-detection context. */
  scope: KeyScope;
  /** Canonical default combo (e.g. `Mod+Shift+P`). An empty string means the
   *  action ships unbound: it is listed in the Hotkeys tab for the user to bind,
   *  and nothing listens for it until they do. */
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
    label: msg`Toggle settings`,
    description: msg`Open or close the settings panel.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+S',
    rebindable: true,
  },
  {
    id: 'stats.toggle',
    label: msg`Toggle Usage Stats`,
    description: msg`Open or close the usage statistics dashboard.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+U',
    rebindable: true,
  },
  {
    // Mod+Shift+A from the free set. M (monitor) and U (stats) are taken, and
    // detectConflicts must stay empty across every rebindable global/board
    // entry plus the terminal-unsafe set. R and I are avoided deliberately:
    // Chromium claims them for force-reload and DevTools.
    id: 'knowledgeGraph.toggle',
    label: msg`Toggle Knowledge Graph`,
    description: msg`Open or close the map of what the conversation index has learned.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+A',
    rebindable: true,
  },
  {
    id: 'monitor.toggle',
    label: msg`Toggle Agent Monitor`,
    description: msg`Open or close the cross-project view of every running agent.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+M',
    rebindable: true,
  },
  {
    id: 'view.toggleBoardBacklog',
    label: msg`Switch board / backlog`,
    description: msg`Toggle between the board and the backlog view.`,
    group: 'General',
    scope: 'board',
    defaultCombo: 'Mod+Shift+B',
    rebindable: true,
  },
  {
    id: 'view.toggleWorkflows',
    label: msg`Open workflows`,
    description: msg`Open the Workflows view; pressed there, return to the view you came from.`,
    group: 'General',
    scope: 'board',
    defaultCombo: 'Mod+Shift+L',
    rebindable: true,
  },
  {
    id: 'view.toggleSidebar',
    label: msg`Toggle sidebar`,
    description: msg`Show or hide the project sidebar.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+E',
    rebindable: true,
  },
  {
    id: 'view.toggleTerminalPanel',
    label: msg`Toggle terminal panel`,
    description: msg`Collapse or expand the bottom terminal panel.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+J',
    rebindable: true,
  },
  {
    id: 'commandBar.toggle',
    label: msg`Toggle Command Terminal`,
    description: msg`Open or close the command terminal overlay.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+P',
    rebindable: true,
  },
  // Cycle keys (GitHub #176). A terminal is a running board agent or a Command
  // Terminal terminal. Literal Ctrl on every platform, because Cmd+Tab and Cmd+`
  // belong to macOS. Claude Code binds neither Ctrl+Tab nor Ctrl+`, and xterm sends
  // Ctrl+Tab as a plain Tab, so taking them costs the agent nothing. Only
  // Ctrl+Tab and Ctrl+Shift+Tab are free in the Tab family (Ctrl+Alt+Tab is the
  // Windows switcher), so Shift picks the scope and both previous-terminal
  // actions ship unbound. PageUp/PageDown is Claude Code's fullscreen scroll.
  {
    id: 'session.cycleNext',
    label: msg`Next terminal in this project`,
    description: msg`Go to the next running agent or Command Terminal terminal in this project.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Ctrl+Tab',
    rebindable: true,
  },
  {
    id: 'session.cyclePrev',
    label: msg`Previous terminal in this project`,
    description: msg`Go to the previous running agent or Command Terminal terminal in this project.`,
    group: 'General',
    scope: 'global',
    defaultCombo: '',
    rebindable: true,
  },
  {
    id: 'session.cycleAllNext',
    label: msg`Next terminal in any project`,
    description: msg`Go to the next running agent or Command Terminal terminal, switching project when it is in another.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Ctrl+Shift+Tab',
    rebindable: true,
  },
  {
    id: 'session.cycleAllPrev',
    label: msg`Previous terminal in any project`,
    description: msg`Go to the previous running agent or Command Terminal terminal, switching project when it is in another.`,
    group: 'General',
    scope: 'global',
    defaultCombo: '',
    rebindable: true,
  },
  {
    id: 'project.cycleNext',
    label: msg`Next project`,
    description: msg`Open the next project in sidebar order.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Ctrl+Backquote',
    rebindable: true,
  },
  {
    id: 'project.cyclePrev',
    label: msg`Previous project`,
    description: msg`Open the previous project in sidebar order.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Ctrl+Shift+Backquote',
    rebindable: true,
  },
  {
    id: 'dictation.pushToTalk',
    label: msg`Push-to-talk (hold)`,
    description: msg`Hold to dictate; release to populate the focused terminal or text field.`,
    group: 'Dictation',
    scope: 'global',
    defaultCombo: 'Mouse:Back',
    rebindable: true,
  },
  {
    id: 'search.togglePalette',
    label: msg`Quick Find`,
    description: msg`Open the cross-project Quick Find palette.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+Shift+F',
    rebindable: true,
  },
  {
    id: 'search.plainFind',
    label: msg`Find on board`,
    description: msg`Focus the board search, or open Quick Find if not on the board.`,
    group: 'General',
    scope: 'global',
    defaultCombo: 'Mod+F',
    rebindable: true,
  },
  {
    id: 'conversation.find',
    label: msg`Find in conversation`,
    description: msg`Open in-viewer search inside the focused Conversation window.`,
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
    label: msg`New task`,
    description: msg`Open the New Task dialog on the board.`,
    group: 'General',
    scope: 'board',
    defaultCombo: 'Mod+N',
    rebindable: true,
  },
  // One save key for every form: the task window's edit form binds it itself,
  // and any BaseDialog that passes `save` (New Task, New Backlog Task, the Board
  // Manager and the dialogs it opens, ...) gets it from BaseDialog, where only
  // the topmost overlay acts. The id predates that and is kept, because user
  // overrides key on it. Not Mod+Enter, which is terminal.sendNewline, and a
  // rebindable default on a terminal-consumed combo is a terminal-warn.
  {
    id: 'taskDetail.save',
    label: msg`Save edits`,
    description: msg`Save the open form, the same as its Save, Create or Done button.`,
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+S',
    rebindable: true,
  },
  {
    id: 'dialog.dismiss',
    label: msg`Dismiss dialog`,
    // Hidden universal closer: Escape closes any open modal. Always on, not
    // rebindable, not shown in the list. The visible, rebindable close hotkey
    // is panel.close.
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Escape',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'boardManager.nextColumn',
    label: msg`Next column`,
    // Selects the next column (or the overview) in the Edit Columns dialog. Fixed.
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+PageDown',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'boardManager.prevColumn',
    label: msg`Previous column`,
    // Selects the previous column (or the overview) in the Edit Columns dialog. Fixed.
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+PageUp',
    rebindable: false,
    hidden: true,
  },
  // Description editor formatting keys. Fixed (not rebindable): handled
  // directly inside DescriptionEditor's keydown handler, not via
  // useKeybinding, following terminal.copy's precedent for a combo a specific
  // surface owns. Registered so the Hotkeys tab lists them, which is the only
  // guarantee that buys: detectConflicts resolves rebindable actions only, so a
  // later rebind landing on one of these combos is not flagged, and the listing
  // is what a user has to read. `scope: 'dialog'` rather than 'task-dialog': the
  // editor also mounts in the New Task and New Backlog Task dialogs, not just
  // task detail.
  {
    id: 'description.bold',
    label: msg({ message: 'Bold', context: 'hotkey' }),
    description: msg`Wrap the selected description text in bold markdown. Fixed.`,
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+B',
    rebindable: false,
  },
  {
    id: 'description.italic',
    label: msg({ message: 'Italic', context: 'hotkey' }),
    description: msg`Wrap the selected description text in italic markdown. Fixed.`,
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+I',
    rebindable: false,
  },
  {
    id: 'description.link',
    label: msg({ message: 'Link', context: 'hotkey' }),
    description: msg`Wrap the selected description text in a markdown link. Fixed.`,
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+K',
    rebindable: false,
  },
  {
    id: 'description.pastePlain',
    label: msg`Paste as plain text`,
    // Pastes into the description without converting pasted HTML to markdown.
    // Fixed; not shown because the combo is a platform convention no app lets
    // you rebind.
    group: 'General',
    scope: 'dialog',
    defaultCombo: 'Mod+Shift+V',
    rebindable: false,
    hidden: true,
  },

  // ── Task Detail ──
  // Maximize / Close are the shared panel.* bindings: they act on whichever panel
  // is open (the task detail dialog or the command terminal overlay).
  {
    id: 'panel.maximize',
    label: msg({ message: 'Maximize', context: 'hotkey' }),
    description: msg`Maximize the open panel: the command terminal, the task detail dialog (view or edit mode), a create dialog (New Task / New Backlog Task), or the Edit Columns dialog.`,
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+M',
    rebindable: true,
  },
  {
    id: 'panel.close',
    label: msg({ message: 'Close', context: 'hotkey' }),
    description: msg`Close the open panel: the command terminal, the task detail dialog, or a create dialog (New Task / New Backlog Task). Escape also closes any modal.`,
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+W',
    rebindable: true,
  },
  {
    id: 'panel.closeViaHeaderClick',
    label: msg`Close window (click header)`,
    description: msg`Close the focused task detail window by clicking its title bar with this button (default middle mouse button). Rebind to any keyboard chord or mouse button (middle / side).`,
    group: 'Task Detail',
    scope: 'panel',
    defaultCombo: 'Mouse:Middle',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleBrowser',
    label: msg`Toggle Browser pane`,
    description: msg`Show or hide the browser pane inside the task detail dialog.`,
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+B',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleChanges',
    label: msg`Toggle Changes panel`,
    description: msg`Show or hide the changes (diff) panel inside the task detail dialog.`,
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+G',
    rebindable: true,
  },
  {
    id: 'taskDetail.toggleDescription',
    label: msg`Toggle description peek`,
    description: msg`Show or hide the description panel inside the task detail dialog.`,
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Mod+Shift+K',
    rebindable: true,
  },
  // Move the open task one column left/right WITHOUT closing its window - the
  // kebab's "Move to" and a board drag both close or bypass the window.
  // `Mod+Shift+Arrow*` is window.snapLeft/Right in this same window;
  // `Mod+Alt+Arrow` is the Windows Intel-graphics display-rotation chord; bare
  // `Alt+Arrow` is Browser-pane back/forward. Alt+Shift+Arrow is free and sits
  // beside the existing Alt+Shift+Up/Down (changes.prevFile/nextFile).
  //
  // Policy: the hotkey runs the SAME move `handleMoveTo` runs for the kebab -
  // a target column's automation fires and the existing move confirmations
  // (the To Do "Reset task?" dialog, the Done confirm) still gate it, exactly
  // as they do today. Refusing to cross into a session-changing lane would
  // block the transitions the board is built from (Executing -> Code Review
  // spawns /code-review); prompting on every automated column defeats a
  // one-keystroke step. See useTaskActions.ts's `keepOpen` handling.
  {
    id: 'taskDetail.moveColumnLeft',
    label: msg`Move task left`,
    description: msg`Move the open task one column left and keep its window open.`,
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Alt+Shift+ArrowLeft',
    rebindable: true,
  },
  {
    id: 'taskDetail.moveColumnRight',
    label: msg`Move task right`,
    description: msg`Move the open task one column right and keep its window open.`,
    group: 'Task Detail',
    scope: 'task-dialog',
    defaultCombo: 'Alt+Shift+ArrowRight',
    rebindable: true,
  },
  // Changes panel review navigation. Next/prev change steps through the diff
  // hunks and rolls into the adjacent file at a file's first/last change (F7 /
  // Shift+F7 is the VS Code / JetBrains diff-nav convention, offered as an alt).
  {
    id: 'changes.nextChange',
    label: msg`Next change`,
    description: msg`Jump to the next change in the diff. Past a file's last change, continues into the next file.`,
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+ArrowDown',
    defaultComboAlt: 'F7',
    rebindable: true,
  },
  {
    id: 'changes.prevChange',
    label: msg`Previous change`,
    description: msg`Jump to the previous change in the diff. Before a file's first change, continues into the previous file.`,
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+ArrowUp',
    defaultComboAlt: 'Shift+F7',
    rebindable: true,
  },
  {
    id: 'changes.nextFile',
    label: msg`Next changed file`,
    description: msg`Select the next file in the Changes panel.`,
    group: 'Git Changes',
    scope: 'task-dialog',
    defaultCombo: 'Alt+Shift+ArrowDown',
    rebindable: true,
  },
  {
    id: 'changes.prevFile',
    label: msg`Previous changed file`,
    description: msg`Select the previous file in the Changes panel.`,
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
    label: msg`Copy selection`,
    description: msg`Copy the selected diff text to the clipboard.`,
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
    label: msg`Snap window left`,
    description: msg`Snap left: to the left half, or from a right corner to the matching left corner (Win11 stateful snap).`,
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowLeft',
    rebindable: true,
  },
  {
    id: 'window.snapRight',
    label: msg`Snap window right`,
    description: msg`Snap right: to the right half, or from a left corner to the matching right corner (Win11 stateful snap).`,
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowRight',
    rebindable: true,
  },
  {
    id: 'window.snapUp',
    label: msg`Snap window up`,
    description: msg`Snap up: maximize when floating, or move a half-snapped window to its top corner (Win11 stateful snap).`,
    group: 'Windows',
    scope: 'panel',
    defaultCombo: 'Mod+Shift+ArrowUp',
    rebindable: true,
  },
  {
    id: 'window.snapDown',
    label: msg`Snap window down`,
    description: msg`Snap down: restore when maximized, or move a half-snapped window to its bottom corner (Win11 stateful snap).`,
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
    label: msg`Inspect element`,
    // Picks an element from the embedded page.
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+I',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.draw',
    label: msg`Draw / annotate`,
    // Toggles free-draw annotation on the embedded page.
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+D',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomIn',
    label: msg`Zoom in`,
    // Increases the embedded page zoom.
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+=',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomOut',
    label: msg`Zoom out`,
    // Decreases the embedded page zoom.
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+-',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.zoomReset',
    label: msg`Reset zoom`,
    // Resets the embedded page zoom to 100%.
    group: 'Browser',
    scope: 'browser-pane',
    defaultCombo: 'Mod+0',
    rebindable: false,
    hidden: true,
  },
  {
    id: 'browser.reload',
    label: msg`Reload page`,
    // Reloads the embedded page.
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
    label: msg({ message: 'Copy', context: 'hotkey' }),
    description: msg`Copy the selected terminal text (Ctrl+Shift+C always copies). With no selection, Ctrl+C cancels the running command instead.`,
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+C',
    defaultComboAlt: 'Mod+Shift+C',
    rebindable: false,
    terminalUnsafe: true,
  },
  {
    id: 'terminal.paste',
    label: msg({ message: 'Paste', context: 'hotkey' }),
    description: msg`Paste text or an image into the terminal (Ctrl+Shift+V also pastes).`,
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+V',
    defaultComboAlt: 'Mod+Shift+V',
    rebindable: false,
    terminalUnsafe: true,
  },
  {
    id: 'terminal.sendNewline',
    label: msg`Insert newline`,
    // Sends a newline instead of submitting (Claude Code TUI). Handled by the terminal.
    group: 'Terminal',
    scope: 'terminal',
    defaultCombo: 'Mod+Enter',
    rebindable: false,
    terminalUnsafe: true,
    hidden: true,
  },
  {
    id: 'terminal.interrupt',
    label: msg`Interrupt (cancel)`,
    // Cancels the running command (sends SIGINT). Native terminal behavior.
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
    label: msg`Toggle debug overlay`,
    description: msg`Show or hide the activity-engine debug overlay.`,
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
    // The save key is live in New Task and the task window's edit form, beside
    // panel.maximize / panel.close and the task window's own keys.
    ['dialog', 'panel'],
    ['dialog', 'task-dialog'],
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
  /** `Mod` and literal `Ctrl` are the same physical key here (every platform but
   *  macOS), so compare them as one. A rebind captured on Windows records a
   *  physical Ctrl+Tab as `Mod+Tab`, which must clash with a `Ctrl+Tab` default.
   *  Default false, which keeps the two apart as they are on macOS. */
  modIsCtrl?: boolean;
}

/** `normalizeCombo`, with `Mod` folded into literal `Ctrl` when the two are one key. */
function comparableCombo(combo: string, modIsCtrl: boolean): string {
  const normalized = normalizeCombo(combo);
  if (!modIsCtrl || isMouseCombo(normalized)) return normalized;
  return normalizeCombo(normalized.split('+').map((part) => (part === 'Mod' ? 'Ctrl' : part)).join('+'));
}

/**
 * Detect conflicts across all rebindable bindings given the current overrides.
 *
 * A `conflict` is two+ rebindable actions resolving to the same normalized combo
 * whose scopes overlap. A `terminal-warn` is a rebindable action resolving onto
 * a combo the embedded terminal consumes (so it would not fire while the terminal
 * is focused). An unbound action (empty combo) is never part of either.
 */
export function detectConflicts(
  overrides?: Record<string, string> | null,
  options: DetectConflictsOptions = {},
): KeyConflict[] {
  const modIsCtrl = options.modIsCtrl === true;
  const active = KEYBINDINGS.filter(
    (definition) => definition.rebindable && (!definition.devOnly || options.includeDevOnly),
  );
  const resolved = active
    .map((definition) => ({
      definition,
      combo: comparableCombo(effectiveCombo(definition.id, overrides), modIsCtrl),
    }))
    .filter((entry) => entry.combo !== '');

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
        ? [comparableCombo(definition.defaultCombo, modIsCtrl), comparableCombo(definition.defaultComboAlt, modIsCtrl)]
        : [comparableCombo(definition.defaultCombo, modIsCtrl)],
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
 * Supported main keys: a single A-Z letter, a 0-9 digit, F1-F24, `Tab`, and
 * `Backquote` (emitted as `` ` ``). That covers every rebindable global/dialog
 * default. An unbound (empty) combo has nothing to probe and returns null.
 */
export function comboToAccelerator(combo: string): string | null {
  // Mouse buttons are never OS global shortcuts; skip the accelerator probe.
  if (combo === '' || isMouseCombo(combo)) return null;
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
  } else if (mainKey === 'Tab') {
    acceleratorKey = 'Tab';
  } else if (mainKey === 'Backquote') {
    acceleratorKey = '`';
  }
  if (!acceleratorKey) return null;

  return [...acceleratorModifiers, acceleratorKey].join('+');
}

---
paths:
  - "src/renderer/**"
  - "src/shared/keybindings.ts"
---
# Rule: renderer shortcuts go through the central keybinding registry

Keyboard shortcuts used to be registered ad-hoc as scattered `useEffect` +
`window/document.addEventListener('keydown')` handlers, each hard-coding its own combo inline.
That made shortcuts undiscoverable and uncustomizable, let the same combo silently clash across
files, and meant adding a shortcut touched nothing the settings UI could see. The central
registry (`src/shared/keybindings.ts`) is now the single source of truth: handlers read their
combo from it, the Hotkeys settings tab lists and rebinds them, and conflict detection runs over
the same array.

## The rule

- **Declare every renderer shortcut in `KEYBINDINGS`** (`src/shared/keybindings.ts`) as one
  `KeybindingDefinition` (id, label, group, scope, defaultCombo, rebindable, and optionally
  terminalUnsafe / devOnly / defaultComboAlt). Action ids are stable and never renamed: user
  overrides key on them.
- **Bind it with `useKeybinding(id, handler, opts)`** (`src/renderer/hooks/useKeybinding.ts`),
  not a hand-rolled `addEventListener('keydown')`. The hook reads the effective combo (override
  or default) live, so a rebind in settings takes effect immediately. Use `opts` for capture
  phase, `document` vs `window` target, `enabled` gating, `when` predicates, and
  preventDefault/stopPropagation.
- **Combos are canonical** (`Mod+Shift+P` form; `Mod` = Cmd on macOS, Ctrl elsewhere; literal
  `Ctrl` only for terminal SIGINT). Default combos must already be normalized.
- **Three narrow exception families, each kept hand-written on purpose:**
  - The embedded xterm clipboard/SIGINT handlers in `terminal-clipboard.ts` (they live inside
    xterm's own key pipeline, not a window listener). They are registered in `KEYBINDINGS` as
    display-only entries (`rebindable: false, terminalUnsafe: true`) so the panel lists them and
    the conflict checker can warn against them.
  - Structural Escape, in three shapes. A dialog's own dismissal (BaseDialog's Escape), a
    pop-out window's own dismissal (`PopOutWindowFrame`'s bubble-phase Escape closes the OS
    window, guarded so open overlays, DOM windows, and focused text fields keep their Escape),
    and a TRANSIENT IN-GESTURE cancel that must beat the dialog dismissal to the event: BrowserPane's
    Esc-cancels-Inspect and `useWindowDrag`'s Esc-cancels-drag. Both of the latter register a
    CAPTURE-phase listener and call `stopImmediatePropagation`, because the focused window closes
    itself on a bubble-phase `document` Escape - without the capture-phase intercept, Escape
    during the gesture closes the window instead of cancelling. Each gates on the gesture being
    in flight and returns early otherwise, so a plain Escape still reaches the dialog. Escape is
    registered display-only as `dialog.dismiss` and is not rebindable; none of the three shapes
    adds an entry, since a second entry for the same physical key would only invent a phantom
    conflict.
  - The description editor's text-formatting combos (`description.bold` / `.italic` / `.link` /
    `.pastePlain`, handled in `DescriptionEditor`'s own `onKeyDown`). They are decisions made
    while already inspecting the keystroke, alongside bare Enter and Tab, against the textarea's
    live selection - a window listener would have to re-derive all of that, and four separate
    `useKeybinding` calls would each re-enter the same handler. Registered display-only
    (`rebindable: false`) so the Hotkeys tab lists them.
- **New shortcut = one registry entry + one `useKeybinding` call.** It then auto-appears in the
  Hotkeys settings tab and conflict detection with no further wiring.

  Caveat for a display-only entry: `detectConflicts` resolves `rebindable` actions only, so a
  non-rebindable combo is NOT a clash target - a user rebinding onto `Mod+B` is never warned. The
  xterm entries dodge this via `terminalUnsafe`, which feeds the terminal-warn set from all of
  `KEYBINDINGS`; the others rely on the Hotkeys listing alone.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/keybindings-registry.test.ts` scans `src/renderer/**` and fails if any
  `useKeybinding('id', ...)` references an id not in `KEYBINDINGS`; it also locks registry
  hygiene (unique ids, canonical default combos), the terminal-unsafe set, and the
  normalize/scope/conflict/accelerator helpers. Runs in CI via `npm run test:unit`.
- **Review:** `/code-review` flags a hand-rolled `addEventListener('keydown')` for an app
  shortcut that bypasses the registry on renderer changes.

## Scope

Renderer keyboard shortcuts under `src/renderer/`. The xterm clipboard handler and structural
dialog Escape handling are the documented exceptions above. Main-process accelerators (the
global-shortcut availability probe in `handlers/system.ts`) consume the registry's
`comboToAccelerator` but are not themselves `useKeybinding` consumers.

---
paths:
  - "src/renderer/components/settings/settings-card.tsx"
  - "src/renderer/components/settings/settings-registry.ts"
  - "src/renderer/components/settings/tabs/**"
  - "src/renderer/components/settings/keybindings/**"
  - "src/devtools/renderer/DevToolsSections.tsx"
---
# Rule: a settings tab is built from SettingsCard tiles

Settings tabs share one card design, chosen on 2026-09-27 after comparing five depth options in
real frames. Before it, the cards blurred into the panel. Their fill was a shade darker than the
panel, the header and the options shared that one fill, switches ended on two different right
edges, and descriptions wrapped to a second line. Tabs also mixed three layouts: cards, flat rows
under an uppercase heading, and compact toggle lists. Each of those came from a tab styling its own
rows. The same drift comes back the moment a new tab or setting hand-rolls a row, so the shape is
stated here and held by the components.

## The rule

- **Every tab is cards, and only cards.** A tab returns one `SettingsCard`, or a wrapper holding
  `SettingsCard`s (plus its dialogs). No row, heading or note sits loose on a tab, so every tab
  flows the same way whatever its content.
- **One card per feature, from `settings/settings-card.tsx`.** A feature with a master switch puts
  it in the card's header and the settings that depend on it in the body, passed only while the
  switch is on. A card with no switch groups related settings under a title and a one-line
  description. Use `settingProps(id)` so a card's or row's label and description come from the
  settings registry.
- **Every child of a card body is a tile.** Use `CardRow` for a control under its label,
  `CardToggleRow` for a label with a switch, `CardChoiceRow` for a choice between two named
  options, and `CardTile` for anything custom: an action row, a
  group of controls, a status line, a sortable list item. A component of your own may sit in a
  body when every one of its returns is a tile (`NotifyChannelRow`, `HotkeyRow`). Never put a raw
  element in a body, and never give a `CardTile` its own fill or padding (its `className` is for
  layout only). The one exception is `wideBody`, for a grid with no label column (MCP Server's
  tool list).
- **The old row components are gone.** `SectionHeader`, `SettingRow`, `SettingToggleRow` and
  `CompactToggleList` were removed from `settings/shared.tsx` when every tab moved to cards. Do not
  bring them back. A card's title replaces a section heading.
- **A short fixed choice is a segmented control, never a dropdown.** Two to four options that fit
  beside the row's label show at once, and any is one click away. In a card body that is
  `CardChoiceRow`, whose control ends on the switches' right edge; inside a custom tile's form it
  is `SegmentedControl` with `quiet`. Keep the labels to a word or two and let the card or row
  supply the context ("Desktop", not "Desktop only"). When one-word labels need more meaning,
  put it in each option's `title` (Close on outside click and Card preview do). Only a set whose
  labels will not shorten to fit keeps its `Select`, and says why with
  `// choice-select-ok: <reason>`; no settings tab has one today. A `Select` whose options come from a list is exempt, since it can grow.
- **Depth lifts, never recesses.** The card is clear and each tile is lighter than the panel
  (`bg-surface-hover/40`). Nothing inside a card is darker than the panel it sits on. Recessed
  wells were compared and rejected as heavy and dim. Form controls keep their shared fills
  (`INPUT_CLASS`, `Select`, `SegmentedControl`'s track), which are the control's, not a surface.
- **Alignment is computed, not styled.** The header's right inset is the tiles' inset plus their
  right padding, and a tile's left padding puts its label where the header's title starts. Those
  are numbers in one constants block at the top of `settings-card.tsx`. Change a constant and the
  sums follow; do not reach for a padding class. The result is that every switch, trailing button
  and dropdown arrow in a card ends on one right edge, the header's switch included. A row's drag
  handle goes in `CardTileGutter`, under the header's icon, so it never pushes the row's label off
  that left edge.
- **A `CardToggleRow` tile is one click target.** A click anywhere on it flips the switch, and the
  hover tint fills the tile. A click on a control of its own (the switch, an `InfoTip`, a link) is
  left to that control. A header with a switch behaves the same way, and its click target is
  tile-shaped: inset like a tile, with a tile gap between it and the first tile, so its hover
  fill never runs into the option below.
- **Every description a card shows fits on one line.** That covers a header's description, a
  row's `inlineDescription`, and a `requirement` tag. The budgets are 60 characters beside a
  switch, 66 in a header with no switch, and 54 in a nested row. Anything longer goes in the
  row's `InfoTip`, which has no budget. See `ui-conventions.md` for the rest of the copy
  conventions.
- **Labels are plain nouns in sentence case, and the card supplies the context.** Inside the
  Knowledge Graph card the rows are Agent, Model and Effort, not "Answering agent". Keep the longer
  phrase as a search keyword and put the card's name in the registry entry's `section`.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/settings-card-design.test.ts` parses every TSX file under `settings/` plus
  the dev-only `DevToolsSections.tsx`. It fails on a tab that renders anything but cards at its top
  level, on a card body child that is not a tile, on a `CardTile` that sets its own fill or
  padding, on a `Select` with two to four static options and no `choice-select-ok` marker, and
  on a shown description over its budget. The body check looks through fragments,
  conditionals, `.map()` callbacks and dnd-kit's wrappers, and accepts any component whose every
  return is a tile. Every detector runs over known-bad input, and the scan pins that it visited
  every tab, so it cannot pass vacuously. Runs in CI via `npm run test:unit`.
- **Type system:** the removed row components no longer exist, so `npm run typecheck` fails an
  import of one.
- **Test (behavior):** `tests/ui/toggle-card.spec.ts` asserts that every switch on the Git tab
  ends on one right edge, that a click on a header or row flips its switch, and that a click on an
  `InfoTip` does not.
- **Structural:** the alignment is computed in `settings-card.tsx`, so it holds with no check.
- **Review:** `/code-review` flags a fill darker than the panel. The unit test only sees
  `CardTile` class names, so a darker fill added inside a tile's content is review-only.

The character budget is a heuristic, not a pixel guarantee. The UI font is each OS's system font,
so a pixel check on the Linux CI runner would measure a font no user sees. The budgets come from
the widest text measured in Segoe UI (5.7px per character) against the fixed 720px panel's text
columns, with room left for the slightly wider macOS and Linux fonts.

## Scope

Every tab in the settings panel (`settings/tabs/**`), the keybinding rows the Hotkeys tab renders,
and the dev-only cards the Developer tab renders from `src/devtools/renderer/DevToolsSections.tsx`.
Does not govern the board manager's `ToggleCard` columns or the task dialogs.

---
paths:
  - "src/renderer/hooks/**"
  - "src/renderer/utils/intent-keyboard-sensor.ts"
  - "src/renderer/components/board/**"
  - "src/renderer/components/dialogs/board-manager/**"
  - "src/renderer/components/backlog/manage-labels/PrioritiesPopover.tsx"
  - "src/renderer/components/settings/tabs/ShortcutsTab.tsx"
  - "src/renderer/components/DataTable.tsx"
---

# Rule: a keyboard drag arms only on keyboard-placed focus, and ends when intent moves

dnd-kit's stock `KeyboardSensor` starts a drag on any Space or Enter keydown that reaches a focused
sortable, and every sortable here is `tabindex="0"`, so a mouse press focuses it. A pointer drag
leaves the card focused (dnd-kit swallows the post-drag click, so no window opens and nothing takes
focus back), and the next Enter lifts the card into a `DragOverlay` ghost. That drag ends only on a
keydown that reaches `document` or on a window resize / visibilitychange. Clicks and focus moves do
not end it, and xterm stops every key it consumes, so once the user clicks into a terminal nothing
can end it. On the dogfooding board a ghost sat over Planning for 8m48s; while it was up no card
could be mouse-dragged (`DndContext` refuses a second activator), a stray Space or Enter anywhere
would have DROPPED the card (a lane transition with automations attached), and the reload gate
parked every board reload for its 30s watchdog. The Board Manager's column rail and automations
list share the shape: a click on the grip focuses it, Enter lifts the row, and an Enter in a text
field of the same dialog drops it.

## The rule

- **`IntentKeyboardSensor` (`src/renderer/utils/intent-keyboard-sensor.ts`) is the only keyboard
  sensor.** A `useSensor` call never names dnd-kit's `KeyboardSensor`. The shared class arms only
  when the focused element is the sortable node itself (not a focusable child) and its focus was
  placed by Tab or an arrow key, and it cancels the drag on a pointer press anywhere or on focus
  landing outside the dragged node.
- **A sortable that carries dnd-kit's `attributes` registers the shared sensor.** `attributes` is
  `tabindex="0"`, `role="button"` and `aria-roledescription="sortable"`: a Tab stop that a screen
  reader announces as sortable. Without a keyboard sensor that announcement is a lie, and the stop
  is dead weight in the Tab order. `attributes` and `listeners` also go on the SAME element, the
  grip: on a wrapper they made every board column an invisible `outline-none` focus stop that a
  click on empty lane space landed on, while the grip that sorts stayed unreachable. The one
  deliberate exception is the sidebar's project row, whose own `onKeyDown` makes Enter and Space
  "open this project" and shadows the activator, so a sensor there would be inert.
- **Focus origin is tracked, not read from `:focus-visible`.** Chromium flips its "had keyboard
  event" bit BEFORE it dispatches the keydown. Measured on a card focused by a real press:
  `:focus-visible` read false before the key and true inside the first capture listener of the
  Space that followed, so a `:focus-visible` gate lets the pickup through. Only a Tab or arrow
  keydown arms the tracker: those are the keys whose DEFAULT action moves focus. A focus that
  follows any other key is a script (`BaseDialog`'s `trapFocus` restores the opener when Enter
  confirms a `ConfirmDialog`), and a script focus must not arm a drag.
- **Cancel through the sensor, never through a synthetic event.** dnd-kit has no imperative
  cancel. A synthetic Escape on `document` would also reach `BaseDialog`, `SettingsPanelShell`,
  `PopOutWindowFrame` (which closes the OS window on a bubble-phase Escape) and every
  `useKeybinding` Escape handler; a synthetic `visibilitychange` or `resize` has the same
  collateral; a `<DndContext>` re-key remounts every card. The subclass detaches the base
  listeners and calls its own `onCancel`. It does not call the base `handleCancel(event)`, which
  prevents the event's default: a prevented `pointerdown` suppresses the compat `mousedown`, which
  is what focuses the terminal the user just clicked.
- **The in-gesture Escape is consumed by the tracker, not by the sensor instance.** BaseDialog and
  the settings panel dismiss on a bubble-phase document Escape; `PrioritiesPopover` and the
  combobox menus dismiss on a CAPTURE-phase one registered when they open. Same-node capture
  listeners run in registration order, so a listener registered at pickup runs after a host's and
  can never beat it. The tracker's keydown listener is registered by `setup()`, which `DndContext`
  runs as a child effect of whatever hosts it, so it is earlier in the list and its
  `stopImmediatePropagation` wins. It consumes Escape only while a keyboard drag is in flight and
  only when the key is aimed at the dragged node (or at body, once the node is gone); a second
  Escape reaches the host as before. Every exit path releases the registration through the wrapped
  `onEnd` / `onCancel`, and a context that unmounts mid-drag (the Board Manager closed by its X
  with a row lifted) fires neither, so `setup()`'s teardown disposes whatever is registered: the
  dead sensor's document listeners go with it, and the next Escape on the board is not swallowed
  by a dialog the user already closed.
- **The board `DragOverlay`'s first child carries no transform.** dnd-kit measures that child
  (`getMeasurableNode`) for the collision rect and the drop animation. With the tilt on it the
  measured box leaned 1.6px left and 7px above the card, `sortableKeyboardCoordinates`' "to the
  right of" test then admitted every same-column sibling, and ArrowRight landed on the card below
  instead of the next column. `.drag-overlay` is the measured box; `.drag-overlay-tilt` inside it
  is the look.
- **The subclass declares no instance fields.** dnd-kit's constructor assigns `props`,
  `listeners`, `windowListeners` and `referenceCoordinates`; a subclass field of the same name runs
  its initializer after `super()` and clobbers the registry the cancel relies on.
- **Escape inside xterm stays xterm's.** The fix never makes a terminal keystroke reach dnd-kit;
  the drag is already gone by the time focus is in the terminal.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/intent-keyboard-sensor.test.ts` scans `src/renderer/**` and fails on any
  `KeyboardSensor` identifier outside the sensor module (an aliased import is caught at the
  import), pins that the six sorting sites register `IntentKeyboardSensor` so the scan cannot pass
  vacuously, pins the two dnd-kit internals the subclass reaches through its one cast
  (`KeyboardSensor.prototype.detach` and the single `onKeyDown` activator), fails a subclass field
  that shadows a base instance member, pins that `.drag-overlay` carries no transform while
  `.drag-overlay-tilt` carries the rotation and that `KanbanBoard` nests them that way, and drives
  the focus-origin reducer through the cases the UI tier cannot isolate (a focus after Enter is
  not keyboard-placed; a pointer press revokes; an alt-tab re-fired focusin keeps the
  classification). Runs in CI via `npm run test:unit`. The overlay pins read CSS and JSX as text,
  so a transform arriving through a utility class on the measured div is invisible to them; the
  ArrowRight UI case below is the guard for that, and it is red against the old geometry.
- **Test (behavior):** `tests/ui/board-keyboard-drag-intent.spec.ts` presses, drags and releases a
  card so the mouse leaves it focused, then presses Space and Enter: no `.drag-overlay`. It also
  pins that Tab-placed focus still picks up, that Escape and Space end that drag, that a pointer
  press anywhere cancels it, that a script focus into a terminal cancels it and the terminal keeps
  its keys, that Space on a card's delete button opens the delete confirm and lifts nothing, that
  ArrowRight highlights the next column and not the source lane, that a column grip lifts its
  column from Tab-placed focus only, and that Escape cancels a lifted Board Manager row while the
  Board Manager stays open and the next Escape closes it. Four more cases pin what the sensor
  does around the pickup: Space on a pointer-focused card is swallowed (`defaultPrevented`)
  rather than scrolling the lane, a real click into a terminal cancels the drag and the terminal
  takes focus (the cancel must not prevent the pointerdown), the tracker survives the Board
  Manager closing (the ref count), and no column wrapper is a Tab stop while only custom columns
  carry a grip. Every card case is red against the stock sensor except the pure
  keyboard one. It asserts on overlay presence, `aria-pressed` and the lane highlight, never on a
  completed reorder: dnd-kit's arrow move is the part Playwright cannot drive reliably.
- **Review:** the `keyboard-drag-intent.md` line in `/code-review`'s Project Conventions list
  (`.claude/skills/code-review/SKILL.md`) flags a new `useSensor` site that registers a keyboard
  sensor of its own or none at all while its sortables carry `attributes`, `attributes` and
  `listeners` split across two elements, a key added to the tracker's arming set without the
  default-action justification, a cancel path that reaches for a synthetic event, and a transform
  on the board overlay's measured node.

## Scope

The six `DndContext` sites that sort by keyboard (`useBoardDragDrop`, `useBacklogDragDrop`,
`ColumnRail`, `AutomationsPane`, `PrioritiesPopover`, `ShortcutsTab`), the sensor module, and the
board's `DragOverlay`. The sidebar's project list (`useSidebarDragDrop`) is the one pointer-only
site, for the reason above. Escape is pinned by `tests/ui/board-keyboard-drag-intent.spec.ts`
against a `BaseDialog` (Board Manager): the lift cancels, the dialog stays open, and the next
Escape closes it. The settings panel (Shortcuts) and a capture-phase popover (Priorities) share
that document-capture ordering and were checked live, but no test pins them: their row grips
carry no stable selector to drive.

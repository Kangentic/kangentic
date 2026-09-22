---
paths:
  - "src/renderer/components/ActivityMark.tsx"
  - "src/renderer/components/IconSlot.tsx"
  - "src/renderer/components/board/TaskCard.tsx"
  - "src/renderer/components/command-bar/**"
  - "src/renderer/components/monitor/**"
  - "src/renderer/components/sidebar/**"
  - "src/renderer/components/terminal/**"
  - "src/renderer/components/layout/TitleBar.tsx"
---
# Rule: activity marks come from branding, move on composited properties, and never eat a click

The nine glyphs that express agent and terminal activity are owned upstream in
`@kangentic/branding` (`assets/activity/`), so desktop, web, and mobile cannot drift.
`components/ActivityMark.tsx` is the only consumer. Three classes of bug have shipped from this
one component: a non-composited animation that stops producing frames whenever the renderer's
main thread is blocked, an `innerHTML` re-assign that destroys the node under the cursor and
makes Chromium drop the click outright, and a frozen-motion override that lost the cascade and
silently did nothing. Each is invisible in review and obvious in production. Background,
measurements, and the upstream geometry history live in
[docs/activity-marks.md](../../docs/activity-marks.md).

## The rule

- **Never hand-author a mark.** Marks come from `@kangentic/branding`. `ActivityMark` imports
  each with `?raw`, strips the packaged `<svg>` wrapper, and injects the inner markup into a
  `<g>` under a React-authored root. That root shape is load-bearing and must not become
  `BrandMark`'s wrapper-`<span>` form: React forbids `children` next to
  `dangerouslySetInnerHTML` on one element, and `TaskCard` passes a `<title>` child for its
  hover tooltip.
- **Motion is always on a composited property.** Chromium composites only `transform` and
  `opacity`. Anything else stops producing frames for exactly as long as the main thread is
  blocked. Which primitive a mark gets is decided by its geometry, not by taste: a circle's
  symmetry group is continuous, so the three round working marks rotate (`.kng-spin`); a rounded
  square's is discrete, so `terminal-working` cannot travel a dash at all and blinks its whole
  prompt instead (`.kng-blink`, an `opacity`). `.kng-march` still ships but no mark uses it.
- **Three things bite silently.** `ActivityMark`'s timeline anchor must select EVERY motion
  class, because none of the primitives is phase-invariant. Any consumer that freezes motion
  must do the same AND must use `!important`: `ActivityMark` imports the packaged CSS from
  node_modules, so `.kng-spin` arrives unlayered and outranks every Tailwind utility, which
  compile into `@layer utilities`. And the packaged CSS must ship no animation fill mode, or a
  stopped blink rests at its 0.06 trough instead of visible. The shared 1400ms period across all
  primitives is what keeps a rotating agent ring in lockstep with a blinking chip in the same
  sidebar row.
- **Marks are `currentColor` only.** The CALL SITE supplies `text-active` / `text-attention` /
  `text-fg-muted`. Never hardcode a hex: `--kng-active` and `--kng-attention` are desktop-only
  values that mobile and web deliberately diverge from.
- **The injected `<g>` is `pointer-events: none`, and stays there.** Re-assigning its `innerHTML`
  on a `mark` change destroys the node the cursor is over, and Chromium then drops the click.
  Hits must land on the React-authored `<svg>`, which survives a `mark` change. So the `none`
  never moves up to the root, which `TaskCard`'s `<title>` tooltip needs hit-testable, and the
  `<g>` never gets `key={mark}`.
- **An icon that changes ELEMENT TYPE between states goes through `IconSlot`.** A branch that is
  lucide at rest and `ActivityMark` when active unmounts the `<svg>` too, which no change inside
  `ActivityMark` can reach. `components/IconSlot.tsx` is a fixed-size `<span>` all branches
  share, so React reconciles the one span in place across the swap and the span absorbs the
  pointer. Wrap ONCE around the icon the branching produced, never per branch, so a future
  branch cannot silently opt out. A slot neutralizes the element it wraps, so a mark inside one
  labels itself with `aria-label`; a native `<title>` child would be inert.
- **There is no `-rest` mark.** Rest is the `-idle` geometry in a muted tone. `data-rest` on the
  root is the reduced-motion strategy (`static` / `keep-dash` / `drop-dash`), NOT a tone. Test
  selectors key off `data-mark`.
- **Sizes are fixed by role.** Two keylines: 18 for indicators, 20 for controls. Size floors are
  12 for indicators and 16 for controls, which is why `TerminalPanel`'s 8px session dot stays
  lucide. Control marks render at size 20, indicators at 16 (`TaskCard` and both sidebar
  components). Move the sidebar's two indicator components together or the row goes ragged.
- **lucide stays everywhere else** (140+ files), and `utils/swimlane-icons.tsx` needs its whole
  glyph map because column icon names are persisted as kebab-case strings in the DB.

## Enforcement (self-maintaining)

- **Test (geometry):** `tests/unit/activity-mark.test.ts` pins the r=10 control ring, the r=9
  agent ring, and the envelope's 18 x 16 box, as the guard against a silent upstream reshape.
  Runs in CI via `npm run test:unit`.
- **Test (render):** `tests/unit/activity-mark-render.test.ts` covers the injected markup and the
  motion classes. `tests/ui/activity-marks.spec.ts` covers the rendered marks.
- **Test (clicks):** `tests/ui/command-terminal.spec.ts` covers both hazard variants, a mark flip
  and an element-type swap, with red-green mouse-level tests, but only for `StopButtonIcon`. The
  other adoptions ride on the shared component.
- **Review:** `IconSlot` adoption is the read-trigger gap this rule cannot close. The hazard
  appears when someone CREATES a new branching icon, which a path-scoped rule does not fire on,
  so `/code-review` is the backstop for new sites.

## Scope

Renderer code that renders an activity mark. `IconSlot` has been adopted at `StopButtonIcon`,
`PauseButtonIcon`, and `MonitorCard`'s `StateGlyph`. That is what has been ADOPTED, not where the
hazard exists: `MonitorTable`'s `StateCell` (inside `DataTable`'s clickable `<tr>`) and
`TerminalPanel`'s session-tab glyph have the same element-type swap and are still unwrapped.
`TaskCard` is a mark flip only and carries a `<title>` tooltip, so it is deliberately not a slot
candidate. Does not govern lucide icons, which stay everywhere else.

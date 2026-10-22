# Activity Marks

The nine glyphs that express agent and terminal activity. This document records why they look
and move the way they do, and the measurements behind each choice. The prescriptive version,
which is what you need when editing a mark consumer, is
[`.claude/rules/activity-marks.md`](../.claude/rules/activity-marks.md).

## Why they live upstream

The marks are owned in `@kangentic/branding` (`assets/activity/`), not hand-authored in this
repo, so desktop, web, and mobile cannot drift from each other.
`src/renderer/components/ActivityMark.tsx` is the only consumer: it imports each mark with
`?raw`, strips the packaged `<svg>` wrapper, and injects the inner markup into a `<g>` under a
React-authored root.

The root has to be React-authored rather than `BrandMark`'s wrapper-`<span>` form because it is
the element a caller's Tooltip wraps: `TaskCard` shows the activity reason that way, so the root
`<svg>` takes the tip's handlers itself. It used to carry a native `<title>` child for the same job.

## Motion has to be composited

Chromium composites only `transform` and `opacity`. A non-composited animation stops producing
frames for exactly as long as the renderer's main thread is blocked. Measured on a real session:
194 stalls in 3.6 hours, worst 703ms, and the indicators visibly hitched.

Which primitive a mark gets is decided by its geometry, not by taste. To travel a dash along a
perimeter, a transform must map the shape onto itself while advancing arc length, which is the
shape's symmetry group.

- A circle's symmetry group is continuous, so the three round working marks rotate
  (`.kng-spin`). This is the same image the old march produced: `pathLength` 100 makes a dash
  shift of d exactly a rotation of d percent of 360 degrees.
- A rounded square's is discrete (four 90-degree rotations, nothing between), so
  `terminal-working` cannot travel a dash at all. Its working state is a solid outline with a
  blinking prompt (`.kng-blink`, an `opacity`), and its rest strategy is `static` rather than
  `drop-dash`, since there is no dash left to drop.

`.kng-march` still ships but no mark uses it. The travelling dash ran until 2026-08-07; a
rounded rect cannot carry a composited one, so the working chip was redesigned rather than left
stalling.

All primitives share a 1400ms period, which is what keeps a rotating agent ring in lockstep with
a blinking chip in the same sidebar row.

### Which element blinks

Settled at the 16px sidebar size, not at review size. 2.8.0 blinked the 4-unit prompt bar alone,
which draws 2.7px there against the 15.6px of perimeter the march had put in motion, and read as
no motion at all. The whole prompt is 7.9px, so the whole prompt blinks. Blinking the outline
too moves more ink but fades the tone that carries working against resting, so the outline stays
solid.

### The cascade incident

`ActivityMark` imports the packaged CSS from node_modules, so `.kng-spin` arrives unlayered and
outranks every Tailwind utility, which compile into `@layer utilities`. An un-important override
loses the cascade outright and does nothing.

`MonitorSummaryCards`' zero-state Active tile is the only consumer that freezes motion, and it
did nothing at all from the day it adopted the shared marks until a rendered test caught it. The
lucide era before that had simply omitted `animate-spin` and never fought the cascade.

Two related traps: `ActivityMark`'s timeline anchor must select every motion class, because none
of the primitives is phase-invariant (the rotating arc is dashed, and a restarted blink can land
mid-off); and the packaged CSS must ship no animation fill mode, or a stopped blink rests at its
0.06 trough instead of visible.

## The OS preference never stops motion

The packaged `activity.css` sets `animation: none` on every motion class under
`prefers-reduced-motion: reduce`. On 2026-10-20 that froze every mark in the dev instance at once:
board cards, the sidebar project row, and the Command Terminal header. The renderer reported
`reduce` while Windows had Animation effects on. A probe placed the stale value in Electron's
browser process, not in one page. A fresh Electron 44.5.1 on the same machine reported no
preference, and a new `<webview>` created inside the running app reported `reduce`. Re-broadcasting
`SPI_SETCLIENTAREAANIMATION` with `SPIF_SENDCHANGE` did not clear it. Only a relaunch did.

The decision is that Kangentic's motion does not depend on the OS preference. The preference, real
or stale, does not stop it, and the only off switch is Settings > Performance > Animations
(`.no-motion` on `<html>`).

The mechanism is one line in `src/main/index.ts`: main appends Chromium's
`force-prefers-no-reduced-motion` switch at module scope. Chromium fills every web contents'
`prefers_reduced_motion` from `gfx::Animation::PrefersReducedMotion()`. That function checks
`--force-prefers-reduced-motion` first, then this switch, and reads its cached OS value only after
both. So the switch beats whatever the cache holds. `--force-prefers-reduced-motion` on a launch
still wins over it, which is how to look at the reduced-motion styles on desktop.

I measured it on Linux, where Chromium takes the OS value from GTK's `gtk-enable-animations`. With a
`settings.ini` that turns animations off, Electron 44.5.1 reported `reduce` in the main window and
in a `<webview>` guest. With the switch appended the way the app appends it, both reported no
preference. `tests/e2e/os-reduced-motion.spec.ts` repeats that against the real app on CI. It
was also run against a Linux build of the real app before it reached CI: it passed with the switch,
and with the built switch name broken it failed on `prefersReducedMotion` after its GTK
precondition had held. Windows
and macOS read a system-wide setting a test cannot scope to one process, so CI's Linux run is the
only red-green. One trap for any test of this: Playwright emulates
`prefers-reduced-motion: no-preference` on every page it drives by default, so a renderer read
under Playwright reports no preference with or without the switch. The spec asserts on
`systemPreferences.getAnimationSettings().prefersReducedMotion` in main, which emulation cannot
reach, and lifts the override (`emulateMedia({ reducedMotion: null })`) before it reads the
renderer.

The switch is process-wide, so it reaches further than Kangentic's own code:

- **Browser pane guests and agent browser lanes** report no preference. They had latched the same
  stale `reduce`, so this fixes them too. The cost is that a user whose OS really asks for reduced
  motion does not see it in their own dev server inside the pane. The guest's DevTools can still
  emulate it. Keeping the real value for guests would mean CDP media emulation on every app window
  instead of one switch, plus overriding the branding CSS's own media rule.
- **Third-party code in the app's own windows.** Monaco and recharts read the query too, and
  neither leaves motion the Animations setting cannot stop. Every recharts element Kangentic
  draws passes `isAnimationActive` explicitly (tooltips `false`, series from `motionReduced()`),
  so recharts' own `'auto'` default never runs. Monaco's reduced-motion classes never land in the
  standalone diff viewer at all: its accessibility service stamps `monaco-enable-motion` or
  `monaco-reduce-motion` only on editor containers that exist when it is built, and the standalone
  layout service never announces a later one (`onDidAddContainer` is `Event.None`). A UI run with
  a diff open found neither class anywhere, whatever the preference, so an OS reduce never
  reached Monaco's CSS here either. Driving monaco's `workbench.reduceMotion` from the setting was
  tried and dropped: a change event stamps the classes onto editors already open, so a toggle
  would leave the motion-gated rules on some editors and not on ones mounted later.

Kangentic's own readers are unchanged: `motionReduced()`, the reduced-motion blocks in
`index.css`, `OverseerMascot`, and the branding CSS still read the query. In the desktop app it
never matches. Pop-out windows get `.no-motion` too, since every surface boots through
`usePopOutBootstrap`, which loads the config the class follows.

The web demo keeps the visitor's preference. It runs the same renderer bundle in a visitor's own
browser, where no Electron switch exists, and it autoplays on a public page, where a real
reduced-motion request is one WCAG 2.2.2 asks the page to respect. So the reduced-motion CSS is
live there and is not dead code, and the UI tier's reduced-motion specs exercise it through
`emulateMedia`. The split comes from the switch, not from a renderer branch, so the web build is
still the real renderer ([`web-demo-parity.md`](../.claude/rules/web-demo-parity.md)).

One consequence for `.no-motion`: it zeroes `animation-duration` for every element, but it does
not touch transitions. Every transition the reduced-motion styles stopped needs its own
`.no-motion` line, or the desktop app has no way to stop it at all.
`tests/unit/no-motion-parity.test.ts` holds both the `index.css` blocks and the Tailwind
`motion-reduce:` utilities to a counterpart.

## The click the mark ate

The injected `<g>` is `pointer-events: none`, and that is load-bearing for any mark inside a
button. Re-assigning its `innerHTML` on a `mark` change destroys the node the cursor is over, and
Chromium then drops the click outright. This shipped as "the first Stop click never registers".
Measured: the injected ink covered 15% of the pause button, and `control-stop`'s filled square
covers the exact centre.

Hits have to land on the React-authored `<svg>`, which survives a `mark` change. So the
`pointer-events: none` never moves up to the root, which `TaskCard`'s Tooltip needs
hit-testable, and the `<g>` never gets `key={mark}`.

That covers a mark FLIP only. An icon that changes element type between states (lucide at rest,
`ActivityMark` when active) unmounts the `<svg>` too, which no change inside `ActivityMark` can
reach. Those render every branch through `components/IconSlot.tsx`, a fixed-size `<span>` (a minimum
width with `grow`) all branches share: React reconciles the one span in place across the swap, so the node under the
pointer survives, and the span absorbs the pointer on the glyph's behalf.

Adopted so far: `StopButtonIcon`, `PauseButtonIcon`, `MonitorCard`'s `StateGlyph`, and the
Workflows tab in `ViewToggle`, which swaps its count pill for the working mark (its slot takes a
`grow` prop, so a two-digit pill can widen it). `StateGlyph` is why the neutralization is scoped
to the glyph rather than put on the button, since its clickable is a whole card carrying other
interactive children. It also shows where a tip goes on a slotted mark: the card's `Tooltip` wraps
the `IconSlot`, which forwards the pointer, focus and `aria-description` props the Tooltip clones
onto it, because the mark inside takes no pointer and a tip around it would never open. Still
unwrapped, with the same
element-type swap: `MonitorTable`'s `StateCell` (inside `DataTable`'s clickable `<tr>`) and
`TerminalPanel`'s session-tab glyph.

## Geometry and sizing

The set's grid is a width keyline, not a square ink box: each mark fills its slot's width and
takes the height its form needs. Width is the advance that shifts a row; height is absorbed by
`align-items: center`. Two keylines, one per role: 18 for indicators, 20 for controls. Size
floors are 12 for indicators and 16 for controls, which is why `TerminalPanel`'s 8px session dot
stays lucide.

Upstream geometry has moved three times:

| Version | Change |
|---------|--------|
| 2.5.0 | Squared the envelope to 18 x 18 and shrank the controls to r=9 |
| 2.6.0 | Reversed both, to 18 x 14.4 |
| 2.7.1 | Moved the envelope to 18 x 16 so its y edges sit on the integer lattice at 4 and 20 |

`tests/unit/activity-mark.test.ts` pins the r=10 control ring, the r=9 agent ring, and the
18 x 16 envelope as the guard against a silent upstream reshape.

The envelope's height is load-bearing beyond legibility. A card swaps idle for working in place,
so what the eye judges is apparent size. At 18 x 18 the envelope enclosed 26% more than the ring
and visibly grew on every state change. 18 x 14.4 held that to +0.5%. 18 x 16 gives that parity
up at +11.8% (284.6 units against the r=9 ring's 254), accepted upstream as the price of the
hinting fix and checked on a rendered idle/working swap strip.

Control marks render at size 20: their r=10 ring draws 18.33px, a pixel match for the lucide
`Circle` they replaced.

Indicators render at 16 (`TaskCard`, both sidebar components, and the Workflows tab in
`ViewToggle`), not the 14 the lucide glyphs
used. The branding envelope is 18 wide where lucide's `Mail` was 20, so a same-number swap
silently shrinks it about 10%. 15 restored the drawn size production shipped; 16 is a deliberate
one-step legibility bump on top of that. Move the sidebar's two indicator components together or
the row goes ragged.

## Color

Marks are `currentColor` only, so the call site supplies `text-active` / `text-attention` /
`text-fg-muted`. Never hardcode a hex: `--kng-active` and `--kng-attention` are desktop-only
values that mobile and web deliberately diverge from.

There is no `-rest` mark. Rest is the `-idle` geometry in a muted tone. `data-rest` on the root
is the reduced-motion strategy (`static` / `keep-dash` / `drop-dash`), not a tone; test selectors
key off `data-mark`. Only the web build ever applies it, since the desktop app never matches the
reduced-motion query.

## What stays lucide

Everything else, across 140+ files. Column and shortcut icons are persisted as kebab-case names in
the DB, so any lucide glyph can come back by name. `utils/icon-registry.ts` resolves the ones a
stock board names from named imports and loads lucide's whole glyph map (`utils/icon-catalog.ts`)
only when the icon picker opens, when an Icon button in the Board Manager or the Shortcuts
settings is hovered or focused, or when a persisted name outside that set has to paint.

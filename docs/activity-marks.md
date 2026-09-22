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

The root has to be React-authored rather than `BrandMark`'s wrapper-`<span>` form because React
forbids `children` next to `dangerouslySetInnerHTML` on one element, and `TaskCard` passes a
`<title>` child for its hover tooltip.

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

## The click the mark ate

The injected `<g>` is `pointer-events: none`, and that is load-bearing for any mark inside a
button. Re-assigning its `innerHTML` on a `mark` change destroys the node the cursor is over, and
Chromium then drops the click outright. This shipped as "the first Stop click never registers".
Measured: the injected ink covered 15% of the pause button, and `control-stop`'s filled square
covers the exact centre.

Hits have to land on the React-authored `<svg>`, which survives a `mark` change. So the
`pointer-events: none` never moves up to the root, which `TaskCard`'s `<title>` tooltip needs
hit-testable, and the `<g>` never gets `key={mark}`.

That covers a mark FLIP only. An icon that changes element type between states (lucide at rest,
`ActivityMark` when active) unmounts the `<svg>` too, which no change inside `ActivityMark` can
reach. Those render every branch through `components/IconSlot.tsx`, a fixed-size `<span>` all
branches share: React reconciles the one span in place across the swap, so the node under the
pointer survives, and the span absorbs the pointer on the glyph's behalf.

Adopted so far: `StopButtonIcon`, `PauseButtonIcon`, and `MonitorCard`'s `StateGlyph`. The last
is why the neutralization is scoped to the glyph rather than put on the button, since its
clickable is a whole card carrying other interactive children. Still unwrapped, with the same
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

Indicators render at 16 (`TaskCard` and both sidebar components), not the 14 the lucide glyphs
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
key off `data-mark`.

## What stays lucide

Everything else, across 140+ files. `utils/swimlane-icons.tsx` in particular needs its whole
glyph map, because column icon names are persisted as kebab-case strings in the DB.

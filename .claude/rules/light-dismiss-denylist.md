---
paths:
  - "src/renderer/**"
---
# Rule: light dismiss is a denylist, so overlays and action cursors must opt out

Clicking dead space outside a task-detail window closes it. That used to be an ALLOWLIST of five
marked regions (`data-dismiss-surface` on the board columns, toolbar, status bar, sidebar, and the
terminal panel-when-empty), which meant the user had to memorize geography: dead space inside those
dismissed, identical-looking dead space anywhere else did nothing. It is now a DENYLIST: the whole
app shell dismisses, and only interactive things are excluded.

That inversion flips where the danger lives. Under the allowlist, forgetting to mark a surface was
inert - the region simply did not dismiss. Under the denylist, forgetting to exclude something means
a click closes the user's task window instead of doing what they asked. Two shapes cause that, and
both have already happened.

## The rule

### 1. An overlay mounts OUTSIDE the marked shell subtree

`data-dismiss-layer` declares which layer owns a subtree, so a click resolves to the right window
store. It is not a dismissibility switch. There is one declaration per HOST, and
`tests/unit/window-layer-isolation.test.ts` pins the exact set:

- `AppLayout.tsx`'s content row and `StatusBar`'s root: `"board"`
- `MonitorPage.tsx`'s root (the in-app overlay) and `PopOutMonitorRoot.tsx` (the detached window):
  `"monitor"`

Per HOST is the subtlety. The monitor has two hosts that share no root - the pop-out renders
`LazyMonitor` + `MonitorDetailLayer` without `MonitorPage` - and both mount the hook via
`MonitorDetailLayer`, so both need a marker. A surface that gains a second host needs a second
declaration, or that host silently stops dismissing.

Anything with no scope root above it is inert. That is deliberate and load-bearing: every overlay in
AppLayout's mount block (settings panel, stats page, search palette, command-terminal layer,
walkthrough, toasts, dictation, every dialog) and every `document.body` portal is a SIBLING of the
marked subtree, so a new overlay added there is inert on arrival rather than a hole someone has to
find. **Mount new overlays in that block, and do not hoist the marker to AppLayout's root** - doing
so puts every overlay inside board scope at once.

An overlay that must render inside the shell subtree (a context menu anchored to a sidebar row) needs
`data-dismissable-layer` on its root. Portaled menus inherit it from `OverlayPopover`; hand-rolled
ones must declare it.

### 2. An element showing an action cursor must be excluded

The catch-all exclusion is the computed cursor: `pointer` means "this is an action". So a clickable
`<div>` needs no marker, but an element with a DIFFERENT action cursor is invisible to that check:

- `cursor-grab` / `cursor-col-resize` / `cursor-row-resize` / `cursor-move` and friends are not
  `pointer`, so the hook classifies them as dead space. Add `data-no-dismiss` to the element or an
  ancestor. `cursor-grab` also OVERRIDES an inherited `cursor-pointer`, so a clickable row's
  exemption does not reach its own drag handle.
- `.xterm` is excluded by selector rather than by wrapper, because xterm's CSS sets `cursor: text` on
  `.xterm` and `default` on `.xterm-viewport` - neither candidate hit target is `pointer`.

### 3. Hover must not promise what the click will not do

An element that lights up on hover but dismisses is a lie: it advertises an action and then closes
the window instead. Resolve it in whichever direction is true, and never by reading the cursor back
to decide dismissal (that would make styling silently change behavior):

| What it actually is | Fix |
|---|---|
| A clickable div missing `cursor-pointer` | add `cursor-pointer` - it then acts AND is auto-excluded |
| A drag handle / resizer | add `data-no-dismiss`; its real cursor stays |
| Hover polish on space that is not an action | remove the hover classes, or move them onto the child that does act |

## Enforcement (self-maintaining)

- **Test (action cursors):** `tests/unit/light-dismiss-action-cursor.test.ts` fails on any renderer
  file using an action cursor without `data-no-dismiss` / `data-task-id` /
  `data-dismissable-layer`, unless it is portal-protected or carries a
  `// light-dismiss-ok: <reason>` marker. It also pins that the pointer-cursor heuristic and the
  `.xterm` exclusion still exist, since its own scope assumes both. Runs in CI via
  `npm run test:unit`.
- **Test (scope markers):** `tests/unit/window-layer-isolation.test.ts` pins the four marker sites,
  fails on a bare unscoped `data-dismiss-layer`, and fails if the retired `data-dismiss-surface`
  returns. The site list is what stops the bare-attribute scan passing vacuously if a marker is
  deleted - under a denylist, a MISSING marker silently disables background-close for that layer.
- **Test (behavior):** `tests/ui/window-click-outside-close.spec.ts` covers the regions that dismiss,
  the exclusions that hold, and the fail-safe (open the settings panel, click its dead space, assert
  the window beneath survives). `tests/ui/window-light-dismiss-terminal-panel.spec.ts` exercises the
  `.xterm` and pane-wrapper exclusions separately so neither masks the other.
- **Review:** `/code-review` flags a new overlay mounted inside the shell subtree and a new hover
  affordance on dismiss space.

**Mechanical coverage is deliberately incomplete, and this is the gap:** "every overlay mounts
outside the scope subtree" and "no hover class promises what the click will not do" both need the
runtime tree to decide, so neither is statically expressible. The UI specs and review are the guard
for those; do not assume the unit scans cover them.

## Scope

Renderer light dismiss under `src/renderer/`. The `window-manager/`, `dialogs/task-detail/`, and
`command-bar/` trees are exempt from the action-cursor rule, because they render under body-level
hosts stamped `data-window-layer-root` and are excluded wholesale.

`pop-out/**` is NOT exempt from the scope rule: a pop-out is a separate `BrowserWindow` document,
but `PopOutMonitorRoot` mounts `MonitorDetailLayer`, which mounts the hook, so that window needs
its own scope root (above). Only the action-cursor scan skips the tree.

Does not govern the `windowLightDismiss` POLICY (how many windows a qualifying click closes), which
is the pure resolver in `window-manager/light-dismiss/resolve-targets.ts`.

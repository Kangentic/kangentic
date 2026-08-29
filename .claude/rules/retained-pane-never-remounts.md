---
paths:
  - "src/renderer/window-manager/**"
  - "src/renderer/components/browser/**"
  - "src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx"
  - "src/renderer/hooks/useProjectSwitchEffect.ts"
---
# Rule: a retained Browser pane must never remount

An Electron `<webview>` guest dies the instant its DOM node is unmounted or moved. That is why a
task-detail window whose Browser pane is open is kept mounted and hidden instead of being
removed, in two cases that share one mechanism and one predicate (`isWindowDormant` in
`window-manager/store/types.ts`):

- RETAINED across a project switch (`ManagedWindow.retainedProjectId`), so the agent in the
  backgrounded project can keep driving its own pane.
- PARKED when the user closes the window while the task's agent session is live and its pane is
  mounted (`ManagedWindow.parked`), so reopening the task re-attaches the SAME guest: its
  `sessionStorage`, in-memory app state, and the agent's surface handle all survive. Before
  parking, a close destroyed the guest and main handed the page off to an offscreen lane, a fresh
  document; reopening built another; an app whose auth lives in `sessionStorage` logged the
  agent out twice per close.

In both cases the window stays in the `windows` map and keeps rendering at its existing position,
invisible and inert.

A third case hides the PANE inside a visible window: HELD (`browserHeldTasks` in the session
store) when the user puts the pane away with the Browser pill, its shortcut, or by opening Changes /
the Description peek over it while the agent is live. The pane stays mounted in its own fixed slot
of the split row (`browserSlot`), absolutely positioned at zero opacity behind the full-width
terminal, and showing it again is a style change. Only `toggleBrowserOpen` holds; an agent's
`close_pane` and hydration call `setBrowserOpen(taskId, false)` without `hold` and DISCARD. A held
pane counts as mounted for parking and retention, and the park reaper releases the hold when the
session stops.

The failure mode is silent. A remounted pane looks identical on screen and in the DOM: same
element, same URL, same everything. What is gone is the guest's identity, and with it the agent's
CDP session. Two separate causes were found by live testing, neither visible to any DOM-presence
assertion:

- The pane resolved its task URL against the OPEN board's project instead of its own, found
  nothing, fell back to the empty state, and unmounted itself.
- A URL refetch flipped `useBrowserUrl` back to `loading` for one commit. Child effects run
  before parent effects, so this happened BEFORE the window was marked retained, and the pane
  was torn down and rebuilt with a new `webContentsId`.

## The rule

- **Never re-parent a pane.** `WindowLayer` renders windows in stable insertion order and stacks
  purely by `zIndex`. Do not "tidy" retained windows into a separate container, list, or portal;
  leaving the entry in the map is the entire mechanism.
- **A dormant window's render tree must not change shape.** Style changes are free. Adding,
  removing, or reordering an element ABOVE `BrowserPane` is not: React matches the fixed JSX
  children of `TaskDetailBody`'s split row by index, so a shifted index remounts the pane. The
  terminal is dropped by swapping the CHILD (`{dormant ? null : <TerminalTab/>}`), never by
  dropping its wrapping elements. The Browser pane has its OWN slot in that row (`browserSlot`),
  distinct from the slot Changes and the Description peek share, so hiding the pane or opening
  another panel over it restyles the slot and never moves `BrowserPane` between children.
- **The store is the mechanism; the board layer is the policy.** `parkWindow` / `unparkWindow`
  hide and revive; `closeWindow` is the unconditional DROP. Every USER close (the X, Escape, light
  dismiss, middle-click) converges on `WindowFrame`'s exit-animation `onClose`, which asks the
  layer's `shouldParkOnClose` (`bridge/window-parking.ts`: an open Browser pane on a task with a
  running session). A direct `closeWindow` caller is declaring a deliberate drop (displacement to
  another host, the task leaving the board, the reaper that ends a park when the pane closes or
  the session stops), and must be listed in `tests/unit/window-parking-close-paths.test.ts`.
- **A parked window is closed as far as everything but the guest is concerned.** It leaves
  `order`, cannot be focused (`focusWindow` refuses), holds no terminal claim, registers no
  closer, does not own its detail, and the board's `detailTaskId` mirror treats it as gone (so a
  second click on the same card un-parks it instead of being swallowed as "no change").
  `applyWorkspace` never adopts it: a restored copy of a parked anchor is dropped, and
  `releaseRetainedWindows` on return clears the retention a parked window picked up on the way
  out.
- **A pane's project is the TASK's, not the open board's.** Use `retainedProjectId ?? projectId`
  wherever the pane's project is needed (registry registration, the task-URL sidecar, the pop-out
  instance key). The host context supplies whichever board is currently open, which is wrong for
  every retained window.
- **A refetch never tears down a live pane.** Once a URL has resolved, `useBrowserUrl` must not
  return to `loading`, and a refetch that finds nothing must not blank an already-showing pane.
- **Retention is invisible, not absent.** Hide with `opacity: 0`; NEVER `visibility: hidden` and
  never offscreen positioning. Both stop the guest compositing, which makes
  `Page.captureScreenshot` hang forever and wedges that guest's CDP queue (measured on Electron
  41; an `opacity: 0` subtree composites normally). See [[browser-automation-driver]].
- **Dormant windows stay out of shared state that belongs to the open project:** the serialized
  workspace (or they persist into another project's layout blob, or a parked window restores
  visible), the tile tree (or a leaf outlives the tree `applyWorkspace` replaces), the reported
  detail-ownership set, the terminal claim set (`dialogSessionIds`), light-dismiss targets, focus
  reconcile, and the dictation target. Read `isWindowDormant` for all of these; never spell the
  two flags out separately.

## Enforcement (self-maintaining)

- **Test (identity, load-bearing):** `tests/ui/browser-pane-registration.spec.ts` asserts the
  registered `webContentsId` is unchanged and that no unregister carries it (across a zoom
  broadcast and a session rotation), and `tests/ui/browser-pane-park-on-close.spec.ts` asserts
  the same across a close and reopen: the parked window keeps its id, its webview element, and
  its guest, and un-parks in place. `tests/ui/browser-pane-hold-on-hide.spec.ts` asserts it
  across a pill hide and show, across Changes opening over the pane, and that the hold parks on
  close, ends when the session stops, and yields to an agent's `close_pane`. These are the only
  assertions that separate "survived" from "silently replaced"; a DOM-presence check passes
  against a brand-new guest.
- **Test:** `tests/unit/window-retention.test.ts` pins the store contract: retention and parking
  are markings that keep the window's id, `applyWorkspace` ADOPTS a retained window rather than
  duplicating or replacing it and never adopts a parked one, dormant windows are excluded from
  serialization and from ownership, and retaining or parking untiles.
- **Test:** `tests/unit/window-parking-close-paths.test.ts` pins that every direct `closeWindow`
  caller is a listed deliberate drop, that `WindowFrame` consults `shouldParkOnClose`, and that the
  board layer supplies the policy and mounts the reaper.
- **Test:** `tests/unit/browser-screenshot-timeout.test.ts` bounds the non-composited capture, so
  a mis-hidden pane degrades to an actionable error instead of a hung tool call.
- **Review:** `/code-review` should flag any new conditional ABOVE `BrowserPane` in the
  task-detail tree, and any new consumer of the host `projectId` on the pane path.

The tree-shape rule is the one part with no mechanical guard, because "this conditional shifts a
sibling index" is not statically detectable. The identity assertion above is its backstop: it
fails the moment a remount is introduced, whatever caused it.

## Scope

The dormant-window path: the board window manager, `BrowserPane` and its URL hook, the
task-detail split row, the project-switch effect that applies retention, and the board-layer
park policy and reaper. Command Terminal and Monitor layers never set `retainedProjectId` or
`parked`; retention and parking are board-layer only.

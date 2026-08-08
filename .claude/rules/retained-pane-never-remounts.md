---
paths:
  - "src/renderer/window-manager/**"
  - "src/renderer/components/browser/**"
  - "src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx"
  - "src/renderer/hooks/useProjectSwitchEffect.ts"
---
# Rule: a retained Browser pane must never remount

An Electron `<webview>` guest dies the instant its DOM node is unmounted or moved. That is why a
task-detail window whose Browser pane is open is RETAINED across a project switch (marked with
`ManagedWindow.retainedProjectId`) instead of being closed: the window stays in the `windows` map
and keeps rendering at its existing position, invisible and inert, so the agent in the
backgrounded project can keep driving its own pane.

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
- **A retained window's render tree must not change shape.** Style changes are free. Adding,
  removing, or reordering an element ABOVE `BrowserPane` is not: React matches the fixed JSX
  children of `TaskDetailBody`'s split row by index, so a shifted index remounts the pane. The
  terminal is dropped by swapping the CHILD (`{retained ? null : <TerminalTab/>}`), never by
  dropping its wrapping elements.
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
- **Retained windows stay out of shared state that belongs to the open project:** the serialized
  workspace (or they persist into another project's layout blob), the tile tree (or a leaf
  outlives the tree `applyWorkspace` replaces), and the reported detail-ownership set.

## Enforcement (self-maintaining)

- **Test (identity, load-bearing):** `tests/ui/browser-pane-registration.spec.ts` asserts the
  registered `webContentsId` is unchanged and that no unregister carries it. This is the only
  assertion that separates "survived" from "silently replaced"; a DOM-presence check passes
  against a brand-new guest.
- **Test:** `tests/unit/window-retention.test.ts` pins the store contract: retention is a marking
  that keeps the window's id, `applyWorkspace` ADOPTS rather than duplicates or replaces,
  retained windows are excluded from serialization and from ownership, and retaining untiles.
- **Test:** `tests/unit/browser-screenshot-timeout.test.ts` bounds the non-composited capture, so
  a mis-hidden pane degrades to an actionable error instead of a hung tool call.
- **Review:** `/code-review` should flag any new conditional ABOVE `BrowserPane` in the
  task-detail tree, and any new consumer of the host `projectId` on the pane path.

The tree-shape rule is the one part with no mechanical guard, because "this conditional shifts a
sibling index" is not statically detectable. The identity assertion above is its backstop: it
fails the moment a remount is introduced, whatever caused it.

## Scope

The retained-window path: the board window manager, `BrowserPane` and its URL hook, the
task-detail split row, and the project-switch effect that applies retention. Command Terminal and
Monitor layers never set `retainedProjectId`; retention is board-layer only.

---
paths:
  - "src/main/pop-out/**"
  - "src/shared/pop-out.ts"
  - "src/main/index.ts"
  - "src/renderer/pop-out/**"
---
# Rule: pop-out surfaces go through the registry

The pop-out window engine lets a registered UI surface (usage stats, git changes, the task
Browser pane) detach into its own OS-level `BrowserWindow`. It stays a small, declarative system
only if every surface and every window-creation site funnels through the same two registries -
otherwise each new detachable surface becomes a bespoke multi-window rewrite, and a stray
`new BrowserWindow` bypasses the bounds persistence, broadcast fan-out, and synchronous-shutdown
teardown the engine already handles centrally.

This is distinct from `src/renderer/window-manager/` (movable DOM windows inside the single
`BrowserWindow` - task-detail and Command Terminal). Do not extend that system to cover OS-level
pop-outs, and do not conflate the two layers.

## The rule

- **Every OS `BrowserWindow` is created in exactly one of three places:** the main window in
  `createWindow()` (`src/main/index.ts`), a pop-out window in
  `src/main/pop-out/pop-out-window-manager.ts`, or an offscreen browser LANE in
  `src/main/browser/browser-lane-manager.ts` (a headless surface an agent drives; see
  [[browser-automation-driver]]). No other file may call `new BrowserWindow(`.
- **Every such site is also torn down when the MAIN window goes away.** Creation parity is not
  the property that matters on its own: Electron fires `window-all-closed` only at window-count
  zero, so any surviving window silently prevents `app.quit()`, which means `before-quit` never
  fires and `syncShutdownCleanup` never runs - PTYs unkilled, session records unsuspended, DBs
  unclosed, and on Windows the invisible orphan keeps the single-instance lock so the next launch
  exits at once. Pop-outs are swept in the main window's `close` handler; lanes in its `closed`
  handler, because destroying the window tears down its `<webview>` guests, which can trigger the
  lane hand-off and construct a NEW lane after `close` handlers have already returned. A fourth
  construction site needs a teardown of its own, in whichever of the two the same reasoning picks.
- **Every `PopOutKind` has a shared metadata entry** in `POP_OUT_SURFACES`
  (`src/shared/pop-out.ts`): title, default bounds/min size, `needsWebview`, and the push
  `channels` fanned to that surface's open windows, plus optionally `resolveTitle` (a
  per-instance OS/taskbar title derived from params, read via `resolveSurfaceTitle` by both
  processes), `maxInstances` (a kind-wide window cap, enforced in
  `PopOutWindowManager.open()`, which returns null at the cap and whose IPC handler resolves
  `false`), and `openMaximized` (with no saved bounds yet, open maximized; a user
  resize/move/maximize persists via `popOutBounds` and wins from then on). This is the single
  source both processes read - the main-side window manager for bounds/webview config, the
  renderer for its fan-out declaration.
- **Every `PopOutKind` has a matching renderer registry entry** (`SurfaceDescriptor` in
  `src/renderer/pop-out/surface-registry.ts`, registered via `registerSurface()` in
  `src/renderer/pop-out/surfaces/index.ts`): a root component, a minimal `bootstrap()` (load only
  what the surface consumes, not the full `App.tsx` bootstrap), an `hmrResync()`, and the in-app
  surface it is mutually exclusive with (`inAppSurface`, or `null` for an additive surface - see
  the carve-out below).
- **Every declared fan-out channel is a real `IPC` constant.** A typo silently drops that push
  instead of erroring.
- **Strict mutual exclusivity - for surfaces that HAVE an in-app counterpart.** When such a
  surface's pop-out window is open (`usePopOut(kind, params).isOpen`), the in-app form (overlay /
  dialog / embedded pane) must not also be mounted. Guard the in-app mount site and add a
  `<PopOutButton kind=... params=.../>` to its header/toolbar.

  **Carve-out: an ADDITIVE surface declares `inAppSurface: null`.** `changes-file` is a detached
  read of ONE file's diff, opened FROM the inline diff pane - suppressing that pane would defeat
  the surface, so it has no exclusive in-app counterpart and its origin stays mounted while its
  windows are open. Because an additive surface can hold many windows at once (its instance key
  carries a `filePath` segment), it must declare a main-side `maxInstances` cap instead of
  relying on singleton-per-key behavior; the cap lives in `PopOutWindowManager.open()` because a
  pop-out renderer never receives `popOut:changed` and cannot count its siblings.
- **Task-scoped surfaces resolve their own data from `params`** (`{ taskId, projectId }`), never
  from ambient ` currentProject`/`currentTask` state - a pop-out window is a separate renderer
  process with its own stores.

## Enforcement (self-maintaining)

- **Test:** `tests/unit/pop-out-surface-registry.test.ts` scans `src/main` for `new BrowserWindow(`
  outside the two sanctioned files, asserts the shared-meta `PopOutKind` set matches the renderer
  registry's registered set, and asserts every declared `channels` entry is a member of
  `Object.values(IPC)`. Runs in CI via `npm run test:unit`.
- **Test:** `tests/unit/hmr-resync.test.ts` covers the renderer half of Pattern B/E for
  `pop-out-store.ts` (the store mirroring which windows are open).
- **Review:** `/code-review` flags a new `new BrowserWindow(` outside the manager, or a new
  in-app surface added without its mutual-exclusivity guard.

## Scope

The pop-out window engine: `src/main/pop-out/**`, `src/shared/pop-out.ts`,
`src/renderer/pop-out/**`, and the pop-out-specific edits to `src/main/index.ts`
(`createWindow()`'s `configure()` call and the main-window `close` handler). Does not cover the
in-app DOM window manager (`src/renderer/window-manager/`), which is a separate, unrelated system.

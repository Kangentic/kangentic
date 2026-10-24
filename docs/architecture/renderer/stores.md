---
type: Reference
title: Zustand stores
description: "The renderer's Zustand stores: BoardStore optimistic moves, move generations, lane pins and the move-confirm queue, SessionStore dialogSessionIds terminal ownership and project-switch cleanup, ConfigStore theme and agent inventory, Backlog and Toast stores, and the HMR instance pins."
tags: [renderer, zustand, stores, hmr]
sources:
  - resource: src/renderer/stores/board-store.ts
  - resource: src/renderer/stores/board-store/automations-slice.ts
  - resource: src/renderer/stores/board-store/lane-pin-slice.ts
  - resource: src/renderer/stores/board-store/task-move-confirm-slice.ts
  - resource: src/renderer/stores/board-store/task-completion-slice.ts
  - resource: src/renderer/stores/session-store.ts
  - resource: src/renderer/stores/session-lifecycle-hooks.ts
  - resource: src/renderer/stores/config-store.ts
  - resource: src/renderer/stores/project-store.ts
  - resource: src/renderer/stores/backlog-store.ts
  - resource: src/renderer/stores/toast-store.ts
---
# Zustand stores

All stores in `src/renderer/stores/`. They call `window.electronAPI.*` for IPC and manage local UI state.

## BoardStore (`board-store.ts`)

State: `tasks`, `swimlanes`, `automations`, `automationsLoaded`, `archivedTasks`, `loading`, `completingTask`, `completingTaskIds`, `completionGates`, `recentlyArchivedId`, `lanePins`, `pendingMoveConfirms` (with `pendingMoveConfirm` as its head)

- **Optimistic updates** -- all mutations update UI immediately, then sync via IPC. Errors revert via full `loadBoard()`.
- **Stale move protection** - per-task `moveGenerations` counters prevent older async reloads from clobbering newer moves of the same task.
- **Lane pins** - `loadBoard()` has no staleness guard and `taskContentsMatch` compares `swimlane_id`, so a `tasks.list()` issued before a move's DB write reverts the optimistic lane when it resolves. A `lanePins` entry holds the card at its destination until a payload reports the task at neither the pre-move lane nor the pre-move `updated_at`. Read only at `KanbanBoard`'s `tasksPerLane`, the same chokepoint as `completingTaskIds`; every task payload applies through `applyTaskListPayload` so the reconcile is atomic with the write. See `.claude/rules/board-completing-task-chokepoint.md`.
- **Move confirmations queue** - `pendingMoveConfirms` is FIFO. As a single slot, a second confirmation overwrote the first, and that move had already returned `ok` without calling the IPC, leaving an optimistic placement no write backed.
- **Session cascade** -- after task move, reloads sessions to detect spawns/kills from transition engine. Auto-activates new sessions with toast notification.
- **Icon loading** - `loadBoard()` and `loadShortcuts()` await `ensureIcons()` before they publish swimlanes or shortcuts. The wait happens only when a persisted icon name is outside the core set (`CORE_ICONS` in `src/renderer/utils/icon-registry.ts`), so a stock board never loads lucide's full icon map and a project switch still paints each icon on its first frame.
- **Completion animation** -- `setCompletingTask()` mounts the FlyingCard with the captured drop rect; a per-task completion gate joins the fly finishing (`markCompletionAnimationDone`) and the move being approved (`approveCompletion`, after a clean worktree probe or a confirmed dialog), and `persistCompletion` runs the actual move once both signals land.
- **Automations** (`board-store/automations-slice.ts`) -- `loadAutomations()` fetches every column's list, `replaceAutomationsForColumn()` writes one column's whole list and re-reads, and `runAutomationAgain()` re-runs one row for the failure toast's Run again and returns the result. `selectAutomationCounts(swimlaneId, reportsTurnEnd?)` derives the runnable enter, turn-end and exit counts the rail, the board glyph and the overview all read, so the same number cannot mean three things.

## SessionStore (`session-store.ts`)

State: `sessions`, `activeSessionId`, `detailTaskId`, `dialogSessionIds`, `sessionUsage`, `sessionActivity`, `sessionEvents`

- **Terminal ownership handoff** -- `dialogSessionIds` (a string array) lists every session owned by an open task-detail window, so the bottom panel never renders an xterm for a session a window already owns (one xterm per PTY). It replaced the scalar `dialogSessionId` once task detail became modeless and multiple windows can stack. When a window claims a session, the panel unmounts that session's xterm; on release, the panel recreates from scrollback. The array is renderer-GLOBAL, not per-layer: `useWindowSessionClaims` reconciles it across every window-manager instance in the renderer (`allWindowManagers` - board, Command Terminal, Agent Monitor), resolving each window's taskId through its manager's `anchorToTaskId` since the board anchors by taskId and the monitor by `projectId:taskId`. A reconciler that walked one layer would treat the other layers' claims as stale and erase them, putting a second xterm on a live PTY.
- **HMR store re-sync** -- The `vite:afterUpdate` handler in `App.tsx` re-fetches all IPC-backed stores (project, config, board, session) after Vite HMR replaces modules. For the instance-pinned stores (Pattern E) it reconciles the pinned instance with main-process truth, and for any unpinned store it restores the state the store lost by reverting to defaults. A unit test (`hmr-resync.test.ts`) enforces that new stores are included. Usage and events are scoped to the current project; activity is fetched unscoped so sidebar badges work across all projects.
- **HMR instance pin (Pattern E)** - The store instance is pinned in `import.meta.hot.data.sessionStore`, so a re-eval (usually a `session-store/` slice edit) cannot hand part of the tree a second, empty store. Re-sync alone could not cover renderer-only state that no `load*` call restores: the browser-pane sets reading empty for one commit unmounted every live `<webview>`. It pins WITHOUT self-accepting, unlike the other Pattern E stores, because it sits in an import cycle (session-store -> the arrival-focus arbiter -> dictation-target -> session-store) and Vite turns an `invalidate()` from inside a cycle into a full page reload. The separate `project-store` <-> `session-store` cycle was broken outright via `stores/session-lifecycle-hooks.ts` and is guarded by `tests/unit/renderer-store-import-cycles.test.ts`. Measure any change here with `scripts/hmr-guest-probe.mjs`. See `.claude/rules/hmr-patterns.md`.
- **Project switch cleanup** -- On project switch, `activeSessionId`, `dialogSessionIds`, `detailTaskId`, `sessionUsage`, and `sessionEvents` are cleared before re-syncing. A generation counter invalidates in-flight syncs from the previous project. `sessionActivity` and `sessions` are preserved for sidebar badge rendering. After sync completes, any `_pendingOpenTaskId` (set by notification click) is applied and cleared.
- **Event capping** -- max 500 events per session to bound DOM size in ActivityLog.
- **Queue position** -- `getQueuePosition()` returns 1-indexed position sorted by startedAt.

## ConfigStore (`config-store.ts`)

State: `config` (AppConfig), `globalConfig`, `appVersion`, `agentList`, `gitInfo`, `settingsOpen`, `projectOverrides`

- **Theme subscription** -- resolves the shown theme (the Theme tab's hover preview if one is resting, else `resolveTheme(config, systemPrefersDark)`: the hand-picked `theme`, or with `themeFollowsSystem` on, the pair member for the OS side read off `prefers-color-scheme`), swaps the `theme-*` class on `<html>` (no class for `dark`), and mirrors the RESOLVED committed theme, never a preview, to `localStorage` to seed the next launch's FOUC guard. A media-query listener keeps `systemPrefersDark` live, so a follow-system install repaints when the OS flips with no restart or config write.
- **App version** -- `loadAppVersion()` fetches the Electron app version via IPC on mount, and again in the `vite:afterUpdate` re-sync.
- **HMR instance pin (Pattern E)** - The store instance is pinned in `import.meta.hot.data.configStore` and self-accepts, which is safe because config-store sits in no import cycle. Unpinned, a re-eval (an edit to it, `announcements-store`, `project-cache`, or the shared modules it imports) built a second store whose `appVersion` was never loaded, so the status bar dropped its version pill while the devtools mirror and the pinned stores importing it kept the first. The theme and `no-motion` subscriptions and the OS appearance listener are released in the module's one dispose so they do not stack on the pinned instance, and `workspaceSeeded` now survives HMR, so the post-HMR `loadConfig()` keeps the renderer's live `workspaceByProject`, `commandTerminalWorkspace` and `commandTerminalPanel` (`monitorWorkspace` is still re-read from disk, since the monitor pop-out also writes it). `saveCommandTerminalPanel` writes the panel's place optimistically into both `config` and `globalConfig` before its `config:set`, so a move or resize never snaps back while the write is in flight. See `.claude/rules/hmr-patterns.md`.
- **Agent inventory** - `loadAgentList()` fetches main's agent inventory into `agentList`, per-agent found/path/version/displayName (`AgentDetectionInfo[]`); consumers look up their own agent's entry rather than reading a single Claude-only detection result. Main builds it by probing every registered adapter and caches it until an agent-config change or a forced refresh (`src/main/agent/agent-list.ts`). `updateConfig` reloads it, unforced, when `agent` or `discoveredModelsByAgent` is written, and main labels telemetry-learned model ids on each call (`nameLearnedModels`).
- **Git detection** -- `detectGit()` checks for git installation, version, and minimum version requirement.
- **Project overrides** -- `loadProjectOverrides()` and `updateProjectOverride()` manage per-project config overrides by filesystem path. A write goes to the project the Settings panel is editing (`projectSettingsPath`) unless the caller passes an explicit target path, which a handler that awaits before it writes captures at the gesture so a project-switcher move cannot redirect it.

## ProjectStore (`project-store.ts`)

State: `projects`, `currentProject`, `loading`

Standard CRUD. `setDefaultAgent()`, `setDefaultModel()`, and `setDefaultEffort()` write a project's defaults and apply main's returned row to both `projects` and `currentProject`, because `openProject()` copies its row from the list. `openProject()` triggers main process initialization (DB open, worktree pruning). Session recovery and reconciliation run in the background (fire-and-forget) so the board renders immediately; sessions appear reactively as PTYs come online via IPC status events.

## BacklogStore (`backlog-store.ts`)

State: `items`, `loading`, `selectedIds`

- **CRUD + bulk operations** -- `createItem()`, `updateItem()`, `deleteItem()`, `bulkDelete()`, `reorderItems()`.
- **Optimistic reorder** -- `reorderItems()` reorders locally first, then syncs via IPC. Errors trigger a full `loadBacklog()` reload.
- **Promote/demote** -- `promoteItems()` optimistically removes items from the backlog, calls IPC (which returns after DB work but before agent spawn), then reloads the board. On failure, removed items are restored and a toast error is shown. `demoteTask()` adds the returned backlog item locally and reloads the board.
- **Label management** -- `renameLabel()` and `deleteLabel()` update labels across all items via IPC, then reload both the backlog and the board (since promoted tasks share label data).
- **Selection** -- `toggleSelected()`, `selectAll()`, `clearSelection()` manage a `Set<string>` of selected item IDs for bulk actions.

## ToastStore (`toast-store.ts`)

State: `toasts` (max 5)

Ephemeral notifications with auto-dismiss. Called by other stores for success/error feedback.

---
type: Reference
title: App IPC channels
description: "The remaining IPC channels: config, keybindings, mobile bridge, git and diff watching, shell, window, pop-out, Browser pane, clipboard, updater, GPU health, host memory, leftover processes, announcements, diagnostics, dictation and the dev-only preview channels."
tags: [ipc, channels, config, git, browser]
sources:
  - resource: src/shared/ipc-channels.ts
    title: IPC channel constants
  - resource: src/main/ipc/handlers/git-diff.ts
  - resource: src/shared/pop-out.ts
    title: PopOutKind and the pop-out window params
  - resource: src/main/pop-out/pop-out-window-manager.ts
    title: Pop-out window lifecycle
  - resource: src/main/ipc/helpers/task-windows.ts
    title: Closing a task's windows when its work ends
---
# App IPC channels

## Dev-only (preview)
Build-excluded from production via `__KANGENTIC_DEV__` (esbuild dead-code elimination); present only in `npm start` and `/preview` builds, never in shipped installers. Registered from `src/devtools/`, so it is not counted in any group's channel count below.

| Channel | Pattern | Purpose |
|---------|---------|---------|
| `dev:createEphemeralProject` | invoke | Clone the current worktree into an isolated, throwaway preview project (TestHarness "Create Project" button); fills its working tree in the background and returns the usable `Project` |
| `dev:seedGitChanges` | invoke | Seed a realistic all-scopes / all-statuses git changeset (committed, staged, working) into each ephemeral preview repo (active task worktrees plus the project) so the Changes tab has content to exercise; silently skips any path outside the preview-projects root. Returns `DevSeedGitChangesResult` |
| `dev:seedLargeConversation` | invoke | Seed a throwaway task backed by a synthetic multi-thousand-turn Claude JSONL transcript (TestHarness "Seed Large Conversation" button; appends more turns on re-click) and open it in the Conversation viewer, for exercising the viewer's virtualization, in-viewer search, and open-at-position behavior against a realistic long transcript. Returns `DevSeedLargeConversationResult` |
| `dev:simulateLowMemory` | invoke | Read every host memory sample as low memory (`true`) or stop (`false`), so the low-memory pause runs in a preview without exhausting the machine (TestHarness "Simulate Low Memory" toggle). Turning it on evaluates the last sample at once |
| `dev:seedUsageData` | invoke | Seed days of realistic synthetic usage (sessions across several agents/models plus per-turn time series) into every registered project's usage ledgers via the real capture repositories, at descending volume per project (TestHarness "Seed Usage Data" button; appends another batch on re-click), so the usage dashboard has rich charts in a preview. Returns `DevSeedUsageDataResult` |
| `dev:seedKnowledgeGraph` | invoke | Seed a cluster-structured synthetic conversation corpus into the current project, hung off real tasks and session rows so provenance exists: the TestHarness "Seed Knowledge Graph" button's fallback when there is no real index to mirror. Vectors are written DIRECTLY rather than inferred, because real ONNX inference over hundreds of documents would take minutes before the Knowledge Graph showed anything, except for the newest `embeddingBacklog` chunks (1,000 by default), which are left for the embedding drain. Documents are drawn from planted topic clusters, so the map has a ground truth you can check by eye. Returns `DevSeedKnowledgeGraphResult` |
| `dev:seedKnowledgeGraphReal` | invoke | Mirror the real parent project's indexed conversations (chunks, vectors, index state, and the tasks and sessions they hang off) into the open preview project (TestHarness "Seed Knowledge Graph" button), so the Knowledge Graph shows a real corpus in a preview. `documentLimit` keeps only the most recent conversations; `sourceProject` (an id or a name, passed at run time) mirrors a different real project, which is how a second preview project is seeded to check the graph across projects; the newest `embeddingBacklog` chunks (1,000 by default) are copied without their vectors, so the embedding drain has real work the moment the map is built, and a count above the index's size leaves all of it pending, the backlog a model switch creates. The result's `modelTag` is the source's own; the harness then turns semantic search on with that model through the Settings panel's `updateConfig`, since a fresh preview has it off and the drain would otherwise never run. A tag no longer in the registry (vectors from a removed bge model) changes nothing, and semantic search stays off. Answers `{ unavailable }` when this machine has no real index to copy. |
| `dev:seedKnowledgeGraphDemo` | invoke | Register the web demo's sample install in the open preview as real projects, one per sample project at a repository with the History pane's history, writing the dataset's tasks and backlog and pointing each recorded session's row at its agent's own history, so main's indexer, embedding drain, and map pass build the demo's Knowledge Graph fixture. Driven by `scripts/capture-demo-knowledge-graph.mjs`; refuses a second seed into the same preview. Its second driver, `scripts/lib/demo-mcp-capture.mjs`, records an agent calling Kangentic's MCP tools: that plan also places each task in its column (`lane`), names each column's agent (`columnAgents`), and gives the recorded task its branch, base branch and worktree, and the result carries the project's MCP URL and the server's token (`mcpUrl`, `mcpToken`, null when the server is off). |

## Config (11 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `config:get` | invoke | Fetch effective AppConfig (global merged with project overrides, and the board's team-shared default base branch). An optional `projectId` reads another registered project's |
| `config:getGlobal` | invoke | Fetch global-only AppConfig (no project overrides) |
| `config:set` | invoke | Update global config (partial merge). Resolves `ConfigSetResult` (`{ persisted }`), which says whether the write reached disk. Only the settings panel acts on it: this channel also carries window layouts, model caches and announcement dismissals, so a failure here is not necessarily something a user asked for (Sentry DESKTOP-1C) |
| `config:setSync` | sendSync | Update global config synchronously (blocks the renderer until the fs write completes); used on window close to persist the workspace layout before the renderer tears down. Puts the same boolean on `event.returnValue`, which the preload bridge discards: there is no renderer left to tell |
| `config:getProject` | invoke | Fetch project-level config overrides |
| `config:setProject` | invoke | Update project-level overrides; resolves `ConfigSetResult` |
| `config:getProjectByPath` | invoke | Fetch project overrides by filesystem path |
| `config:setProjectByPath` | invoke | Update project overrides by filesystem path; resolves `ConfigSetResult` for a background project as well as the current one |
| `config:syncDefaultToProjects` | invoke | Sync default config values to all project configs. Returns a bare count rather than `ConfigSetResult`: one click writes one file per project, and the count already excludes the ones that failed |
| `config:changed` | on | Bare-signal event fanned to every window (main + open pop-outs) after any `config:set` is applied; subscribers re-fetch via `config:get` so theme/settings sync live across windows |
| `config:writeFailed` | on | Push to the main window only, not broadcast to pop-outs (they show toasts too, but this reports one app-wide condition once, and a broadcast would raise it in every open window): a synchronous write to the data directory failed, so the change applies to this session but will not persist. Carries the user-facing message, which names the cause when the errno gives one (disk full, no permission, read-only volume, drive unavailable). Latched per failing source in `src/main/config/write-failure-notice.ts`, so it fires at most once until a later write to that source succeeds (Sentry DESKTOP-14/DESKTOP-13, DESKTOP-1C) |

## Keybindings (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `keybindings:probeGlobal` | invoke | Probe whether each canonical combo can be claimed as a system-wide global shortcut (via Electron `globalShortcut`); returns `Record<combo, 'available' \| 'taken' \| 'unsupported'>`. Used by the Hotkeys settings tab to warn when a combo is already owned by the OS or another app. |

## Mobile Bridge (14 channels)
Machine-global (like Config), not project-scoped - backs the Mobile Devices settings tab. See [Mobile bridge overview](../../integrations/mobile-bridge/overview.md) for the pairing ceremony, roster, capability verbs, and relay transport this group fronts.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `mobile:getStatus` | invoke | Report bridge status: enabled, secure-storage availability, identity fingerprint, relay URL, relay transport state, paired device count, pairing-in-progress |
| `mobile:startPairing` | invoke | Mint a pairing token, connect the pairing relay slot, and return the QR payload URI. Supersedes a stale in-progress ceremony rather than throwing |
| `mobile:cancelPairing` | invoke | Cancel an in-progress pairing ceremony |
| `mobile:listDevices` | invoke | List paired devices (id, display name, capabilities, paired-at, live connection state and the time it last changed) |
| `mobile:revokeDevice` | invoke | Revoke a paired device: drop it from the signed roster and tear down its session |
| `mobile:renameDevice` | invoke | Rename a paired device (re-signs the roster entry, preserves paired-at) |
| `mobile:setDeviceCapabilities` | invoke | Update a paired device's granted capability verbs (re-signs the roster entry); no longer surfaced as settings-tab UI, kept as the enforcement/future-preset seam |
| `mobile:testRelay` | invoke | Reachability probe for a candidate relay URL ("Test connection"); validates server-side and never throws |
| `mobile:pairingSas` | on | Event: the SAS digits to display for the current pairing ceremony (no emoji) |
| `mobile:pairingConfirmed` | on | Event: the phone's sealed confirm frame opened and the device was auto-enrolled, with its deviceId and phone-supplied display name |
| `mobile:pairingEnded` | on | Event: pairing ended with a reason and a `kind` (`'cancelled'` \| `'failed'`); the desktop only surfaces a message for `'failed'` (mismatch, timeout, handshake error) - a plain cancel is already obvious from the UI returning to idle |
| `mobile:stateChanged` | on | Event: status or device list changed (pairing confirmed/revoke/capability update) |
| `mobile:getTerminalStreams` | invoke | The set of session ids a phone is streaming a terminal for - the set the bottom panel suspends its own terminals for. Seeds a renderer that mounts after the phone already subscribed (app start with a connected phone, window reload) |
| `mobile:terminalStreamsChanged` | on | Event: the phone-streamed session id set changed; keeps the renderer's copy current between seeds |

## Notifications (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `notification:show` | send | Show native OS notification (task name + project name) |
| `notification:clicked` | on | User clicked a notification (includes projectId, taskId) |

## Shell (6 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `shell:getAvailable` | invoke | List available shells |
| `shell:getDefault` | invoke | Get default shell |
| `shell:openPath` | invoke | Open directory in file explorer |
| `shell:openExternal` | invoke | Open URL in default browser (http/https/mailto only; other schemes are rejected) |
| `shell:showItemInFolder` | invoke | Reveal a file or directory in the native file manager (Explorer on Windows, Finder on macOS); the path is normalized to platform separators before dispatch |
| `shell:exec` | invoke | Execute shell command |

## Fonts (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `font:getAvailable` | invoke | List detected system fonts (monospace-filtered when detectable) for the Terminal tab's Font Family picker |

## Git (16 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `git:detect` | invoke | Detect git installation (path, version, minimum version check) |
| `git:listBranches` | invoke | List branches for a repository: the open project's, or another registered project's by an optional `projectId` |
| `git:diffFiles` | invoke | List changed files with status and stats for a scope (working / staged / branch), for a single commit (`<oid>^..<oid>`) when `commitOid` is set, or for a completed task's whole change when `range` (`{ base, head }`, two full object ids) is set. Precedence is `commitOid`, then `range`, then `scope`. A `commitOid` or range end that is not a hex object id is refused before git runs |
| `git:fileContent` | invoke | Fetch original and modified file content for diff display (per scope, for a single commit when `commitOid` is set, or between the two commits of `range`, reading `base:<path>` and `head:<path>` with no working tree involved). A `filePath` or rename `oldPath` that is absolute, drive-relative, or holds a `..` segment, or a `commitOid` or range end that is not a hex object id, is refused before any read and returns empty text, as `git:fileImage` refuses it with unreadable sides |
| `git:taskChanges` | invoke | What a completed task changed, read from git alone (`src/main/git/task-changes.ts`), for the completed view's Changes tab, its Summary's commit and file rows, and its header strip. Takes `{ projectId, taskId }` and reads the task row (archived included). Resolves, in order: the task's linked commits when they form one run on the base's first-parent history (a range `oldest^..newest`, tried first because a rebase merge leaves the branch on pre-rebase hashes); the linked commits on their own with the union of their files when they do not; the task's unmerged branch (head `refs/heads/<branch>` else `head_sha`, start the newest of the merge-base, `fork_point_sha` and the reflog's creation point). Returns the range, up to 300 commits newest first with `webUrl` stamped as `git:commitGraph` does, the files biggest change first (each carrying `newestCommitSha` when there is no range), totals when a range resolves, and an `emptyReason` (`no-commits`, `indexing-off`, `not-in-clone`) when there is nothing to show. Linked commits come from the retrieval worker's `task.knowledge`; a worker that is down with nothing else to show throws, so the tab offers Retry |
| `git:fileImage` | invoke | Fetch both sides of a changed raster image or SVG as bytes for the Changes panel's image view, with the same per-scope revisions as `git:fileContent`. Each side is fingerprinted and sized before its bytes are read: a side from git from the header of one `git cat-file --batch` process (`src/main/git/git-object-reader.ts`), a working-tree side from `stat`. A side whose fingerprint (its blob id, or a working-tree file's size and modified time) matches one the caller passes in `knownFingerprints` answers `unchanged` without bytes, so a diff refresh does not resend an image that did not change. A working-tree side read within 2 seconds of its last write gets a fingerprint marked racy, which never matches, so the next refresh reads it again. A side over 10 MB returns its size alone. A Git LFS pointer answers `lfs-pointer`, and a side that cannot be read (a refused path, a missing object or file, a failed read) answers `unreadable`; a refused or missing path is quiet and any other failure is logged. A separate channel because the mobile bridge forwards `git:fileContent`'s result to the phone as JSON |
| `git:diffSubscribe` | send | Subscribe to file-system watcher for live diff updates on a worktree (working tree plus git metadata). Refcounted per sender window, so N windows (the in-app panel, the detached Changes window, per-file diff windows) can watch one path; the underlying watch arms once |
| `git:diffUnsubscribe` | send | Release THIS window's subscription for a worktree; the watcher and merge-base cache are torn down only when the path's last subscriber leaves (a destroyed window releases its subscriptions automatically) |
| `git:diffChanged` | on | Debounced event fired when watched worktree files or git metadata change on disk |
| `git:checkPendingChanges` | invoke | Check whether a path has uncommitted or unpushed changes |
| `git:prefetchRemotes` | invoke | Warm the throttled all-remotes fetch for a worktree (fire-and-forget, non-interactive) so a following `checkPendingChanges` skips or joins it rather than starting its own; the board calls it when a worktree-backed card drag begins, and main skips it when the `git.autoFetch` switch is off |
| `git:branchSummary` | invoke | Lightweight branch summary for the Changes panel header: current branch and ahead/behind commit counts vs the base branch. It also returns the HEAD tip commit (hash, subject, timestamp), which the header no longer draws (History lists every commit). Cheap enough to run on every panel open and watcher fire. An optional `refreshRemote` flag makes the handler run the throttled all-remotes fetch first so `behind` reflects the actual remote; the panel passes it once per mount, never on watcher fires |
| `git:worktreeHead` | invoke | A checkout's live HEAD (`branch`, `sha`): two rev-parse calls, no fetch. `branch` is null on a detached HEAD or a git error and `sha` is null only on a git error, so the pair tells the two apart. The Command Terminal layer re-derives every window's branch pill from it on reattach and on every `git:diffChanged`. Unqueued, like `git:branchSummary` |
| `git:commitGraph` | invoke | Topo-ordered commit history (commits with parent links plus resolved tip / base / merge-base anchors) for the Changes panel's commit-history browser. Each commit the primary remote has (one bounded `git rev-list ... --not --remotes`) carries a `webUrl` built by the PR connector that claims that remote (`commitWebUrl`, GitHub or Azure DevOps), and the result names the host in `webProviderName`; a commit only this clone has gets none. Local-only and fail-safe, like `git:branchSummary` |
| `git:fileHistory` | invoke | Commits touching a single file (`git log --follow`), newest first, for the Changes panel's per-file history popover. Local-only and fail-safe |
| `git:blame` | invoke | Per-line blame (`git blame --line-porcelain`) - short hash, author, date per line of the file's current content - for the DiffViewer blame gutter. Local-only and fail-safe |

## Dialog (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `dialog:selectFolder` | invoke | OS folder picker. With options (Add project) it offers New folder and starts at `options.defaultPath`, else home. Without (relocate, locate) it starts at the parent of the last folder it returned, else home, because Electron 43 otherwise opens in Downloads. Returns the path, or null on cancel |

## Window (5 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `window:minimize` | send | Minimize the sending window (resolved via `BrowserWindow.fromWebContents(event.sender)`, so this operates on whichever window - main or a pop-out - actually called it) |
| `window:maximize` | send | Maximize/restore the sending window |
| `window:close` | send | Close the sending window |
| `window:flashFrame` | send | Flash the sending window's taskbar icon to attract attention |
| `window:isFocused` | invoke | Check if the sending window has focus (for the renderer's spawn-stall/plan-complete notification gating; the idle/crash desktop notifier resolves focus synchronously in main instead - see `src/main/notifications/desktop-notifier.ts`) |

## Pop-out Windows (6 channels)
Detach a registered UI surface (usage stats, git changes, a single changed file's diff, the task Browser pane, the Agent Monitor, the Knowledge Graph, a project's Command Terminal panel) into its own OS-level `BrowserWindow`. A surface's scope is global, task or project: `command-terminal` is the one project-scoped kind, keyed `command-terminal:<projectId>` and read back by `parseProjectPopOutInstanceKey`, with the project name in its params only as a boot seed for the window title. See `src/shared/pop-out.ts` for the surface registry (`PopOutKind`, params, per-surface push fan-out) and `src/main/pop-out/` for the window manager + broadcast helper. Distinct from the in-app DOM window manager (`src/renderer/window-manager/`), which tiles movable panes inside the single main `BrowserWindow`. Most kinds are singletons per instance key; `changes-file` is additive (one window per file, opened by double-clicking a Changes file row) with a main-side `maxInstances` cap and a cascade offset for each additional window of the kind. It opens maximized until the user resizes, moves, or maximizes one (that preference then persists per kind, like every pop-out; un-maximizing restores the default float). A task's windows (`changes`, `changes-file`, `browser`) also close when the task's work ends: a move to Done, a reset to To Do, a backlog demote, an unarchive into To Do, a delete (single, bulk, MCP, or a move to another project) and a project delete. Main closes them with `PopOutWindowManager.closeForTask`, through the same `close()` a user close runs, so `popOut:changed` and its close effects are identical. It runs after the task's sessions have ended, so a closing Browser window is never handed off to an offscreen lane, and before the process reap and the worktree removal. The same call destroys the task's offscreen lane (`closeTaskWindows` in `src/main/ipc/helpers/task-windows.ts`). A parked task keeps its windows: Pause, Stop and a column that starts no agent close nothing.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `popOut:open` | invoke | Open a surface's pop-out window (kind + params), or focus it if already open; resolves `false` when the kind's `maxInstances` cap refused the open (currently only `changes-file`) |
| `popOut:close` | invoke | Close a surface's pop-out window |
| `popOut:focus` | invoke | Focus (and restore if minimized) a surface's pop-out window |
| `popOut:isOpen` | invoke | Whether a surface's pop-out window is currently open |
| `popOut:listOpen` | invoke | List the instance keys of every currently-open pop-out window |
| `popOut:changed` | on | Event: the set of open pop-out windows changed; pushed to the main window only. Handled by `renderer/pop-out/pop-out-changed.ts`, which mirrors the set into `pop-out-store.ts` (so in-app triggers - title bar, headers - flip between "open" and "focus") and then applies the effects a window OPENING or CLOSING implies: a closed `changes` window leaves its task's inline Changes panel CLOSED rather than reclaiming the split; a `command-terminal` window opening hides that project's in-app panel, and closing it arms the pending-open flag so the panel comes back, but only while that project is current and still has a Command Terminal running. Those effects hang off this push and NOT off `pop-out-store.setOpen()`, which `popOut:listOpen` also drives on mount and on every HMR re-sync; `browser` masks its pane the same way but deliberately still reclaims on close |

## Analytics (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `analytics:trackRendererError` | send | Report a renderer-side error to main, with a `RendererErrorContext` (`boundary`, `panel?`) saying where it came from. See [Error reporting (Sentry)](../../telemetry/error-reporting.md). |
| `analytics:trackFeatureUsed` | send | Report one use of a curated adoption feature; main re-validates against `ANALYTICS_FEATURES` and dedups to once per feature per day. See [Usage analytics](../../telemetry/usage-analytics.md). |

## App (1 channel)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `app:getVersion` | invoke | Get Electron app version string |

## Clipboard (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `clipboard:readImage` | invoke | Read the native clipboard image through the async `clipboard.read()` (Electron 44 removed `readImage()`), cap its long edge at `IMAGE_LONG_EDGE_CAP`, prune stale `pasted-image-*` files from the temp directory (24h age limit, 40-file cap), save it to a temp file, returns file path, or null when the clipboard holds no image or the read fails |
| `clipboard:saveImage` | invoke | Save PNG bytes the renderer decoded from a dropped image (a format the agent CLI cannot attach from a path, such as bmp) into the same temp directory under the same cap and prune; returns the file path, or null when the bytes are not a decodable image or the write failed |
| `clipboard:writeText` | invoke | Write text to the native clipboard (focus-independent; used by terminal copy and the OSC 52 handler) |

## Browser pane (24 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `browser:captureSend` | invoke | Composite the embedded webview frame + draw overlay + picked element into a PNG, write it to the session captures dir, and submit a structured prompt to the agent's PTY via PasteEngine |
| `browser:urlGet` | invoke | Get the project default URL and per-task URL override for a given task. Takes a trailing `projectId` (the TASK's project, not the open board's) resolved via `resolveProjectContext`: a popped-out or retained pane outlives a project switch, so the ambient current project would route it to the wrong sidecar |
| `browser:urlSetTask` | invoke | Persist a per-task URL override. Same trailing `projectId` |
| `browser:urlClearTask` | invoke | Remove the per-task URL override (falls back to project default). Same trailing `projectId` |
| `browser:clearStorage` | invoke | Wipe cookies, localStorage, IndexedDB, service workers, and HTTP/auth caches across the project's task-keyed embedded browser partitions, its identity jar, and the legacy shared jar. Saved URLs are kept. |
| `browser:jarEnsure` | invoke | Sync a task's cookie jar with the project identity jar before the pane's guest attaches, so it opens already signed into shared non-localhost (IdP) sessions. Takes the pane's own `projectId` (no ambient fallback, since the pane's partition is computed from that same value) and never rejects; the renderer caps the wait at 3s |
| `browser:zoomChanged` | push | Broadcast the new zoom factor after Ctrl+wheel is applied in the main process (the webview's `zoom-changed` event lives on WebContents, not the DOM tag, so the renderer learns about wheel zoom only via this push). Carries the guest's `webContentsId` alongside the factor: one window can host several panes, and a factor-only broadcast made all of them adopt a zoom applied to just one |
| `browser:paneRegister` | invoke | Register an open Browser pane's guest webContents (taskId, sessionId, webContentsId, url) with the main-process pane registry so the `kangentic_browser_*` MCP tools can target it. The handler backfills `projectId` from the session registry rather than trusting the renderer's ambient current project, since that is the field cross-project scoping is enforced on |
| `browser:paneUnregister` | invoke | Unregister a Browser pane on unmount, keyed on the `webContentsId` that instance registered with. The registry is keyed on the guest, so this removes only that guest's entry: an out-of-order unmount between the in-app pane and its pop-out cannot clobber a newer registration for the same task, and a malformed id is a harmless no-op. The guest's own `destroyed` event is the backstop |
| `browser:paneUserClose` | invoke | The user's Close browser control, sent BEFORE the pane unmounts so the guest's surface handle retires with reason `user-closed`. That reason is deliberately outside the hand-off allowlist (`HANDOFF_REASONS`), so no offscreen lane is stood up to re-spend the memory the user just reclaimed; the agent's next call on the old handle gets `surface-gone` saying the user closed it. The unmount that follows unregisters a guest the registry no longer knows, which is a no-op |
| `browser:paneVisibility` | invoke | Renderer to main: where a registered pane currently sits on screen (`showing` / `hidden` / `parked`; lanes are `offscreen`). Only the renderer knows, since a pane can be held behind the terminal or parked with its window closed while its guest stays mounted and driveable. Surfaced to agents through `kangentic_browser_list_panes` and `kangentic_browser_open_pane` so a tool call can tell whether the user can see what it is doing |
| `browser:paneOpenRequest` | push | Main asking the renderer to open a task's Browser pane, behind `kangentic_browser_open_pane`. Pane open state is renderer-owned (`browserOpenTasks`), so main cannot set it directly. Fire-and-forget: main validates every precondition itself (the open project, the per-project `browser.enabled` gate, the task row, the URL it seeds first) and then awaits the pane REGISTRY rather than a reply, because only a registered live guest proves the pane is driveable |
| `browser:paneCloseRequest` | push | Main asking the renderer to close Browser panes, behind `kangentic_browser_close_pane`. Carries the taskIds main computed: each target pane's task, plus the task of every detached Browser window being closed, including one with no pane registered in it. Main sends it before closing any window, because closing a detached window docks it back and would re-mount the in-app pane. The renderer must not re-derive them, since `browserOpenTasks` is not project-keyed and the board store holds only the open project's tasks, so a retained backgrounded pane would be invisible to a board lookup |
| `browser:agentInput` | push | An agent has started or stopped driving a guest, carrying the guest's `webContentsId` (one window hosts several panes). Debounced to the whole BURST rather than each tool call: announcing every call made the pane hand focus back between consecutive calls, measured at 810 focus events in one drive against 11 debounced. Drives the visible state - the terminal dims and the pane is marked - and arms the focus guard. See `.claude/rules/agent-driven-focus.md` |
| `browser:viewportOverride` | push | Main to renderer: the emulated viewport a guest is now laying out against. The pane cannot see this for itself, because an override is a CDP-session property main owns and the guest's own widget size never changes, so without the push the page silently renders at a width nothing on screen accounts for. Drawn as a chip with a reset control, which is also the user's escape hatch once the agent that set it is gone |
| `browser:viewportClear` | invoke | The user clearing a pane's viewport override from that chip. Separate from the agent's own `reset`, so the user is never waiting on an agent to give their pane back |
| `browser:paneWidgetSize` | invoke | Renderer to main: the `<webview>` element's own size in CSS pixels. Main cannot measure it (its window is the whole app, several times the pane) and it is what a requested viewport is fitted against, so without this report a fit computes a zoom of 1 and leaves the page cropped |
| `browser:viewportGet` | invoke | Which override, if any, this guest is already under. A pane that mounts AFTER the override was set, a pop-out or a re-register, missed the push, so it asks once on registration rather than showing nothing |
| `browser:offscreenSurfaces` | push | Main to renderer: which tasks currently hold their one browser surface in its OFFSCREEN form. The whole set on every change, never a delta, because a renderer that missed one push would stay wrong forever. This is what makes an offscreen surface visible at all: the card globe and the task-detail Browser pill both read `browserGuestTasks`, written in exactly one place (`BrowserPane.tsx`, on the guest's `dom-ready`), so a main-process offscreen window set nothing and the user had no way to know one existed, let alone close it |
| `browser:offscreenSurfacesGet` | invoke | The same set, asked for once on mount and after an HMR update. A push-only channel leaves a reloaded renderer blank until the next change, and an offscreen surface can sit unchanged for a whole session |
| `browser:offscreenClose` | invoke | The user's "Close browser" on a task whose surface is offscreen. There is no guest in `browserGuestTasks` to retire and no pane to unmount, so the ordinary close path is a silent no-op for it, which would leave a control that says Close and does nothing. Main destroys the offscreen window directly |
| `browser:userKeyDuringDrive` | push | A keystroke the user made while an agent held the guest's focus, already encoded as terminal bytes (`src/shared/terminal-key-encoding.ts`). Main intercepts it at `before-input-event` so it never reaches the page, and the pane writes it to the terminal the user was typing in. CDP input does not travel that path, so an event arriving mid-drive is the user's |
| `browser:downloadDone` | push | A download from a guest finished, carrying `{ fileName, filePath, state }` for the toast, whose card shows the file in its folder on a click (reusing the existing `shell:showItemInFolder`). Sent to the INITIATING guest's host window, resolved per download rather than captured at install time, since one `Session` serves every pane in a worktree |
| `browser:guestMouseButton` | push | A guest page's mouse BACK / FORWARD button went down or up, carrying the guest's `webContentsId` and a MAIN-stamped `at`. A guest consumes the mouse outright - measured, one real back press produced 31 events inside the page and ZERO on the host window - so no renderer listener can see the button that push-to-talk and back-navigation both live on. `webContents.on('input-event')` does see it, and reports a true down/up PAIR, which is what makes push-to-HOLD possible rather than a one-shot toggle. The timestamp is stamped in main because the renderer's own clock is congested by the work a press starts (mic permission, engine start, AudioWorklet load: an 80ms timer measured 414ms), which would misfile a tap as a hold |

## Updater (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `updater:check` | invoke | Check for application updates |
| `updater:install` | invoke | Install downloaded update (quit and install) |
| `updater:downloaded` | on | Event: update has been downloaded and is ready to install |
| `updater:blocked` | push | This install cannot update itself until the user acts, today only the macOS read-only-volume case (Sentry DESKTOP-1A). Carries the whole user-facing sentence, composed and latched in main so the renderer toasts it verbatim and a condition every 4-hour check rediscovers still toasts once per run. Every OTHER updater failure stays silent by design; see the "counted, not reported" family in `docs/telemetry/error-reporting.md` |

## Leftover processes (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `leftoverProcesses:report` | push | What a burst of terminal transitions stopped, could not stop, and left running (`LeftoverProcessReport`), one report per burst so a bulk delete is one toast, stamped with when it was sent (`reportedAt`, UTC) for the age the sticky toast and the list header show. Main window only. Never sent when nothing was left running. See `src/main/ipc/helpers/leftover-process-reports.ts` |
| `leftoverProcesses:stop` | invoke | Stop one reported process, with everything under it, by the id its report minted (never a pid). Resolves `'stopped'`, `'ended'` or `'failed'`. Not project-scoped: the id carries its own identity |
| `leftoverProcesses:stopSettled` | push | The real outcome of a Stop that `stop` answered `'failed'` because main stopped waiting for the pty host, which finished it anyway (`LeftoverStopSettled`). The row takes it only while it still reads failed; no toast. Main window only |
| `leftoverProcesses:check` | invoke | Which reported processes, named by their report ids, have ended since the report. The pty host checks each by pid and start key, never a scan (`isRunning` on the reader), and an id main no longer knows, or a process it cannot read, is left out. Asked by `useLeftoverRecheck` while a row that claims a live process is on screen, through its toast or its open list; an ended one retries its Done task's worktree removal, as a Stop does |

## Host memory pressure (3 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `hostMemory:pressure` | on | Event: host commit headroom crossed below the warning threshold (edge-triggered, not a per-tick heartbeat). Carries `{ sample, activeAgentCount }`. See `src/main/diagnostics/host-memory.ts` (Sentry DESKTOP-16) |
| `hostMemory:recovered` | on | Event: host commit headroom recovered past the hysteresis line after a warning was latched (fires once per recovery, not on every healthy tick). Carries `{ sample }`. Clears the persistent toast `hostMemory:pressure` raised. See `src/main/diagnostics/host-memory.ts` (Sentry DESKTOP-16) |
| `hostMemory:agentPaused` | on | Event: low memory paused an agent that was waiting on the user, one push per agent, on every platform. Carries `HostMemoryAgentPausedEvent` (`pausedAt`, `taskId`, `projectId`, `taskTitle`, `projectName`, `waitedMs`), with the names resolved in main so the toast and the Review list need no lookup. See `src/main/diagnostics/idle-agent-pause.ts` |

The warning toast reads "Low on memory" over the commit headroom left, and its Settings button opens
the Behavior tab, where Max Concurrent Sessions is set. The user has two levers: a larger initial
page file, and fewer agents at once. Where commit goes per agent, and the page-file steps, are in
[Low memory warning (Windows)](../../user-guide/troubleshooting.md#low-memory-warning-windows).

## GPU health (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `gpuHealth:status` | invoke | How this launch is rendering, and whether the user still needs telling. Returns `GpuGraphicsStatus` (`{ softwareRendering, noticePending }`) via `ElectronAPI.gpuHealth.readStatus()`. A PULL, unlike its neighbour above: both facts are decided during boot, before the renderer can have registered a listener, and the escalation record behind them is already cleared by then, so a dropped push would lose the notice for good. Reading consumes `noticePending`, so a renderer reload cannot re-toast. See `src/main/diagnostics/gpu-health.ts` (Sentry DESKTOP-18 / DESKTOP-W) |
| `gpuHealth:setAccelerationAndRestart` | invoke | Save `graphicsAccelerationEnabled` (and `graphicsAccelerationOffBy`) and restart Kangentic, via `ElectronAPI.gpuHealth.setAccelerationAndRestart(enabled)`. One call because the graphics mode is chosen before `app.whenReady()`: a save without the restart would leave the saved value disagreeing with how the app renders. Restarts through `app.quit()`, so `before-quit` runs and the run records `clean`. Under `npm start` it asks `scripts/dev.js` to respawn Electron instead of calling `app.relaunch()`, and with an update already downloaded it installs it and relaunches into it, since a plain quit would run the installer without relaunching. See `src/main/app-relaunch.ts` |

## Announcements (4 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `announcements:get` | invoke | Current active announcements (remote feed, already filtered for this client's version/platform in main) |
| `announcements:getHistory` | invoke | The local announcement archive (every announcement ever active for this client, plus read-state) |
| `announcements:markRead` | invoke | Stamp `readAt` on one archive entry, clearing it from the megaphone's unread badge |
| `announcements:changed` | on | Event: the filtered active announcement list changed since the last poll. Carries `{ active, history }`, since both derive from the same poll |

## Diagnostics (2 channels)
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `diagnostics:logAppend` | invoke | Renderer / preload forwards a `LogEntry` to the main process. The main-side log mirror persists `error` and `warn` levels unconditionally and `info` / `debug` / `log` when `developer.persistConsoleLogs` is on. NDJSON written to `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`, falling back to `<configDir>/logs/` while no project is open (the same fallback crash capture uses). |
| `diagnostics:crashReport` | invoke | Renderer forwards a `CrashRecord` (window.onerror, unhandledrejection) to the main process. Crash capture writes one JSON file per record to `<projectRoot>/.kangentic/logs/crashes/<ts>.json`, falling back to the app's own config directory when no project is open (a crash must never be silently dropped for that reason). Always-on - no toggle. |

## Dictation (14 channels)
By-session-id, not task-scoped (no `projectId`), in the same category as `session:resize`.
| Channel | Pattern | Purpose |
|---------|---------|---------|
| `transcribe:start` | invoke | Begin a dictation session; resolves the engine + model from config + hardware. Returns `{ dictationSessionId, engineId, modelId, needsDownload, sentenceCaseFinal }`; `sentenceCaseFinal` is true when the live model writes all caps (the Zipformer), since the committed text can be its own (no refinement, or a refinement that fell back to the live text); the renderer then sentence-cases a final in that all-caps shape, and with any other live model types the final as written |
| `transcribe:stop` | invoke | Finalize and return the committed text. Passes the renderer's sent-frame count so the decode drains all in-flight audio first (the tail is never clipped) |
| `transcribe:cancel` | invoke | Abort a session without committing |
| `transcribe:commit` | invoke | Inject finalized text into the focused terminal WITHOUT submitting (no Enter) |
| `transcribe:submit` | invoke | Auto-submit: erase the live preview, then paste + submit the refined text via the paste engine (settle -> separate Enter -> submission evidence with retry) |
| `transcribe:getInfo` | invoke | Hardware profile + engines + installed models + per-slot model lists (settings panel) |
| `transcribe:partial` | on | Push: live revising hypothesis to the renderer |
| `transcribe:final` | on | Push: finalized text to the renderer |
| `transcribe:audioChunk` | on | Stream one PCM frame into the funnel (fire-and-forget, no round-trip) |
| `transcribe:requestMic` | invoke | Ensure microphone access (macOS TCC prompt on first use) |
| `transcribe:modelProgress` | on | Push: first-use model download progress, as aggregate bytes across the set plus the downloading model's own pair (`modelDownloadedBytes`, `modelTotalBytes`) for its line in the Dictation tab. An `error` carries the id of the model whose download failed |
| `transcribe:downloadModel` | invoke | Pre-download the selected model from settings |
| `transcribe:liveWrite` | on | Live experience: write raw bytes (text + backspaces) straight into the focused terminal as the user speaks (fire-and-forget) |
| `transcribe:prewarm` | on | Pre-load the selected engine's live (streaming) model so the next press streams partials at once; the refinement model loads on the first press itself, overlapped with the utterance. `null` (dictation disabled) releases the worker outright (fire-and-forget) |

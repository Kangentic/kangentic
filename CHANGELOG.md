# Changelog

All notable changes to Kangentic will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

<!-- releases -->

## [v0.16.1] - 2026-04-20

### Features

- MCP: add update and delete tools for backlog items (2e34a82)

### Fixes

- Worktree: restore git timeout ceiling for heavy repos (dcf8ea8)
- Worktree: prevent asar handle leak that blocked Windows cleanup (1a80b49)
- Worktree: retry failed Done-task cleanups on project open (18dc8a7)
- Test: stub process.platform so updater-retry passes on Linux CI (e5ef7c5)

### Other

- Perf: parallelize terminal resize and scrollback fetch on mount (6883969)
- Perf: virtualize ActivityLog rendering (4839c4d)
- Perf: shrink withTaskLock scope around slow git and PTY I/O (2173804)
- Perf: batch xterm onData into one IPC write per microtask (c6e1b6b)
- Perf: extract backlog dialogs into sibling component (9ef2ee0)
- Docs: mark Asana as supported import source in README (703ad6f)

## [v0.16.0] - 2026-04-19

### Features

- Agent: GitHub Copilot CLI adapter (61506c6)
- Agent: Warp CLI (Oz) adapter (3f89876, b7e3917)
- Agent: Cursor CLI adapter with stream-json init parsing for agent name and model (451e164, c4dd921)
- Aider: session history parsing, transcript cleanup, and mode-aware idle detection (200cb45)
- Boards: Asana integration with OAuth PKCE and setup wizard (43f309c)
- Activity: detect background shells to prevent false idle state (b6b4d46)
- Sidebar: reimagined project sidebar UX (b82e4e9)
- Sidebar: project counts in header and group rows (ef49d53)
- Sidebar: idle and active task counts per project row (5a391e8)
- Command Bar: ContextBar in overlay with responsive layout (9f8c143)
- Board: redesigned Done column to reclaim worktrees while preserving resumability (dc2a38f)
- Worktree: encode base branch in auto-generated names and surface in task UI (afcf7fc)
- Marketing: Playwright screenshot/video capture framework (cd6d465)

### Fixes

- Startup perf: don't block session recovery on resource cleanup (292fe3b)
- Task-move: clear spawn progress when task moves to To Do (4b737c8)
- Context-bar: distribute overlay row space evenly across pills (17d6129)
- Worktree: kill-on-timeout for git removal ops so queue can't be poisoned (3df1f75)
- Bulk-delete: per-task deadline and visibility to survive git hangs (b08ecf3)
- Board: bulk delete no longer freezes or orphans worktrees (dbc040c)
- Shutdown: remove real node_modules dirs and silence pipe write errors (cf5abcb)
- Board: archive atomically on Done move and restore cursor attachSession binding (5d64625)
- Asana: capture attachments on import and migrate auth from OAuth to PAT (049a4bb)
- Cursor: clear "Loading agent..." spinner in interactive TUI mode (0530a37)
- Updater: stop macOS update failures and silence transient noise (5513c7c)
- Review findings for v0.16.0 release (78c7295)
- Agents: unstick Copilot and Cursor at "loading agent" spinner (6c56ab0)
- Copilot: add `type:"http"` to MCP config so Copilot CLI accepts it (43502b7)
- PTY: swallow EACCES/ESRCH from already-dead PTY kills (199011e)
- Board: prevent completed task from sticking in Done dropzone (0c1c9c6)
- Renderer: render dates in the user's system locale (c7e155f)

### Other

- Perf: board structural sharing, subscription consolidation, agent-event debounce (9eb53d4)
- Perf: keep main-process event loop responsive during bulk delete across all OSes (cc4137d)
- Refactor: IPC tasks.ts split and withTaskLock policy gaps closed (c165977)
- Refactor: move git-detector into src/main/git (39563bc)
- Refactor: address review findings from comprehensive refactor audit (656af6a)
- Refactor: azure-devops html-to-markdown and wiql helpers extracted (fced25f)
- Refactor: git-checks, node-modules-link, fetch-throttle extracted from worktree-manager (eb18971)
- Refactor: decompose session-manager into focused modules (9dd776e, bdbacbc)
- Refactor: split board-store and session-store into slice files (bde5e3b)
- Refactor: split completed-tasks, backlog, task-card dialogs (1251d6c)
- Refactor: split settings, task-detail, manage-labels dialogs (6a11e33)
- Refactor: split board-config-manager, mcp-http-server, session-recovery (e997968)
- Refactor: per-adapter layout for board integrations (80625a1)
- Refactor: tighten move-to-Done dialog copy and visual consistency (54ff0ca, 2fffaa8)
- Docs: testing column discipline added to CLAUDE.md (1e949a5)
- Docs: list all 7 supported agents and rename Warp to Oz CLI (bb42851)
- Docs: update README to reflect multi-agent support and import sources (9eee320)

## [v0.15.0] - 2026-04-11

### Features

- Multi-agent support: Codex CLI, Gemini CLI, and Aider adapters alongside Claude Code (6589b36, 765b6d2, 6079a4c)
- Welcome screen: show all supported agents in detection grid (bef896d)
- Agent-specific permission models with dynamic dropdowns (07d733f, b2fb55e)
- Settings: default agent picker and per-column agent override (64aa5ce)
- Layout settings tab: card density, column width, panel visibility toggles, window restore, animations (68d0411)
- Multi-agent context handoff: pass the prior agent's native session history file to the next agent on column move (b92de92, 335b8bd)
- Changes panel: added to task context menu, Command Terminal dialog, and expand/collapse toggle; auto-selects first file; untracked files visible (0df44c7, ceefed3, 2e2a806, 4224d83, 6806b23)
- Board: Add Column button moved to toolbar with dedicated create dialog (cd17f74)
- Board: confirmation dialog when moving task with pending changes to To Do (c6fe672)
- Command Terminal: fetch + fast-forward pull before spawn (34204d6)
- Context bar: Claude session and weekly rate-limit quotas (df749a5)
- Session state machine: atomic transitions and per-task lifecycle locks with pause/resume race fixes (34970e6, 56dd2ff)
- Session resume for Codex and Gemini (8922312)
- Native session history telemetry for Codex, Gemini, and Claude via `SessionHistoryReader` (ea0564f, 6df12f0)
- MCP HTTP server: in-process streamable HTTP transport replaces the file-bridge (e682b0c)
- MCP tools: `kangentic_get_current_task`, `kangentic_delete_task`, session file/event accessors, unified task creation, rich structured transcripts (39593e5, badbb3b, eafd4c6, a0d21f8, 0ed4a40)

### Fixes

- Context bar always renders with 0% default; no more missing-bar states (6f16949)
- Task card shows "Loading agent..." spinner instead of bare ellipsis while the agent model resolves (276fb09, 19ddd99)
- Task card shows "Pausing agent..." label while suspending a running session (ba8944b)
- Hide uninstalled agents from the per-column agent dropdown (dfcda65)
- Remove version-number noise from agent dropdowns (ff07fc8)
- Welcome screen no longer flashes on app startup (622621c)
- Prevent card from snapping back during the move confirmation dialog (6198599)
- Hide the Agent section in Edit Column for To Do / Done columns (f61ff03)
- Window restores maximized state on launch instead of a half-width bounds (35bae8d)
- Spinner animations no longer freeze during drag operations (0eed804)
- Diff viewer: fix crash when selecting a file (851df64)
- Diff viewer: remove `@monaco-editor/react` from Vite optimizeDeps to fix a `useState` crash (5bb2e08)
- Diff viewer: eliminate flicker when the Changes panel is open alongside the terminal (3add42d)
- Diff: prefer origin ref in `getMergeBase` to avoid stale local branches (f3aa1d0)
- Compare: honor the project's `defaultBaseBranch` instead of a hardcoded `main` (fd48709)
- PTY: preserve scrollback across session resume (regression from b8385ca) (1302772)
- PTY: await process exit before worktree removal to prevent freeze (8eab0fe)
- PTY: suppress idle -> thinking flicker after resize-induced redraws (affdbfa)
- PTY: ring-buffer content dedup to handle placeholder rotation and normalize whitespace for resize redraws (5e653fd, df59041)
- PTY: unstick Codex and Gemini task cards on first output (5f890a1)
- PTY: eliminate activity watcher stale/recover loop (381a3e2)
- Codex: unwrap `event_msg` envelope so context usage updates (373211e)
- Codex: replace `detectIdle` with silence timer + content dedup, filter TUI noise (c351ec1, 3c52220)
- Codex: wire `statusFile` hook and session history E2E coverage (48f2f4f)
- Gemini: resolve model name never appearing on task card (8d13dd5)
- Gemini / Codex: standardize hook lifecycle and status display (8be7d0d)
- Gemini / Codex: reliable session-ID capture (1e226ae)
- Claude: drop session-history live telemetry to stop model flash (ba31ef5)
- Claude: detect CLI installed via Homebrew (155ae05)
- Claude: detect CLI version on Windows via shell-aware `execFile` (d31951a)
- Agent: surface override path failure instead of silent fallthrough (3874ca2)
- Agent: eliminate DEP0190 deprecation warning from detectors (b0d43f9)
- Activity state machine: unwedge permission idle inside subagents (47b8e5b)
- Spawn: optimize task-move to agent-spawn latency (45e9253)
- Project switch: feels instant (ef7eb4d)
- Terminal: suppress background-session IPC to eliminate typing lag (47b8e5b)
- Terminal: include Command Terminal in focused-session set for live PTY data (9b564b2)
- Task: copy task ID as `Task #N` for better MCP context (18d94e1)
- Task detail: truncate long titles so header commands always fit (cb1f441)
- Notifications: label Command Terminal idle sessions and reopen overlay on click (000b525)
- MCP: stop wiping in-flight commands on bridge start (b75f8fe)
- MCP: route "create a todo task" to board instead of backlog (06e153b)
- MCP: align session-bridge directory and wire new tools (b28c662)
- Analytics: fix Aptabase average duration showing 0s (b2685b2)
- Updater: retry once on transient network timeout before reporting error (29bbf32)
- Stores: add hydration gates to board and backlog stores (5c5de90)
- Engine: use task's original agent on session resume (1d99c4e)
- Engine: resolve default agent from detected agents instead of hardcoding Claude (8ae5604)
- Engine: Command Terminal uses project default agent (dd824d3)
- Settings: refresh `currentProject` after changing default agent (55d0439)
- Settings: preserve terminal settings when merging partial project overrides (faaa843)
- UI: deduplicate provider name in import source labels (a9183ec)
- HMR: preserve terminal state, transient session pointers, Command Terminal open state, `moveGeneration`, and `syncController` across refreshes (b72cae6, 7df679a, 60ffc44, d244dc3)
- Code review follow-ups: session-file-watcher uses `fs.rmSync` with `{ recursive, force }`; Gemini hook writes are reference-counted so concurrent sessions no longer clobber each other; `EditColumnDialog` / `ActivityLog` / `SettingsPanel` dropdowns use the shared `Select` component

### Refactor

- DB: rename `claude_session_id` -> `agent_session_id` (9850726)
- Config: rename `AppConfig.claude` -> `AppConfig.agent` with per-agent CLI paths (53516ad)
- Engine: use agent adapter instead of hardcoded Claude in transition engine (15c13ea)
- PTY: use agent adapter for status/event parsing in `UsageTracker`; trust Claude Code's `used_percentage` directly (ddd6ce8, 0b1f90b)
- Agent: reorganize adapters into per-agent subfolders (`claude/`, `codex/`, `gemini/`, `aider/`) (dc8d2b0, 2b4f4a7)
- Agent: extract `ActivityStateMachine` from `SessionManager`; move hook telemetry into `runtime.statusFile` (47b8e5b, f0805e0)
- UI: replace hardcoded `claude` strings with `DEFAULT_AGENT` constant and `getAgentDisplayName` utility (d2034e6, aade3c3)
- Session: consolidated `spawnAgent` helper for unarchive / session resume (1724cd4)
- Settings: move session limits from Agent tab to Behavior tab (4ecfc51)
- Board: hide agent section in Edit Column for To Do / Done columns (f61ff03)

### Other

- Deps: upgrade core dependencies to latest stable (03b8747)
- Tests: add Codex and Gemini agent-parity E2E specs + `ActivityStateMachine` unit tests (7d6bb41)
- Tests: speed up E2E suite 36% and replace branch-rename E2E with unit tests (0dd683b)
- CI: prevent partial releases and fix macOS build OOM (27c2f5b)

## [v0.14.0] - 2026-04-01

### Features
- Support Ctrl+V paste for images and shell-aware path quoting in terminal (5c3d5dd)
- Show git diff viewer for all tasks with persist panel state and kebab menu (9790d57)
- Add git diff viewer to task detail dialog (9065b5a)

### Fixes
- Format currency with thousands separators (129abd6)
- Emit exit event for killed queued sessions and add session reset (f86523f)
- Constrain rawBody to prevent header clipping in dialogs (61fd2fc)
- Use merge-base for branch-only diffs, move Changes to pill row (3accbf0)

### Other
- Extract AgentAdapter interface and registry (bc89c35)

## [v0.13.1] - 2026-03-31

### Fixes
- Send newline instead of carriage return for Ctrl+Enter in terminal (114e8c9)

## [v0.13.0] - 2026-03-31

### Features
- Add @-mention file autocomplete to description editors (4455387)

### Fixes
- Eliminate terminal truncation from resize/scrollback race (b8385ca)
- Clear stale pendingCommandLabel when user-paused task is moved (2dd36cb)
- Hide header shortcut pills that overflow instead of clipping (a9eca21)
- Don't auto-resume manually paused tasks on column move (e759dbc)
- Command palette dropdown not visible in Command Terminal overlay (fdf5a24)
- Address PR review feedback for file mention autocomplete (4da56dd)

## [v0.12.2] - 2026-03-26

### Fixes
- Shorten worktree slug names to avoid Windows MAX_PATH limit (28b9fdb)

## [v0.12.1] - 2026-03-26

### Fixes
- Crash on Git tab when project overrides use partial config (1e25c2b)

## [v0.12.0] - 2026-03-26

### Features
- Add backlog view for staging tasks before the board (85b3c8b)
- Background transient sessions with reattach support (6dcfa45)
- Right-click context menus with move, edit, delete, archive on board and backlog (caadf15)
- Use column color for drag-and-drop drop target highlight (33dc140)
- Support paste/drop of any file type as attachment (edc5757)
- Fix MCP schema serialization, add attachment support, and file drop-to-terminal (759f585)
- Double-click backlog row to open edit dialog (7e8379e)
- Add copyable task display ID to board and MCP (f3d8770)
- Wire up attachment persistence for backlog items (38c1d24)
- Add external MCP command bridge for preview isolation (0648766)
- Add copyable display ID to task edit dialog header (3e0384e)
- Allow drag reorder while filters or search are active in backlog (544c652)
- Add color support to backlog label creation via MCP (02d209f)
- Carry labels and priority from backlog to board tasks (a262cd2)
- Add markdown rendering for task descriptions (3dae7e8)
- Import tasks from GitHub Issues and Projects (6a533a2)
- Show priority badge in task detail dialog header (8f3b2b0)
- Replace auto-focus idle sessions with amber tab indicator (ad5625a)
- Add label and priority editing to board task forms (65599bd)
- Add label and priority filtering to the board view (49fd4b2)
- Move Labels/Priorities into board header row (4f8b7ca)
- Add Azure DevOps as an import source (9f59872)
- Fetch Azure DevOps comments and file attachments (0c3b43d)
- Mention import option in empty backlog state (a0b3f7a)
- Add usage stats time period dropdown to status bar (7aad7f4)

### Fixes
- Replace native select with custom popover and fix metrics persistence in status bar (e7281c2)
- Support UNC paths for SMB network share projects (9f92295)
- Add fallback spawn to ensure all promoted tasks get agents (8d54da0)
- Make context menu paste consistent with Ctrl+V path (d5b4386)
- Make backlog promotion instant with deferred agent spawn (56be2da)
- Pass AbortSignal through SESSION_RESUME to prevent stale spawns (1c4f879)
- Pass AbortSignal through promotion async chain (408e279)
- Include config-defined labels in autocomplete suggestions (9a2e451)
- Make backlog context menu respect multi-selection (d327f4e)
- Cancel in-flight session spawns when task is moved back quickly (bb88ff8)
- Prevent large paste truncation with chunked PTY writes and bracketed paste (eeb4e29)
- Make xterm cursor transparent to prevent flickering (4028d68)
- Preserve command terminal across project switches (50fc1e5)
- Hide entire search/filter row when Ctrl+F dismisses it (d677241)
- Enable core.longpaths for worktree creation on Windows (85ea878)
- Sync backlog store after MCP create/promote operations (9558d41)
- Clean up transient session state on stop and add idle indicator (0fcc344)
- Unblock CLA assistant on protected main branch (c0d5256)

### Other
- Consolidate spawn fallback into single spawnAgent primitive (3845165)
- Update all documentation for v0.12.0 and consolidate /sync-docs skill (48f3260)
- Move time ago to its own line below labels on completed cards (4758dfd)
- Replace generation counter with AbortController in syncSessions (7e30695)
- Rename BacklogItem to BacklogTask across codebase (727dee4)
- Extract shared DescriptionEditor component (1760a89)
- Extract auto-spawn into shared function for external bridge (e6c2b85)
- Decompose large single-file modules into focused submodules (bc1739b)
- Add gh pr permission to project settings (ab001c8)
- Use wildcard MCP permissions instead of individual tool entries (b3e1bb4)

## [v0.11.0] - 2026-03-23

### Features
- Auto-detect PR URLs from terminal output and link to tasks (ed7ab0f)
- Add ephemeral Claude Code terminal overlay (8c96252)

### Fixes
- Remove overflow-x-auto from header pills to unclip command popover (6cddaf1)
- Fix Done column bleed-through, task detail header layout, and completed task view (8f905f4)
- Fix summary view overflow, git stats, and Done column layout (6267979)
- Support right-click paste in xterm terminals (4ec2088)
- Update session-queued-status test for push-based session sync (5029b85)

### Other
- Lift shimmer overlay on alternate screen buffer detection (09fcc72)
- Reduce heartbeat interval from 5min to 60min (6af07c0)
- Add fade-out gradient to Done column completed tasks (4231cd4)

## [v0.10.0] - 2026-03-22

### Features
- Expose Kangentic board API via MCP server for Claude Code agents (c8f1c3b)
- Add "Copy Image" to right-click context menu for image attachments (4b3072a)
- Show action buttons on selected project and add context menu with rename (0915525)

### Fixes
- Restore F12 and Ctrl+Shift+I DevTools shortcuts in dev mode (40278e6)
- Persist queued status in SessionRecord instead of lying about running (1792be1)
- Escape PowerShell special characters in CLI prompts (032ac02)
- Deterministic worktree cleanup with correct junction removal on Windows (3d99544)
- Remove node_modules junction before recursive cleanup (9c155b6)
- Auto-rebuild native modules after npm install (24bc64d)
- Use full removeWorktree in createWorktree pre-cleanup (f965abb)
- Clean stale worktree resources for backlog tasks on startup (514236a)
- Serialize trust manager writes and reserve session slots during spawn (bab5184)
- Enable Ctrl+C copy and Ctrl+V paste keyboard shortcuts (5f82374)
- Move @aptabase/electron from devDependencies to dependencies (0c40aca)
- Serialize git operations and recover stale branches on backlog move (085d6e4)
- Drain buffer in getScrollback to prevent duplicate terminal history (f22f0cf)
- Revert task move on duplicate branch detection (05c20c0)
- Resolve aptabase module errors and fix stale unit tests (48eca32)
- Register suspended placeholders for user-paused sessions on restart (8785177)
- Reuse session ID on queue promotion to prevent stuck "Starting agent..." (77ce0d0)

### Other
- Push-based session sync to replace ad-hoc mechanisms (226f4d0)
- Caller-owned session IDs to prevent queue ID mismatch (955908c)
- Split tasks.ts handler into task-crud, task-move, task-branch (2d35a13)
- Deliver MCP server via --mcp-config flag instead of .mcp.json injection (cfbd0f2)
- Extract PtyBufferManager, SessionFileWatcher, UsageTracker from SessionManager (a3b6c2d)
- Split board-store into Zustand slices (3d602e6)
- Extract useBoardDragDrop and useBoardSearch hooks from KanbanBoard (66ef063)
- Extract ProjectListItem, GroupHeader, and context menu from ProjectSidebar (160e12a)
- Extract TaskDetailDialog into focused components and hooks (01f422a)
- Rename "Commands & Skills" to "Commands" and auto-size kebab menu (57c2696)
- Migrate ESLint 8 to 9, upgrade commitlint and minor deps (ca1ad07)
- Add MCP server documentation and fix anchor gaps (76251df)
- Update developer-guide structure and fix branch naming in user-guide (3672382)
- Add gh issue permission to Claude settings (859bf62)

## [v0.9.1] - 2026-03-18

### Fixes
- Bundle @aptabase/electron via esbuild alias to fix packaged builds (59f1d84)
- Ensure spawn-helper has execute permissions on macOS (5e579be)
- Prevent garbled TUI output on scrollback replay at wrong width (e2e4102)

### Other
- Allow start command in project permissions (e300ade)

## [v0.9.0] - 2026-03-18

### Features
- Convert commands to skills and add skills to palette (bd0abed)

### Fixes
- Prevent zombie processes by sharing shutdown flag across spawn paths (2eeab4f)
- Prevent sidebar toggle from resizing bottom panel (4c292a9)

### Other
- Upgrade GitHub Actions to node24 versions (4d879ba)
- Auto-open releases page after /release push (529fe31)

## [v0.8.0] - 2026-03-18

### Features
- Make backlog move destructive and add full branch config to edit (c63c6fe)
- Add custom branch name support for tasks (00e8b38)
- Add defaultBaseBranch to team-shared kangentic.json (12b66b0)

### Fixes
- Skip prompt template when starting tasks from non-backlog columns (2f7d58e)
- Prevent terminal color corruption from scrollback replay (03103f7)
- Add CWD validation and enhanced diagnostics for posix_spawnp failures (ee34e07)
- Preserve task detail dialog across board reloads (6dca5c4)
- Preserve scrollback on resume and fix garbled terminal handoff (fba13e8)
- Replace platform-specific version checks with cross-platform version marker (abc7863)

### Other
- Remove confirmation prompt from /test write mode (785cdc7)

## [v0.7.1] - 2026-03-17

### Fixes
- Restore IPC init order and add idempotency guard (a204b9b)

## [v0.7.0] - 2026-03-16

### Features
- Add project grouping with collapsible sections in sidebar (303c9fa)
- Add heartbeat event for session duration tracking (7912d6a)
- Add Visual Studio preset for Windows keyboard shortcuts (2d68f5d)

### Fixes
- Checkout selected branch for non-worktree tasks (e7fcc01)
- Prevent IPC double-registration crash and harden cross-platform support (e052be0)
- Prevent session resume for tasks in the backlog (740f9f9)
- Always pre-populate trust for agent cwd including demo mode (4529a12)

### Other
- Add YouTube demo badge and watch demo button to README (7e509a9)
- Fix publish-npm job skipped on tag-triggered releases (81c911f)

## [v0.6.0] - 2026-03-15

### Features
- Add /pull-request command and fix /merge-back branch docs (b9b6f9a)
- Add --demo flag for ephemeral demo mode in launcher (5756ae7)
- Add muted Project/System section headers to settings tab sidebar (3b32350)
- Add ability to switch base branch or enable worktree after task creation (8d91e6d)
- Add search bar for filtering tasks across columns (0ecb713)
- Redesign Done column with capped preview and enhanced completed dialog (b67647c)
- Restrict "Add task" button to Backlog column only (207d895)
- Add Completed Tasks dialog with sortable data table (1d9af35)

### Fixes
- Remove @xterm/addon-fit from Vite manual chunks (2ecf94f)
- Improve terminal panel collapse/expand and drag-resize behavior (f39b9f8)
- Capture metrics before suspend in auto_spawn=false and auto_command paths (644817c)
- Close task detail dialog on save instead of returning to view mode (5fa1533)
- Prevent completed date wrapping and expand title column width (62847fc)
- Skip scrollback carryover on resume to prevent duplicated terminal output (5723d83)
- Compute timeline/duration from task creation, aggregate multi-session metrics (3ce4fc3)
- Skip kangentic.json write-back when content is unchanged (b2fcb32)

### Performance
- Optimize drag-and-drop for smooth 60fps interaction (4957f52)

### Other
- Improve CLA with version, third-party clause, and narrower scope (86e4cf9)
- Replace .clabot with CLA Assistant GitHub Action (c92bad4)
- Reorder task detail header pills so Commands appears before Worktree (66d387f)
- Rewrite README features section for product launch (975c54d)
- Replace @xterm/addon-fit with custom FitAddon and simplify resize (fc330e9)

## [v0.5.0] - 2026-03-14

### Features
- Add configurable shortcuts to task detail dialog (ea4597d)
- Show contextual status labels on task card during command invocation (2f3d176)
- Add quick-access Claude commands popover (3352590)
- Add session summary panel and metrics to completed tasks (247cc99)
- Add mechanical doc-auditor agent and anchor-based verification (6777b8a)

### Fixes
- Preserve scroll position when fit() reflows during user scroll (e5c51c4)
- Skip fit() when user is scrolled up to prevent viewport jump (ad41dad)
- Distinguish manual resume from auto_command transition in overlay label (13c2e9e)
- Show auto_command label instead of generic "Resuming agent" on transition (920520b)
- Prevent "Rendered more hooks" crash when archiving from detail dialog (337b83a)
- Prevent false idle during Claude Code nucleation (0390d5e)
- Use bare file paths for image attachments instead of bracketed format (843f31c)
- Prevent false idle during long-running tool executions (dddd2ee)
- Only suspend/resume session when target column has auto_command (eb25839)
- Prevent viewport from snapping to top on fit/resize (c302061)
- Show resume label instead of auto-command when resuming a paused session (e6e74e6)
- Eliminate flaky Electron launch failures on Windows (484e58c)
- Re-register IPC listeners after store replacement (d2077bb)
- Suppress false "config changed" dialog with content hashing (f24dade)
- Keep skills and agents in worktree checkout (7157a3c)
- Gate npm publish on build success and remove duplicate workflow (174cfea)
- Use correct Lucide icon name for TortoiseGit Commit preset (b592e94)

### Other
- Align permission modes with Claude Code CLI (b9c938b)
- Remove Global/Project scope toggle, unify settings panel (089b2b4)
- Stack compact done card into two rows (096fb67)
- Show title + description on compact done cards, remove cost badge (d586aaa)
- Reduce animation overhead when launching multiple agents (b1db038)
- Reduce visual noise in terminal loading shimmer (37c6c0c)
- Upgrade vite 7, electron-builder 26, fix all vulnerabilities (2df94ae)
- Add auto-commands to Code Review and Tests columns (98dd6b1)
- Update project settings and code review conventions (52fff39)
- Add argument-hint to /preview command frontmatter (c683225)
- Add shared Pill component for consistent pill/badge styling (3fb5e4b)
- Migrate remaining pill buttons to shared Pill component (e22cc55)

## [v0.4.0] - 2026-03-12

### Features
- Add shareable board config via kangentic.json (bf48665)
- Auto-export kangentic.json on project open and add ephemeral mode (be991a9)
- Add permission mode guard and shimmer overlay for column transitions (d34002f)
- Add search bar to settings panels (64e3585)
- Persist user-paused sessions across app restarts (13864f7)
- Add configurable context bar element visibility (894bd49)
- Add 5 custom Claude Code agents for proactive validation (c29eca2)

### Fixes
- Detect stale thinking state after Ctrl+C interruption (2343a8e)
- Close existing task detail dialog on notification click (03065f7)
- Resolve intermittent UI test failures from Vite startup race (09eace9)
- Show toast instead of inline error when deleting column with tasks (13b4f5f)
- Use shell-aware quoting in quoteArg to prevent $var expansion (95f79f6)
- Use same-permission columns in session survive E2E test (9364fcc)

### Other
- Unify settings panel with VS Code-style scope tabs (defdb58)
- Remove sync dialog, snapshot defaults on project create (f427a2d)
- Comprehensive documentation update for v0.4.0 (2916d35)

## [v0.3.1] - 2026-03-10

### Fixes
- Bundle electron-updater instead of marking it external, fixing "Cannot find module" crash on launch (9a1f5e9)

## [v0.3.0] - 2026-03-10

### Features
- Auto-spawn agent when creating task in auto-spawn column (8a9e6df)
- Improve first-launch experience with welcome overlay and git detection (69caf9a)
- Add Notifications tab, terminal options, idle timeout, and window restore (78d7078)

### Fixes
- Add cold Vite cache message to dev startup (8a01c93)
- Suppress welcome overlay flash during config store re-sync (5fb17d7)
- Re-sync all IPC-backed stores after Vite HMR update (3f95493)
- Suppress bottom panel switch when Task Detail dialog is open (3bd5cff)
- Include output tokens in context window percentage (9ce3891)

### Other
- Shrink task detail dialog during edit mode (3dacac3)
- Remove dead kgnt CLI entry point (e97d2d9)
- Center project name in title bar (f36d27b)
- Restructure header branding, sidebar collapse, and version badge (ac5f868)
- Documentation updates and README improvements (bc09a13, 2f457a1, eb80fdb, 6587722, 03d7b52)

## [v0.2.0] - 2026-03-09

### Features
- Auto-update via electron-updater (813cf91)

### Other
- Tolerate already-published versions and update CLI docs to npx (942a2fd)

## [v0.1.0] - 2026-03-09

### Features
- Cross-platform desktop Kanban board for Claude Code agents (cb97509)
- Session persistence, drag-and-drop, and worktree config propagation (9c0f4e5)
- Context usage tracking, status bridge, and toast notifications (e721367)
- Kebab menu, archive flow, wildcard transitions, and UI hardening (71fbbaf)
- Consolidated runtime data under .kangentic/ and session suspend (6463c83)
- Hook-based activity log replacing aggregate terminal (bbe0828)
- Image attachment support for task dialogs (1b2945c)
- Worktree preview system (b1f4156)
- Multi-theme support with semantic color tokens and light/dark/system switching (f178afa)
- 8 named color themes with per-theme accents (1b5f7d1)
- Token usage display in task detail and app footer (fc1a2f9)
- Per-task worktree override toggle (7278ecf)
- Auto-command feature for swimlane columns (6a6f78e)
- Persistent project reordering via drag-and-drop in sidebar (2434ad0)
- Desktop notifications for idle agents with settings toggle (8611522)
- Native Electron desktop notifications (e7c998c)
- Anonymous usage analytics with Aptabase SDK (97416c5)
- App version display in StatusBar (c80dd44)
- App crash and error tracking in Aptabase (6a2d314)
- Auto-open last activated project on launch and welcome screen (37cb331)
- Split settings into App Settings and Project Settings panels (a886253)
- Window control buttons (minimize, maximize, close) in titlebar (b4dee00)
- Per-project config overrides with global/project settings scope (f11f20e)
- Resizable sidebar with auto-collapse (2fbfabc)
- Agent skills and commands for session lifecycle, IPC bridge, and cross-platform knowledge (01e8b24)
- Deployment pipeline: npx launcher, code signing, CI matrix (4628ece)

### Fixes
- Synchronous shutdown to eliminate zombie processes and auto-restart (53f656f)
- Disable auto-updater to prevent phantom relaunch and zombie processes (6d22bf0)
- Cross-platform hardening for alpha release (3c7ebaa)
- Task card stuck on Idle after permission prompt during subagent work (8a37a69)
- Drag-and-drop grey screen crash with error boundaries (f31b97c)
- Session recovery re-entrancy bug (8dda8a1)
- Idle vs active state race condition (f54419f)
- CLI option parsing for prompts with ->, --, and double quotes (3115f0d)
- Terminal resize hardening and onData race condition (82132da)
- Context window progress bar showing inflated percentages (815a702)
- Startup pruning to remove all ephemeral worktree projects (211efc0)
- Notification icon quality and app name on Windows (51a20bd)
- Windows taskbar icon showing Electron logo instead of Kangentic (03621f7)
- Packaging: bundle native modules and bridge scripts for distribution (244dd15)
- Packaged app: unpack bridge scripts from asar for external node processes (634ac9d)
- Desktop notifications: title, task name, and click-to-open (0c54757)
- Permission idle suppressed during subagent execution (4373120)
- SyncSessions race condition causing stale idle/active state (85f9f51)
- Confirm dialog Enter key freezing UI and stale archived tasks reappearing (bcd81c6)
- Stale Initializing state when moving task back to Backlog (e74fb7a)
- Idle-to-thinking delay after answering AskUserQuestion/ExitPlanMode (b4966d6)
- Drag-and-drop oscillation by removing visual cross-container transfer (cd7b40c)
- Session lookup divergence causing blank terminal in task detail dialog (b376b44)
- Activity recovery from false idle after permission approval in subagents (c5050b6)
- Context % accuracy matching Claude Code TUI using floor division (aedd5ad)
- Notifications: prevent GC of click handler and restore minimized window (c2d6089)
- Suppress false-positive stale warnings during startup grace period (7762085)
- Context usage display after HMR matching Claude's rounding (44a0117)

### Performance
- Reduce installed bundle size from 401 MB to ~293 MB (699dccb)
- Startup instrumentation and parallelize session recovery (70a72e6)
- Speculatively preload project during renderer load (517661e)
- Vite: warm up renderer module graph before Electron launch (f3c823e)
- Vite: pre-declare renderer deps in optimizeDeps.include (95eab70)
- Disable analytics in dev to avoid HMR phantom sessions (bb9675f)
- Electron app startup time improvements (a441122)

### Other
- Comprehensive documentation suite (fcb0323)
- Automated documentation maintenance via /update-docs (9769a0e)
- Switch license from MIT to AGPLv3 with CLA for dual-licensing (85257fc)
- Redesign README with branded hero and tech badges (6d1d604)
- Declutter root directory for cleaner GitHub landing page (5d23473)
- Redesign release strategy with conventional commits and CI (5022326)
- CI workflows for build and release (af82656)
- Production readiness cleanup (fcff489)
- Comprehensive test suite: unit, UI, and E2E tiers (436e96e)
- Auto-populate draft release description from RELEASE_NOTES.md (426a69d)

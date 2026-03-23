# Changelog

All notable changes to Kangentic will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

<!-- releases -->

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

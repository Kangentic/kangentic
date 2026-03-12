# Changelog

All notable changes to Kangentic will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

<!-- releases -->

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

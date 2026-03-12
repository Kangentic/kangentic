## What's New
- **Shareable board configuration**: Teams can commit `kangentic.json` to share column layout, colors, icons, actions, and transitions. Personal overrides via `kangentic.local.json` (auto-gitignored). Live file watching detects teammate changes and offers to reconcile.
- **Permission mode guard**: Moving a task to a column with a different permission mode automatically suspends and resumes the session with the correct CLI flags. A shimmer overlay indicates the transition.
- **Settings search**: Filter any setting instantly with a search bar. Multi-token matching, grouped results by tab, match count badges.
- **User-paused session persistence**: Sessions paused manually via the pause button stay paused across app restarts, respecting user intent.
- **Configurable context bar**: Toggle individual elements (shell, version, model, cost, tokens, context usage, progress bar) on or off in settings.
- **Unified settings panel**: VS Code-style layout with Global and Project scope tabs in a single panel.
- **Custom Claude Code agents**: 5 built-in agents for proactive validation (HMR integrity, IPC audit, migration safety, cross-platform guard, session debugging).

## Bug Fixes
- Fixed stale thinking state detection after Ctrl+C interruption
- Fixed task detail dialog not closing on notification click when another dialog was open
- Fixed shell-aware quoting to prevent `$variable` expansion in non-PowerShell environments
- Fixed toast error display when deleting a column that still has tasks
- Fixed intermittent UI test failures from Vite dev server startup race

---
type: Reference
title: Settings panel
description: "Layout of the Settings panel: project and system tab groups and the three system tiers, why a tab must match where its setting persists, what the Task, Performance and Terminal tabs hold and why, where each project tab saves, multi-token search, and how the Hotkeys tab captures and conflict-checks rebinds."
tags: [settings, tabs, search, hotkeys]
sources:
  - resource: src/renderer/components/settings/settings-tabs.ts
  - resource: src/renderer/components/settings/settings-registry.ts
  - resource: src/renderer/components/settings/settings-search.tsx
  - resource: src/shared/keybindings.ts
    title: KEYBINDINGS
---
# Settings panel

The panel uses a VS Code-style layout: a sidebar with tab navigation on the left and the active settings pane on the right. It opens from the titlebar gear icon or the gear icon on each project row in the sidebar, and a project switcher dropdown in its header switches between projects. A search bar at the top filters settings by keyword. Search uses multi-token matching (all tokens must appear in the setting name or description). Results are grouped by tab with match count badges on the sidebar; tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter. The [user guide's Settings section](../user-guide/settings.md) lists every tab with its group and tier.

## Project and system tabs

Each tab in `SETTINGS_TABS` (`settings-tabs.ts`) declares a `category`:

- `'project'` tabs (General, Theme, Agent, Git, Browser, Shortcuts) hold per-project settings, save to `.kangentic/config.json` (Shortcuts to the board config files), and are hidden when no project is open.
- `'system'` tabs (Board, Task, Changes, Terminal, Behavior, Performance, Hotkeys, Notifications, Workflows, Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer) hold shared settings that apply across all projects, save to the global config, and stay fully usable with no project open. When no project is open, only the system tabs appear.

A thin full-bleed divider, not just the "System" text label, marks the Project/System boundary, because that split is behavioral (system tabs must work with no project open), not only organizational. There is no Global/Project scope toggle. When adding a setting, its `tabId` must match its persistence scope: see `.claude/rules/settings-tab-scope.md`, enforced by `tests/unit/settings-tab-scope-parity.test.ts`.

System tabs are grouped again into three sidebar tiers (`tier` on each tab): Core (Board through Notifications, unlabeled, directly under the System header), Advanced (Workflows through Mobile Devices), and Other (Privacy, Developer). Tiers must stay contiguous; `settings-tab-scope-parity.test.ts` enforces it. Order within each group (Project, and each System tier) is curated by frequency and concept rather than alphabetical, since the search bar already covers lookup by name. The comment above `SETTINGS_TABS` says why.

## What each tab holds

- **Task** holds task-presentation settings split out of Board (Card Density, Ticket Numbers) and Terminal (the whole Context Bar section). Those describe how an individual task presents itself, not board layout or terminal cosmetics, so Board keeps `columnWidth` and the board-level Config Sync and Window settings, and Terminal keeps shell, font, cursor and colors.
- **Performance** holds app-wide rendering: Graphics acceleration (Chromium hardware rendering, which the GPU recovery path in `src/main/index.ts` turns off after a run the GPU killed) and Animations, which moved from Board because it toggles `.no-motion` on `<html>` and was never board chrome. It also holds Pausing agents (low memory, and the idle timer that left Behavior).
- **Knowledge Graph** keeps its own hardware row, named "Model acceleration": it pairs with Search quality as one speed-versus-accuracy decision, and the name keeps it distinct from Performance's Graphics acceleration.
- **Terminal** (shell, font, cursor style, colors) is global-only, not per-project. Shell in particular was never reliably project-scoped at the PTY-spawn level (`SessionManager` caches a single `configuredShell` keyed to whichever project is currently focused, `src/main/pty/session-manager.ts`), so a background project's spawn or resume could silently pick up the wrong shell.
- **Theme** is its own tab, not folded into General, so it has a sidebar entry distinct from Project Location.

## Where each project tab saves

General saves `project.location` to the project record in the global index database, through a "Change..." button that re-points the project after its folder is moved or renamed, preserving tasks and history, which are keyed by project id. Theme saves `theme`, `themeFollowsSystem`, `themeLight` and `themeDark` to `.kangentic/config.json`; Agent, Git and Browser also save there; Shortcuts saves to the board config files (`kangentic.json` and `kangentic.local.json`).

The Agent tab exposes `project.defaultAgent` (the "Agent" combobox), the agent CLI used for new sessions in this project, with `project.defaultModel` and `project.defaultEffort` (the "Model" and "Effort" comboboxes), the project-level model and reasoning-effort defaults applied when no column or task override is set. Like `project.location`, all three are stored on the project record in the global index database rather than in `AppConfig`. When the selected agent declares remote-execution support (today: OpenCode only), the Agent tab also shows an Execution mode row right below the CLI Path row, letting the project run that agent locally (the default) or attach to a server it declares support for; see [Remote Execution](app-config.md#remote-execution). An agent without the capability shows none of these rows.

Changes save immediately. New projects inherit only the seeded settings subset (`theme`, `themeFollowsSystem`, `themeLight`, `themeDark`, `agent.permissionMode`, `git.*`) from the most recently configured project, falling back to defaults if none exist. Project-specific data such as `browser.defaultUrl`, `importSources`, and `agent.execution` (a remote server's working directory is specific to the project it was configured for) is stored per-project and is never cloned into a new project.

## Hotkeys

Lists every keyboard hotkey in one card per area (General, Dictation, Task detail, Git changes, Windows, Browser, Terminal, Developer) and lets the user rebind the configurable ones. Global-only (per-machine). Each row's capture widget records the next key chord or a mouse button press (middle or side buttons, so an action can be bound to either input; Escape cancels) and probes whether that combo is already claimed by the OS or another app (via the `keybindings:probeGlobal` IPC channel), warning if so. Two actions resolving to the same combo in overlapping scopes are flagged as a conflict. Reset-to-default is available per row and for all at once. Terminal clipboard combos (Copy, Paste) and Escape are shown read-only. The registry of every hotkey + default combo lives in `src/shared/keybindings.ts`; handlers read their effective combo through the `useKeybinding` hook. Overrides persist to the `hotkeyOverrides` key (see [Top-Level](app-config.md#top-level)). The **Git Changes** group adds four cross-file diff-navigation hotkeys for the Changes panel, scoped to the task dialog and gated on the focused window: `changes.nextChange` (Alt+Down, also F7) and `changes.prevChange` (Alt+Up, also Shift+F7) step through hunks and roll over into the adjacent file at the boundaries, while `changes.nextFile` (Alt+Shift+Down) and `changes.prevFile` (Alt+Shift+Up) jump whole files. The **General** group also carries the description editor's three fixed formatting keys, shown read-only for the same reason the terminal clipboard combos are: `description.bold` (Mod+B), `description.italic` (Mod+I), and `description.link` (Mod+K) wrap the selection in markdown, and are handled inside the editor's own keydown handler rather than through `useKeybinding`. Their sibling `description.pastePlain` (Mod+Shift+V) is `hidden` and so does not appear at all. Because `detectConflicts` resolves rebindable actions only, a later rebind landing on one of these four combos is not flagged as a conflict; the listing is the warning.

## Privacy

The Privacy tab is informational only. It displays what anonymous telemetry Kangentic collects (app launches, platform, the previous run's duration, crash reports, task/session counts, daily feature-usage counts, and a once-per-launch list of which global settings differ from their defaults) and what it does not collect (task content, file paths, usernames, code). Usage analytics are powered by Aptabase (no cookies, GDPR-compliant, plus one anonymous non-reversible install id for unique-install counting); crash and error reports go to Sentry with the home directory and each registered project folder removed from every text field of a report. Set `KANGENTIC_TELEMETRY=0` as an environment variable to disable all telemetry, or `KANGENTIC_ERROR_REPORTING=0` to disable only error reporting (see [Usage analytics](../telemetry/usage-analytics.md)). It points to the Knowledge Graph tab for the (fully local) conversation-search controls. Global-only (per-machine).

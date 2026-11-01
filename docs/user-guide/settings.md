---
type: Guide
title: Settings
description: "Every Settings tab in the unified panel: project tabs (General with Move project, Theme, Agent, Git worktree and PR settings, Browser, Shortcuts) and shared tabs (Language, Board, Task, Changes, Terminal, Behavior, Performance, Hotkeys, Notifications, Workflows, Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer)."
tags: [settings, tabs, git, notifications, dictation]
sources:
  - resource: src/renderer/components/settings/settings-tabs.ts
    title: SETTINGS_TABS
---
# Settings

Settings are accessed from two entry points, both opening the same unified panel:

- **App Settings** - click the gear icon in the title bar. Scoped to the currently active project (or, if none is open, only the shared System tabs appear).
- **Project Settings** - click the gear icon on a project row in the sidebar. Opens the same panel scoped to that project, with a project switcher dropdown in the header to jump between projects.

Both panels use a VS Code-style layout: a sidebar with tab navigation on the left, and the active settings pane on the right. Tabs above the divider (General, Theme, Agent, Git, Browser, Shortcuts) are per-project settings; tabs below it (Language, Board, Task, Changes, Terminal, Behavior, Performance, Hotkeys, Notifications, Workflows, Dictation, Knowledge Graph, MCP Server, Agent Browser, Mobile Devices, Privacy, Developer) are shared across all projects. The shared tabs are further grouped into Core (Language through Notifications, unlabeled), Advanced (Workflows through Mobile Devices), and Other (Privacy, Developer). The Performance tab holds Graphics acceleration (see [Graphics failures](troubleshooting.md#graphics-failures)) and Animations, which moved there from Board because it applies to the whole app rather than the board. The General tab shows the project's location on disk with a "Move..." button (see [Moving a project](#moving-a-project)); the Theme tab holds the interface color-scheme picker. The Task tab (Card Density, Ticket Numbers, Context Bar) holds settings for how an individual task presents itself, split out from Board and Terminal. Terminal (shell, font, cursor style, colors) is a shared tab, not per-project: nobody wants a different font per project, and the shell setting in particular was never reliably project-scoped under the hood. When no project is open, only the shared tabs appear.

## Moving a project

To relocate a project to a new folder, open Project Settings > General and click **Move...**. Pick the destination's parent folder; Kangentic moves the project folder (keeping its name) into it and re-points the project at the new path in one step. All tasks, board history, and worktrees move with it, and each agent's resumable session data is migrated so sessions resume at the new location.

Before the move, a confirmation dialog lists the project's active agent sessions. Confirming stops them (they resume automatically at the new path) and performs the move; cancelling changes nothing. Only this project's own sessions are touched - agents running in other projects or external terminals are left alone.

A same-drive move is instant. Moving to a different drive copies the folder (a progress indicator shows the copy), then removes the original once the relocation has succeeded; if the original cannot be fully removed, the move still completes and a warning notes that the old copy remains.

If a project's folder was moved or renamed outside Kangentic while the app was closed, you are instead prompted with **Project Folder Not Found** the next time you open it; click **Locate Folder...** to point Kangentic at the new location.

## Language

The Language tab (a shared setting, first in the list) holds one card, Display language, with a picker
of the languages Kangentic ships. Each row shows the language's own name and its code, such as
"English (en)", and the current one is checked. The picker lists English and 14 other languages. Their
translations are machine-made and open to review.

Picking another language asks to restart: "Switch to {language}?" with Cancel and Restart now. Only
Restart now saves the choice (`displayLanguage` in the global config), and Kangentic restarts with it.
The language never switches without a restart. It covers menus, settings and dialogs. Agent output and
terminal text keep their own language.

Kangentic always starts in English. The first time you open it, if your operating system's language is
one Kangentic ships and is not English, a toast offers to switch, with its title and button in that
language. Closing the toast or answering the prompt ends the offer for good.

## Search

A search bar at the top of each panel filters settings by keyword. Type multiple words to narrow results (all tokens must match). Results are grouped by tab, and each sidebar tab shows its match count right after its name. Tabs with zero matches are dimmed. Press Ctrl+F (Cmd+F on macOS) to focus the search bar, Escape to clear the filter.

## Themes

The Theme tab (a per-project setting) shows the 12 themes as a grid of tiles, each painted in
its own colours, so you pick by eye. Rest the pointer on a tile to try that theme on the whole
app without changing anything; move off the grid and it reverts. Click a tile to keep it, or
with the grid focused use the arrow keys, Home and End, or type the first letter of a name; the
app repaints as the selection moves. The tiles are grouped by whether the theme is dark or
light underneath:
- **Dark:** Graphite, Rust, Moon, Forest, Ocean, Ember
- **Light:** Paper, Clay, Sand, Mint, Sky, Peach

Graphite and Paper are the neutral defaults. Rust and Clay are the product palette, built from
kangentic.com's own tokens, so the app and the site read as one surface; their tiles carry the
brand mark. Colour only: the site's typefaces do not come with the theme, and the terminal keeps
its own colour scheme (see Terminal Colors below). Searching Settings for a theme's name finds
the picker. (In `config.json` Graphite and Paper keep their original ids, `dark` and `light`;
the others are their lower-cased names.)

**Follow system appearance**, the switch above the grid, keeps one theme for when the OS is
light and another for when it is dark. With it on, each group in the grid has its own selected
tile and the other tiles dim so the pair stands out (a dimmed tile still previews on hover and
can be picked); the app paints the one that matches the OS right now and switches the moment
the OS does, with no restart. Turning it on keeps the theme you had (it becomes that group's
choice), and turning it off keeps whichever theme is showing. The launch background follows the
same rule, so a follow-system install opens in the right colour.

## Terminal Colors

The Terminal tab's **Colors** section (not the Theme tab's color-scheme picker - this is a global setting, not per-project) lets you customize the terminal's background, foreground, and cursor color. Click a swatch to open the color picker; any color left at its default shows the built-in value (near-black `#0c0c0c` background, `#e4e4e7` foreground/cursor). The preset grid offers the built-in default first, then a color matching your current app theme (skipped if it would duplicate the default), then curated generic presets. The 16-color ANSI palette (used by shell tools like `git diff` and `ls --color`) is a fixed scheme based on Windows Terminal's Campbell, not individually customizable. "Reset to default" clears every customization. Applies globally across all projects.

## Terminal Settings

Applies to every project (Settings > Terminal, not a per-project override):

| Setting | Description |
|---------|-------------|
| Shell | Override the auto-detected shell |
| Font Size | Terminal text size in pixels, from 8 to 32 |
| Font Family | Terminal font, picked from your detected system fonts via an autocomplete field |
| Cursor Style | Terminal cursor appearance (block, underline, or bar) |

Font and cursor start where your platform's own terminal does: Cascadia Mono with a bar cursor on Windows, Adwaita Mono with a block cursor on Linux, and Menlo with a block cursor on macOS, all at 14px. An install still on the old shared default moves to these once; a font or size you picked is kept. Every terminal has an 8px inset on its left, top and bottom. The per-platform values are in [App config](../settings/app-config.md).

## Board Settings

Applies to every project (Settings > Board, not a per-project override). Two cards: **Board layout** and **Config sync**.

| Setting | Card | Description |
|---------|------|-------------|
| Column width | Board layout | Width of the board's columns: Narrow, Default or Wide |
| Terminal panel | Board layout | Show the terminal panel below the board (on by default) |
| Status bar | Board layout | Show the status bar at the bottom of the window (on by default) |
| Auto-apply board config changes | Config sync | Apply a detected `kangentic.json` change at once instead of asking you to confirm it (off by default). See [Applying Changes](board-basics.md#applying-changes) |

## Task Settings

Applies to every project (Settings > Task, not a per-project override). These describe how an individual task presents itself, not board layout or terminal cosmetics:

| Setting | Description |
|---------|-------------|
| Card Density | Amount of detail shown on task cards (compact, default, comfortable) |
| Card Preview | The text under each card's title: the latest agent message (default), recent agent messages one line each, or the task description |
| Ticket Numbers | Show each task's `#N` number as a muted badge on its card (on by default) |

With Card Preview at its default, a card whose agent is running prints that agent's newest message in place of the description, in a shaded terminal panel, wrapped to three lines at default density, five at comfortable, one at compact. **Recent** prints the agent's newest messages one line each and newest last in those same lines, for a sense of the agent's last few steps instead of one whole thought. The text updates live as the agent works. The panel appears exactly when the card's activity glyph does, including while the agent is waiting on you, and the moment the session pauses or ends the card goes back to showing the task description. A task with no session, or whose agent has not said anything yet, shows its description too. The Agent Monitor's cards honor the same setting and render it the same way. The Task tab also holds the Context Bar toggles below.

## Context Bar

The context bar is a status line displayed below the terminal showing session metadata. Each element can be individually toggled on or off in App Settings > Task.

| Toggle | What it shows |
|--------|--------------|
| Shell Name | The active shell name (e.g., pwsh, bash, zsh) |
| Version | Agent CLI version |
| Elapsed | Ticking wall-clock time since the session started |
| Model | Active model name (e.g., Claude Sonnet 4) |
| Cost | Cumulative session cost in dollars |
| Tool Calls | Cumulative count of completed tool calls |
| Agent Active | Agent active time reported by the CLI (off by default) |
| Tokens | Token usage (input + output) |
| Context Fraction | Context window usage as a percentage |
| Progress Bar | Visual progress bar for context window usage |
| Rate Limits | Adapter-reported plan-usage quota bars (e.g. Claude reports 5-hour session and 7-day weekly windows, and only the windows its plan has). A window disappears once its reset time passes, and the bars hide when none is left. Hidden for adapters that do not report rate limits. |

## Changes Settings

Applies to every project (Settings > Changes, not a per-project override). These are the defaults for the [Changes panel](task-detail.md#changes-panel) and its file diffs. The diff's own layout, whitespace and wrap toggles write the same settings, so a choice made there sticks.

| Setting | Description |
|---------|-------------|
| Layout | Side by side (default) or inline |
| Default diff scope | What a freshly opened panel shows: uncommitted edits (default), staged changes, or the whole branch against its base. The panel's scope control changes it for that panel only |
| Ignore whitespace | Hide whitespace-only changes (off by default) |
| Collapse unchanged regions | Fold large unchanged spans so only the changed hunks show, with a little context (off by default) |
| Wrap long lines | Wrap long lines instead of scrolling the diff sideways (off by default) |
| Inline when narrow | Show a narrow diff inline even when Layout is side by side (on by default) |
| File sort | Order files by name (default), status, size, or extension |
| Flat file list | List full paths instead of a folder tree (off by default) |

## Agent Settings

| Setting | Description |
|---------|-------------|
| Default Agent | Which agent CLI to use for new sessions in this project. Supported agents: Claude Code, Codex CLI, Gemini CLI, Antigravity CLI, Qwen Code, Kimi Code, OpenCode, Droid (Factory), Cursor CLI, GitHub Copilot CLI, Aider, Oz CLI (Warp), Ollama, Grok Build, Goose CLI. Per-project setting. |
| CLI Path | Path to agent CLI binary (auto-detected if empty) |
| Execution (remote) | For agents that support it (today OpenCode), attach to a server you run instead of spawning a local process: server URL, authentication, and the server-side working directory. Shown only when the selected agent declares remote execution. |
| Launch Options | Agent-specific startup toggles (today Codex's "Disable ChatGPT Apps", which skips the optional cloud ChatGPT Apps connector that can hang startup). Shown only for agents that declare options. |
| Permissions | Default permission mode for all sessions. Options vary by agent (e.g., Claude Code has Plan, Don't Ask, Default, Accept Edits, Auto, and Bypass; Aider has Interactive and Auto-Approve) |

All permission modes are available in both the global App Settings dropdown and the per-column Edit Column dialog. The dropdown shows only the modes supported by the active agent. Each column can override the project default agent via the Edit Column dialog. When a task moves between columns with different agents, a context handoff occurs automatically - see [Column Management](columns-and-automations.md).

## Git Settings

Three cards: **Branches**, **Worktrees**, and **Pull requests**.

| Setting | Card | Description |
|---------|------|-------------|
| Default base branch | Branches | Branch new worktrees start from (default: main) |
| Auto-fetch remote | Branches | On by default. Fetches all remotes 5 minutes after the project's last full fetch, so "behind" counts stay current. Any full fetch resets that clock: opening the Changes panel, the Done check, or this sweep. Creating a worktree always fetches its base branch first, even with this off. Off, the project still fetches when it opens |
| Worktrees | Worktrees | On by default. Gives tasks the option to run in their own git worktree: the New Task dialog then offers Worktree or Project, starting on Worktree. Off, the dialog does not offer the choice and tasks run in the project folder, including one created earlier with Worktree picked. A task that already has a worktree keeps it. The rows below show only while this is on |
| Auto-cleanup | Worktrees | Remove a task's worktree when the task completes |
| Link node_modules | Worktrees | Symlink the root `node_modules` into each worktree to skip a fresh install (on by default). Turn off to let the Post-worktree script install the worktree's own dependencies. Workspace repos should turn it off: a linked worktree imports the main checkout's code for its workspace packages, and pnpm's per-package `node_modules` are not linked |
| Copy files | Worktrees | Files to copy from repo root into each new worktree, such as `.env` |
| Post-worktree script | Worktrees | Shell script run in each new worktree after creation (e.g. `npm install`). When you move a task into a column that starts an agent, or an MCP tool starts one, the agent starts while the script runs (see the next row); creating, promoting or restoring a task starts it after the script. Other tasks' git work does not wait for it. A non-zero exit or timeout fails worktree creation |
| Hold prompt for script | Worktrees | Shows while a Post-worktree script is set. On by default: an agent that can take its first prompt typed (Claude today) starts while the script runs and gets that prompt once the script succeeds, and any other agent starts after the script. A failed script fails the task as before. Off, every agent starts on its prompt at once, is told the script is still running, and a failed script is reported on the task and to the agent instead of moving the task back. Off saves the whole install; on saves the agent's start-up |
| Auto-refresh PRs | Pull requests | On by default. Checks each open PR about 2 minutes after its own last check, one call at a time and at least 10 s apart, so at most 360 calls an hour however many PRs are open. Any check resets a PR's clock: this queue, the 30 s re-poll while CI runs, an agent's `gh pr create`, or a manual refresh. Past 12 open PRs each PR's interval stretches instead of the cost growing. Off, PRs are checked when the project opens and nothing re-polls one whose checks are running |
| Count merge bypass as ready | Pull requests | On by default, GitHub only. Ready means you could merge the PR now. A PR still waiting on a required review reads `blocked` even when you can bypass that rule and merge it yourself, which is how the Merge column already lands PRs. That stays true once somebody else's PR lands and leaves yours behind the base. On, such a PR reads `ready`, at one extra `gh` call per such PR per check. Never past a check: the same call reads the branch's required checks and every one must have reported green. Turn it off to keep the review norm even where you could bypass |

Azure DevOps PRs always get their branch policies checked (reviewer minimums, required builds, work-item linking), so a clean Azure PR reads `ready` or `blocked` the same way a GitHub one does. Kangentic does not read Azure DevOps bypass permissions yet.

## Browser

Per-project. The Browser tab holds this project's [Browser pane](task-detail.md#browser-pane) settings. What agents may do in the pane is the shared [Agent Browser](#agent-browser) tab.

| Setting | Description |
|---------|-------------|
| Browser pane | Embed a Browser pane in this project's task windows (on by default). Off, task headers show no Browser pill and agents cannot open the pane |
| Default URL | The page a task's pane opens when the task has no URL of its own. Saved the first time you navigate the pane |
| Clear browser data | Wipe the embedded browser's cookies, storage, service workers and caches, keeping saved URLs. It clears the browser for every project, not only this one |

## Shortcuts

The Shortcuts tab lets you add custom command buttons to the task detail dialog. Each shortcut has a label, icon, shell command, and display location (header bar, kebab menu, or both).

Commands support template variables: `{{cwd}}`, `{{branchName}}`, `{{taskTitle}}`, `{{projectPath}}`. These are resolved at runtime using the active task's context.

Shortcuts can be scoped as **Team** (saved in `kangentic.json`, shared via git) or **Personal** (saved in `kangentic.local.json`, local-only). Presets are available for common tools (VS Code, Cursor, GitHub Desktop, terminal emulators, file managers).

## Scope

Settings have two scopes:
- **Global** - applies to all projects
- **Project** - overrides global settings for this project only (stored in `.kangentic/config.json`)

Some settings are global-only and cannot be overridden per-project (e.g., max concurrent sessions, sidebar width).

## Behavior Settings

These are global-only settings that apply to the entire app.

| Setting | Description |
|---------|-------------|
| Max Concurrent Sessions | Limit how many agents can run at the same time. A request past the limit waits in the [Session Queue](sessions-and-worktrees.md#session-queue). |
| Auto-Focus Idle Sessions | Automatically switch the bottom panel to idle sessions. Idle tabs stay highlighted either way. |
| Auto-Resume Agents on Restart | Resume agent sessions that were running when the project last closed. Turn off if resuming many at once slows your machine. |
| Stop Leftover Processes | Stop what an agent left running in its folder when its task is done, moved back to To Do, or deleted, or when its Command Terminal ends. Off, nothing is stopped and the toast still lists what kept running. |
| Close on Outside Click | Click empty space outside a task window to close it. Controls, task cards, and running terminals still act on the first click. An edit form with unsaved changes asks to save first. Closing a window does not kill its session. |
| Restore Window Position | Remember window size and position between launches |

The Board tab has its own Auto-apply board config changes switch. See [Board Settings](#board-settings).

## Performance Settings

Global-only, like Behavior.

| Setting | Description |
|---------|-------------|
| Graphics Acceleration | Hardware rendering for the app window and terminals. A change restarts Kangentic. See [Graphics failures](troubleshooting.md#graphics-failures). |
| Animations | Transition and motion effects across the app. |
| Pausing agents: When memory runs low | On by default. While memory runs low, pause the agent that has waited on you longest, one a minute, until there is room. See [Pausing agents](sessions-and-worktrees.md#pausing-agents). |
| Pausing agents: When idle | Off by default. Pause any agent that has waited on you for the minutes on its second line, Minutes idle (30 by default). Command Terminals are never paused. |

## Hotkeys

Applies to every project. Settings > Hotkeys lists every shortcut by area. A rebindable one takes a new key chord or mouse button and has its own reset, and **Reset to default** restores them all after asking. The tab flags a combo that clashes with another shortcut or is already claimed by the OS or another app, and counts the conflicts at the top. [Keyboard shortcuts](keyboard-shortcuts.md) lists every default and which ones are fixed.

## Workflows

Applies to every project. Two agent cards and the workflow agent's first message:

| Setting | Description |
|---------|-------------|
| Workflow agent | Agent, Model and Effort for the agent that plans each workflow in the Workflows view's left pane. No workflow agent starts until one is chosen, and Model is required when the agent takes one |
| Automation agent | Agent, Model and Effort for the agent that answers column Conditions, judges workflow steps, and names tasks and Command Terminals. Nothing runs until one is chosen. A small, fast model is usually enough |
| Workflow agent prompt | The first message a new workflow's agent gets |

See [Workflows](workflows.md) and [Columns and automations](columns-and-automations.md) for what each agent does.

## Dictation

Applies to every project (Settings > Dictation, not a per-project override). Voice dictation is off by default. Turn it on, then hold the push-to-talk key and speak. The text goes into the field you have focused, or into the terminal when no text field has focus. A live preview streams in while you talk, and the final text is inserted when you let go. The push-to-talk key is the mouse's back button unless you rebind it in Hotkeys, and a quick tap on it still navigates an active Browser pane's history. Everything runs on this machine unless you choose a cloud refinement.

| Setting | Card | Description |
|---------|------|-------------|
| Voice dictation | Voice dictation | The switch for the whole feature. Off hides every row below |
| Push-to-talk | Voice dictation | Shows the current key. **Rebind** opens Hotkeys |
| Release buffer | Voice dictation | Keeps recording up to 500 ms after you let go so the last word is not clipped (250 ms by default, 0 turns it off) |
| Auto-submit | Voice dictation | Press Enter after inserting the text (on by default). Off leaves the text for you to review and send |
| Language | Transcription | The language you speak. English offers every model, and another language narrows the choice to the multilingual ones |
| Mode | Transcription | Best, Balanced and Light each pick the live and refinement models for you. Custom lets you pick both |
| Live model | Transcription | Custom only. The preview while you speak. A streaming model is instant and a chunked one is more accurate |
| Refinement model | Transcription | Custom only. Re-reads the clip on release for the final text, and None keeps the live text. **Cloud endpoint** sends the final clip to an OpenAI-compatible `/v1/audio/transcriptions` URL, with an optional API key and model, while the live preview stays on this machine |

Under these rows the Transcription card lists the models the setup runs, whether each one is downloaded, and their licenses. [Dictation](../architecture/dictation.md#dictation) lists the models behind each Mode.

## Knowledge Graph

Applies to every project. The **Index** card decides what Quick Find and the Knowledge Graph search, and the **Knowledge Graph** card turns on finding by meaning and answering questions.

| Setting | Card | Description |
|---------|------|-------------|
| Index | Index | Index conversations, tasks and commits on this machine (on by default). Off, nothing is indexed and Quick Find shows no conversation hits |
| Task summaries | Index | A sentence or two per Done task, so questions find it |
| Source code | Index | Index the project's code and docs, so answers can explain them |
| Knowledge Graph | Knowledge Graph | Find your work by meaning and answer questions |
| Search quality | Knowledge Graph | The local model that finds by meaning. Changing it re-indexes in the background |
| Model acceleration | Knowledge Graph | Where the local model runs. Auto uses the GPU when there is one |
| Agent, Model, Effort | Knowledge Graph | The agent that answers questions and writes the task summaries. A small model answers as well and faster, but invents more details in summaries |

[Knowledge Graph](knowledge-graph.md) covers what each source holds and how questions are answered.

## MCP Server

The MCP Server tab controls the built-in Model Context Protocol server. When enabled, agents running inside Kangentic get access to MCP tools for creating tasks, querying the board, and viewing session stats. Disable this if you don't want agents to interact with the board programmatically.

| Setting | Description |
|---------|-------------|
| Kangentic MCP Server | Enable or disable the built-in MCP server that gives agents board-aware tools |
| MCP connection | Whether agents can reach the server: Connected, or Failed with the error the check hit. Checked each time the tab opens, from this machine and from any WSL distro a CLI path points into; Test connection checks again |

If an agent session starts and its tools cannot connect, Kangentic shows one notice per run, "Couldn't reach the MCP server", with the same error and an Open settings button.

## Agent Browser

The Agent Browser tab controls whether and how agents may drive the embedded Browser pane via the `kangentic_browser_*` tools (screenshot, click, type, navigate, and more), so an agent can verify a dev server you have loaded. It is a global (per-machine) policy, separate from the per-project Browser tab.

| Setting | Description |
|---------|-------------|
| Enable Browser Automation | Master switch. Turn off to disable all agent browser control. |
| Allow Interaction | Let agents click, type, press keys, and drag. Off is observe-only (screenshots and DOM reads still work). |
| Allow Navigation | Let agents point the pane at other URLs. Off confines agents to the page you loaded. |
| Allow Eval | Let agents run arbitrary JavaScript in the loaded page. Off by default. |
| Restrict Navigation to Localhost | Only allow agents to navigate the pane to localhost / private hosts. Off by default. |

## Notifications

Notifications fire when an agent needs attention and you cannot already see it. The two channels cover opposite halves of that, so between them nothing is missed and nothing is said twice.

Desktop notifications are for when you are away: they fire only when the window is minimized or unfocused, or a different project is active. The one exception is a stalled workflow, which shows even while the window is in front. Notification events: an agent waiting on you, session crash (non-zero exit), plan-completion auto-moves, a stalled spawn, a finished workflow, and a stalled workflow. An agent waiting on you is titled by what happened: "Agent went idle" (it finished its turn), "Agent has a question", "Agent needs your approval" (a tool to allow or a plan to approve), or "Agent needs your input" when the agent does not report which. Its body is the task's title, then " - ", then the project ("Cap retries in the sync client - sync-service"); a Command Terminal's reads "Command Terminal - <project>". For the other events the task name is the title (a finished workflow's reads "Workflow complete: <name>") and the project name is the body. For a task in a workflow, the place names the workflow after the project ("kangentic: Usage budgets workflow"). Clicking one brings the window to the foreground, switches to the correct project, and opens the task detail dialog (a finished workflow names no single task, so it opens none). The taskbar also flashes on Windows. A 10-second cooldown prevents the same agent repeating the same kind of desktop notification. Idle and crash are counted separately, so an agent that dies right after finishing a turn still reports the crash. A newer desktop notification for a task replaces that task's older one in Windows Action Center or macOS Notification Center, so they do not stack. Command Terminal notifications are the exception and still stack. A Notify me automation row is not one of these events: it notifies the desktop and every paired phone whatever these settings and the phone's own alert switches say, because the row itself is the choice to be told.

Toasts are for when you are here but looking elsewhere. Every notification toast is scoped to the open project, so a background project speaks through the desktop channel alone. The idle toast fires when an agent finishes its turn, has a question, or needs your approval, titled the same way ("Agent finished" for a finished turn), and is skipped when that session's terminal is already on screen: a task-detail window, the in-app or detached Agent Monitor, or a phone streaming it. A click on it opens the task. One toast per turn, not one per progress update.

Every toast has a title over one line of detail. One that closes on its own draws a thin line along its bottom edge that fills as its time runs out; hovering it holds the time until the pointer leaves. A toast about one thing (a task, a list, a workflow, a downloaded file) opens it when clicked. A toast that stays until closed carries a button instead (Review, Settings, Run again, Restart to update). While a dialog or the settings panel is open, toasts take no clicks, so one sitting over a dialog's buttons never swallows them. Toasts also show in detached windows such as the Agent Monitor.

The Settings > Notifications panel exposes six configurable events: **Agent idle** (all three waits: a finished turn, a question, an approval), **Agent crash** (session exit; desktop alerts on error exits only, toasts also cover clean exits), **Plan complete**, **Workflow complete** (every task in a workflow reached Done), **Workflow stalled** (a running workflow cannot move a task on by itself), and **Spawn stalled** (a task spawn that waits too long on the git queue while preparing). Each can be set to Off, Desktop, Toast, or Both. Toast duration and max visible count are also configurable.

A task in a running workflow raises no plain idle notice. Its step check notifies instead: at once, with why, when the agent waits on you, and once, as Workflow stalled, when recovery runs out (see [Workflows](workflows.md)). The stall's desktop notice shows even while the window is in front, since it is the only one. A paired phone gets both as "Agent needs your attention".

## Mobile Devices

The Mobile Devices tab is the desktop half of the mobile companion app's pairing link - global (applies to this desktop installation, not any one project) and off by default. Below the **Mobile Bridge** toggle it splits into two sections: **Relay** (where this desktop connects) and **Mobile** (which phones may use it). Each ends in a documentation link that stays usable with the bridge off, since someone still deciding whether to enable it is exactly the person who has not.

Enable the toggle, then pick a **Relay**: *Kangentic* (the default, the one Kangentic operates) or *Custom* (your own self-hosted address). Dev builds also offer a *Local* option pointing at a relay on localhost. The address being dialed always sits in the field directly beneath the picker, read-only for the presets and editable for a custom relay, so there is one place to look regardless of which you chose; a shield in front of it marks the Kangentic-operated relay and appears for nothing else. **Test connection** probes that address before you pair: it reports whether the relay answered and how long it took, or prints why it did not. The relay forwards encrypted traffic and never holds your keys; **How the relay works** opens the relay documentation, which covers what it does, what an operator can still observe, and how to run your own. A custom address must use `wss://`, or `ws://` for localhost only, since the phone refuses to pair over an untrusted transport.

Click **Pair a device** to display a QR code; scanning it with the Kangentic mobile app starts an end-to-end encrypted pairing handshake. Once the handshake completes, both the desktop and the phone show the same short code - compare them, then tap **Confirm** on the phone. The desktop auto-enrolls the device as soon as it hears back; there is no second confirmation to make on the desktop. This catches a photographed or relayed QR, since an attacker cannot make both sides show the same code. To back out, cancel on the phone (or close the desktop's pairing panel) before confirming.

The phone is treated as an extension of your own desktop, not a separate integration to configure: pairing grants it full access to every capability the protocol defines (there is no shell, file, or arbitrary-command access in the protocol at all). Paired devices appear in a list below, identified by a key fingerprint you can compare against the phone's own Settings > Devices screen, along with their connection status and paired date. Rename a device from that list, or revoke it - revoking removes it from the desktop's signed roster immediately, and a revoked phone must be paired again from scratch to reconnect. See [Pairing and device roster](../integrations/mobile-bridge/pairing-and-roster.md) for the underlying protocol, pairing ceremony, and security design.

The Mobile section closes with **How to install and pair**, which opens the [Kangentic Mobile docs](https://kangentic.com/mobile/): installing the app, pairing a phone, and push notifications. It is always present, in both directions - it stays usable with the bridge toggle off, since someone who has not installed the app yet is exactly the person who has not enabled the bridge, and it does not disappear once phones are paired, since that link is a docs landing page rather than an install page and you may well be adding a second device. Install instructions live on the website so they stay current between desktop releases; while a store rollout is in progress, the in-app Announcements dialog carries the signup steps for the current phase.

## Privacy

The Privacy tab shows what anonymous telemetry Kangentic collects (app launches and the previous run's duration, crash reports, task and session counts, daily feature-usage counts, and a once-per-launch list of which global settings differ from their defaults) and how to opt out. Usage analytics are powered by Aptabase (no cookies, GDPR-compliant, plus one anonymous non-reversible install id used only to count unique installs); crash and error reports go to Sentry with the home directory and each registered project folder removed from every text field of a report. Set `KANGENTIC_TELEMETRY=0` as an environment variable to disable all telemetry, or `KANGENTIC_ERROR_REPORTING=0` to disable only error reporting. It also lists `support@kangentic.com` for questions about what is collected. This tab is informational only - there are no configurable settings.

## Developer

The Developer tab exposes power-user diagnostics for the activity-detection subsystem. Settings here are global (apply to every project) and are intended for debugging only.

| Setting | Description |
|---------|-------------|
| Activity Engine Debug Overlay | Show a floating overlay with live activity-engine state for every running session: current `ActivityReason`, raw counters (pending tools, subagent depth, background shells), and a ring buffer of recent state transitions. Toggle from anywhere with Ctrl+Shift+D. Polls every 2 seconds while open; lazy-disables the IPC when closed. |

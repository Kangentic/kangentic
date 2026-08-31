## What's New

- **The Changes tab is now a proper review surface.** It splits into a changed-file rail and a diff pane with a resizable divider, and the rail carries a collapsible History section: a commit graph you can click to scope the diff to any single commit, plus a pinned "Uncommitted changes" row. Mark files viewed as you go, sort and filter the list, right-click for a file's own history, and double-click any file to pop its diff into its own window.
- **View options for diffs.** Ignore whitespace, collapse unchanged regions, wrap long lines, and render inline when the pane is narrow, all as named checkable items shared with Settings > Changes. Per-file blame annotation lives in the same menu.
- **Close a task's browser to free its memory.** Hiding the Browser pane keeps the page loaded on purpose, so an agent driving it is never interrupted when you reclaim the space. When you are genuinely finished with a task's browser, "Close browser" ends the page and gives back the memory (roughly 120 MB per loaded pane). The task's URL is remembered either way.
- **More reliable browser panes.** Panes now resolve by stable surface handles and by their own task, stay alive while hidden, and park correctly when a window closes instead of being dropped.
- **Opt-in error reporting.** Kangentic can now report crashes through Sentry alongside the existing anonymous usage events, controlled from Settings > Privacy.
- **Faster CI.** The pipeline consolidates into a single checks job with 11 UI shards, and the code-review pass gathers its review pack once instead of once per reviewer.

## Bug Fixes

- Terminal geometry is re-asserted when the agent enters its full-screen view, closing a race that could leave a freshly spawned terminal at the wrong size.
- A deleted directory no longer leaves a file watcher spinning a CPU core.
- Clicking an animated activity indicator, such as a Stop button mid-run, no longer drops the first click.
- Browser pane contents survive a dev-mode hot reload instead of being torn down.
- A window no longer docks into a dormant one, and a window is parked only when there is actually a page worth preserving.
- Escape in the Changes sort menu closes just the menu, not the whole task window.

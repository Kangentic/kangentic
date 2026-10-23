## What's New

- A completed task can now be inspected after Done removed its worktree. Its window has Summary, Changes, Conversation, Usage and Description tabs, and Changes reads the task's commits from git. Show changes and View conversation in an archived card's right-click menu open those tabs for every archived task, and a completed task's Changes and file windows can be popped out.
- The Changes panel opens with History showing, lists only commits there, and shows a bar for the selected commit that Escape clears. A commit the remote has links out to GitHub or Azure DevOps.
- Counts across the app are now a tinted pill after their label.
- Kangentic now runs on Electron 45 and the xterm.js 6.1 line, which carries upstream fixes for terminal listener and WebGL leaks.
- Error reporting moved to Sentry 8 with every optional field kept off, so reports carry no IP address, cookies, HTTP headers or request bodies.
- The Knowledge Graph's source code index leaves out a doc's frontmatter and puts the doc's one-line description on each of its passages, so questions about the docs find the right page.

## Bug Fixes

- Error reports now remove every project folder's path from their text, including projects outside your home folder.
- Switching files quickly in the Changes panel no longer raises an "Illegal value for lineNumber" error from the diff.
- A Command Terminal no longer shows the shell prompt for a few seconds before the agent appears, and a task terminal waits for the agent itself before its loading cover lifts. The cover keeps your terminal colors, and reopening a task terminal under PowerShell or cmd no longer replays the prompt and the typed command.
- A task with automations turned off keeps them off when it leaves Done, whether it is dragged out, restored from the Completed list, or moved by an agent.
- Dependency updates clear the npm audit advisories in the packages Kangentic ships.

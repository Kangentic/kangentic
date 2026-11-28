## What's New

- An SSH host now moves to the new version of Kangentic's host program by itself after an app update. It waits until every agent and Command Terminal on the host is idle, then resumes them. ([#977](https://github.com/Kangentic/kangentic/pull/977))
- Error reports from a low-memory spell or a full descriptor table now say what holds the memory or the descriptors. Settings > Privacy lists what they carry. ([#976](https://github.com/Kangentic/kangentic/pull/976))

## Bug Fixes

- A task did not move to its next column after its agent's plan was approved. ([#967](https://github.com/Kangentic/kangentic/issues/967))
- A page in the Browser pane stopped working with no message after it crashed. The pane now says the page stopped and offers Reload. ([#969](https://github.com/Kangentic/kangentic/issues/969))
- Phone push notifications stopped arriving until the phone app was restarted. ([#972](https://github.com/Kangentic/kangentic/pull/972))
- Searching a Claude terminal while Claude was working found only what was on screen, not the whole conversation. ([#971](https://github.com/Kangentic/kangentic/issues/971))
- Resuming a task on an SSH host showed No conversation found and every later Resume did the same. ([#970](https://github.com/Kangentic/kangentic/issues/970))
- Adding a git worktree or submodule folder on an SSH host as a project failed with a not a directory error. ([#966](https://github.com/Kangentic/kangentic/issues/966))

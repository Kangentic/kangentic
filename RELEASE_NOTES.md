## What's New

- A workflow task can wait on a task that is already on a board, even one that has started: pick it from Add blocker in the workflow inspector. ([#957](https://github.com/Kangentic/kangentic/pull/957))
- `kangentic_create_task` creates a task whose text names another project and says how to move it there, instead of refusing it, and `labels: []` now means the task has no labels. ([#945](https://github.com/Kangentic/kangentic/pull/945), [#944](https://github.com/Kangentic/kangentic/pull/944))
- More handled failures are reported, with enough detail to diagnose from the first report. Settings > Privacy lists what they carry. ([#951](https://github.com/Kangentic/kangentic/pull/951))

## Bug Fixes

- The Changes panel failed to load, and the Changes button counted too few files, in a project with a very large number of untracked files. ([#958](https://github.com/Kangentic/kangentic/issues/958))
- The Changes panel stopped updating by itself on Windows. ([#952](https://github.com/Kangentic/kangentic/issues/952))
- OpenCode 2 sessions no longer lose their activity plugin when another session in the project ends. ([#959](https://github.com/Kangentic/kangentic/pull/959))
- A column's multi-line message at an agent turn end could be cleared by another command sent at the same moment, and a paste that fails now says in plain words what happened. ([#949](https://github.com/Kangentic/kangentic/pull/949))
- Resuming a task whose agent never got a message showed No conversation found and paused the card. ([#946](https://github.com/Kangentic/kangentic/issues/946))

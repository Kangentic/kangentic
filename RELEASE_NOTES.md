## What's New

- **A task now tracks the branch it actually pushed.** Kangentic records the pushed branch and the base branch it resolved against, so a task whose branch was renamed locally, or pushed under a different name, no longer loses track of itself.
- **Pull request linking follows that pushed branch instead of guessing from the task slug.** A task whose branch diverged from its slug now finds its PR.
- The commit anchor in the Changes panel appears only when the connected board provider can actually supply it, rather than offering a control that leads nowhere.

## Bug Fixes

- An arriving terminal no longer steals keyboard focus after its replay was pre-empted. The focus decision outlived the replay that requested it, so it could pull you out of the pane you were typing in.
- Azure DevOps no longer sends its bearer token to hosts that are not really Azure DevOps.
- Declining a Linux update prompt is no longer filed as an application error.
- Worker processes no longer mix an inherited handle with a piped one for their output, which could stall a worker or lose what it wrote.

# Pull requests

## Connector model

* [PR connector model](connector-model.md) - The PRConnector contract, the DetectedPR and ResolvedPR shapes, PRResolveOptions, the viewer-relative merge readiness values, the two resolver error types, and the registry's remote-ownership dispatch that stops a missing CLI from wiping a PR link.

## Connectors

* [GitHub connector](github.md) - How the gh-based connector detects PR URLs, maps state and merge readiness (mergeStateStatus, the check rollup classes, required checks not yet reported, the viewer's merge-bypass probe), filters commit-tier candidates, caps gh at three concurrent calls, and treats a repo mismatch as unavailable.
* [Azure DevOps connector](azure-devops.md) - How the az-based connector parses Azure remotes, resolves by branch, number and the pullrequestquery commit tier that sees completed PRs only, builds the PR URL, folds mergeStatus and branch-policy evaluations into readiness, contains policy-fetch failures, and caps az at two concurrent calls.

## Linking and refresh

* [PR linking](pr-linking.md) - How a task finds its PR: the six-tier confidence ladder from pr_number to remote tip, the guards against linking a sibling's PR, how pushed_branch is recorded from an agent's push, what a To Do move forgets, the link entry points, and the task columns that hold PR state.
* [PR refresh and scheduler](refresh-and-scheduler.md) - What the linker does on each resolve and how checks are paced: the 60 s throttle, degrading when gh or az is missing, the confident not-found clear, holding a platform unknown, 30 s in-flight re-polls, the on-open sweep, and the per-PR queue with a 2 minute interval.

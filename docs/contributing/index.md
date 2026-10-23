# Contributing

## Working in the repo

* [Developer guide](developer-guide.md) - How to run, build and test Kangentic from source: the dev server and esbuild watch, worktree previews and their data isolation, the production and web demo builds, the unit, UI, E2E and demo test tiers, project structure, environment variables, and packaging notes.
* [Board test gate](board-test-gate.md) - How the Code Review, Testing and Merge columns gate a change on this repo's own board, what each column's skill runs, why a review pass commits in the task's own worktree, and the Ready or Blocked verdict and ledger it leaves.
* [Authoring a rule](authoring-rules.md) - How to codify a convention as a .claude/rules file in this repo, including always-on versus paths-scoped loading, measuring the context a rule adds with measure-rule-load.js, the read-trigger gap, the required sections, and choosing the strongest enforcement.

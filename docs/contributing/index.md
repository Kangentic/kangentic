# Contributing

## Working in the repo

* [Developer guide](developer-guide.md) - How to run, build and test Kangentic from source: the dev server and esbuild watch, worktree previews and their data isolation, the production and web demo builds, the unit, UI, E2E and demo test tiers, project structure, environment variables, and packaging notes.
* [Board test gate](board-test-gate.md) - How the Code Review, Testing and Merge columns gate a change on this repo's own board, what each column's skill runs, why a review pass commits in the task's own worktree, and the Ready or Blocked verdict and ledger it leaves.
* [Translations](translations.md) - How Kangentic's translations are drafted and reviewed: the translation harness that fills the PO catalogs with Claude or a local model, the fuzzy review mark, refining a translation by hand, running a refill after rewording, the glossary, the local model bake-off, and the translated READMEs with their stamp and release refresh.
* [Shared agent instructions](agent-instructions.md) - How Claude Code and Cursor read one set of instructions in this repo: AGENTS.md imported by CLAUDE.md, the skills and subagents both load from .claude/, the Cursor rules generated from .claude/rules/ and why they are gitignored, and what is still unverified in Cursor.
* [Authoring a rule](authoring-rules.md) - How to codify a convention as a .claude/rules file in this repo, including always-on versus paths-scoped loading, measuring the context a rule adds with measure-rule-load.js, the read-trigger gap, the required sections, and choosing the strongest enforcement.

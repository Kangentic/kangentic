# Rule: never commit Superpowers scratch or process docs

The Superpowers workflow generates process artifacts as it works: brainstorms, plans, design
specs, progress ledgers, briefs, diffs, and reports. These are scratch notes for the authoring
session, not project documentation. They do not belong in the repository. They add noise to the
diff, go stale immediately, and duplicate what the code and commit history already record, and
the repo is public so the leakage is worse.

## The rule

Never commit Superpowers-generated docs. Concretely:

- Nothing under `.superpowers/` (scratch ledgers, briefs, diffs, reports).
- Nothing under `docs/superpowers/` (the plan and spec markdown the workflow writes).
- No brainstorm, plan, or design-spec markdown authored by the Superpowers workflow anywhere else
  in the tree. If a design decision is worth keeping, fold it into a real project doc under
  `docs/` or a `.claude/rules/*.md` file, not a dated scratch file.

Both paths are gitignored, so `git add -A` will not stage them. Do not force-add them with
`git add -f`, and do not relocate a Superpowers doc to an un-ignored path to sneak it in.

## Enforcement (self-maintaining)

- **Mechanical (primary):** `.gitignore` ignores `.superpowers/` and `docs/superpowers/`, so the
  files can never be staged by a normal `git add`. This is the load-bearing guarantee.
- **Review:** `/code-review` flags any newly committed Superpowers scratch, plan, or spec doc
  that still reaches a diff (for example via `git add -f`, or a moved path the ignore misses).

## Scope

All committed files. Real project documentation under `docs/` and committed `.claude/` rules,
skills, and agents are unaffected. Only the Superpowers scratch and plan/spec artifacts are
forbidden.

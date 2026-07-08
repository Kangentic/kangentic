---
paths:
  - ".claude/skills/release/**"
  - "kangentic.json"
---
# Rule: release actions only inside an explicit `/release` invocation

Releasing is irreversible and outward-facing: it creates a git tag and pushes it, which triggers
`release.yml` to build platform artifacts and publish a public draft GitHub Release. A skill's
frontmatter `description` is matched by the Skill-tool router against natural-language requests,
so without a guard an agent could self-route into a full release from vague language ("release
it", "cut a release", a task titled "release X") or hand-roll the steps (`npm version`,
`git tag`, `git push --tags`) outside the skill. A Release column with `autoCommand: /release`
(Opus 4.8, xhigh) exists in `kangentic.json`, which raises the stakes on the invocation gate.

## The rule

No agent performs release actions - a release version bump, a CHANGELOG release entry, a git
tag, or pushing tags / triggering `release.yml` - except inside an explicit `/release`
invocation. "Explicit" means the literal command: typed directly by a human, or injected by the
board Release column's `autoCommand: /release` (which delivers the literal `/release` token, not
prose). Never hand-roll the release steps outside the skill. The irreversible tag-and-push always
pauses for human confirmation (the release skill's Step 4.5), even for an auto-injected
invocation - so a mistaken or automated entry still cannot ship without a pause.

## Enforcement (self-maintaining)

- **Harness (blocking):** `disable-model-invocation: true` in `.claude/skills/release/SKILL.md`
  frontmatter - the model has no tool path to invoke `/release` from a natural-language request;
  only a literal `/release` (human-typed or board `autoCommand` keystroke injection) fires it.
  This makes "started from prose" structurally unreachable, so the skill itself does not need a
  runtime check for it.
- **Skill backstop:** the Step 4.5 pre-push confirmation in `.claude/skills/release/SKILL.md`
  pauses every legitimate run right before the irreversible tag/push, regardless of which
  explicit path triggered it.
- **Review:** judgment-based backstop for an agent hand-rolling the release steps (`npm
  version`, `git tag`, `git push --tags`) outside the skill entirely - that path never reads
  SKILL.md, so no in-skill text can catch it. There is no mechanical test blocking it today; it
  relies on the flag closing the prose-routing vector, the Step 4.5 confirmation as a last line
  of defense if the skill is reached, and review to catch a hand-rolled sequence.

## Scope

Release actions only (version bump, changelog release entry, git tag, tag push). Does not govern
ordinary commits (`/commit`) or PR flows (`/pull-request`, `/merge-pull-request`, `/merge-back`),
which have their own explicit-invocation discipline (CLAUDE.md: "Only push, land, or merge when
the user explicitly asks").

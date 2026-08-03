---
paths:
  - "packages/protocol/**"
---
# Rule: every published protocol version has a changelog entry

`@kangentic/protocol` ships on its own cadence through `/release-protocol`, which bumps the
version, writes a `CHANGELOG.md` entry, commits `chore(protocol-release): protocol-vX.Y.Z`, tags,
and pushes. The tag push is what triggers `publish-protocol.yml`, so a tag is a publish.

That coupling is exactly where it drifted. Eight versions (0.2.0, 0.3.0, 0.6.0, 0.8.0, 0.9.0,
0.10.0, 0.11.0, 0.11.1) went to npm with no changelog entry, because the tags were created by
hand directly on the feature and fix commits instead of on a `chore(protocol-release):` commit.
Nothing noticed: the skill only ever prepends the newest entry, so it wrote 0.7.0 on top of a
hole and never looked down. The gap ran for six releases and was found by accident, during an
unrelated desktop `/release`, when the package read 0.11.1 and the changelog read 0.7.0. It was
backfilled in v0.32.0 by reconstructing every entry from the tag ranges.

The convention that makes this easy to get wrong is deliberate and stays: a feature commit MAY
bump `packages/protocol/package.json` ahead of its changelog entry (see 4e126bd3, "the changelog
entry lands at release time as usual"). So a version with no entry is normal before a release and
a defect after one. The tag, not the version field, is the line.

## The rule

1. **Never hand-tag a protocol release.** Creating `protocol-vX.Y.Z` and pushing it is a publish.
   It goes through `/release-protocol` so the changelog entry, the release commit, and the tag are
   produced together. A `protocol-v*` tag pointing at anything other than a
   `chore(protocol-release):` commit is the signature of a bypass.
2. **Every `protocol-v*` tag has a matching `## [protocol-vX.Y.Z]` entry** in
   `packages/protocol/CHANGELOG.md`. That file is canonical for the package. `docs/mobile-bridge.md`
   carries the same history as narrative for the bridge feature; it is not a substitute.
3. **Do not write a bare `#N` in the changelog.** The repo is public and the package is published,
   so a private board task id renders as a GitHub issue link to an unrelated issue. Describe the
   change instead. `68afad59`'s subject carries a `(#172)` that was dropped for this reason.
4. **Backfill on sight.** If you find a published or tagged version with no entry, reconstruct it
   from `git log <previousTag>..<tag> -- packages/protocol/src` and the commit messages, rather
   than leaving the hole for the next release to paper over.

## Enforcement (self-maintaining)

- **Skill (pre-flight):** `/release-protocol` verifies tag-to-entry parity across the whole
  `protocol-v*` sequence before it releases, and backfills any gap it finds. This is what turns a
  single missed release into a self-healing one instead of a permanent hole.
- **Skill (recurring):** `/release` Step 1.5 checks the same parity during every desktop release.
  Desktop releases are frequent and protocol releases are not, so this is the check most likely
  to actually fire.
- **Gap, deliberate:** there is no mechanical CI guard. A `tests/unit/` check cannot see the tag
  list (`actions/checkout` does not fetch tags by default), and the package version legitimately
  runs ahead of the changelog between releases, so there is no static invariant to assert. The
  strongest available fix is a step in `.github/workflows/publish-protocol.yml` that fails the
  publish when `CHANGELOG.md` has no entry for `github.ref_name`, which would block the bypass
  outright rather than detecting it later. Not implemented; flagged here so the gap is explicit.

## Scope

`@kangentic/protocol` releases and `packages/protocol/CHANGELOG.md`. The desktop app's own
`CHANGELOG.md` and `RELEASE_NOTES.md` are `/release`'s concern and are not governed here. The two
version sequences are deliberately decoupled and must not be synchronized.

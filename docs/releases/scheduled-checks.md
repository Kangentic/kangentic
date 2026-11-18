---
type: Reference
title: Scheduled checks
description: "The workflows that run on a schedule to catch what breaks with no commit (a dead signing credential, an agent CLI release that changes what Kangentic reads), what reads each one, what to do when one is red, and what is deliberately not checked."
tags: [ci, release, credentials, agents]
sources:
  - resource: .github/workflows/signing-credentials.yml
  - resource: .github/workflows/agent-clis.yml
  - resource: scripts/probe-ssh-rig/transcript-clis.sh
  - resource: scripts/probe-ssh-rig/transcript-summary.mjs
  - resource: tests/unit/scheduled-workflows.test.ts
---
# Scheduled checks

Some failures need no commit. A client secret reaches its end date, an agreement goes unaccepted, a
vendor ships a CLI that writes its transcript somewhere new. No pull request check can see these,
because nothing in the repository changed. The workflows here run on a schedule so the team finds
out before a user or a release does.

## What runs

| Workflow | When (UTC) | What it proves | Who reads it |
|---|---|---|---|
| `package-smoke.yml` | Nightly, 03:17 | The packaged app launches on all five release legs | `/release` requires the newest scheduled run green, within 48 hours |
| `signing-credentials.yml` | Nightly, 05:43 | The credentials a release signs with still work | `/release` requires the newest scheduled run green, within 48 hours |
| `agent-clis.yml` | Nightly, 06:11 | Seven agent CLIs at their newest versions still write what Kangentic reads | `/release` reports the newest scheduled run and does not stop on it |
| `codeql.yml` | Mondays, 04:27 | Code scanning against newly published queries | Its findings are code scanning alerts. Nothing reads the run's conclusion |

A scheduled run that nothing reads is not a check. `tests/unit/scheduled-workflows.test.ts` fails
when a workflow with a `schedule:` is neither read by the release skill
(`.claude/skills/release/SKILL.md`, step 8) nor listed in that test with the reason.

GitHub also emails a failed scheduled run to whoever last edited the workflow's `cron` line. That
is one person's inbox, which is why `/release` reads the runs itself.

## Signing credentials

`release.yml`'s `preflight-signing` and `preflight-symbols` jobs prove each secret is non-empty.
They cannot tell a live secret from a dead one, so a dead one used to be found inside the release
matrix, after the tag and the draft release existed. The nightly uses each credential the way the
release does:

- **Azure Trusted Signing.** A Windows job builds a throwaway library, signs it through
  `build/windowsSign.js` (the hook electron-builder calls) and requires
  `Get-AuthenticodeSignature` to report `Valid` with a timestamp. This also covers the
  `TrustedSigning` PowerShell module, which the hook installs from the PowerShell Gallery with no
  pinned version.
- **Apple notarization.** A macOS job runs `xcrun notarytool history` with the Apple ID, the
  app-specific password and the team id. It submits nothing. It needs macOS because only notarytool
  takes that kind of sign-in.
- **Developer ID certificate.** A Linux job reads the certificate's end date from the `.p12` secret
  and goes red inside 30 days. Because `/release` reads this workflow, a release stops for those
  30 days until the certificate is renewed.
- **Sentry token.** The same job asks Sentry whether the symbol-upload token authenticates.

It adds no secret, uploads nothing, and never runs on a pull request.
`tests/unit/scheduled-workflows.test.ts` fails when `release.yml` reads a secret the nightly does
not, or when the two sign with a different endpoint, account or profile.

### When it is red

| Job | Likely cause | Fix |
|---|---|---|
| Azure Trusted Signing | The client secret reached its end date (Entra's error for that is `AADSTS7000222`), the app registration lost its signing role, or the PowerShell module changed | Create a new client secret on the app registration and replace `AZURE_CLIENT_SECRET`. For the module, pin or update the install in `build/windowsSign.js` |
| Azure Trusted Signing, "no timestamp" | The signature would stop verifying when its short-lived certificate ends | Name a timestamp server in `build/windowsSign.js` |
| Apple notarization sign-in | A revoked app-specific password, an agreement waiting at developer.apple.com, or a lapsed membership | Accept the agreement, or create a new app-specific password and replace `APPLE_APP_SPECIFIC_PASSWORD` |
| Developer ID certificate | It ends within 30 days | Create a new Developer ID Application certificate, export it as a `.p12`, replace `APPLE_CERTIFICATE_BASE64` and `APPLE_CERTIFICATE_PASSWORD` |
| Sentry token | The token was deleted or lost its scope | Create a new token and replace `KANGENTIC_SENTRY_TOKEN` |

Then `gh workflow run signing-credentials.yml --ref main` gets a fresh answer.

The Azure client secret has an end date that only the app registration in Entra shows. The
repository secret was last set on 2026-03-09, and Entra allows 24 months at most. The nightly finds
a dead secret the next morning, not before.

## Agent CLIs

Every other test tier runs against captures and mock CLIs, which stay green when a vendor renames a
flag, moves a session file or changes a transcript's format. `agent-clis.yml` runs the real thing:
`scripts/probe-ssh-rig/transcript-clis.sh` installs the newest release of Kimi Code, Goose, OpenCode
1 and 2, Codex, Gemini, Aider and Droid into a throwaway container and points each at a local
stand-in for a model API, so a run needs no account and costs no quota. Then
`tests/unit/remote-transcript-real-cli.test.ts` runs each CLI through a conversation and a resume
and requires Kangentic's own readers to read the result.

`scripts/probe-ssh-rig/transcript-summary.mjs` gives the verdict. The step summary lists each CLI,
the version it ran and its result. The script fails a run whose tests were all skipped, which
vitest itself exits 0 on, and a CLI that did not install.

It also runs on a pull request that touches the rig's own files. No adapter path is in that filter,
so a vendor's release never turns an unrelated pull request red.

Claude is not in the set. The team runs it all day from `npm start`, so a change in it is noticed
within hours.

### When it is red

- **A CLI "did not print a version" or "its install failed".** The vendor's installer or registry
  was down, or it moved. Run the workflow again. If it fails the same way, the install line for that
  CLI in `transcript-clis.sh` needs the vendor's new instructions.
- **A CLI's test failed.** That CLI's newest release changed something an adapter reads. The summary
  names the version. Its page under `docs/integrations/agents/` says what the adapter depends on.
- **Every test was skipped.** The gate variable did not reach the test run, so the rig itself is
  broken, not a CLI.

## What is not checked, and why

Each of these can also break with no commit. None has a scheduled check, by decision on 2026-11-17.

| Dependency | Who notices today | Why no check |
|---|---|---|
| The response shapes of Trello, Linear, Jira, Asana, Azure DevOps and GitLab | A user, then Sentry, since the board clients report | A probe needs a test account per service, and three of those tokens expire within a year. The check would join the class it guards |
| Model downloads from Hugging Face | A user. Sentry for dictation models | Thirteen of the URLs follow `main` with no checksum. Pinning them to commits would remove the failure, and is the fix if it ever happens |
| The mobile app's Apple Distribution certificate and profile | Whoever runs the next iOS device build | They live in the mobile repository's CI, which is where a check belongs |
| Push notifications | A user | The desktop posts to Expo with no credential, and the push keys Expo holds have no end date |
| The App Store and Play listings | Apple or Google emails the account holder | The desktop has no listing of its own |
| Install channels (Homebrew tap, winget) | Nobody, for winget | Not shipped yet. Two rows are worth adding once they are: each channel's version against the newest release |
| The relay | The relay repository's own uptime monitor and scheduled probe | Already watched there |

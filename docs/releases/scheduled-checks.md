---
type: Reference
title: Scheduled checks
description: "The workflows that run on a schedule to catch what breaks with no commit (a dead signing credential, an agent CLI release that changes what Kangentic reads, a published release that lost a file, a domain near its end date), what reads each one, what to do when one is red, and what is deliberately not checked."
tags: [ci, release, credentials, agents]
sources:
  - resource: .github/workflows/signing-credentials.yml
  - resource: .github/workflows/agent-clis.yml
  - resource: .github/workflows/integrations.yml
  - resource: scripts/check-distribution.mjs
  - resource: scripts/lib/check-report.mjs
  - resource: scripts/probe-ssh-rig/transcript-clis.sh
  - resource: scripts/probe-ssh-rig/transcript-summary.mjs
  - resource: tests/unit/scheduled-workflows.test.ts
---
# Scheduled checks

Some failures need no commit. A certificate reaches its end date, an agreement goes unaccepted, a
vendor ships a CLI that writes its transcript somewhere new. No pull request check can see these,
because nothing in the repository changed. The workflows here run on a schedule so the team finds
out before a user or a release does.

## What runs

| Workflow | When (UTC) | What it proves | Who reads it |
|---|---|---|---|
| `package-smoke.yml` | Nightly, 03:17 | The packaged app launches on all five release legs | `/release` requires the newest scheduled run green, within 48 hours |
| `integrations.yml` | Nightly, 04:43 | The shipped browser sign-ins still work, and the published release, the npm launcher, the site and the domain are whole | `/release` stops on a red run and tells the owner which rows are red |
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

- **Azure Trusted Signing.** A Windows job signs in to Azure exactly as the release's Windows leg
  does: `azure/login` with GitHub's OIDC token, in the `release-windows` environment, with no
  client secret (see [Deployment](deployment.md), Code Signing Secrets). It builds a throwaway
  library, signs it through `build/windowsSign.js` (the hook electron-builder calls) and requires
  `Get-AuthenticodeSignature` to report `Valid` with a timestamp. This also covers the
  `TrustedSigning` PowerShell module, which the hook installs from the PowerShell Gallery with no
  pinned version. The job is in the release's environment because the federated credential's
  subject names it: a job anywhere else would sign in with a credential the release does not use.
- **Apple notarization.** A macOS job runs `xcrun notarytool history` with the Apple ID, the
  app-specific password and the team id. It submits nothing. It needs macOS because only notarytool
  takes that kind of sign-in.
- **Developer ID certificate.** A Linux job reads the certificate's end date from the `.p12` secret
  and goes red inside 30 days. Because `/release` reads this workflow, a release stops for those
  30 days until the certificate is renewed.
- **Sentry token.** The same job asks Sentry whether the symbol-upload token authenticates.

It adds no secret, uploads nothing, and never runs on a pull request.
`tests/unit/scheduled-workflows.test.ts` fails when `release.yml` reads a secret the nightly does
not, when the two sign with a different endpoint, account or profile, or when they sign in to
Azure differently.

### When it is red

| Job | Likely cause | Fix |
|---|---|---|
| Azure Trusted Signing, at the sign-in, with `AADSTS700213: No matching federated identity record found for presented assertion subject` | The federated credential was deleted, or its subject no longer matches (the repository, the organization or the `release-windows` environment was renamed). The error prints the subject GitHub presented | Add the credential again on the app registration with the three values in [Deployment](deployment.md), Code Signing Secrets, or change its subject to the one the error prints |
| Azure Trusted Signing, "no code signing token" or at the signing step | The app registration lost its signing role on the account, or the PowerShell module changed | Give the app the Trusted Signing Certificate Profile Signer role again. For the module, pin or update the install in `build/windowsSign.js` |
| Azure Trusted Signing, waiting and then timed out | Someone added a reviewer rule to the `release-windows` environment | Approve the run, or move the rule off that environment |
| Azure Trusted Signing, "no timestamp" | The signature would stop verifying when its short-lived certificate ends | Name a timestamp server in `build/windowsSign.js` |
| Apple notarization sign-in | A revoked app-specific password, an agreement waiting at developer.apple.com, or a lapsed membership | Accept the agreement, or create a new app-specific password and replace `APPLE_APP_SPECIFIC_PASSWORD` |
| Developer ID certificate | It ends within 30 days | Create a new Developer ID Application certificate, export it as a `.p12`, replace `APPLE_CERTIFICATE_BASE64` and `APPLE_CERTIFICATE_PASSWORD` |
| Sentry token | The token was deleted or lost its scope | Create a new token and replace `KANGENTIC_SENTRY_TOKEN` |

Then `gh workflow run signing-credentials.yml --ref main` gets a fresh answer.

One end date is known as of 2026-11-17:

- **The Developer ID certificate ends on 2027-02-01.** The nightly goes red on 2027-01-02, and
  `/release` stops from then until the certificate is replaced. Apps already signed and notarized
  keep opening after that date. Only new builds need the new certificate.

The Windows sign-in has none. It used a client secret that ended on 2028-03-08, until the release
moved to GitHub's OIDC federation.

The workflow was proven on a scratch branch on 2026-11-17 before it reached main: one green run,
and a red run for each of a made-up certificate profile, a removed sign step, a 4,000 day
certificate threshold and a made-up Sentry token. Its first run is also what found that the
installers had no timestamp (see [Deployment](deployment.md), Code Signing Secrets).

The federated sign-in was proven the same way on 2026-11-18, with the Windows job alone and no
client secret in the workflow. One run signed and timestamped the probe file. One run with the job
outside the `release-windows` environment was refused at the sign-in, with `AADSTS700213` naming
the branch subject it presented. One run waited eleven minutes between the sign-in and the signing
step and still produced a valid, timestamped signature, which is twice the 5.5 minutes the
v0.59.0 Windows build took.

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

A run by hand in a container on 2026-11-17 took about five minutes: a minute for `npm ci`, three
to install the CLIs and twenty seconds for the eight tests. All eight passed, on Kimi Code 2.6.3,
Goose 1.60.1, OpenCode 1.19.6 and 2.3.2, Codex 0.169.1, Gemini 0.68.0, Aider 0.86.2 and Droid
1.14.0. The same container proved the red cases: every test skipped, one CLI removed, one vendor's
installer unreachable, and no report at all.

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

## Daily distribution check

`integrations.yml` has two jobs. The first checks the shipped sign-ins and is described in
[Board integration](../integrations/boards.md#daily-sign-in-check). The second runs
`scripts/check-distribution.mjs`, which checks what an install and an update depend on outside
the repository. `npm run check:distribution` runs it by hand. It holds no secret and needs no
install, and every probe is a request a stranger could make.

| Check | What it asks | Fails on |
|---|---|---|
| release, latest tag | `github.com/<owner>/<repo>/releases/latest`, the address electron-updater follows to find the release to offer | No `vX.Y.Z` tag. The other release rows and the npm row are then not run |
| release, highest version | GitHub's release feed (`releases.atom`) | A published `vX.Y.Z` higher than the latest tag. A release re-created for an older tag can take "latest" back, and installed apps then stop at the older version |
| release, assets | A `HEAD` for every file the release must carry, and the content of each update feed | A file that answers 404, a file it could not ask about, or a `latest-mac.yml` that does not list a zip for each Mac arch. The verdict is the publish gate's own (`verifyReleaseAssets` in `scripts/verify-release-assets.js`) |
| release, feed versions | The `version:` of each update feed | A feed that names another version, or did not download |
| npm, launcher | `registry.npmjs.org/kangentic/latest` | A version that is not the latest release. It is `pending` for two hours after a release, while `publish-npm` may still be running |
| site, hero stars | The landing page | A star count that stays hidden or is not a number. It reads the page up to four times first, since a cold cache serves the page without the count and a failed read of GitHub is cached for 60 seconds |
| domain, registration | The registry's RDAP record for the site's domain | An end date 10 days away or less, or a domain its registry holds for deletion |
| domain, tls site and tls relay | A TLS handshake with the site and with the relay | A certificate 14 days from its end or less, or one that is refused |

- **Values.** The repository comes from `electron-builder.yml`'s `publish:` block, the package from
  the launcher's `package.json`, the site from `DOCS_BASE_URL` and the relay host from
  `KANGENTIC_HOSTED_RELAY_URL`, all read from the checkout. A value that is gone fails the run.
  `tests/unit/check-distribution.test.ts` holds each equal to its source and drives every verdict
  with canned answers. It sends no request.
- **The expected files come from the released tag.** `scripts/release-assets.js` on main describes
  the next release, and it changed twice in five weeks. Checked against main's list, the row would
  be red from such a change until the next tag. The check fetches the publish gate's three files
  from the tag, loads them from a temp folder, and removes the folder.
- **The thresholds.** Both hosts serve 90-day certificates that are replaced about 30 days before
  their end, so one inside 14 days has stopped renewing. The domain's threshold sits below the
  registrar's auto-renew lead, which a third party gives as about 14 days, so a domain with
  auto-renew on never reaches it. One with auto-renew off does, ten days before it lapses.
- **Known end dates, as of 2026-11-17.** The domain's registration ends on 2027-02-22. Both
  certificates end on 2027-01-27.

### When it is red

- **A `release` row.** Read which file or feed it names. Publishing a new release repairs a
  release that lost a file, and `gh release edit <tag> --latest` repairs a "latest" that points at
  an older tag.
- **`npm launcher`.** The newest release's `publish-npm` job did not finish. Re-run that job.
- **`site hero stars`.** The landing page's Function could not read GitHub as its GitHub App. Its
  log (`wrangler pages deployment tail`) names the cause, most often the app's installation on the
  repository being removed.
- **A `domain` row.** Renew the domain at its registrar, or look at why the host's certificate
  stopped renewing.

## What is not checked, and why

Each of these can also break with no commit. None has a scheduled check, by decision on 2026-11-17.

| Dependency | Who notices today | Why no check |
|---|---|---|
| The response shapes of Trello, Linear, Jira, Asana, Azure DevOps and GitLab | A user, then Sentry, since the board clients report | A probe needs a test account per service, and three of those tokens expire within a year. The check would join the class it guards |
| Jira's board issues endpoint | A user, then Sentry | Atlassian's Jira Software spec marked `GET /rest/agile/1.0/board/{boardId}/issue` deprecated when read on 2026-11-18, beside an "enhanced" twin under `/rest/software/1.0/`. The changelog pages read that day gave no removal date. `boardIssues` in `jira/client.ts` moves to the twin when Atlassian announces one. A board and its columns have no twin and are not marked |
| Model downloads from Hugging Face | A user. Sentry for dictation models | Thirteen of the URLs follow `main` with no checksum. Pinning them to commits would remove the failure, and is the fix if it ever happens |
| The mobile app's Apple Distribution certificate and profile | Whoever runs the next iOS device build | They live in the mobile repository's CI, which is where a check belongs |
| Push notifications | A user | The desktop posts to Expo with no credential, and the push keys Expo holds have no end date |
| The App Store and Play listings | Apple or Google emails the account holder | The desktop has no listing of its own |
| Install channels (Homebrew tap, winget) | Nobody, for winget | Not shipped yet. Two rows are worth adding once they are: each channel's version against the newest release |
| The relay | The relay repository's own uptime monitor and scheduled probe | Already watched there |

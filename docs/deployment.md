# Deployment

This document covers the full deployment pipeline for maintainers and the update experience for users.

## For Users

### Install

```bash
npx kangentic
```

This downloads the pre-built binary for your platform, installs it, and launches the app. After the first run, the app updates itself on Windows, macOS, and Linux. The table below shows what each platform asks of the user.

### Auto-Update Behavior

| Platform | Update mechanism | User action |
|----------|-----------------|-------------|
| Windows | `electron-updater` (NSIS) | Review the release notes in the modal and click "Restart to update", or quit normally - installs silently on next launch. |
| macOS | `electron-updater` | Review the release notes in the modal and click "Restart to update". Requires code signing - see [macOS signing note](#macos-auto-update-requires-signing) - and the app must not be running from a read-only volume - see [macOS read-only volumes](#macos-read-only-volumes). |
| Linux | `electron-updater` (deb/rpm) | Review the release notes in the modal and click "Restart to update", then approve the system authentication prompt. Unlike the other platforms there is no install-on-quit - see [Linux auto-update](#linux-auto-update). |

Auto-update is implemented in `src/main/updater.ts`. It checks for updates 5 seconds after launch, then every 4 hours. Updates download in the background; when ready, a centered modal shows the new version's release notes (rendered markdown, sourced from `RELEASE_NOTES.md` baked into the update manifest at build time - see [Release Sequencing](#release-sequencing)) with "Restart to update" and "Later". The modal auto-opens once per version; "Later" dismisses it in favor of a persistent title-bar indicator that reopens it. A version whose release carried no notes falls back to the legacy persistent toast. v0.1.0 users must manually update to v0.2.0 - auto-update kicks in from v0.2.0 onward.

That modal is strictly **pre-restart**, so on its own it reaches only the user who happens to read it before relaunching. Its counterpart is the **"What's New" dialog** (`src/renderer/components/dialogs/WhatsNewDialog.tsx`), which shows the notes for the version now RUNNING, once, on the first launch after the version changes. It covers everyone the pre-restart modal cannot: a user who restarts straight from the toast, one whose update was installed silently on a normal quit by `autoInstallOnAppQuit`, a manual installer run, and a `npx kangentic` upgrade. The status-bar version pill is a permanent way back in, and the dialog links to the full GitHub release. It is gated on its own `lastWhatsNewShownVersion` config key rather than `lastSeenReleaseNotesVersion` (see [Configuration](configuration.md)), and is suppressed on a fresh install so it never stacks on the onboarding walkthrough.

Its notes do not come from the update manifest, which the relaunched app no longer has: `RELEASE_NOTES.md` is inlined into the renderer bundle at build time (`src/renderer/lib/baked-release-notes.ts`, via Vite's `?raw`), so the notes ship inside the build they describe. That needs no network and no update manifest, which is what lets it cover fresh and manual installs. The file is not in the packaged app (`electron-builder.yml`'s `files:` is a whitelist), so inlining is also the only way to read it at runtime.

### macOS read-only volumes

Squirrel.Mac replaces the app bundle in place, so an app that cannot be written over cannot update. Launching Kangentic straight from the mounted `.dmg` is the common way to end up there, and App Translocation produces the same result for a quarantined bundle run from an arbitrary folder. The install downloads normally, the release-notes modal appears, and the handoff to Squirrel then fails with `Cannot update while running on a read-only volume`.

That is a property of where the app was launched from, not a defect, so it is counted and never filed as an issue. It is also the one updater failure the app tells the user about, because nothing else would: the install stays on its current version indefinitely and says nothing. A warning toast naming the Applications folder appears once per app run, latched in main (`src/main/updater.ts`) so a condition every 4-hour check rediscovers does not repeat it. Dragging the app to Applications and relaunching from there is the fix.

Note the ordering: because `MacUpdater` announces the finished download before handing it to Squirrel, the user sees the "Restart to update" modal first and this toast a moment later. The button in that modal is inert rather than visibly failing. Squirrel errored, so `squirrelDownloadedUpdate` was never set, and `MacUpdater.quitAndInstall` takes its else branch: it registers a listener for an `update-downloaded` that will not arrive, skips `checkForUpdates()` because `autoInstallOnAppQuit` is already true on macOS, and returns. Nothing quits and nothing errors. The toast is the only explanation the user gets.

### Linux auto-update

Linux updates in place like the other platforms, through the same modal and the same "Restart to update" button. Nothing extra is configured to make that work:

- `electron-updater` ships `DebUpdater`, `RpmUpdater`, and `PacmanUpdater` beside `AppImageUpdater`. Its `autoUpdater` export picks one by reading a `package-type` marker from `resourcesPath`.
- `electron-builder` writes that marker, plus `app-update.yml`, into every fpm target in its `supportsAutoUpdate` list (`deb`, `rpm`, `pacman`). Both files are already inside the shipped `.deb` and `.rpm`.
- Installing shells out to the system package manager. For rpm it prefers `zypper` / `dnf` / `yum` and falls back to `rpm -Uvh`, so dependencies resolve through the distro's own tooling. For deb it runs `dpkg -i` first and only calls `apt-get install -f -y` afterwards to repair missing dependencies, using `apt` directly just when `dpkg` is absent. Note this is the reverse of the launcher's own order, which prefers `apt` (see [packages/launcher/README.md](../packages/launcher/README.md)).

Two Linux-specific behaviors follow from that:

**A system authentication prompt appears on install.** The package manager always elevates. `electron-updater` prefers a graphical helper (`pkexec`, `gksudo`, `kdesudo`, `beesu`) and falls back to `sudo`. On a desktop with a polkit agent this is a normal password dialog.

**There is no install-on-quit.** `autoInstallOnAppQuit` is forced to `false` on Linux (`src/main/updater.ts`), because an auth prompt raised as the window disappears is both confusing and liable to lose a race with session teardown. The update stays staged until the user explicitly restarts. Upstream made the same call for these targets in a later major.

If a Linux desktop has no polkit agent and no usable `sudo` TTY, the install fails and surfaces through the updater's existing `error` handler rather than failing silently. The user can always fall back to `npx kangentic@latest`.

That handler always logs the failure and always counts it as `app_error`. It does not always file a Sentry issue. `isElevationDeniedError` suppresses exit 126 and 127 from an elevation front-end, the two codes `pkexec` uses when the user dismissed the authentication dialog or was not authorized, because neither is a defect we can ship a fix for. A failure carrying any other code still reports, including a package manager's own. See the "counted, not reported" entries in [analytics.md](analytics.md).

#### What verifies a Linux update

Integrity is checked, authenticity is not signature-based:

- **Checked:** the manifest is fetched over HTTPS from GitHub, and the downloaded package is verified against the `sha512` that manifest declares (`AppUpdater.executeDownload`). A tampered or truncated download is rejected before anything is installed.
- **Not checked:** the package's own GPG signature. Our deb/rpm are unsigned (there is no Linux signing key, which is also why the CI install gate passes `--nogpgcheck`), and electron-updater installs them with `--nogpgcheck` / `--allow-unsigned-rpm` / `dpkg -i` accordingly.

That is the same trust anchor the `npx kangentic` install path has always used - HTTPS to GitHub plus a checksum - so in-app updating is no less verified than the route it replaces. It is weaker than Windows, where electron-updater additionally checks the Authenticode signature against the publisher name embedded in `app-update.yml`.

Tightening this requires two things together, and neither exists yet: GPG-signing the packages at release time, and electron-updater's `allowUnverifiedLinuxPackages: false`, which is a v27 flag not present in the 6.x line this app pins. Setting the flag without the signing key would break every Linux update, so the two must land together.

### Install a Specific Version

```bash
npx kangentic@0.2.0
```

The launcher version matches the app version. This downloads the exact matching release.

### Rollback

To roll back to a previous version, run `npx kangentic@X.Y.Z` with the desired version. On Windows, the NSIS installer will replace the current version. On macOS, the .app is replaced in `~/Applications/`.

## For Maintainers

### Release Sequencing

1. **`/release patch`** (or `minor`/`major`) - analyzes conventional commits, bumps version in root `package.json` + `packages/launcher/package.json`, generates CHANGELOG entry + user-friendly release notes (commit subjects plus any `Release-Note:` commit trailers) written to `RELEASE_NOTES.md` at the repo root, commits, tags, pushes.
2. **`electron-builder.yml`'s `releaseInfo.releaseNotesFile: RELEASE_NOTES.md`** bakes that file's contents into every generated `latest*.yml` update manifest at build time. `electron-updater`'s GitHub provider prefers a populated `releaseNotes` key over its Atom-feed fallback, so this is also the source for the pre-restart release-notes modal (see [Auto-Update Behavior](#auto-update-behavior)), with no separate fetch and no new IPC channel. The post-restart "What's New" dialog reads the same file by a different route - inlined into the renderer bundle at build time - since a relaunched app has no update manifest for its own version. Both paths therefore render identical markdown, and so does the GitHub release body (step 5 sets it from this same file), which is what the dialogs' "GitHub Release" link opens.
3. **Tag push triggers `release.yml`** - each build leg runs in its own `release-<platform>` environment (Settings > Environments), which is where an approval rule goes. Builds all five targets (Windows x64, macOS arm64 and x64, Linux x64 and arm64), signs binaries (when signing secrets are configured), creates a **draft** GitHub Release with artifacts attached. Before any of that, the `preflight-symbols` job fails the release in seconds if the `KANGENTIC_SENTRY_TOKEN` repository secret is missing, and `preflight-signing` does the same for the Apple signing and notarization secrets (`build/afterSign.js` only logs a skip, so a missing one would ship an un-notarized Mac build). Both gate `create-draft-release`, so a failure leaves no orphaned draft behind. Without that secret the build produces no sourcemaps and no native debug files, which is how v0.37.0 and v0.38.0 shipped with unreadable stacks while every job reported success (see [Analytics](analytics.md)). `/release` checks the same secret before it tags, since on a tag push the tag already exists by the time the workflow starts.
4. **Run the [release smoke checklist](release-checklist.md)** against the built artifacts. Automated tests use mock CLI fixtures, so this is the only place real model latency, real tool calls, and conversation continuity across resume get exercised. It does not gate publishing: `publish-release` fires as soon as the builds succeed (step 5), so the lever for a failure here is [Rollback](#rollback), not withholding the release. To gate on the checklist instead, the approval in step 3 has to be the decision point.
5. **The `publish-release` job publishes the draft automatically** once every platform build succeeds: it clears draft status (`--draft=false`) and sets the body from `RELEASE_NOTES.md` in the same `gh release edit` call, so the release is never live with an empty body. Any human gate sits earlier, on the `release-<platform>` environments in step 3 - `publish-release` declares no `environment:` of its own, so nothing blocks between the builds finishing and the release going live. Before publishing it rebuilds `latest-mac.yml` to list both macOS arches (see [One macOS feed for both arches](#one-macos-feed-for-both-arches)). Watch the run at [github.com/Kangentic/kangentic/actions](https://github.com/Kangentic/kangentic/actions), NOT the releases page. `/release` Step 7 waits on the run with `gh run watch` and confirms `draft: false`, 19 assets (the 18 build assets plus `demo-posters-X.Y.Z.zip` from step 8), and the new `npm view kangentic version` before it opens the releases page at all. Opening it while the builds are still running is how v0.39.0 shipped published and empty: it puts a Publish button in front of a human for the ten minutes when clicking it does the most damage, and electron-builder uploads only into a draft, so a hand-publish mid-run makes every platform job skip its artifacts while every one still exits 0.
6. **The `publish-npm` job in `release.yml`** publishes the launcher package to npm after `publish-release` succeeds, using Trusted Publishing (OIDC) - no token required.
7. **The `deploy-demo` job in `release.yml`** calls `deploy-demo.yml` with the release tag, also after `publish-release` succeeds. It rebuilds the static web demo at the `/kangentic/` base, smoke-tests the built bytes with `npm run test:demo`, and publishes them to GitHub Pages at [kangentic.github.io/kangentic](https://kangentic.github.io/kangentic/), so the demo always shows the shipped app. It fails loudly, after the release is already live, when Pages is not enabled with the GitHub Actions source or the `github-pages` environment does not allow `v*` tags to deploy. Dispatch `deploy-demo.yml` by hand with a `ref` to redeploy.
8. **The `demo-posters` job in `release.yml`** shoots the docs poster set from the same tag, also after `publish-release` succeeds, and attaches it to the release as `demo-posters-X.Y.Z.zip`: one 3200 by 2000 still per demo scene in the `clay` and `rust` themes plus a `manifest.json`, which [kangentic.com](https://kangentic.com)'s figures read by version (`npm run demo:posters`; `demo/README.md`, "The poster set"). It is outside `scripts/release-assets.js` on purpose, since that manifest is verified before this job runs, and it uploads with `--clobber` so a re-run replaces the asset in place. Like `deploy-demo`, a failure here lands after the release is live: the release stands, the run goes red, and the site's own sync fails on the missing asset.
9. **`npx kangentic`** now downloads the new version's signed binaries.
10. **`/release` Step 8 marks the Sentry issues this release fixes.** It scans the released commit range for `DESKTOP-*` shortIds and resolves each one against `Kangentic@X.Y.Z`, the release that carries the fix. It runs last because the Sentry release object is created by the bundler plugin during the build in step 3, so it does not exist any earlier, and a marker naming the release an issue was last seen on reopens that issue on exactly the builds that lack the fix. The step reports rather than blocks: the release is already published by then. See [the sentry skill's "Resolution markers"](../.claude/skills/sentry/SKILL.md) for the request shapes and the traps.

### Commit Conventions

All commits must use [Conventional Commits](https://www.conventionalcommits.org/) format. A husky commit-msg hook runs commitlint to enforce this. The config in `package.json` extends `@commitlint/config-conventional` with one change: footer lines have no length cap, because a `/code-review` commit carries its `Refuted:` and `Decisions:` ledger as one trailer-shaped line per item, and a later pass reads each item back from that one line (`tests/unit/review-ledger-commitlint.test.ts`). The commit skills (`/commit`, `/pull-request`, `/merge-pull-request`, `/merge-back`) auto-generate conventional commit messages from diffs.

Common prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `perf:`, `ci:`, `build:`. Add `!` after the type for breaking changes (e.g., `feat!:`).

### Release Permissions

Releases require two things:
- **Write** role (minimum) to trigger the workflow or push a tag
- **`release-<platform>` environment reviewer** to approve the workflow run, when the environments carry a reviewer rule

Each build leg names its own environment: `release-linux`, `release-linux-arm64`, `release-windows`, `release-macos-arm64` and `release-macos-x64`. Add required reviewers to each in Settings > Environments; even Admin users cannot bypass environment approval. GitHub creates an environment the workflow names on its first run, with no rules, so a newly added leg runs unreviewed until one is added. Secrets stay repository secrets, which every environment inherits; `preflight-signing` and `preflight-symbols` read them with no environment at all.

### Code Signing Secrets

Signing only activates when the corresponding env vars are present. Local dev builds remain unsigned. A release requires the five Apple secrets: `preflight-signing` fails the run before anything builds when one is missing.

| Secret | Source |
|--------|--------|
| `APPLE_CERTIFICATE_BASE64` | Developer ID Application certificate (`.p12`), base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | Password of that `.p12` |
| `APPLE_ID` | Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password (not account password) |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `AZURE_TENANT_ID` | Azure AD tenant ID |
| `AZURE_CLIENT_ID` | App registration (service principal) client ID |
| `AZURE_CLIENT_SECRET` | App registration client secret |
| `AZURE_SIGNING_ENDPOINT` | Regional endpoint (e.g., `https://eus.codesigning.azure.net/`) |
| `AZURE_SIGNING_ACCOUNT` | Trusted Signing account name |
| `AZURE_CERT_PROFILE` | Certificate profile name |

The launcher publishes to npm via Trusted Publishing (OIDC), so no npm token secret is
required. The `publish-npm` job proves its identity to npm per-run with a short-lived OIDC
token (`id-token: write`). Configure the trusted publisher on npmjs.com for the `kangentic`
package: GitHub Actions, org `Kangentic`, repo `kangentic`, workflow `release.yml`.

### macOS Auto-Update Requires Signing

Electron's `autoUpdater` on macOS only works with signed apps (Electron docs: "mandatory for auto-update on macOS"). Released builds are always signed and notarized: `preflight-signing` blocks a release when an Apple secret is missing. Only a local or ad-hoc build (`mac.identity` set to `-`, as package-smoke builds) is unsigned, and for such a build:

- macOS users will NOT receive auto-updates
- They must re-run `npx kangentic` manually to get new versions
- The Gatekeeper bypass is required on each install (see [Installation Guide](installation.md#macos-gatekeeper))

### Draft Releases Are Invisible to Auto-Updater

`electron-updater` only sees **published** releases. Draft releases are invisible to the auto-updater and to `npx kangentic`.

That invisibility is what made the v0.35.0 failure user-facing: the three platform jobs it had then each raced
to create their own draft for the same tag, the publish step resolved the tag to the Windows one,
and the macOS and Linux artifacts stayed on drafts nobody could download. Two things now prevent a
repeat. `create-draft-release` creates the single draft before any build starts, so every platform
job attaches to the same release. Then `scripts/verify-release-assets.js` runs before
`--draft=false` and fails the release unless the tag resolves to exactly one release object
carrying all 18 expected build assets, all fully uploaded, with a `latest-mac.yml` that lists both
macOS zips. A build that succeeds on every platform is not evidence that the release is complete;
only the asset check is.

v0.39.0 found the mirror image of that, a release for the tag that is already PUBLISHED and
missing assets. electron-builder's GitHub publisher uploads only into a draft: handed a published
release it logs `existing type not compatible with publishing type` and skips every artifact while
the build still exits 0. So `create-draft-release` decides between four states before any build
starts, rather than reusing whatever release it finds. No release for the tag creates the draft. An
existing draft is reused. A published release that still passes `scripts/verify-release-assets.js`
is left alone, which is what keeps an idempotent re-run of a finished release green. A published
release that does not pass fails the run in seconds with `::error::` lines naming the recovery,
instead of letting every platform build run and skip every upload.

### One macOS feed for both arches

Each macOS leg runs its own electron-builder, which writes a `latest-mac.yml` listing only that
leg's zip, and the second leg's upload deletes and replaces the first's on the release. Left
alone, whichever leg finished last would decide every Mac's updates: an Intel-only feed moves Apple
silicon Macs onto the Intel build under Rosetta, and an arm64-only feed leaves Intel Macs no zip.
`electron-updater`'s `MacUpdater` picks the zip whose URL names `arm64` on Apple silicon and the
other on Intel, so one feed listing both is right for both. `publish-release` builds it with
`scripts/merge-mac-update-feeds.js` before the minimumSystemVersion patch below. The script
downloads both arches' zip and dmg from the release and hashes them (sha512 in base64 and size,
the fields electron-builder writes), so the feed always describes the files a Mac downloads. The
version, release notes and release date come from whichever `latest-mac.yml` is on the release,
and the top-level `path` and `sha512` older clients read name the arm64 zip. Reading the release,
not anything the legs hand over, is what makes it hold on every re-run. Workflow artifacts do not
reliably carry across run attempts, and a re-run over a release that is already published rebuilds
binaries electron-builder never uploads. There the computed feed equals the published one and
nothing is uploaded, which was checked against v0.45.0's real files. The script fails, leaving a
draft, when a zip, a dmg or the feed is missing, or the feed names another version.
`scripts/verify-release-assets.js` then fails the release unless the feed lists every mac zip,
since a one-arch feed carries the right file name. `node scripts/merge-mac-update-feeds.js vX.Y.Z
--dry-run` prints the result without uploading.

Linux needs none of this: electron-updater reads `latest-linux.yml` on x64 and
`latest-linux-arm64.yml` on arm64, and each Linux leg writes its own.

### Macs below the minimum macOS are not offered the update

`electron-updater` skips an update only when `latest-mac.yml` carries `minimumSystemVersion`, and
electron-builder writes `mac.minimumSystemVersion` into `Info.plist` alone, never into the feed.
Without the field, a Mac on a macOS the new Electron dropped (Electron 44 dropped macOS 12)
downloads the update and macOS refuses to open the result. So `publish-release` runs
`scripts/patch-mac-update-info.js` before the asset check. It derives the floor from
`electron-builder.yml`, converts it to the Darwin version the updater compares against
`os.release()` (macOS 13 is `22.0.0`; the updater lets anything that is not full semver through),
replaces the draft's `latest-mac.yml` with `gh release upload --clobber`, and downloads it again to
prove the field landed. A failure leaves the release a draft. Those Macs stay on the last build
that runs on them. `node scripts/patch-mac-update-info.js vX.Y.Z --dry-run` prints the patched feed
for any release without uploading.

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to main, PRs | Typecheck, unit tests, UI tests |
| `package-smoke.yml` | PRs touching packaging, the pty host, the retrieval worker or their clients; `workflow_dispatch` | `npm run package` on every release target (Windows x64, macOS arm64 and x64 ad-hoc signed, Linux x64 and arm64), each on the same runner the release uses, then `scripts/package-smoke.mjs` runs the packaged app: a terminal, a Knowledge Graph read, a task reap that must stop a detached process the task's terminal left, a user's quit, and a fail on any crash or fallback log line. Not a required check |
| `macos-spawn-helper.yml` | PRs touching the spawn-helper, its gates or `package-lock.json` | Compiles and proves Kangentic's macOS spawn-helper on a real Mac. Not a required check |
| `task-reap-real-processes.yml` | PRs and pushes to main touching `src/main/pty/process-tag/`, the source files outside it that its tests import (the host process table, the process-tree probe, `zombie-reaper.ts`, `process-liveness.ts`), its tests, `vitest.config.ts`, `package.json` or the lockfile (a koffi bump); `workflow_dispatch` | Runs the task leftover reap against real processes on Linux (with a display, tmux and xterm), macOS on Apple silicon and Intel, and Windows, including the visible-app case. On Windows it unpacks a portable Windows Terminal, pinned by version and SHA-256, and reaps a program in one of its tabs. Prints `csrutil status` on macOS: GitHub's runners have SIP off, so the test stands an `env -i` process in for the environment a SIP-on Mac hides. Not a required check |
| `shell-quoting-windows.yml` | PRs and pushes to main touching `shell-quote.ts`, `paths.ts`, `cli-print.ts`, the Claude and Aider command builders, their tests, `vitest.config.ts` or the workflow; `workflow_dispatch` | Runs the live cmd.exe, Windows PowerShell 5.1 and pwsh round trips for the shell escapes on `windows-latest`. Fails if pwsh is missing from the runner. Not a required check |
| `shell-quoting-posix.yml` | PRs and pushes to main touching `shell-quote.ts`, `paths.ts`, the Claude command builder, the round-trip tests and their rig, `vitest.config.ts` or the workflow; `workflow_dispatch` | Installs fish (apt) and nushell (a release tarball pinned by version and SHA-256) on `ubuntu-latest` and runs the live round trips for their `quoteArg` branches. Fails if either shell is missing. Not a required check |
| `release.yml` | Tag push (`v*`) or `workflow_dispatch` | Fail fast if the Sentry symbol-upload secret or an Apple signing secret is absent, create one draft Release, build + sign all 5 targets into it, rebuild `latest-mac.yml` for both macOS arches from the binaries on the release and write the macOS floor into it, verify the asset manifest, then publish with notes (one atomic `gh release edit`) + publish launcher to npm (via OIDC trusted publishing) + redeploy the web demo + attach the docs poster set (`demo-posters-<version>.zip`) |

### CI Build Matrix

The release workflow produces 5 builds, contributing 18 build assets to one release. The full
expected filename set is `scripts/release-assets.js`, which the publish gate checks against and
`tests/unit/release-asset-manifest.test.ts` keeps in sync with `electron-builder.yml` and the
launcher. The `demo-posters` job attaches a nineteenth, `demo-posters-<version>.zip`, after the
release is published; it is outside that manifest by design, because the manifest is verified
before the job runs, and the gate does not fail on an asset it does not list.

Every leg builds on a runner of its own arch, never cross-built: npm installs only the host's
per-arch native packages (sherpa-onnx, sqlite-vec, koffi, sharp), and `build/afterPack.js` loads
the native modules with the packaged Electron binary.

| Runner | Platform | Artifacts |
|--------|----------|-----------|
| `ubuntu-latest` | linux | `_amd64.deb`, `.x86_64.rpm`, `latest-linux.yml` |
| `ubuntu-24.04-arm` | linux-arm64 | `_arm64.deb`, `.aarch64.rpm`, `latest-linux-arm64.yml` |
| `windows-latest` | windows | `Setup.exe`, `.exe.blockmap`, `latest.yml` |
| `macos-latest` | macos-arm64 | `-arm64.dmg`, `-arm64-mac.zip`, a `.blockmap` for each, its `latest-mac.yml` |
| `macos-26-intel` | macos-x64 | `-x64.dmg`, `-x64-mac.zip`, a `.blockmap` for each, its `latest-mac.yml` |

The four `latest*.yml` files are the update manifests `electron-updater` fetches, so a release
missing one is broken for that platform even when its installer uploaded fine. The two macOS legs'
feeds become one `latest-mac.yml` in `publish-release` (see
[One macOS feed for both arches](#one-macos-feed-for-both-arches)). The Linux arm64 leg runs the
same distro install and upgrade gates as x64, in arm64 containers. Its upgrade gates skip on the
first release that ships arm64, since no older release has an arm64 package to upgrade from, and
never again after it: the skip counts arm64 packages across every older published release, not
the baseline alone.

The Knowledge Graph's local model has no Intel macOS build (onnxruntime-node ships no darwin x64
binding), so `build/afterPack.js` skips the embed worker probe on the Intel leg, and the app
reports the feature unavailable there. See [Knowledge Graph](configuration.md#knowledge-graph).

Every artifact filename is pinned via `artifactName` in `electron-builder.yml` rather than
inherited from electron-builder's defaults. Three of the five templates (the macOS zip, the dmg,
and the deb) were inherited until v0.35.0; only `nsis` and `rpm` were already pinned. The launcher
hardcodes the names it downloads, so a default change would have silently 404'd `npx kangentic` on
that platform.

Windows ships x64 only; Windows on ARM runs it under emulation. A native arm64 build would lose
dictation (sherpa-onnx ships no win-arm64 package) and vector search (sqlite-vec ships
windows-x64 only).

### Local Testing

Test the packaged app locally before releasing:

| Command | What it does |
|---------|-------------|
| `npm run make` | Creates platform installers in `out/make/` |
| `npm run package`, then `node scripts/package-smoke.mjs` | Runs the unpacked app in `out/` isolated (scratch data, user data and project) and checks a terminal, a Knowledge Graph read, a task reap and a clean quit, as the `package-smoke` workflow does. A local package never uploads symbols, even with a token set; only CI or `KANGENTIC_SENTRY_UPLOAD=1` does |
| `npm run publish -- --dry-run` | Builds installers + simulates publishing (no upload) |
| `npm run publish -- --from-dry-run` | Uploads previously dry-run artifacts |

The installed app and `npm run dev` share the same data directory. Set `KANGENTIC_DATA_DIR` to isolate them if needed.

## Troubleshooting

### Update not appearing

- Verify the release is **published** (not draft) on GitHub
- The app checks every 4 hours - restart the app to trigger an immediate check
- On macOS, auto-update requires code signing. Without it, updates won't be detected. Released builds are signed; this applies to a local or ad-hoc build.

### Rollback

Run `npx kangentic@X.Y.Z` with the desired version to download and install that specific release.

On Linux the package managers disagree about going backwards. `dnf install` of a local rpm performs
the downgrade without complaint, which the release workflow's rpm upgrade gate measured on
`fedora:latest`, so on Fedora `npx kangentic@X.Y.Z` rolls back on its own. `apt install` refuses
(exit 100, "Packages were downgraded and -y was used without --allow-downgrades"), and so do
`zypper install` and `rpm -U`. On those a rollback needs the distro's explicit downgrade command
(`sudo dpkg -i <file>.deb`, `sudo zypper install --oldpackage <file>.rpm`, or
`sudo rpm -Uvh --oldpackage <file>.rpm`) against the artifact downloaded from
[GitHub Releases](https://github.com/Kangentic/kangentic/releases).

### Clearing update cache

- **Windows:** Delete `%LOCALAPPDATA%\Kangentic\packages\` and restart
- **macOS:** Delete `~/Library/Caches/Kangentic/` and restart

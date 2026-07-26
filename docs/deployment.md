# Deployment

This document covers the full deployment pipeline for maintainers and the update experience for users.

## For Users

### Install

```bash
npx kangentic
```

This downloads the pre-built binary for your platform, installs it, and launches the app. After the first run, auto-updates handle everything (Windows and macOS).

### Auto-Update Behavior

| Platform | Update mechanism | User action |
|----------|-----------------|-------------|
| Windows | `electron-updater` (NSIS) | Review the release notes in the modal and click "Restart to update", or quit normally - installs silently on next launch. |
| macOS | `electron-updater` | Review the release notes in the modal and click "Restart to update". Requires code signing - see [macOS signing note](#macos-auto-update-requires-signing). |
| Linux | None | Re-run `npx kangentic` or download from [GitHub Releases](https://github.com/Kangentic/kangentic/releases). |

Auto-update is implemented in `src/main/updater.ts`. It checks for updates 5 seconds after launch, then every 4 hours. Updates download in the background; when ready, a centered modal shows the new version's release notes (rendered markdown, sourced from `RELEASE_NOTES.md` baked into the update manifest at build time - see [Release Sequencing](#release-sequencing)) with "Restart to update" and "Later". The modal auto-opens once per version; "Later" dismisses it in favor of a persistent title-bar indicator that reopens it. A version whose release carried no notes falls back to the legacy persistent toast. v0.1.0 users must manually update to v0.2.0 - auto-update kicks in from v0.2.0 onward.

### Install a Specific Version

```bash
npx kangentic@0.2.0
```

The launcher version matches the app version. This downloads the exact matching release.

### Rollback

To roll back to a previous version, run `npx kangentic@X.Y.Z` with the desired version. On Windows, the NSIS installer will replace the current version. On macOS, the .app is replaced in `~/Applications/`.

## For Maintainers

### Release Sequencing

1. **`/release patch`** (or `minor`/`major`) - analyzes conventional commits, bumps version in root `package.json` + `packages/launcher/package.json`, generates CHANGELOG entry + user-friendly release notes written to `RELEASE_NOTES.md` at the repo root, commits, tags, pushes.
2. **`electron-builder.yml`'s `releaseInfo.releaseNotesFile: RELEASE_NOTES.md`** bakes that file's contents into every generated `latest*.yml` update manifest at build time. `electron-updater`'s GitHub provider prefers a populated `releaseNotes` key over its Atom-feed fallback, so this is also the source for the in-app release-notes modal (see [Auto-Update Behavior](#auto-update-behavior)), with no separate fetch and no new IPC channel.
3. **Tag push triggers `release.yml`** - requires approval from the `release` environment (Settings > Environments). Builds all platforms (Linux x64, Windows x64, macOS arm64), signs binaries (when signing secrets are configured), creates a **draft** GitHub Release with artifacts attached.
4. **Run the [release smoke checklist](release-checklist.md)** against the built artifacts. Automated tests use mock CLI fixtures, so this is the only place real model latency, real tool calls, and conversation continuity across resume get exercised. It does not gate publishing: `publish-release` fires as soon as the builds succeed (step 5), so the lever for a failure here is [Rollback](#rollback), not withholding the release. To gate on the checklist instead, the approval in step 3 has to be the decision point.
5. **The `publish-release` job publishes the draft automatically** once every platform build succeeds: it clears draft status (`--draft=false`) and sets the body from `RELEASE_NOTES.md` in the same `gh release edit` call, so the release is never live with an empty body. The human gate sits earlier, on the `release` environment approval in step 3 - `publish-release` declares no `environment:` of its own, so nothing blocks between the builds finishing and the release going live. Watch the run at [github.com/Kangentic/kangentic/releases](https://github.com/Kangentic/kangentic/releases).
6. **The `publish-npm` job in `release.yml`** publishes the launcher package to npm after `publish-release` succeeds, using Trusted Publishing (OIDC) - no token required.
7. **`npx kangentic`** now downloads the new version's signed binaries.

### Commit Conventions

All commits must use [Conventional Commits](https://www.conventionalcommits.org/) format. A husky commit-msg hook runs commitlint to enforce this. The commit skills (`/commit`, `/pull-request`, `/merge-pull-request`, `/merge-back`) auto-generate conventional commit messages from diffs.

Common prefixes: `feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `test:`, `perf:`, `ci:`, `build:`. Add `!` after the type for breaking changes (e.g., `feat!:`).

### Release Permissions

Releases require two things:
- **Write** role (minimum) to trigger the workflow or push a tag
- **`release` environment reviewer** to approve the workflow run

Configure the `release` environment in Settings > Environments with required reviewers. Even Admin users cannot bypass environment approval.

### Code Signing Secrets

Signing only activates when the corresponding env vars are present. Local dev builds remain unsigned. CI builds sign when secrets exist.

| Secret | Source |
|--------|--------|
| `APPLE_IDENTITY` | Apple Developer ID Application certificate name |
| `APPLE_ID` | Apple ID email |
| `APPLE_PASSWORD` | App-specific password (not account password) |
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

Electron's `autoUpdater` on macOS only works with signed apps (Electron docs: "mandatory for auto-update on macOS"). Until the Apple Developer certificate secrets are configured:

- macOS users will NOT receive auto-updates
- They must re-run `npx kangentic` manually to get new versions
- The Gatekeeper bypass is also required on each install (see [Installation Guide](installation.md#macos-gatekeeper))

### Draft Releases Are Invisible to Auto-Updater

`electron-updater` only sees **published** releases. Draft releases are invisible to the auto-updater and to `npx kangentic`. The manual publish step is the review gate -- always verify artifacts before publishing.

### GitHub Actions Workflows

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | Push to main, PRs | Typecheck, unit tests, UI tests |
| `release.yml` | Tag push (`v*`) or `workflow_dispatch` | Build + sign + draft GitHub Release, then publish with notes (one atomic `gh release edit`) + publish launcher to npm (via OIDC trusted publishing) |

### CI Build Matrix

The release workflow produces 3 builds:

| Runner | Platform | Artifacts |
|--------|----------|-----------|
| `ubuntu-latest` | linux-x64 | `.deb`, `.rpm` |
| `windows-latest` | windows-x64 | `Setup.exe`, `.nupkg` |
| `macos-latest` | macos-arm64 | `.dmg`, `.zip` |

Linux arm64 and macOS x64 are not built in v1. Documented in the [Installation Guide](installation.md).

### Local Testing

Test the packaged app locally before releasing:

| Command | What it does |
|---------|-------------|
| `npm run make` | Creates platform installers in `out/make/` |
| `npm run publish -- --dry-run` | Builds installers + simulates publishing (no upload) |
| `npm run publish -- --from-dry-run` | Uploads previously dry-run artifacts |

The installed app and `npm run dev` share the same data directory. Set `KANGENTIC_DATA_DIR` to isolate them if needed.

## Troubleshooting

### Update not appearing

- Verify the release is **published** (not draft) on GitHub
- The app checks every 4 hours - restart the app to trigger an immediate check
- On macOS, auto-update requires code signing. Without it, updates won't be detected.

### Rollback

Run `npx kangentic@X.Y.Z` with the desired version to download and install that specific release.

### Clearing update cache

- **Windows:** Delete `%LOCALAPPDATA%\Kangentic\packages\` and restart
- **macOS:** Delete `~/Library/Caches/Kangentic/` and restart

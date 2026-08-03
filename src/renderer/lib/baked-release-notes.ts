// The release notes for the version this build IS, inlined at build time.
//
// Why inlined rather than fetched or persisted:
//   - RELEASE_NOTES.md is NOT in the packaged app (electron-builder.yml's
//     `files:` is a whitelist), so it cannot be read from disk at runtime.
//   - Persisting the markdown from the UPDATE_DOWNLOADED payload cannot work for
//     the release that introduces it: that payload arrives in the OLD client, so
//     there would be nothing to read back on the first upgrade into this code.
//   - Inlining also covers the paths the in-app updater never reaches at all -
//     a fresh install, a manual NSIS/DMG install, and Linux, where initUpdater()
//     early-returns (see src/main/updater.ts).
//
// The repo root is the Vite root in every build path (vite.config.mts declares
// no `root:` and lives at the repo root; scripts/dev.js's worktree branch sets
// `root: projectDir` explicitly), so this resolves with no build-script change
// and no server.fs.allow entry. `/release` rewrites RELEASE_NOTES.md and bumps
// package.json in the same commit, so these notes always describe the version
// app.getVersion() reports.
import rawReleaseNotes from '../../../RELEASE_NOTES.md?raw';

/**
 * The running version's release notes as markdown, or an empty string when the
 * file is empty or whitespace only. Callers treat empty as "no notes to show":
 * there is no toast fallback here (unlike the pre-restart flow), because after a
 * restart there is no pending action to offer.
 */
export const bakedReleaseNotes: string = rawReleaseNotes.trim();

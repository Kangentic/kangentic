/**
 * Public URL for a released version's GitHub release page.
 *
 * Matches electron-builder.yml's `publish` block (owner: Kangentic, repo:
 * kangentic) and the `vX.Y.Z` tag format `/release` creates. Shared by the
 * pre-restart release-notes dialog and the post-update what's-new dialog, which
 * both offer it as the way to read more than the current version's notes.
 */
export function githubReleaseUrl(version: string): string {
  return `https://github.com/Kangentic/kangentic/releases/tag/v${version}`;
}

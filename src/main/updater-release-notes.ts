// Normalizes electron-updater's release-notes union into the flat string the
// renderer's release-notes modal expects. Kept standalone (no `electron` /
// `electron-updater` imports) so it is reachable from the node-env unit
// tier without dragging in the updater.ts mock bag.

/** Structurally matches builder-util-runtime's ReleaseNoteInfo. */
export interface ReleaseNoteEntry {
  version: string;
  note: string | null;
}

export type RawReleaseNotes = string | ReleaseNoteEntry[] | null | undefined;

/**
 * `fullChangelog` is left at its `false` default (see AppUpdater.js), so
 * electron-updater's `releaseNotes` is a plain string in practice. The array
 * form only appears with `fullChangelog: true`; handled here for type safety
 * even though we do not enable it.
 *
 * GitHubProvider reports GitHub's empty-body sentinel ("No content.") as an
 * empty string, not null, so empty string is the real "nothing to show"
 * signal the caller must check for.
 */
export function normalizeReleaseNotes(input: RawReleaseNotes): string {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  return input
    .map((entry) => entry.note)
    .filter((note): note is string => note != null && note.length > 0)
    .join('\n\n');
}

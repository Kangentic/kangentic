/**
 * What began the quit in progress, for a launch the quit ends (`quit_by`).
 *
 * A launch that had shown nothing for a minute and was ended by a quit is
 * reported by the next start as `abandoned`, a person giving up. Sentry
 * DESKTOP-2N was a person installing an update, and only a timestamp match
 * against another issue showed it. The quit path knows: the updater's install
 * calls `quitAndInstall`, and the OS shutdown routes run their own flush. Each
 * says so here just before it quits, and `syncShutdownCleanup` reads it.
 *
 * A fixed set of three values, never text. Anything that notes nothing is a
 * quit the user asked for, which is also what a signal's exit reads as: a
 * signal cannot say whether a person or the OS sent it.
 *
 * Main process only, and synchronous: the quit path cannot wait on anything
 * (`synchronous-shutdown.md`).
 */

export type QuitBy = 'update' | 'os' | 'user';

let notedQuitBy: QuitBy = 'user';

/**
 * Note that an update's install (`update`) or an OS shutdown (`os`) is what is
 * quitting the app. Call it right before the quit starts. The first one noted
 * stands: an OS shutdown that lands during an update's quit is still the
 * update's launch to explain.
 */
export function noteQuitBy(by: Exclude<QuitBy, 'user'>): void {
  if (notedQuitBy === 'user') notedQuitBy = by;
}

/** What began this quit: `user` unless an update or an OS shutdown said so. */
export function quitByNoted(): QuitBy {
  return notedQuitBy;
}

/** For tests: back to a quit nobody explained. */
export function resetQuitBy(): void {
  notedQuitBy = 'user';
}

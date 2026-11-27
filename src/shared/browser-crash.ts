/**
 * Why a Browser pane page stopped, in the two words the user and the agent are
 * given (task #1226, design D2 A).
 *
 * Electron reports eight `render-process-gone` reasons. Running out of memory
 * is the one a user can act on (their own dev app is leaking, or the site is
 * too heavy), so it gets its own words. Every other reason, and any reason a
 * later Electron adds, reads "crashed". A page the OS or Task Manager ended is
 * in that bucket too: the user who ended it recognises it anyway.
 *
 * Pure, with no Electron import, so the renderer (the webview's DOM event) and
 * main (the guest webContents' event) classify through the same table.
 */
export type BrowserCrashKind = 'out-of-memory' | 'crashed';

const OUT_OF_MEMORY_REASONS: ReadonlySet<string> = new Set(['oom', 'memory-eviction']);

export function browserCrashKind(reason: string | null | undefined): BrowserCrashKind {
  return reason != null && OUT_OF_MEMORY_REASONS.has(reason) ? 'out-of-memory' : 'crashed';
}

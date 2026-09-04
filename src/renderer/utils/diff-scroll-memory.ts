/**
 * In-memory scroll-position memory for the Changes view diff editor.
 *
 * The Monaco DiffEditor stays mounted across file switches, so scroll position
 * would otherwise bleed between files. This module remembers each file's scroll
 * position (keyed by a task-scoped scroll key plus the file path) so revisiting
 * a file restores where the user left off. The first time a file is opened the
 * map has no entry, and the caller falls back to revealing the first change.
 *
 * The map is module-scope and preserved across HMR (Pattern A in
 * `.claude/rules/hmr-patterns.md`), mirroring `savedScrollPositions` in
 * `src/renderer/hooks/useTerminal.ts`. It is intentionally NOT persisted to the
 * database: a fresh app start falls back to the first-change reveal.
 */

export interface DiffScrollPosition {
  scrollTop: number;
  scrollLeft: number;
}

/** What the diff viewer should do when a file's content first becomes visible. */
export type DiffScrollAction =
  | { kind: 'restore'; position: DiffScrollPosition }
  | { kind: 'revealLineInCenter'; lineNumber: number }
  | { kind: 'scrollToTop' };

/** A single computed line change, narrowed to the field the reveal needs. */
export interface DiffLineChangeLike {
  modifiedStartLineNumber: number;
}

// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const savedDiffScrollPositions: Map<string, DiffScrollPosition> = import.meta.hot?.data?.savedDiffScrollPositions ?? new Map<string, DiffScrollPosition>();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.savedDiffScrollPositions = savedDiffScrollPositions;
  });
}

/** Build the map key from the task-scoped scroll key and the file path. */
export function makeDiffScrollKey(scrollKey: string, filePath: string): string {
  return `${scrollKey}:${filePath}`;
}

/** Read a saved scroll position, or undefined if the file has not been visited. */
export function getSavedDiffScroll(key: string): DiffScrollPosition | undefined {
  return savedDiffScrollPositions.get(key);
}

/** Remember a file's scroll position. */
export function saveDiffScroll(key: string, position: DiffScrollPosition): void {
  savedDiffScrollPositions.set(key, position);
}

/**
 * Clamp a saved scrollTop to what the editor's CURRENT layout can actually
 * scroll to.
 *
 * A diff editor's modified-side scroll height is not a property of the file: it
 * includes the alignment view zones that pad the modified side against the
 * original's inserted/deleted lines. Those zones only exist once the diff has
 * been computed, so between a model swap and the diff result the same file is
 * measurably shorter than it will be. Handing Monaco an offset past the end
 * leaves the scroll state disagreeing with the view model's line count, and the
 * next alignment-zone update resolves it into a line past the last one
 * ("Illegal value for lineNumber", Sentry DESKTOP-8).
 *
 * Restoring past the end saturates at the bottom. A non-finite input (a
 * disposed or never-laid-out editor reporting NaN) degrades to the top.
 */
export function clampDiffScrollTop(
  scrollTop: number,
  scrollHeight: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(scrollTop) || !Number.isFinite(scrollHeight) || !Number.isFinite(viewportHeight)) {
    return 0;
  }
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  return Math.min(Math.max(0, scrollTop), maxScrollTop);
}

/**
 * Decide how to position a file's diff when its content first becomes visible.
 *
 * - A saved position always wins (revisit): restore it.
 * - Otherwise the diff must be computed to reveal the first change. `null` line
 *   changes mean the computation has not finished, so return `null` and stay
 *   armed until it does.
 * - A non-empty result reveals the first hunk centered. Pure-deletion hunks
 *   report `modifiedStartLineNumber` 0, so clamp to line 1.
 * - An empty result (no detectable changes) falls back to the top of the file.
 */
export function resolveDiffScrollAction(
  saved: DiffScrollPosition | undefined,
  lineChanges: DiffLineChangeLike[] | null,
): DiffScrollAction | null {
  if (saved) {
    return { kind: 'restore', position: saved };
  }
  if (lineChanges === null) {
    return null;
  }
  if (lineChanges.length === 0) {
    return { kind: 'scrollToTop' };
  }
  return { kind: 'revealLineInCenter', lineNumber: Math.max(1, lineChanges[0].modifiedStartLineNumber) };
}

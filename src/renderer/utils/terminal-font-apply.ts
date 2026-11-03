// The pure half of useTerminal's live font apply, kept out of the hook so the
// unit tier (no jsdom, no xterm) can run the real code.

export interface AppliedTerminalFont {
  family: string;
  size: number;
}

/**
 * Whether `family` at `size` differs from what this terminal last applied. Two
 * sites ask it: the effect, against the size the terminal WILL apply, to decide
 * whether a font load is needed; and the apply step, against the size it
 * actually assigned, to decide whether the shared glyph atlas must be cleared.
 * A terminal that has applied nothing yet always counts as changed.
 */
export function terminalFontMoved(
  previous: AppliedTerminalFont | null,
  family: string,
  size: number,
): boolean {
  return !previous || previous.family !== family || previous.size !== size;
}

/**
 * Run `apply` once, after `load` settles when `needsLoad` is true and at once
 * otherwise. A rejected load still applies: the options are applied either way
 * rather than left stale. The returned cancel makes a not-yet-run `apply` a
 * no-op, which is how a newer font change (or an unmount) drops a load that
 * settles late.
 */
export function scheduleFontApply(
  needsLoad: boolean,
  load: () => Promise<unknown>,
  apply: () => void,
): () => void {
  let cancelled = false;
  const applyUnlessCancelled = () => {
    if (cancelled) return;
    apply();
  };
  if (needsLoad) {
    load().then(applyUnlessCancelled, applyUnlessCancelled);
  } else {
    applyUnlessCancelled();
  }
  return () => {
    cancelled = true;
  };
}

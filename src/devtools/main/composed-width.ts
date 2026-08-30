/**
 * Measure the terminal width a child TUI is actually COMPOSING rows at, from
 * its own byte stream.
 *
 * The existing terminal invariants (`ptyMatchesGrid`, `colsDrift`,
 * `gridOverflowPx`) compare main's PTY grid against the renderer's xterm grid,
 * and Kangentic sets both of those itself, so they agree by construction. The
 * third layer - the width the agent CLI believes it has - is invisible to them:
 * a resize applied in the spawn window can fail to reach the child (ConPTY only
 * delivers a resize to a connected client), leaving it composing 120-column
 * rows inside a 306-column terminal while every two-layer invariant reads
 * healthy. That width IS readable from the stream: a fullscreen TUI draws
 * full-width rule runs, pads rows with spaces to its believed width, and erases
 * rows with `CSI n X` spans sized to that width.
 *
 * Signals used:
 * - Runs of one identical printable codepoint (rules, padding rows), measured
 *   in COLUMNS via `wcwidthV11` - never code units - per
 *   .claude/rules/xterm-unicode11-parity.md. Any escape sequence or C0 control
 *   splits a run, so SGR params can neither merge two runs nor count as
 *   content.
 * - ECH erase spans (`CSI n X`), whose parameter is already a column count.
 *
 * CUF is deliberately excluded: its parameter is a relative move, and turning
 * it into an absolute column requires a cursor model that needs a known width
 * to clamp, which is circular.
 *
 * A run's length is a MULTIPLE of the composed width, not the width itself:
 * the TUI reaches the next row by autowrap rather than CR/LF, so two adjacent
 * same-glyph full-width rows (a rule under a rule, padding under padding)
 * arrive as ONE 2W-length run. Measured live 2026-08-29: a healthy 306-column
 * session produced nine 612-length runs and a naive max-aggregate read it as
 * a 612-column child. So candidates are FOLDED: every base width w that some
 * candidate could be a k-row concatenation of (k <= COMPOSED_WIDTH_MAX_WRAP_MULTIPLE)
 * is scored across the candidates it explains as approximate multiples, and
 * the best-supported base wins, ties breaking toward the caller's reference
 * grid, then toward the larger base.
 *
 * The load-bearing step is the REFERENCE-CONSISTENCY pre-filter, grounded in
 * a physical bound rather than statistics: inside the alternate buffer a
 * child believing width W cannot produce a same-glyph run or ECH span longer
 * than W except as autowrap multiples of W - every sub-width run is bounded
 * by W per row, and concatenation only happens at full-width row boundaries.
 * So a candidate within tolerance of k*referenceCols can only come from a
 * child that actually believes the reference width; noise cannot fake it.
 * When such candidates exist, ONLY they are folded (they resolve to the
 * reference); the full set is folded only when nothing is consistent, which
 * is exactly the glued defect. Without this filter, dense sub-width lattices
 * out-voted the truth twice on live frames: base 44 grazed the 210-frame's
 * spans under a k-scaled tolerance, and base 40 strictly dominated a healthy
 * 120-column child (every multiple of 120 is one of 40, plus stray 40-column
 * indent runs) - a false red on a session that was healthy by construction.
 *
 * The alt-screen gate still matters: inside the alternate buffer every
 * qualifying run is something the TUI composed against its believed width.
 * Outside it, raw pass-through content (a 500-char `====` divider in cat
 * output) has no relationship to any width; those sessions must report null
 * instead of measuring.
 *
 * Windowing: scan a bounded recent tail, sliced from the last alt-screen entry
 * (`CSI ? 1049 h`) when present so pre-TUI shell bytes never vote. Within it,
 * prefer the slice after the last clear-screen (`CSI 2 J`): a healed child
 * repaints from a clear, so this drops stale runs composed at the previous
 * width. When the post-clear slice is too thin to be trustworthy (fewer than
 * `COMPOSED_WIDTH_MIN_WINDOW_SAMPLES` candidates), fall back to the full
 * window rather than reporting a width off one or two samples.
 *
 * Known limitations, accepted: the clipped direction (child composing WIDER
 * than the PTY) can read as matching because ConPTY re-wraps overlong runs at
 * its own grid before they reach the ring; and after a shrink heals, stale
 * wide runs can hold the max until a clear-screen repaint enters the tail.
 * The glued direction (child composing narrower - the spawn-race defect this
 * measurement exists for) is the reliable one.
 */
import { wcwidthV11 } from '../../shared/xterm-unicode11';

/** Recent-tail scan bound, in UTF-16 code units (the ring's own unit). */
export const COMPOSED_WIDTH_TAIL_CHARS = 48 * 1024;
/** A candidate must span at least this many columns: below any plausible pane
 *  width, above content noise (short rules, "----" in prose). */
export const COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS = 40;
/** Minimum candidates for the post-clear-screen slice to stand alone. */
export const COMPOSED_WIDTH_MIN_WINDOW_SAMPLES = 3;
/** Tolerance for `composedMatchesPty`: a frame whose only full-width evidence
 *  is box borders reads width-2 (the corner glyphs differ from the rule run).
 *  The real defect is a 120-vs-306 gap, which this can never mask. */
export const COMPOSED_MATCH_TOLERANCE_COLUMNS = 2;
/** Deepest autowrap concatenation the fold considers: a run is treated as at
 *  most this many adjacent full-width rows glued by autowrap. */
export const COMPOSED_WIDTH_MAX_WRAP_MULTIPLE = 6;
/** Fold bound: at most this many DISTINCT candidate values enter the fold.
 *  Real frames yield a handful of distinct widths, so this never engages in
 *  practice; it exists because an adversarial or corrupted ring can pack the
 *  48KB window with thousands of distinctly-sized ECH spans (`\x1b[40X` is 5
 *  code units), and the quadratic fold below would then stall the shared
 *  main-process event loop for a single dev request. */
export const COMPOSED_WIDTH_MAX_FOLD_CANDIDATES = 1024;

const ALT_SCREEN_ENTER = '\x1b[?1049h';
const CLEAR_SCREEN = '\x1b[2J';

export interface ComposedWidthMeasurement {
  /** Columns the child appears to compose at, or null with no signal. */
  composedCols: number | null;
  /** How many candidates the winning width explains as approximate multiples. */
  sampleCount: number;
  /** Code units actually scanned (the window the verdict is based on). */
  windowChars: number;
}

/**
 * Consume one escape sequence starting at `start`; returns code units
 * consumed. Tokenization mirrors VirtualScreen.consumeEscape
 * (src/main/pty/virtual-screen.ts) so both parsers split the stream at the
 * same boundaries; this one only harvests ECH spans instead of painting.
 */
function consumeEscapeCollectingEch(data: string, start: number, candidates: number[]): number {
  const next = data[start + 1];
  if (next === '[') {
    // CSI: ESC [ <params> <final byte in @-~>
    let end = start + 2;
    while (end < data.length && !(data[end] >= '@' && data[end] <= '~')) end++;
    if (end >= data.length) return data.length - start; // truncated chunk tail
    if (data[end] === 'X') {
      const params = data.slice(start + 2, end).replace(/^[?<>=!]/u, '');
      const count = parseInt(params, 10);
      if (Number.isFinite(count) && count >= COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS) {
        candidates.push(count);
      }
    }
    return end - start + 1;
  }
  if (next === ']') {
    // OSC: ESC ] ... terminated by BEL or ST (ESC \)
    let end = start + 2;
    while (end < data.length) {
      if (data[end] === '\x07') return end - start + 1;
      if (data[end] === '\x1b' && data[end + 1] === '\\') return end - start + 2;
      end++;
    }
    return data.length - start;
  }
  if (next === '(' || next === ')' || next === '#') return 3; // charset / line attr
  return 2; // ESC + single byte (=, >, 7, 8, ...)
}

/** Every width candidate in the window: qualifying identical-codepoint run
 *  widths (in columns) and qualifying ECH span counts. */
function collectWidthCandidates(window: string): number[] {
  const candidates: number[] = [];
  let runCodepoint: number | null = null;
  let runLength = 0;

  const closeRun = (): void => {
    if (runCodepoint !== null && runLength > 0) {
      const runColumns = runLength * wcwidthV11(runCodepoint);
      if (runColumns >= COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS) candidates.push(runColumns);
    }
    runCodepoint = null;
    runLength = 0;
  };

  let index = 0;
  while (index < window.length) {
    const char = window[index];
    if (char === '\x1b') {
      closeRun();
      index += consumeEscapeCollectingEch(window, index, candidates);
      continue;
    }
    if (char < ' ' || char === '\x7f') {
      closeRun();
      index++;
      continue;
    }
    // Advance by CODE POINT so an astral glyph counts once, not twice.
    const codepoint = window.codePointAt(index) as number;
    if (codepoint === runCodepoint) {
      runLength++;
    } else {
      closeRun();
      runCodepoint = codepoint;
      runLength = 1;
    }
    index += String.fromCodePoint(codepoint).length;
  }
  closeRun();
  return candidates;
}

/**
 * True when `candidate` reads as `k` adjacent rows of width `baseWidth` glued
 * by autowrap, for some k in 1..COMPOSED_WIDTH_MAX_WRAP_MULTIPLE. The
 * tolerance is FLAT, never scaled by k: scaling made a sub-multiple more
 * permissive than the base itself, and on live bytes base 102 then claimed
 * ECH-301 spans (off 5 at k=3, slack 6) that the true 306 rightly rejected
 * (off 5 at k=1, slack 2), out-explaining the truth with its own noise.
 */
function explainsCandidate(baseWidth: number, candidate: number): boolean {
  const wrapMultiple = Math.round(candidate / baseWidth);
  if (wrapMultiple < 1 || wrapMultiple > COMPOSED_WIDTH_MAX_WRAP_MULTIPLE) return false;
  return (
    Math.abs(candidate - wrapMultiple * baseWidth) <= COMPOSED_MATCH_TOLERANCE_COLUMNS
  );
}

/** Score ties within this epsilon are treated as equal explanatory power. */
const SCORE_TIE_EPSILON = 1e-9;

/**
 * Fold the candidate lengths to the best-supported base width (see the module
 * doc). A base's score is EXACTNESS-weighted (each explained candidate
 * contributes 1/(1+offset)), not a bare count: a small base has dense
 * multiples, so some multiple of it grazes almost any length at the edge of
 * the eligibility band, and count-scoring let base 44 "explain" the real
 * 210-column frame. An exact single-row hit outranks a grazing multiple.
 * `referenceCols` breaks ties between bases with equal scores - exact mutual
 * sub-multiples are indistinguishable on the evidence alone - and cannot
 * override evidence a reference-far base explains better.
 */
function resolveBaseWidth(
  candidates: number[],
  referenceCols: number | null,
): { baseWidth: number; explained: number } {
  // Fold over DISTINCT values weighted by occurrence count. Score and
  // explained are additive per occurrence, so the dedup is
  // behavior-preserving; it also bounds the quadratic scan below, with the
  // distinct-value cap as the backstop (dropping the OLDEST values first,
  // matching the window's recency preference).
  const countsByValue = new Map<number, number>();
  for (const candidate of candidates) {
    countsByValue.set(candidate, (countsByValue.get(candidate) ?? 0) + 1);
  }
  if (countsByValue.size > COMPOSED_WIDTH_MAX_FOLD_CANDIDATES) {
    const excess = countsByValue.size - COMPOSED_WIDTH_MAX_FOLD_CANDIDATES;
    for (const staleValue of Array.from(countsByValue.keys()).slice(0, excess)) {
      countsByValue.delete(staleValue);
    }
  }
  const baseWidths = new Set<number>();
  for (const candidateValue of countsByValue.keys()) {
    for (let wrapMultiple = 1; wrapMultiple <= COMPOSED_WIDTH_MAX_WRAP_MULTIPLE; wrapMultiple++) {
      const baseWidth = Math.round(candidateValue / wrapMultiple);
      if (baseWidth >= COMPOSED_WIDTH_MIN_SIGNAL_COLUMNS) baseWidths.add(baseWidth);
    }
  }
  let best: { baseWidth: number; explained: number; score: number } | null = null;
  for (const baseWidth of baseWidths) {
    let explained = 0;
    let score = 0;
    for (const [candidateValue, occurrenceCount] of countsByValue) {
      if (!explainsCandidate(baseWidth, candidateValue)) continue;
      explained += occurrenceCount;
      const wrapMultiple = Math.round(candidateValue / baseWidth);
      score += occurrenceCount / (1 + Math.abs(candidateValue - wrapMultiple * baseWidth));
    }
    if (explained === 0) continue;
    if (!best || score > best.score + SCORE_TIE_EPSILON) {
      best = { baseWidth, explained, score };
      continue;
    }
    if (score < best.score - SCORE_TIE_EPSILON) continue;
    // Tied explanatory power: prefer the base nearer the reference grid,
    // falling back to the larger base (a sub-multiple over-folds).
    if (referenceCols !== null) {
      const currentDistance = Math.abs(best.baseWidth - referenceCols);
      const candidateDistance = Math.abs(baseWidth - referenceCols);
      if (candidateDistance < currentDistance) best = { baseWidth, explained, score };
      else if (candidateDistance === currentDistance && baseWidth > best.baseWidth) {
        best = { baseWidth, explained, score };
      }
    } else if (baseWidth > best.baseWidth) {
      best = { baseWidth, explained, score };
    }
  }
  // candidates is non-empty at every call site and every candidate explains
  // its own k=1 base, so best is always set; the fallback satisfies the type
  // system.
  return best
    ? { baseWidth: best.baseWidth, explained: best.explained }
    : { baseWidth: candidates[0], explained: 1 };
}

/**
 * Derive the composed width from a session's raw scrollback ring. The caller
 * is responsible for the alt-screen gate (see the module doc); feeding a
 * non-alt-screen stream here yields garbage-in verdicts. `referenceCols`
 * (typically the live PTY grid) only breaks evidence ties - see
 * `resolveBaseWidth`.
 */
export function measureComposedCols(
  rawScrollback: string,
  referenceCols: number | null = null,
): ComposedWidthMeasurement {
  let tail = rawScrollback.slice(-COMPOSED_WIDTH_TAIL_CHARS);
  // Nudge off an orphaned low surrogate the plain slice can land on (an emoji
  // split across the boundary), mirroring the forensics tail slice.
  const firstCodeUnit = tail.charCodeAt(0);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) tail = tail.slice(1);

  const altScreenIndex = tail.lastIndexOf(ALT_SCREEN_ENTER);
  const composeWindow =
    altScreenIndex >= 0 ? tail.slice(altScreenIndex + ALT_SCREEN_ENTER.length) : tail;

  let scannedWindow = composeWindow;
  let candidates: number[];
  const clearIndex = composeWindow.lastIndexOf(CLEAR_SCREEN);
  if (clearIndex >= 0) {
    const afterClear = composeWindow.slice(clearIndex + CLEAR_SCREEN.length);
    const afterClearCandidates = collectWidthCandidates(afterClear);
    if (afterClearCandidates.length >= COMPOSED_WIDTH_MIN_WINDOW_SAMPLES) {
      scannedWindow = afterClear;
      candidates = afterClearCandidates;
    } else {
      candidates = collectWidthCandidates(composeWindow);
    }
  } else {
    candidates = collectWidthCandidates(composeWindow);
  }

  if (candidates.length === 0) {
    return { composedCols: null, sampleCount: 0, windowChars: scannedWindow.length };
  }
  // Reference-consistency pre-filter (see the module doc): candidates that
  // read as k rows of the reference width can only come from a child that
  // believes that width, so when any exist the fold runs on them alone and
  // resolves to the reference. An empty consistent set with a non-empty
  // candidate set is the glued defect: fold everything to name the width the
  // child is actually composing at.
  const referenceConsistent =
    referenceCols !== null
      ? candidates.filter((candidate) => explainsCandidate(referenceCols, candidate))
      : [];
  const folded = resolveBaseWidth(
    referenceConsistent.length > 0 ? referenceConsistent : candidates,
    referenceCols,
  );
  return {
    composedCols: folded.baseWidth,
    sampleCount: folded.explained,
    windowChars: scannedWindow.length,
  };
}

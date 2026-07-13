/** Above this combined original+modified character count, a diff is large
 *  enough that Monaco's 'advanced' (word-level) algorithm can take noticeably
 *  longer to resolve in its worker than the simpler 'legacy' line diff -
 *  visible as a delayed diff paint, not a frozen UI (Monaco's diff computation
 *  always runs off the main thread; see editorWebWorker's $computeDiff). */
const LARGE_DIFF_CHAR_THRESHOLD = 200_000;

/** Bounded computation time (ms) for a large diff, below Monaco's 5000ms
 *  default, so a pathological file fails fast to the "diff took too long"
 *  fallback instead of leaving the pane blank for several seconds. */
const LARGE_DIFF_MAX_COMPUTATION_MS = 2_000;

export interface DiffAlgorithmOptions {
  diffAlgorithm: 'legacy' | 'advanced';
  maxComputationTime?: number;
}

/** Picks the diff algorithm and computation-time bound by content size, so a
 *  large diff resolves faster instead of paying for the full word-level diff. */
export function selectDiffAlgorithmOptions(originalLength: number, modifiedLength: number): DiffAlgorithmOptions {
  if (originalLength + modifiedLength > LARGE_DIFF_CHAR_THRESHOLD) {
    return { diffAlgorithm: 'legacy', maxComputationTime: LARGE_DIFF_MAX_COMPUTATION_MS };
  }
  return { diffAlgorithm: 'advanced' };
}

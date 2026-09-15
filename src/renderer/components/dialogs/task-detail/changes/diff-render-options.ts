import { THEME_BASES } from '../../../../../shared/types';
import type { ThemeMode } from '../../../../../shared/types';

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

/**
 * Monaco's built-in theme id for a given app theme, driven by THEME_BASES (a
 * total `Record<ThemeMode, 'dark' | 'light'>`) rather than NAMED_THEMES (the
 * settings-dropdown metadata list, which omits 'dark' and 'light' since those
 * two are hardcoded dropdown options). Looking this up against NAMED_THEMES
 * used to fall through its `?? 'dark'` fallback for the Light theme, painting
 * a black diff pane inside an otherwise light app - see THEME_BASES' own
 * comment in src/shared/types.ts. The `?? 'dark'` here is a runtime-only
 * backstop for an id that predates a theme rename/removal on disk; every
 * value of the ThemeMode type itself is covered by THEME_BASES.
 */
export function monacoThemeForTheme(theme: ThemeMode): 'vs' | 'vs-dark' {
  const themeBase = THEME_BASES[theme] ?? 'dark';
  return themeBase === 'dark' ? 'vs-dark' : 'vs';
}

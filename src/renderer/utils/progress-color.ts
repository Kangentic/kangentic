/**
 * Severity color for a consumed-budget progress fill (context window usage,
 * rate-limit quota usage). Three discrete bands, not a gradient: a gradient
 * blends into an ambiguous midpoint exactly where the user most needs a clear
 * read (a retuned lerp reproduces the same problem this replaced). Returns a
 * `var(--kng-*)` reference, not a hex, so the fill follows the active theme -
 * every call site drops the value straight into an inline `backgroundColor`,
 * where a CSS variable resolves normally.
 *
 * The thresholds were picked to match kangentic-mobile's `contextUsageColor`
 * (src/components/ContextUsageBar.tsx) as of writing. Nothing checks the two
 * repos against each other, so that is a starting point, not a contract: if
 * they need to stay aligned, the alignment needs an owner, not a comment.
 */
export function getProgressColor(percentage: number): string {
  if (percentage >= 90) return 'var(--kng-danger)';
  if (percentage >= 70) return 'var(--kng-warning)';
  return 'var(--kng-active)';
}

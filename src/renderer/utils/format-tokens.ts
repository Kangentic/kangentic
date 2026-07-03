/**
 * Format a token count for compact display.
 * e.g. 850 → "850", 1200 → "1.2k", 45300 → "45.3k", 200000 → "200k", 1200000 → "1.2M"
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(1);
    return `${v.endsWith('.0') ? v.slice(0, -2) : v}k`;
  }
  const v = (n / 1_000_000).toFixed(1);
  return `${v.endsWith('.0') ? v.slice(0, -2) : v}M`;
}

/**
 * A context-window pairing is trustworthy only when the reported window size is
 * positive (0 is the "unknown size" sentinel) AND the used-token count fits
 * within it (usedTokens > window is physically impossible, so the window is
 * wrong, never the tokens). TaskCard and ContextBar both gate their
 * fraction/bar/percent on this single predicate so the two board surfaces
 * cannot drift apart on what counts as trustworthy. The main-process
 * UsageAccumulator.setSessionUsage enforces the same invariant on the merge
 * path, where the 0 sentinel originates.
 */
export function isContextWindowTrusted(contextWindowSize: number, usedTokens: number): boolean {
  return contextWindowSize > 0 && usedTokens <= contextWindowSize;
}

import { parseModelId, type ModelDisplayGroup } from '../../shared/model-id';

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
 * Format a context-window size (in tokens) as a compact uppercase label for the
 * model-dropdown badge, e.g. 1000000 → "1M", 200000 → "200K", 400000 → "400K".
 * Uppercase K/M so it reads as a size label ("1M", "200K") and matches the
 * existing 1M chip, distinct from the mixed-case running-token formatter above.
 * Returns null for a non-positive (unknown) size so callers render no badge.
 */
export function formatContextWindow(tokens: number): string | null {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens < 1_000_000) {
    const thousands = tokens / 1000;
    const value = Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1);
    return `${value}K`;
  }
  const millions = tokens / 1_000_000;
  const value = Number.isInteger(millions) ? String(millions) : millions.toFixed(1);
  return `${value}M`;
}

/**
 * The context-size badge label for a model-dropdown row, or null when no badge
 * should render. Shared by ModelCombobox and the ContextBar ModelEffortPicker so
 * the rule stays identical across both surfaces:
 *  - A row that is itself the `[1m]`-only variant (no separate bare alias)
 *    carries a structurally-certain 1M window from its id string, so it badges
 *    "1M" without waiting on telemetry.
 *  - A row that offers a separate selectable `[1m]` chip suppresses the badge, so
 *    the chip and a badge never stack a redundant "1M".
 *  - Otherwise the badge is the telemetry-learned window for the row's base model
 *    id (absent -> no badge; the window is discovered from telemetry, never
 *    hardcoded).
 */
export function modelContextBadgeLabel(
  group: ModelDisplayGroup,
  contextWindows: Record<string, number>,
): string | null {
  if (group.primaryIsOneMillion) return '1M';
  if (group.oneMillionId !== null) return null;
  return formatContextWindow(contextWindows[parseModelId(group.primaryId).baseId] ?? 0);
}

/**
 * Format a `YYYYMMDD` dated-snapshot capture as `YYYY-MM-DD` for display.
 */
function formatDatedSnapshot(datedSnapshot: string): string {
  return `${datedSnapshot.slice(0, 4)}-${datedSnapshot.slice(4, 6)}-${datedSnapshot.slice(6, 8)}`;
}

/**
 * The friendly row label for a model id: the agent-provided display name when
 * known, else the raw id (never invented in the renderer - see
 * `.claude/rules/agent-adapters-boundary.md`). A dated pin whose display name
 * was substituted gets its date appended (the humanizer drops it, so a bare
 * alias and its pins would otherwise share one label); a raw-id fallback
 * already carries its own date verbatim, so nothing is appended there.
 */
export function modelRowLabel(id: string, displayNames: Record<string, string>): string {
  const displayName = displayNames[id];
  if (!displayName) return id;
  const { datedSnapshot } = parseModelId(id);
  return datedSnapshot ? `${displayName} · ${formatDatedSnapshot(datedSnapshot)}` : displayName;
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

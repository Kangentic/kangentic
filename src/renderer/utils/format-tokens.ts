import { parseModelId, type ModelDisplayGroup } from '../../shared/model-id';
import type { ModelAliasOption } from '../../shared/types';

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
 * What an alias row shows, shared by the model combobox and the context bar
 * popover: the bare family label, the version it runs today (null when the
 * agent did not say), and the hover text naming both.
 */
export function aliasRowView(
  alias: ModelAliasOption,
  aliases: readonly ModelAliasOption[],
  displayNames: Record<string, string>,
): { label: string; target: string | null; title: string } {
  return {
    label: modelRowLabel(alias.id, displayNames),
    target: alias.resolvesTo !== undefined ? modelRowLabel(alias.resolvesTo, displayNames) : null,
    title: modelAliasTitle(alias.id, aliases, displayNames) ?? alias.id,
  };
}

/** Heading over a model picker's floating alias rows. */
export const MODEL_ALIAS_GROUP_HEADING = 'Latest';

/**
 * Label of a model picker's collapsed section: with aliases above it the
 * section holds every specific version, without them only the older ones.
 */
export function modelVersionSectionLabel(hasAliases: boolean): string {
  return hasAliases ? 'Specific versions' : 'Older versions';
}

/**
 * Map each offered id's display name (lowercased) to that id, using only the
 * names the agent's adapter supplied, so no agent's naming scheme lives in the
 * renderer. The model combobox uses it to turn typed text ("Opus 5.5") into the
 * id of the row it names. When several ids share a name (a dated pin drops its
 * date), the shortest id wins, which is the undated one.
 */
export function buildOfferedIdsByDisplayName(
  offeredIds: readonly string[],
  displayNames: Record<string, string>,
): ReadonlyMap<string, string> {
  const idsByName = new Map<string, string>();
  for (const id of offeredIds) {
    const displayName = displayNames[id];
    if (!displayName) continue;
    const key = displayName.trim().toLowerCase();
    const current = idsByName.get(key);
    if (current === undefined || id.length < current.length) idsByName.set(key, id);
  }
  return idsByName;
}

/**
 * Hover text naming what a floating alias runs today, e.g. "Latest Opus,
 * currently Opus 5.5", or just "Latest Opus" when the agent did not say. Null
 * when `id` is not one of the aliases, so a caller can pass it straight to a
 * `title` and a pinned value shows no title at all.
 */
export function modelAliasTitle(
  id: string,
  aliases: readonly ModelAliasOption[],
  displayNames: Record<string, string>,
): string | null {
  const alias = aliases.find((candidate) => candidate.id === id);
  if (!alias) return null;
  const label = modelRowLabel(alias.id, displayNames);
  return alias.resolvesTo
    ? `Latest ${label}, currently ${modelRowLabel(alias.resolvesTo, displayNames)}`
    : `Latest ${label}`;
}

/**
 * A context window is known (has a real denominator to draw a bar against)
 * only when the reported size is positive - 0 is the "unknown size" sentinel
 * used before any window has been learned for a session's model. TaskCard and
 * ContextBar both gate their fraction/bar/percent render on this predicate so
 * the two board surfaces cannot drift on what counts as renderable.
 */
export function isContextWindowKnown(contextWindowSize: number): boolean {
  return contextWindowSize > 0;
}

/**
 * True when usedTokens exceeds a known window - occupancy at or past
 * auto-compaction. This is a legitimate critical state, not a broken
 * denominator: it only ever reaches the renderer from the Claude status.json
 * replace path (UsageAccumulator.replaceSessionUsage), where window and tokens
 * come from one authoritative snapshot. TaskCard and ContextBar both force the
 * displayed percent to 100 on this predicate instead of hiding the bar, so a
 * near-full/auto-compacting session still shows a full critical bar rather
 * than vanishing. (The merge path, UsageAccumulator.setSessionUsage, degrades
 * an over-budget pairing to the 0 sentinel before it reaches the renderer -
 * that protects against a stale/mismatched window seed paired with fresh
 * transcript-fallback tokens, and is unaffected by this predicate.)
 */
export function isContextWindowOverBudget(contextWindowSize: number, usedTokens: number): boolean {
  return contextWindowSize > 0 && usedTokens > contextWindowSize;
}

/**
 * The clamped context-window percentage to DISPLAY, shared by TaskCard and
 * ContextBar so the two board surfaces cannot drift on the number they paint
 * (the same reason the predicates above are shared). Returns:
 *   - 0 for an unknown window (size 0, no denominator - callers render a
 *     reserved 0% bar or hide the segment entirely via isContextWindowKnown),
 *   - 100 for an over-budget window (the near-full/auto-compaction critical
 *     state - a full bar rather than a hidden one),
 *   - otherwise the reported percentage rounded and capped at 100. Claude's
 *     authoritative used_percentage can exceed 100 against an
 *     auto-compact-adjusted denominator even while usedTokens still fits the
 *     window, so the cap is load-bearing, not decorative.
 * This computes the NUMBER only; callers still gate the render on
 * isContextWindowKnown. Feeding both the value-pulse baseline and the rendered
 * label through this one function keeps the pulse inert while the displayed
 * percent holds at a clamped 100 during sustained over-budget growth.
 */
export function contextWindowDisplayPercent(
  contextWindowSize: number,
  usedTokens: number,
  usedPercentage: number,
): number {
  if (!isContextWindowKnown(contextWindowSize)) {
    return 0;
  }
  if (isContextWindowOverBudget(contextWindowSize, usedTokens)) {
    return 100;
  }
  return Math.min(100, Math.round(usedPercentage));
}

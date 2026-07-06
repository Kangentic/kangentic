/**
 * Display-layer grouping for discovered model identifiers.
 *
 * Agent transcripts surface the same underlying model in several spellings:
 * a bare alias (`claude-opus-4-8`), a context-window opt-in suffix
 * (`claude-opus-4-8[1m]`), and dated pinned builds
 * (`claude-haiku-4-5-20251001`). All of them are valid spawn values that must
 * be passed to the CLI verbatim (an empirical probe,
 * `scripts/probe-claude-model-forms.js`, showed dated forms are NOT aliased
 * server-side, so stripping a date silently converts a pin to "latest").
 * These helpers therefore never rewrite an id; they only describe how a list
 * of exact strings should be grouped for display.
 *
 * Everything here is pure pattern matching on string shape. There is no
 * agent-name branching (see `.claude/rules/agent-adapters-boundary.md`):
 * ids without a recognized suffix pass through as their own single-member
 * group, so non-Claude model lists render exactly as before.
 */

export interface ParsedModelId {
  /** The exact input string. Always the spawnable model value. */
  id: string;
  /** The id with a trailing `[1m]` suffix and/or trailing `-YYYYMMDD` removed. */
  baseId: string;
  /** True when the id carries the literal `[1m]` context-window opt-in suffix. */
  isOneMillionVariant: boolean;
  /** The `YYYYMMDD` capture when the id ends in a plausible date pin, else null. */
  datedSnapshot: string | null;
}

const ONE_MILLION_SUFFIX = '[1m]';
// Year constrained to 20xx and month/day to plausible ranges so a
// hypothetical non-date 8-digit tail stays part of the base id. A wrong
// classification is only cosmetic (the row is demoted to the pinned section)
// because the exact string remains selectable either way.
const DATED_SUFFIX_PATTERN = /-(20\d{2})(\d{2})(\d{2})$/;

export function parseModelId(id: string): ParsedModelId {
  let remainder = id;
  let isOneMillionVariant = false;
  if (remainder.endsWith(ONE_MILLION_SUFFIX)) {
    isOneMillionVariant = true;
    remainder = remainder.slice(0, remainder.length - ONE_MILLION_SUFFIX.length);
  }
  let datedSnapshot: string | null = null;
  const datedMatch = DATED_SUFFIX_PATTERN.exec(remainder);
  if (datedMatch) {
    const month = Number(datedMatch[2]);
    const day = Number(datedMatch[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      datedSnapshot = `${datedMatch[1]}${datedMatch[2]}${datedMatch[3]}`;
      // datedMatch[0] is the full matched suffix including the leading dash, so
      // stripping its length removes exactly what the regex consumed.
      remainder = remainder.slice(0, remainder.length - datedMatch[0].length);
    }
  }
  return { id, baseId: remainder, isOneMillionVariant, datedSnapshot };
}

/**
 * Humanize a model id for display, matching Anthropic's naming scheme
 * (`claude-<name>-<major>-<minor>` <-> "<Name> <major>.<minor>"): e.g.
 * `claude-opus-4-8` -> "Opus 4.8", `claude-fable-5` -> "Fable 5", `opus` -> "Opus".
 * Pure string-shape formatting for the display layer. A dated pin (a 6+ digit
 * segment like `20251001`) is dropped; a `[1m]`-style bracket becomes a
 * parenthesized suffix. Returns null when nothing meaningful can be derived, so
 * callers fall back to the raw id. The Claude adapter's `humanizeClaudeModelId`
 * delegates here so this stays the single source for model-name display.
 */
export function humanizeModelId(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed) return null;

  const bracketMatch = trimmed.match(/\[([^\]]+)\]/);
  const base = trimmed.replace(/\[[^\]]*\]/, '');
  const segments = base.replace(/^claude-/i, '').split('-').filter(Boolean);
  if (segments.length === 0) return null;

  const nameParts: string[] = [];
  const versionParts: string[] = [];
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      // Numeric segment: a version component, unless it is a date stamp
      // (>= 6 digits, e.g. 20251001), which we drop.
      if (segment.length < 6) versionParts.push(segment);
    } else {
      nameParts.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }

  const label = [nameParts.join(' '), versionParts.join('.')].filter(Boolean).join(' ');
  if (!label) return null;
  return bracketMatch ? `${label} (${bracketMatch[1].toUpperCase()})` : label;
}

export interface ModelDisplayGroup {
  /** Exact string selected by activating the group's primary row. */
  primaryId: string;
  /** Exact `<base>[1m]` string for the 1M affordance; null when no such variant is known. */
  oneMillionId: string | null;
  /** True when the primary row itself carries the `[1m]` suffix (only that form exists). */
  primaryIsOneMillion: boolean;
  /** Exact dated-pin strings demoted under this group, newest first. */
  pinnedBuildIds: string[];
}

/**
 * Collapse a flat list of exact model ids into one display group per base
 * model. The primary row is the bare alias when present; otherwise the newest
 * dated form is promoted verbatim (an alias the user never invoked is never
 * synthesized); otherwise the `[1m]` form itself is primary. Groups are
 * sorted by `primaryId` so suffix-free lists keep today's ordering.
 */
export function groupModelIds(ids: string[]): ModelDisplayGroup[] {
  const membersByBase = new Map<string, ParsedModelId[]>();
  for (const id of ids) {
    const parsed = parseModelId(id);
    const members = membersByBase.get(parsed.baseId);
    if (!members) {
      membersByBase.set(parsed.baseId, [parsed]);
    } else if (!members.some((member) => member.id === parsed.id)) {
      members.push(parsed);
    }
  }

  const groups: ModelDisplayGroup[] = [];
  for (const members of membersByBase.values()) {
    const bareAlias = members.find(
      (member) => !member.isOneMillionVariant && member.datedSnapshot === null,
    );
    const plainOneMillion = members.find(
      (member) => member.isOneMillionVariant && member.datedSnapshot === null,
    );
    const datedMembers = members
      .filter((member) => member.datedSnapshot !== null)
      .sort(
        (first, second) =>
          (second.datedSnapshot ?? '').localeCompare(first.datedSnapshot ?? '') ||
          first.id.localeCompare(second.id),
      );
    const newestPlainDated = datedMembers.find((member) => !member.isOneMillionVariant);

    const primary = bareAlias ?? newestPlainDated ?? plainOneMillion ?? datedMembers[0];
    if (!primary) continue;

    groups.push({
      primaryId: primary.id,
      oneMillionId:
        plainOneMillion && plainOneMillion.id !== primary.id ? plainOneMillion.id : null,
      primaryIsOneMillion: primary.isOneMillionVariant,
      pinnedBuildIds: datedMembers
        .filter((member) => member.id !== primary.id)
        .map((member) => member.id),
    });
  }

  return groups.sort((first, second) => first.primaryId.localeCompare(second.primaryId));
}

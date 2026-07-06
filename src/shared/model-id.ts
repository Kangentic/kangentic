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

export interface ParsedModelFamily {
  /** The base id with its trailing numeric version run removed. */
  family: string;
  /** The trailing numeric version segments, e.g. `claude-opus-4-8` -> `[4, 8]`. Empty when the
   *  base id has no trailing numeric run (a floating alias like `claude-opus` or `opus`). */
  version: number[];
}

/**
 * Split a `baseId` into a family (everything before the trailing run of
 * pure-integer `-`-separated segments) and that run as a numeric version
 * tuple. A base id with no trailing numeric segment (a floating alias that
 * always tracks "latest", a non-Claude id with a non-numeric tail, or a legacy
 * Claude id whose version is embedded BEFORE the name like `claude-3-5-sonnet`)
 * gets an empty version tuple and is never treated as superseded. Demotion
 * therefore only applies to the current trailing-version scheme
 * (`claude-opus-4-7` vs `claude-opus-4-8`), which every shipping model uses.
 */
export function parseModelFamily(baseId: string): ParsedModelFamily {
  const segments = baseId.split('-');
  let splitIndex = segments.length;
  while (splitIndex > 0 && /^\d+$/.test(segments[splitIndex - 1])) {
    splitIndex -= 1;
  }
  const version = segments.slice(splitIndex).map(Number);
  const family = segments.slice(0, splitIndex).join('-');
  return { family, version };
}

/**
 * Lexicographically compare two version tuples. A missing element counts as
 * lower than any present element, so `[4]` < `[4, 8]` and `[5]` > `[4, 6]`.
 */
export function compareModelVersion(first: number[], second: number[]): number {
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const firstComponent = first[index] ?? -1;
    const secondComponent = second[index] ?? -1;
    if (firstComponent !== secondComponent) return firstComponent - secondComponent;
  }
  return 0;
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
  /** True when a newer generation of this family exists (e.g. this is Opus 4.7 and Opus 4.8 is
   *  also present). A floating alias with no numeric version is never superseded. */
  isSuperseded: boolean;
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

  const groups: (ModelDisplayGroup & { baseId: string })[] = [];
  for (const [baseId, members] of membersByBase.entries()) {
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
      isSuperseded: false,
      baseId,
    });
  }

  // A family with a version tuple tracks generations (e.g. `claude-opus`
  // 4-7/4-8); demote every member below the family's max version. A family
  // whose version tuple is empty (a floating alias, or a non-Claude id with a
  // non-numeric tail) never supersedes anything - grouping by baseId already
  // gave it its own group, and there is no newer form to defer to.
  const groupsByFamily = new Map<string, (ModelDisplayGroup & { baseId: string })[]>();
  for (const group of groups) {
    const { family, version } = parseModelFamily(group.baseId);
    if (version.length === 0) continue;
    const familyGroups = groupsByFamily.get(family);
    if (familyGroups) {
      familyGroups.push(group);
    } else {
      groupsByFamily.set(family, [group]);
    }
  }
  for (const familyGroups of groupsByFamily.values()) {
    if (familyGroups.length < 2) continue;
    const maxVersion = familyGroups.reduce(
      (max, group) => {
        const { version } = parseModelFamily(group.baseId);
        return compareModelVersion(version, max) > 0 ? version : max;
      },
      parseModelFamily(familyGroups[0].baseId).version,
    );
    for (const group of familyGroups) {
      const { version } = parseModelFamily(group.baseId);
      group.isSuperseded = compareModelVersion(version, maxVersion) < 0;
    }
  }

  return groups
    .map((group) => ({
      primaryId: group.primaryId,
      oneMillionId: group.oneMillionId,
      primaryIsOneMillion: group.primaryIsOneMillion,
      pinnedBuildIds: group.pinnedBuildIds,
      isSuperseded: group.isSuperseded,
    }))
    .sort((first, second) => first.primaryId.localeCompare(second.primaryId));
}

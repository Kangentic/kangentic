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
 * The grouping and picker-layout helpers therefore never rewrite an id; they
 * only describe how a list of exact strings should be grouped for display.
 * `resolveModelSelector` is the one helper that rewrites, and only at the
 * sites its own comment lists.
 *
 * Everything here is pure pattern matching on string shape. There is no
 * agent-name branching (see `.claude/rules/agent-adapters-boundary.md`):
 * ids without a recognized suffix pass through as their own single-member
 * group, so non-Claude model lists render exactly as before.
 */

import type { ModelAliasOption } from './types';

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

/**
 * The exact shapes `humanizeModelId` emits for a model id: one family word,
 * an optional dotted version, and an optional "(1M)" suffix. Anything else is
 * treated as a raw id and never rewritten.
 */
const FRIENDLY_MODEL_NAME_PATTERN = /^([A-Za-z][a-z]+)(?:\s+(\d+(?:\.\d+)*))?(\s*\(1[Mm]\))?$/;

/**
 * Best-effort inverse of `humanizeModelId`. The spelling it produces is
 * Claude's, so it runs only where the value is known to be headed for Claude
 * or has always been converted: the Claude adapter when it builds `--model`
 * and `/model` (`toClaudeModelArgument`, which converts a single word only
 * when it is a known alias), and the MCP task tools for a name with a space.
 * The model combobox does not use it: it maps typed text through the adapter's
 * own display names (`buildOfferedIdsByDisplayName`). Stored values (board config, profile
 * entries, the column and profile handlers) are never rewritten, since those
 * sites do not know which agent the column runs. Only the exact shapes
 * `humanizeModelId` produces are rewritten:
 * - "<Name> <major>.<minor>" -> `claude-<name>-<major>-<minor>` ("Opus 4.8" -> `claude-opus-4-8`)
 * - "<Name>" -> the lowercase floating alias ("Sonnet" -> `sonnet`), which is
 *   the spelling an agent CLI accepts
 * - either with a trailing "(1M)" -> the `[1m]` suffix
 *
 * Every other input passes through trimmed and unchanged, so another agent's
 * ids (`GPT-5.5`, `Qwen2.5-Coder:7B`), a raw Claude id (`claude-opus-4-8[1m]`),
 * and a multi-word name are never mangled.
 *
 * This is deliberately best-effort, not a validated lookup: it does not check
 * the result against a live discovered model list (that would require an
 * agent CLI probe at the MCP layer), so a synthesized id for an unusual or
 * unreleased model name may not match the CLI's actual spawnable string. The
 * agent CLI is the final validator - an unresolvable model surfaces as a
 * normal CLI error at spawn time, and the caller can retry with the exact id.
 */
export function resolveModelSelector(input: string): string {
  const trimmed = input.trim();
  const match = FRIENDLY_MODEL_NAME_PATTERN.exec(trimmed);
  if (!match) return trimmed;
  const [, name, version, oneMillion] = match;
  const family = name.toLowerCase();
  const id = version ? ['claude', family, ...version.split('.')].join('-') : family;
  return oneMillion ? `${id}[1m]` : id;
}

/**
 * Convert a model name only when it has a space ("Opus 4.8", "Sonnet (1M)"),
 * which no raw id has, so the conversion is safe without knowing the agent. A
 * single word passes through trimmed: whether it is an alias is the adapter's
 * call. Shared by the MCP task tools (what they store) and the Claude adapter
 * (what it hands the CLI).
 */
export function resolveSpacedModelName(input: string): string {
  const written = input.trim();
  return /\s/.test(written) ? resolveModelSelector(written) : written;
}

/**
 * Best-effort normalization for a friendly effort/reasoning level (MCP
 * tools): case-insensitive, trimmed. Effort values are stored and displayed
 * verbatim (there is no id<->display mapping like models), so this only
 * fixes casing ("XHigh" -> "xhigh"); the agent CLI validates the result.
 */
export function resolveEffortSelector(input: string): string {
  return input.trim().toLowerCase();
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

/**
 * One row of a model picker's collapsed version section: a whole generation
 * (it keeps its 1M chip and context badge) or a bare dated pin.
 */
export type ModelVersionRow =
  | { kind: 'group'; group: ModelDisplayGroup; sortId: string }
  | { kind: 'pin'; id: string; sortId: string };

export interface ModelPickerRows {
  /** Floating selectors, in the CLI's own order. */
  aliasRows: ModelAliasOption[];
  /**
   * Generations listed at the top level. With no aliases, every current
   * (non-superseded) generation, exactly as before aliases existed. With
   * aliases, only the current generations no alias already resolves to, so a
   * family the CLI offers no alias for is never hidden.
   */
  topGroups: ModelDisplayGroup[];
  /**
   * The collapsed section: superseded generations, every dated pin, and (with
   * aliases) the current generations an alias covers. A family's rows stay
   * together, newest version first, with a dated pin right after the
   * generation it pins.
   */
  versionRows: ModelVersionRow[];
  /** Every id selectable from inside `versionRows`, so a value held there opens the section expanded. */
  versionSelectableIds: Set<string>;
}

/**
 * Order for the collapsed section: families side by side (by name), the newest
 * version of each first. A dated pin shares its generation's version, so the
 * final id comparison lands it directly after that generation. A row with no
 * trailing version (`sonnet[1m]`) sorts after the versioned rows of its family.
 */
function compareVersionRows(first: ModelVersionRow, second: ModelVersionRow): number {
  const firstFamily = parseModelFamily(parseModelId(first.sortId).baseId);
  const secondFamily = parseModelFamily(parseModelId(second.sortId).baseId);
  return (
    firstFamily.family.localeCompare(secondFamily.family) ||
    compareModelVersion(secondFamily.version, firstFamily.version) ||
    first.sortId.localeCompare(second.sortId)
  );
}

/**
 * Lay out a model picker: floating aliases first, then the current versions no
 * alias covers, then one collapsed section holding every specific version.
 * Shared by the model combobox and the context bar popover so both list the
 * same rows. An id equal to an alias (a bare `sonnet` learned from a spawn, a
 * draft column set to `opus`) is folded into the alias row instead of listed
 * twice. Any other form of an alias (`sonnet[1m]`) is a real value someone
 * chose, so it stays selectable, listed with the specific versions. Coverage
 * is read from each alias's `resolvesTo` only; an alias the CLI gave no target
 * covers nothing.
 */
export function planModelPickerRows(
  ids: readonly string[],
  aliases: readonly ModelAliasOption[] = [],
): ModelPickerRows {
  const aliasIds = new Set(aliases.map((alias) => alias.id));
  const aliasBaseIds = new Set(aliases.map((alias) => parseModelId(alias.id).baseId));
  const coveredBaseIds = new Set(
    aliases.flatMap((alias) => (alias.resolvesTo ? [parseModelId(alias.resolvesTo).baseId] : [])),
  );
  const groups = groupModelIds(ids.filter((id) => !aliasIds.has(id)));

  const topGroups: ModelDisplayGroup[] = [];
  const demotedGroups: ModelDisplayGroup[] = [];
  for (const group of groups) {
    const baseId = parseModelId(group.primaryId).baseId;
    const isCovered = coveredBaseIds.has(baseId) || aliasBaseIds.has(baseId);
    if (group.isSuperseded || isCovered) {
      demotedGroups.push(group);
    } else {
      topGroups.push(group);
    }
  }

  const versionRows: ModelVersionRow[] = demotedGroups.map((group) => ({
    kind: 'group',
    group,
    sortId: group.primaryId,
  }));
  const versionSelectableIds = new Set<string>();
  for (const group of demotedGroups) {
    versionSelectableIds.add(group.primaryId);
    if (group.oneMillionId !== null) versionSelectableIds.add(group.oneMillionId);
  }
  for (const group of groups) {
    for (const id of group.pinnedBuildIds) {
      versionRows.push({ kind: 'pin', id, sortId: id });
      versionSelectableIds.add(id);
    }
  }
  versionRows.sort(compareVersionRows);

  return { aliasRows: [...aliases], topGroups, versionRows, versionSelectableIds };
}

/**
 * The newest known generation of `value`'s family when `value` is an older one
 * (`claude-sonnet-5` while `claude-sonnet-5-5` is known), else null. A floating
 * alias or an id with no trailing version is never behind.
 */
export function newerModelFor(value: string, ids: readonly string[]): string | null {
  const { family, version } = parseModelFamily(parseModelId(value).baseId);
  if (version.length === 0) return null;
  // Group only this family's ids: the board overview asks once per column.
  const familyIds = ids.filter((id) => parseModelFamily(parseModelId(id).baseId).family === family);
  let newest: { primaryId: string; version: number[] } | null = null;
  for (const group of groupModelIds(familyIds)) {
    const candidate = parseModelFamily(parseModelId(group.primaryId).baseId);
    if (candidate.version.length === 0) continue;
    if (compareModelVersion(candidate.version, version) <= 0) continue;
    if (newest === null || compareModelVersion(candidate.version, newest.version) > 0) {
      newest = { primaryId: group.primaryId, version: candidate.version };
    }
  }
  return newest?.primaryId ?? null;
}

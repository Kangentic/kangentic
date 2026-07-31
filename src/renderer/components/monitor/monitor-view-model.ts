/**
 * Pure view-model for the Agent Monitor: bucketing, filtering, sorting, grouping,
 * and the flattening that lets one virtualizer serve every layout.
 *
 * Deliberately free of React and of `window`, so the whole decision surface is
 * unit-testable without a DOM. The store calls these once per change and hands
 * the result to the components; no component re-derives an aggregate of its own
 * (the failure shape of `ProjectListItem`, which recomputes the full
 * cross-project tally inside every project row's selector).
 */
import { isActive, requiresUserInteraction } from '../../../shared/activity-state';
import { formatActivityReasonText } from '../board/ActivityReasonTooltip';
import { formatRelativeTime } from '../../lib/datetime';
import type {
  ActivityReason,
  MonitorSessionRow,
  MonitorStateBucket,
  MonitorView,
} from '../../../shared/types';

/** Display order and labels for the state buckets. Attention first, always. */
export const BUCKET_ORDER: readonly MonitorStateBucket[] = [
  'needs-you',
  'working',
  'idle',
  'finished',
];

/**
 * Display names, in the app's OWN activity vocabulary rather than invented
 * synonyms. `ActivityDisposition` is literally `'idle' | 'active'`, and the
 * sidebar dots and board cards already speak it, so an agent waiting on you is
 * "Idle" (not "Needs you") and one running is "Active" (not "Working").
 *
 * That frees "Paused" for the genuinely suspended/queued bucket, which is what
 * the board card calls that state too.
 */
export const BUCKET_LABELS: Record<MonitorStateBucket, string> = {
  'needs-you': 'Idle',
  working: 'Active',
  idle: 'Paused',
  finished: 'Recently finished',
};

/**
 * Which bucket a row belongs to.
 *
 * The live idle-vs-active split goes through the shared classifier only - never a
 * comparison against an `ActivityState` literal (see
 * `.claude/rules/activity-state-classification.md`, which is CI-enforced). That
 * classifier is binary, matching the sidebar dots: a RUNNING session is either
 * waiting on the user or working. The two extra buckets here come from session
 * STATUS rather than activity: suspended/queued sessions are parked ("idle"), and
 * exited ones are "finished".
 */
export function bucketOf(row: MonitorSessionRow): MonitorStateBucket {
  if (row.status === 'exited') return 'finished';
  if (row.status === 'suspended' || row.status === 'queued') return 'idle';
  return requiresUserInteraction(row.activity ?? undefined) ? 'needs-you' : 'working';
}

/**
 * Label for the reason variants that carry a `since` timestamp. A lookup rather
 * than an equality check on `reason.kind`, because those kind names overlap with
 * `ActivityState` members and a bare `=== 'permission'` reads as (and is scanned
 * for) hand-rolled activity bucketing.
 *
 * Plain `idle` is deliberately UNLABELLED: the amber tone, the Mail glyph, and
 * the "Needs you" section header already say idle three times before any word
 * does, so the pill just reports when ("9 minutes ago"). `permission` keeps its
 * label because it says something the colour cannot - the agent is blocked on a
 * specific approval, not merely waiting.
 */
const SINCE_LABELS: Partial<Record<ActivityReason['kind'], string>> = {
  permission: 'Awaiting permission',
};

/**
 * The row's "doing now" text.
 *
 * Where the engine gives us a `since` instant, this reports WHEN the agent
 * entered the state ("Idle 2 minutes ago") rather than a live-counting duration
 * ("Idle for 2m 0s"). A ticking counter draws the eye to whichever row happens to
 * be incrementing, which is noise on a screen whose whole job is to show you the
 * one row that needs you; a settled "2 minutes ago" reads at a glance and reuses
 * the relative-time format the rest of the app already speaks.
 *
 * Reason variants with no `since` (a running tool, subagents, a background shell)
 * are not durations at all, so they keep the engine's own phrasing.
 */
export function formatMonitorStatus(row: MonitorSessionRow): string {
  const reason = row.activityReason;
  if (reason && 'since' in reason) {
    const label = SINCE_LABELS[reason.kind];
    const when = formatRelativeTime(reason.since);
    return label ? `${label} ${when}` : when;
  }
  if (reason) return formatActivityReasonText(reason);
  if (row.status === 'exited') {
    return `Finished ${row.exitedAt ? formatRelativeTime(row.exitedAt) : ''}`.trim();
  }
  return '';
}

/** True when the agent is actively working, for the green-spinner affordance. */
export function isWorking(row: MonitorSessionRow): boolean {
  return row.status === 'running' && isActive(row.activity ?? undefined);
}

/** True when the session is blocked on the user, for the amber affordance. */
export function needsUser(row: MonitorSessionRow): boolean {
  return row.status === 'running' && requiresUserInteraction(row.activity ?? undefined);
}


function startedAtMs(row: MonitorSessionRow): number {
  const parsed = Date.parse(row.startedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}



/** Case-insensitive substring match across the fields a user would search by. */
function matchesText(row: MonitorSessionRow, needle: string): boolean {
  const haystack = [
    row.taskTitle,
    row.projectName,
    row.columnName,
    row.agentName ?? '',
    row.modelDisplayName ?? '',
    row.displayId === null ? '' : `#${row.displayId}`,
    ...row.labels,
  ].join(' ').toLowerCase();
  return haystack.includes(needle);
}

/**
 * Apply the view's filters.
 *
 * `liveOnly` keeps just the buckets with a live agent (Idle and Active), dropping
 * Paused and Recently finished. The finer-grained `stateFilter` is there for
 * anyone who wants one but not the other.
 */
/** The buckets that are NOT live: no agent is running and none is waiting on you. */
const NOT_LIVE_BUCKETS: ReadonlySet<MonitorStateBucket> = new Set(['idle', 'finished']);

export function filterRows(rows: MonitorSessionRow[], view: MonitorView): MonitorSessionRow[] {
  const needle = view.textFilter.trim().toLowerCase();
  const projectSet = view.projectFilter.length > 0 ? new Set(view.projectFilter) : null;
  const stateSet = view.stateFilter.length > 0 ? new Set(view.stateFilter) : null;

  return rows.filter((row) => {
    const bucket = bucketOf(row);
    if (view.liveOnly && NOT_LIVE_BUCKETS.has(bucket)) return false;
    if (stateSet && !stateSet.has(bucket)) return false;
    if (projectSet && !projectSet.has(row.projectId)) return false;
    if (needle && !matchesText(row, needle)) return false;
    return true;
  });
}

/**
 * Sort a COPY of the rows per the view's sort mode. Never mutates the input.
 *
 * Ordering by attention is deliberately absent: rows are always grouped, and
 * `groupRows` emits the state sections in BUCKET_ORDER (Idle first), so
 * attention-first is structural rather than a sort the user has to pick.
 */
export function sortRows(rows: MonitorSessionRow[], sort: MonitorView['sort']): MonitorSessionRow[] {
  const sorted = [...rows];
  if (sort === 'recently-started') {
    sorted.sort((left, right) => startedAtMs(right) - startedAtMs(left));
  } else {
    sorted.sort((left, right) => startedAtMs(left) - startedAtMs(right));
  }
  return sorted;
}

export interface MonitorGroup {
  key: string;
  label: string;
  rows: MonitorSessionRow[];
}

/**
 * Group the (already filtered and sorted) rows. `flat` returns a single unlabelled
 * group so downstream code has one shape to render regardless of grouping mode.
 */
export function groupRows(
  rows: MonitorSessionRow[],
  /** `'flat'` is internal-only and currently has NO production caller: the table
   *  layout renders one grouped `<MonitorTable>` per section rather than asking
   *  for a single unlabelled group. Kept as a supported input (and covered by
   *  tests) so a caller that cannot interleave section headers has a shape to
   *  ask for. Users never select it. */
  groupBy: MonitorView['groupBy'] | 'flat',
): MonitorGroup[] {
  if (groupBy === 'flat') {
    return rows.length === 0 ? [] : [{ key: 'all', label: '', rows }];
  }

  const groups = new Map<string, MonitorGroup>();
  for (const row of rows) {
    const key = groupBy === 'state' ? bucketOf(row) : row.projectId;
    const label = groupBy === 'state' ? BUCKET_LABELS[bucketOf(row)] : row.projectName;
    const existing = groups.get(key);
    if (existing) existing.rows.push(row);
    else groups.set(key, { key, label, rows: [row] });
  }

  const ordered = [...groups.values()];
  if (groupBy === 'state') {
    ordered.sort((left, right) =>
      BUCKET_ORDER.indexOf(left.key as MonitorStateBucket)
      - BUCKET_ORDER.indexOf(right.key as MonitorStateBucket));
  } else {
    ordered.sort((left, right) => left.label.localeCompare(right.label));
  }
  return ordered;
}

/**
 * One virtualizable unit. A header spans the full width; a `row` unit carries up
 * to `columns` cards that share one grid line.
 */
export type MonitorRenderUnit =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'row'; key: string; rows: MonitorSessionRow[] };

/**
 * Flatten groups into a single list of render units.
 *
 * This is what lets one virtualizer serve the CARD and LIST layouts: the card grid
 * chunks into rows of `columns`, the list passes `columns = 1`, and group headers
 * participate in the same measured list. Without it, the grid would need its own
 * virtualization strategy.
 *
 * The TABLE layout does not come through here. It renders one `<MonitorTable>` per
 * group and virtualizes via `DataTable`'s own `virtualized` prop, because a
 * `<table>` cannot interleave section headers between its rows.
 */
export function toRenderUnits(groups: MonitorGroup[], columns: number): MonitorRenderUnit[] {
  const perRow = Math.max(1, Math.floor(columns));
  const units: MonitorRenderUnit[] = [];

  for (const group of groups) {
    if (group.label) {
      units.push({ kind: 'header', key: `header:${group.key}`, label: group.label, count: group.rows.length });
    }
    for (let index = 0; index < group.rows.length; index += perRow) {
      const chunk = group.rows.slice(index, index + perRow);
      units.push({ kind: 'row', key: `row:${group.key}:${chunk[0].sessionId}`, rows: chunk });
    }
  }

  return units;
}

/** Per-bucket totals for the summary strip, computed in one pass over ALL rows. */
export function summarize(rows: MonitorSessionRow[]): {
  counts: Record<MonitorStateBucket, number>;
  projectCount: number;
  /** Epoch ms the longest-waiting agent entered its state, or null if none waits.
   *  Lets the "Needs you" tile answer "for how long?" - the follow-up question a
   *  bare count always prompts. */
  oldestNeedsYouSince: number | null;
  /** Projects that currently have a working agent, for the Working tile's sub-line. */
  workingProjectCount: number;
  /** Epoch ms an agent most recently STOPPED working, or null if that is unknowable.
   *  Lets the Active tile say something when the count is zero - "0" with a blank
   *  line beneath reads as missing data rather than as a quiet machine. Derived from
   *  the two instants the app actually records: when a live agent went idle, and when
   *  a finished one exited. A paused session has no such timestamp, so a board of
   *  nothing but paused sessions correctly reports null rather than guessing. */
  lastActiveAt: number | null;
} {
  const counts: Record<MonitorStateBucket, number> = {
    'needs-you': 0, working: 0, idle: 0, finished: 0,
  };
  const projects = new Set<string>();
  const workingProjects = new Set<string>();
  let oldestNeedsYouSince: number | null = null;
  let lastActiveAt: number | null = null;

  for (const row of rows) {
    const bucket = bucketOf(row);
    counts[bucket] += 1;
    // Only count a project as active if it has something live in it.
    if (row.status === 'running' || row.status === 'queued') projects.add(row.projectId);
    if (bucket === 'working') workingProjects.add(row.projectId);
    if (bucket === 'needs-you' && row.activityReason && 'since' in row.activityReason) {
      const since = row.activityReason.since;
      if (oldestNeedsYouSince === null || since < oldestNeedsYouSince) oldestNeedsYouSince = since;
      if (lastActiveAt === null || since > lastActiveAt) lastActiveAt = since;
    }
    if (bucket === 'finished' && row.exitedAt) {
      const exited = Date.parse(row.exitedAt);
      if (!Number.isNaN(exited) && (lastActiveAt === null || exited > lastActiveAt)) {
        lastActiveAt = exited;
      }
    }
  }

  return {
    counts,
    projectCount: projects.size,
    oldestNeedsYouSince,
    workingProjectCount: workingProjects.size,
    lastActiveAt,
  };
}

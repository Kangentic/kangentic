/**
 * Slices a task's stitched conversation by its Route, for the conversation
 * window's column tabs.
 *
 * Every entry belongs to the stay (one visit to a working column) with the
 * latest start at or before the entry's timestamp, across every column the
 * Route lists. A stay therefore runs until the next stay begins, so the stay a
 * live task is in now stays open without anyone knowing "now". The Route lists
 * working columns only, and no turn happens in To Do or Done, so a gap the task
 * spent there never needs a stay of its own. An entry with no timestamp (0), or
 * one from before the first logged move, belongs to no stay: it shows in All
 * and in no column tab. A tool result follows its tool call's stay, so a card is
 * never split from its result across a boundary.
 *
 * The dividers are synthetic system entries, built here and never sent
 * anywhere: they use the subtype whose text is ready to display
 * (`session_boundary`), so the row, search and Copy as Markdown all take them
 * as they are (Copy writes each as a `## ` heading), and their uuids live under
 * `route-divider:` so they can never collide with a real entry.
 * `TranscriptSystemSubtype` is deliberately left alone: the mobile wire mapper
 * and the protocol guard key on it, and these entries never leave the window.
 * `dividerColumns` names each divider's column so the row can draw its icon.
 * `isolatedDividers` names each of All's dividers into a column that ran an
 * isolated session, so the row can draw the Split icon after the name. A
 * column tab's dividers are dates under a tab that already carries it. The
 * mark is per column, not per stay: a column switched between Main and
 * Isolated during the task marks every one of its stays.
 *
 * All draws a divider with the column's name where each stay's turns begin. A
 * column tab keeps only that column's stays and opens each with its start date.
 * In both, a real session boundary that is a stay's first entry is dropped: the
 * divider already marks the break, so a new session started by the move adds no
 * second line. A session that starts mid-stay keeps its own divider. A stay's
 * divider waits for the first entry the stay keeps, so a stay whose only entry
 * was that dropped boundary draws no divider and is never a stay with no turns.
 */

import type { ConversationSessionMeta, TaskReportColumn, TaskReportRouteColumn, TranscriptEntry } from '../../../shared/types';
import { formatMonthDayTime } from '../../lib/datetime';

/** The tab holding the whole conversation. Every other tab id is a column's swimlane id. */
export const ALL_CONVERSATION_TAB = 'all';

export interface ConversationSlice {
  entries: TranscriptEntry[];
  /** Each divider's uuid, mapped to the column whose icon it draws. */
  dividerColumns: Map<string, TaskReportColumn>;
  /** The uuids of All's dividers into a column that ran an isolated session. */
  isolatedDividers: Set<string>;
}

const NO_ISOLATED_COLUMNS: ReadonlySet<string> = new Set();

const ISOLATED_KEY_SEPARATOR = '\u0000';

/**
 * The columns an isolated session ran in, from the sessions a conversation was
 * stitched from, as one string. Sorted and without repeats, so a live poll that
 * finds the same columns gives the same key and a set memoized on it keeps its
 * identity. `isolatedSwimlaneIdsFromKey` reads it back.
 */
export function isolatedSwimlaneIdsKey(sessions: ReadonlyArray<Pick<ConversationSessionMeta, 'isolatedSwimlaneId'>>): string {
  const swimlaneIds = new Set<string>();
  for (const session of sessions) {
    if (session.isolatedSwimlaneId) swimlaneIds.add(session.isolatedSwimlaneId);
  }
  return [...swimlaneIds].sort().join(ISOLATED_KEY_SEPARATOR);
}

/** The columns an `isolatedSwimlaneIdsKey` key names. */
export function isolatedSwimlaneIdsFromKey(key: string): Set<string> {
  return new Set(key === '' ? [] : key.split(ISOLATED_KEY_SEPARATOR));
}

interface Stay {
  column: TaskReportColumn;
  startedAt: string;
  startMs: number;
}

const DIVIDER_UUID_PREFIX = 'route-divider:';

/** The uuid of the divider opening one stay in its column's tab. */
export function visitDividerUuid(swimlaneId: string, startedAt: string): string {
  return `${DIVIDER_UUID_PREFIX}visit:${swimlaneId}:${startedAt}`;
}

function moveDividerUuid(swimlaneId: string, startedAt: string): string {
  return `${DIVIDER_UUID_PREFIX}move:${swimlaneId}:${startedAt}`;
}

/** Every stay of every column, oldest first. A visit whose start does not parse is left out. */
function staysOf(route: ReadonlyArray<TaskReportRouteColumn>): Stay[] {
  const stays: Stay[] = [];
  for (const routeColumn of route) {
    const column: TaskReportColumn = {
      swimlaneId: routeColumn.swimlaneId,
      name: routeColumn.name,
      color: routeColumn.color,
      icon: routeColumn.icon,
      role: routeColumn.role,
    };
    for (const visit of routeColumn.visits) {
      const startMs = Date.parse(visit.startedAt);
      if (Number.isNaN(startMs)) continue;
      stays.push({ column, startedAt: visit.startedAt, startMs });
    }
  }
  return stays.sort((first, second) => first.startMs - second.startMs);
}

/** The index of the stay an instant falls in, or -1 for none (no timestamp, or before the first stay).
 *  A binary search: with older pages loaded this runs once per entry over thousands of entries. */
function stayIndexAt(stays: ReadonlyArray<Stay>, timestampMs: number): number {
  if (!(timestampMs > 0)) return -1;
  let low = 0;
  let high = stays.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (stays[middle].startMs <= timestampMs) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Each entry's stay index, a tool result taking its tool call's. */
function assignStays(entries: ReadonlyArray<TranscriptEntry>, stays: ReadonlyArray<Stay>): number[] {
  const stayByToolUseId = new Map<string, number>();
  return entries.map((entry) => {
    if (entry.kind === 'tool_result') {
      const owner = stayByToolUseId.get(entry.toolUseId);
      if (owner !== undefined) return owner;
    }
    const stayIndex = stayIndexAt(stays, entry.ts);
    if (entry.kind === 'assistant') {
      for (const block of entry.blocks) {
        if (block.type === 'tool_use') stayByToolUseId.set(block.id, stayIndex);
      }
    }
    return stayIndex;
  });
}

function dividerEntry(uuid: string, timestampMs: number, text: string): TranscriptEntry {
  return { kind: 'system', uuid, ts: timestampMs, subtype: 'session_boundary', text };
}

function isSessionBoundary(entry: TranscriptEntry): boolean {
  return entry.kind === 'system' && entry.subtype === 'session_boundary';
}

/**
 * The entries one tab shows: `ALL_CONVERSATION_TAB` for the whole conversation
 * with a divider at each column move, or a column's swimlane id for that
 * column's stays alone, each opened by its date. A Route with no parseable stay
 * leaves the entries as they are. `isolatedSwimlaneIds` are the columns an
 * isolated session ran in, whose dividers in All are marked.
 *
 * `loadedFromMs` is set when the entries start partway through the
 * conversation (a paged window with older history not loaded): a stay that
 * began before it draws no divider, since where it begins is not among the
 * entries. A divider drawn there would stay the first row while pages land
 * under it, and the view would hold the divider in place instead of the row
 * the reader was on.
 */
export function sliceConversationByRoute(
  entries: ReadonlyArray<TranscriptEntry>,
  route: ReadonlyArray<TaskReportRouteColumn>,
  tab: string,
  isolatedSwimlaneIds: ReadonlySet<string> = NO_ISOLATED_COLUMNS,
  loadedFromMs?: number,
): ConversationSlice {
  const dividerColumns = new Map<string, TaskReportColumn>();
  const isolatedDividers = new Set<string>();
  const stays = staysOf(route);
  if (stays.length === 0) return { entries: [...entries], dividerColumns, isolatedDividers };

  const assignment = assignStays(entries, stays);
  const showsAll = tab === ALL_CONVERSATION_TAB;
  const sliced: TranscriptEntry[] = [];
  let openStay = -1;
  // The open stay's divider, held until the stay keeps an entry.
  let pendingDivider: { entry: TranscriptEntry; column: TaskReportColumn } | null = null;

  entries.forEach((entry, index) => {
    const stayIndex = assignment[index];
    const stay = stayIndex >= 0 ? stays[stayIndex] : null;
    if (!showsAll && stay?.column.swimlaneId !== tab) return;
    if (stay && stayIndex !== openStay) {
      openStay = stayIndex;
      const uuid = showsAll
        ? moveDividerUuid(stay.column.swimlaneId, stay.startedAt)
        : visitDividerUuid(stay.column.swimlaneId, stay.startedAt);
      pendingDivider = loadedFromMs !== undefined && stay.startMs < loadedFromMs
        ? null
        : {
          entry: dividerEntry(uuid, stay.startMs, showsAll ? stay.column.name : formatMonthDayTime(stay.startedAt)),
          column: stay.column,
        };
      // The stay's divider stands in for a session boundary that opens it.
      if (pendingDivider && isSessionBoundary(entry)) return;
    }
    if (stay && pendingDivider) {
      sliced.push(pendingDivider.entry);
      dividerColumns.set(pendingDivider.entry.uuid, pendingDivider.column);
      if (showsAll && isolatedSwimlaneIds.has(pendingDivider.column.swimlaneId)) {
        isolatedDividers.add(pendingDivider.entry.uuid);
      }
      pendingDivider = null;
    }
    sliced.push(entry);
  });

  return { entries: sliced, dividerColumns, isolatedDividers };
}

/**
 * A column's stays as the time each covers, oldest first: a stay runs until the
 * next stay of any column begins, as `sliceConversationByRoute` assigns turns.
 * A paged window uses them to load a column's own history and skip the rest.
 */
export function columnTimeRanges(route: ReadonlyArray<TaskReportRouteColumn>, swimlaneId: string): Array<{ start: number; end: number }> {
  const stays = staysOf(route);
  const ranges: Array<{ start: number; end: number }> = [];
  stays.forEach((stay, index) => {
    if (stay.column.swimlaneId !== swimlaneId) return;
    ranges.push({ start: stay.startMs, end: stays[index + 1]?.startMs ?? Infinity });
  });
  return ranges;
}

/**
 * The uuid of the first turn of one stay in its column's tab, the place a
 * repeat-stay row on the Route card opens at. Null when that stay has no turns.
 */
export function firstEntryOfStay(slice: ConversationSlice, swimlaneId: string, startedAt: string): string | null {
  const dividerUuid = visitDividerUuid(swimlaneId, startedAt);
  const index = slice.entries.findIndex((entry) => entry.uuid === dividerUuid);
  if (index < 0) return null;
  return slice.entries[index + 1]?.uuid ?? null;
}

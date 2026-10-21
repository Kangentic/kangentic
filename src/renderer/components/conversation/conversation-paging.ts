/**
 * Pure paging model for the Conversation viewer's whole-transcript scrolling.
 *
 * The window polls each session's newest `MAX_PARSE_SOURCE_BYTES` (the tail)
 * exactly as before, and holds at most `HISTORY_WINDOW_MAX_BYTES` of older
 * history pages on top of it (`HeldBlock`). This module decides what of all that
 * renders, where the reader sits in the whole transcript, and which page to read
 * next. `useConversationPaging` owns the state and the bridge calls; nothing here
 * touches the DOM or the bridge.
 *
 * WHAT RENDERS is one contiguous stretch of the conversation. The stitch orders
 * turns by time across sessions, and a big transcript's unloaded parts (holes)
 * span stretches of time, so the window is a time range: the widest one around
 * the reader that overlaps no hole. Every held entry in it renders, from the tail
 * and from pages alike, with a loading row at an edge wherever a hole bounds it.
 * An older session whose turns fall inside a big file's unloaded time therefore
 * stays hidden until the reader reaches its time, and shows there, in order.
 * The stitch's session dividers stay where it drew them, and none is invented
 * for a crossing it never drew.
 *
 * A column tab covers only its stays (`timeRanges`): a hole that lies wholly in
 * another column's time bounds nothing, and an edge whose next stay is past such
 * a hole reads around that stay instead of reading through the gap.
 *
 * WHERE THE READER IS (the scrollbar) is `P(t)`: the sum over conversations of
 * each one's position before time `t`, against the sum of their sizes. Each
 * conversation's `P` runs through what is known of it, loaded entries and the
 * worker's timeline samples, and is interpolated across a hole. For a task with
 * one transcript file that is simply its byte position. A column tab lays its
 * stays' stretches of `P` end to end.
 *
 * A conversation whose agent records no timestamps is ordered by position.
 */

import type { ConversationExtent, TranscriptEntry, TranscriptHistoryPage } from '../../../shared/types';
import { HISTORY_WINDOW_MAX_BYTES } from '../../../shared/conversation-history';

/** A page of history the window holds, as `transcripts.page` returned it. */
export type HeldBlock = Omit<TranscriptHistoryPage, 'totalPosition' | 'reachedEnd'>;

export interface TimelineSample {
  position: number;
  ts: number;
}

/** A stretch of time a view covers: [start, end), `end` Infinity for a stay still open. */
export interface TimeRange {
  start: number;
  end: number;
}

/** Entries a window holds across pages at most, beyond the byte cap, for a run of unusually dense pages. */
export const MAX_HELD_PAGE_ENTRIES = 12_000;

/** An unloaded stretch of one conversation, between two held stretches (or before the first). */
export interface ConversationHole {
  conversationId: string;
  startPosition: number;
  endPosition: number;
  /** The cursor where the held stretch before the hole ends, null at the conversation's start. */
  startCursor: string | null;
  /** The cursor where the held stretch after the hole starts. */
  endCursor: string;
  /** The last time held before the hole, or the conversation's start (or -Infinity when unknown). */
  tsBefore: number;
  /** The first time held after the hole. */
  tsAfter: number;
  /** Where this conversation's tail starts: a page never reads past it. */
  tailStartPosition: number;
  sourceToken: string | null;
}

/** A request for one page, as the window sends it. */
export interface PageRequest {
  conversationId: string;
  direction: 'before' | 'after' | 'around';
  cursor?: string;
  position?: number;
  untilPosition: number;
  sourceToken?: string;
}

/** Where a logical position lands: the conversation and position to read there, and its time. */
export interface LogicalTarget {
  conversationId: string;
  position: number;
  ts: number;
}

export interface PagingInput {
  /** The polled tail, as the stitch ordered it. */
  tail: ReadonlyArray<TranscriptEntry>;
  conversations: ReadonlyArray<ConversationExtent>;
  blocks: ReadonlyArray<HeldBlock>;
  timelines: ReadonlyMap<string, ReadonlyArray<TimelineSample>>;
  /** The time the window is built around: the reader's, Infinity for the tail, -Infinity for the start. */
  anchorTs: number;
  /** The stretches of time the view covers (a column tab's stays), or undefined for all of it. */
  timeRanges?: ReadonlyArray<TimeRange>;
}

export interface PagingWindow {
  /** What renders, in order. */
  entries: TranscriptEntry[];
  /** The hole bounding the window above (older history), or null. */
  topHole: ConversationHole | null;
  /** The hole bounding it below (newer history short of the tail), or null. */
  bottomHole: ConversationHole | null;
  /** Whether the window runs to the newest message. */
  reachesTail: boolean;
  /** The time the window was built around, after moving out of any hole. */
  anchorTs: number;
  /** Each rendered entry's logical position in the view, by uuid. */
  logicalByUuid: Map<string, number>;
  /** Each rendered entry's effective time, by uuid: monotone within its conversation. */
  timeByUuid: Map<string, number>;
  /** The logical position where the window starts and ends. */
  logicalStart: number;
  logicalEnd: number;
  /** The view's whole logical size. */
  logicalTotal: number;
  /** Where a logical position lands, for a far scrollbar drag. */
  targetAt(logical: number): LogicalTarget | null;
  /** The time at a logical position, for the drag label. Null where there are no timestamps. */
  timeAt(logical: number): number | null;
  /** The page that fills an edge. */
  requestFor(edge: 'top' | 'bottom'): PageRequest | null;
  /** The page holding a moment, or null when the window's sources already hold it. */
  requestForTime(ts: number): PageRequest | null;
  /** The page holding one position of a conversation, or null when it is already held. */
  requestForPosition(conversationId: string, position: number): PageRequest | null;
}

/** Whether a response has history to page: a pageable conversation whose tail starts past 0. */
export function isPagingMode(conversations: ReadonlyArray<ConversationExtent> | undefined): boolean {
  return !!conversations?.some((extent) => extent.pageable && extent.tailStartPosition > 0);
}

function isSessionBoundary(entry: TranscriptEntry): boolean {
  return entry.kind === 'system' && entry.subtype === 'session_boundary';
}

interface TailNotice {
  cursor: string;
  position: number;
}

/** The truncation notice each pageable conversation's tail carries, by conversation. */
function noticesOf(tail: ReadonlyArray<TranscriptEntry>): Map<string, TailNotice> {
  const notices = new Map<string, TailNotice>();
  for (const entry of tail) {
    if (entry.kind === 'system' && entry.subtype === 'truncated' && entry.earlierHistory) {
      notices.set(entry.earlierHistory.conversationId, {
        cursor: entry.earlierHistory.cursor,
        position: entry.earlierHistory.position,
      });
    }
  }
  return notices;
}

interface Item {
  entry: TranscriptEntry;
  /** Monotone time within its conversation, used to order and window. */
  effectiveTs: number;
  conversationKey: string;
  /** Position within the conversation, or the tail index for an entry with no origin. */
  order: number;
  /** Rank of the conversation (oldest session first), for ties at equal time. */
  conversationRank: number;
  hasOrigin: boolean;
  fromTail: boolean;
  /** Arrival order, so equal keys keep the stitch's order. */
  sequence: number;
}

/** A stitch divider and the entry it followed in the tail. */
interface TailDivider {
  divider: TranscriptEntry;
  previousUuid: string | null;
}

interface Collected {
  /** Every held entry once, in render order. */
  items: Item[];
  itemsByConversation: Map<string, Item[]>;
  extentById: Map<string, ConversationExtent>;
  noticeById: Map<string, TailNotice>;
  /** The stitch's dividers, by the uuid of the entry each one introduces. */
  dividerBefore: Map<string, TailDivider>;
}

/**
 * Make each conversation's times monotone in position order: a zero time, or
 * one that steps back, takes the time before it, and leading zeros take the
 * first real time. A conversation with no timestamps keeps its entries at its
 * earliest time and orders them by position.
 */
function assignEffectiveTimes(items: Item[], hasTimestamps: (conversationKey: string) => boolean): void {
  const byConversation = new Map<string, Item[]>();
  for (const item of items) {
    const list = byConversation.get(item.conversationKey);
    if (list) list.push(item);
    else byConversation.set(item.conversationKey, [item]);
  }
  for (const [conversationKey, list] of byConversation) {
    list.sort((first, second) => first.order - second.order || first.sequence - second.sequence);
    if (!hasTimestamps(conversationKey)) {
      let earliest = Infinity;
      for (const item of list) if (item.entry.ts > 0 && item.entry.ts < earliest) earliest = item.entry.ts;
      const base = Number.isFinite(earliest) ? earliest : 0;
      for (const item of list) item.effectiveTs = base + item.order * 1e-6;
      continue;
    }
    let previous = list.find((item) => item.entry.ts > 0)?.entry.ts ?? 0;
    for (const item of list) {
      item.effectiveTs = Math.max(item.entry.ts > 0 ? item.entry.ts : previous, previous);
      previous = item.effectiveTs;
    }
  }
}

/**
 * Every held entry once, from the tail and the pages, with effective times,
 * sorted into render order. The tail keeps its own object for a uuid it holds;
 * between two pages the entry from the later position wins. The pageable
 * conversations' notices and the stitch's dividers are set aside: the window
 * draws its own edges and puts each divider back where the stitch drew it.
 */
function collectItems(input: PagingInput): Collected {
  const extentById = new Map(input.conversations.map((extent) => [extent.conversationId, extent]));
  const rankById = new Map(input.conversations.map((extent, index) => [extent.conversationId, index]));
  const pageable = new Set(input.conversations.filter((extent) => extent.pageable).map((extent) => extent.conversationId));
  const noticeById = new Map<string, TailNotice>();
  const dividerBefore = new Map<string, TailDivider>();
  const chosen = new Map<string, Item>();
  let sequence = 0;

  let segment = 0;
  let pendingDivider: TranscriptEntry | null = null;
  let previousUuid: string | null = null;
  input.tail.forEach((entry, tailIndex) => {
    if (isSessionBoundary(entry)) {
      // Each stretch between two of the stitch's dividers is one session.
      segment += 1;
      pendingDivider = entry;
      return;
    }
    if (entry.kind === 'system' && entry.subtype === 'truncated' && entry.earlierHistory
      && pageable.has(entry.earlierHistory.conversationId)) {
      noticeById.set(entry.earlierHistory.conversationId, {
        cursor: entry.earlierHistory.cursor,
        position: entry.earlierHistory.position,
      });
      return;
    }
    if (pendingDivider) {
      dividerBefore.set(entry.uuid, { divider: pendingDivider, previousUuid });
      pendingDivider = null;
    }
    previousUuid = entry.uuid;
    if (chosen.has(entry.uuid)) return;
    const origin = entry.origin;
    chosen.set(entry.uuid, {
      entry,
      effectiveTs: entry.ts,
      conversationKey: origin ? origin.conversationId : `segment:${segment}`,
      order: origin ? origin.position : tailIndex,
      conversationRank: origin
        ? rankById.get(origin.conversationId) ?? input.conversations.length
        : input.conversations.length + segment,
      hasOrigin: !!origin,
      fromTail: true,
      sequence: sequence++,
    });
  });
  for (const block of input.blocks) {
    for (const entry of block.entries) {
      const position = entry.origin?.position ?? block.startPosition;
      const existing = chosen.get(entry.uuid);
      if (existing && (existing.fromTail || existing.conversationKey !== block.conversationId || position <= existing.order)) continue;
      chosen.set(entry.uuid, {
        entry,
        effectiveTs: entry.ts,
        conversationKey: block.conversationId,
        order: position,
        conversationRank: rankById.get(block.conversationId) ?? input.conversations.length,
        hasOrigin: !!entry.origin,
        fromTail: false,
        sequence: sequence++,
      });
    }
  }

  const items = [...chosen.values()];
  assignEffectiveTimes(items, (key) => extentById.get(key)?.hasTimestamps !== false);
  items.sort((first, second) => first.effectiveTs - second.effectiveTs
    || first.conversationRank - second.conversationRank
    || first.order - second.order
    || first.sequence - second.sequence);
  const itemsByConversation = new Map<string, Item[]>();
  for (const item of items) {
    const list = itemsByConversation.get(item.conversationKey);
    if (list) list.push(item);
    else itemsByConversation.set(item.conversationKey, [item]);
  }
  return { items, itemsByConversation, extentById, noticeById, dividerBefore };
}

/**
 * A conversation's anchors for `P(t)`: (time, position) points known about it,
 * rising in both, ending at its size.
 */
function conversationAnchors(
  extent: ConversationExtent,
  held: ReadonlyArray<Item>,
  timeline: ReadonlyArray<TimelineSample> | undefined,
): TimelineSample[] {
  const points: TimelineSample[] = [];
  if (extent.hasTimestamps) {
    for (const sample of timeline ?? []) points.push({ position: sample.position, ts: sample.ts });
  }
  for (const item of held) {
    if (item.hasOrigin) points.push({ position: item.order, ts: item.effectiveTs });
  }
  points.sort((first, second) => first.position - second.position || first.ts - second.ts);
  const anchors: TimelineSample[] = [];
  let latestTs = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.ts) || point.ts <= 0) continue;
    latestTs = Math.max(latestTs, point.ts);
    const last = anchors[anchors.length - 1];
    if (last && last.position === point.position) {
      last.ts = latestTs;
      continue;
    }
    anchors.push({ position: point.position, ts: latestTs });
  }
  const lastTs = anchors.length > 0 ? anchors[anchors.length - 1].ts : 0;
  if (anchors.length === 0 || anchors[anchors.length - 1].position < extent.totalPosition) {
    anchors.push({ position: extent.totalPosition, ts: lastTs });
  }
  return anchors;
}

/** One conversation's position at time `t`: the furthest anchor at or before it, interpolated toward the next. */
function positionAtTime(anchors: ReadonlyArray<TimelineSample>, ts: number): number {
  if (anchors.length === 0 || ts < anchors[0].ts) return 0;
  let low = 0;
  let high = anchors.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (anchors[middle].ts <= ts) low = middle;
    else high = middle - 1;
  }
  const at = anchors[low];
  const next = anchors[low + 1];
  if (!next || next.ts <= at.ts) return at.position;
  const fraction = (ts - at.ts) / (next.ts - at.ts);
  return at.position + Math.max(0, Math.min(1, fraction)) * (next.position - at.position);
}

/** `P(t)` over every conversation, and its inverse. */
interface TranscriptModel {
  total: number;
  anchorsByConversation: Map<string, TimelineSample[]>;
  /** `P(t)`, optionally pinned to one conversation's exact position. */
  at(ts: number, conversationId?: string, position?: number): number;
  /** The conversation, position and time where `P` reaches `target`. */
  inverse(target: number): LogicalTarget | null;
}

function transcriptModelOf(input: PagingInput, collected: Collected): TranscriptModel {
  const anchorsByConversation = new Map<string, TimelineSample[]>();
  let total = 0;
  for (const extent of input.conversations) {
    total += extent.totalPosition;
    anchorsByConversation.set(
      extent.conversationId,
      conversationAnchors(extent, collected.itemsByConversation.get(extent.conversationId) ?? [], input.timelines.get(extent.conversationId)),
    );
  }
  const at = (ts: number, conversationId?: string, position?: number): number => {
    let sum = 0;
    for (const [id, anchors] of anchorsByConversation) {
      sum += id === conversationId && position !== undefined ? position : positionAtTime(anchors, ts);
    }
    return Math.min(total, sum);
  };
  let sortedTimes: number[] | null = null;
  const inverse = (target: number): LogicalTarget | null => {
    if (total <= 0) return null;
    if (!sortedTimes) {
      const times = new Set<number>();
      for (const anchors of anchorsByConversation.values()) for (const anchor of anchors) times.add(anchor.ts);
      sortedTimes = [...times].filter((ts) => Number.isFinite(ts)).sort((first, second) => first - second);
    }
    const times = sortedTimes;
    if (times.length === 0) return null;
    const clamped = Math.min(Math.max(0, target), total);
    if (clamped <= 0) {
      // The very start: position 0 of the conversation that began first.
      let first: LogicalTarget | null = null;
      for (const [conversationId, anchors] of anchorsByConversation) {
        const startTs = anchors[0]?.ts ?? Infinity;
        if (!first || startTs < first.ts) first = { conversationId, position: 0, ts: startTs };
      }
      return first;
    }
    let low = 0;
    let high = times.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (at(times[middle]) >= clamped) high = middle;
      else low = middle + 1;
    }
    const ts = times[low];
    const previousTs = low > 0 ? times[low - 1] : -Infinity;
    let remaining = clamped - (low > 0 ? at(previousTs) : 0);
    let lastGrowing: LogicalTarget | null = null;
    for (const [conversationId, anchors] of anchorsByConversation) {
      const from = low > 0 ? positionAtTime(anchors, previousTs) : 0;
      const to = positionAtTime(anchors, ts);
      const growth = to - from;
      if (growth <= 0) continue;
      lastGrowing = { conversationId, position: Math.round(to), ts };
      if (remaining <= growth) {
        // Inside the growth: interpolate the time too, so a drag label moves smoothly.
        const fraction = remaining / growth;
        const interpolatedTs = low > 0 ? previousTs + fraction * (ts - previousTs) : ts;
        return { conversationId, position: Math.round(from + remaining), ts: interpolatedTs };
      }
      remaining -= growth;
    }
    return lastGrowing;
  };
  return { total, anchorsByConversation, at, inverse };
}

/** The logical coordinate a view uses: `P` itself, or a column's stays laid end to end. */
interface ViewModel {
  total: number;
  at(ts: number, conversationId?: string, position?: number): number;
  targetAt(logical: number): LogicalTarget | null;
}

function viewModelOf(model: TranscriptModel, ranges: ReadonlyArray<TimeRange> | undefined): ViewModel {
  if (!ranges) {
    return { total: model.total, at: model.at, targetAt: model.inverse };
  }
  const stretches = [...ranges]
    .sort((first, second) => first.start - second.start)
    .map((range) => {
      const from = model.at(range.start);
      const to = Number.isFinite(range.end) ? model.at(range.end) : model.total;
      return { range, from, span: Math.max(0, to - from) };
    });
  let total = 0;
  const cumulative: number[] = [];
  for (const stretch of stretches) {
    cumulative.push(total);
    total += stretch.span;
  }
  return {
    total,
    at(ts, conversationId, position) {
      let sum = 0;
      for (let index = 0; index < stretches.length; index += 1) {
        const stretch = stretches[index];
        if (ts < stretch.range.start) break;
        if (ts >= stretch.range.end) {
          sum = cumulative[index] + stretch.span;
          continue;
        }
        const inside = model.at(ts, conversationId, position) - stretch.from;
        return cumulative[index] + Math.max(0, Math.min(stretch.span, inside));
      }
      return sum;
    },
    targetAt(logical) {
      if (stretches.length === 0) return null;
      const clamped = Math.min(Math.max(0, logical), total);
      let index = stretches.length - 1;
      for (let candidate = 0; candidate < stretches.length; candidate += 1) {
        if (stretches[candidate].span > 0 && cumulative[candidate] + stretches[candidate].span >= clamped) {
          index = candidate;
          break;
        }
      }
      const stretch = stretches[index];
      const found = model.inverse(stretch.from + (clamped - cumulative[index]));
      if (!found) return null;
      return { ...found, ts: Math.min(Math.max(found.ts, stretch.range.start), stretch.range.end) };
    },
  };
}

/** A conversation's held stretch, merged where blocks touch. */
interface HeldStretch {
  startPosition: number;
  endPosition: number;
  startCursor: string;
  endCursor: string;
  sourceToken: string | null;
}

/** One pageable conversation's held stretches, oldest first, the tail last. */
function stretchesOf(input: PagingInput, collected: Collected, extent: ConversationExtent): HeldStretch[] | null {
  const tailCursor = collected.noticeById.get(extent.conversationId)?.cursor;
  if (!tailCursor) return null;
  const stretches: HeldStretch[] = [];
  const blocks = input.blocks
    .filter((block) => block.conversationId === extent.conversationId)
    .sort((first, second) => first.startPosition - second.startPosition);
  for (const block of blocks) {
    const last = stretches[stretches.length - 1];
    const startPosition = block.reachedStart ? 0 : block.startPosition;
    if (last && startPosition <= last.endPosition) {
      if (block.endPosition > last.endPosition) {
        last.endPosition = block.endPosition;
        last.endCursor = block.endCursor;
      }
      continue;
    }
    stretches.push({
      startPosition,
      endPosition: block.endPosition,
      startCursor: block.startCursor,
      endCursor: block.endCursor,
      sourceToken: block.sourceToken,
    });
  }
  // The tail is the last stretch; a block that reached it joins it.
  const lastHeld = stretches[stretches.length - 1];
  if (lastHeld && lastHeld.endPosition >= extent.tailStartPosition) {
    lastHeld.endPosition = extent.totalPosition;
  } else {
    stretches.push({
      startPosition: extent.tailStartPosition,
      endPosition: extent.totalPosition,
      startCursor: tailCursor,
      endCursor: tailCursor,
      sourceToken: null,
    });
  }
  return stretches;
}

/** Each pageable conversation's holes: the unloaded stretches between what the window holds. */
function holesOf(input: PagingInput, collected: Collected): ConversationHole[] {
  const holes: ConversationHole[] = [];
  for (const extent of input.conversations) {
    if (!extent.pageable || extent.tailStartPosition <= 0) continue;
    const stretches = stretchesOf(input, collected, extent);
    if (!stretches) continue;
    const conversationItems = collected.itemsByConversation.get(extent.conversationId) ?? [];
    const firstTimeIn = (start: number, end: number): number => {
      for (const item of conversationItems) if (item.order >= start && item.order < end) return item.effectiveTs;
      return Infinity;
    };
    const lastTimeIn = (start: number, end: number): number => {
      for (let index = conversationItems.length - 1; index >= 0; index -= 1) {
        const item = conversationItems[index];
        if (item.order >= start && item.order < end) return item.effectiveTs;
      }
      return -Infinity;
    };
    // The conversation's own start, where the timeline knows it: a session that
    // ended before it began is not inside its unloaded head.
    const timeline = extent.hasTimestamps ? input.timelines.get(extent.conversationId) : undefined;
    const startTs = timeline?.find((sample) => sample.ts > 0)?.ts;
    let previous: HeldStretch | null = null;
    for (const stretch of stretches) {
      const holeStart = previous ? previous.endPosition : 0;
      if (stretch.startPosition > holeStart) {
        let tsBefore = -Infinity;
        if (previous) tsBefore = lastTimeIn(previous.startPosition, previous.endPosition);
        else if (startTs !== undefined) tsBefore = startTs - 1;
        holes.push({
          conversationId: extent.conversationId,
          startPosition: holeStart,
          endPosition: stretch.startPosition,
          startCursor: previous ? previous.endCursor : null,
          endCursor: stretch.startCursor,
          tsBefore,
          tsAfter: firstTimeIn(stretch.startPosition, stretch.endPosition),
          tailStartPosition: extent.tailStartPosition,
          sourceToken: stretch.sourceToken ?? previous?.sourceToken ?? null,
        });
      }
      previous = stretch;
    }
  }
  return holes;
}

/** Whether a hole covers any of the view's time. */
function holeIsRelevant(hole: ConversationHole, ranges: ReadonlyArray<TimeRange> | undefined): boolean {
  if (!ranges) return true;
  return ranges.some((range) => range.start < hole.tsAfter && range.end > hole.tsBefore);
}

/**
 * Build the window: merge the tail and held pages, find each pageable
 * conversation's holes, and keep the widest time range around `anchorTs` that
 * no hole of the view's time overlaps.
 */
export function buildPagingWindow(input: PagingInput): PagingWindow {
  const collected = collectItems(input);
  const holes = holesOf(input, collected);
  const ranges = input.timeRanges;

  // An anchor inside a hole moves to the hole's newer side.
  let anchorTs = input.anchorTs;
  for (const hole of holes) {
    if (anchorTs > hole.tsBefore && anchorTs < hole.tsAfter) anchorTs = hole.tsAfter;
  }
  let windowStart = -Infinity;
  let windowEnd = Infinity;
  let topHole: ConversationHole | null = null;
  let bottomHole: ConversationHole | null = null;
  for (const hole of holes) {
    if (!holeIsRelevant(hole, ranges)) continue;
    if (hole.tsAfter <= anchorTs && hole.tsAfter > windowStart) {
      windowStart = hole.tsAfter;
      topHole = hole;
    }
    if (hole.tsBefore >= anchorTs && hole.tsBefore < windowEnd) {
      windowEnd = hole.tsBefore;
      bottomHole = hole;
    }
  }
  const inWindow = collected.items.filter((item) => item.effectiveTs >= windowStart && item.effectiveTs <= windowEnd);

  // The stitch's dividers, where it drew them: before the entry each introduced,
  // when that entry still follows the one it followed, or still crosses from
  // another conversation.
  const entries: TranscriptEntry[] = [];
  let previous: Item | null = null;
  for (const item of inWindow) {
    const tailDivider = collected.dividerBefore.get(item.entry.uuid);
    if (tailDivider && previous
      && (previous.entry.uuid === tailDivider.previousUuid || previous.conversationKey !== item.conversationKey)) {
      entries.push(tailDivider.divider);
    }
    entries.push(item.entry);
    previous = item;
  }

  const model = transcriptModelOf(input, collected);
  const view = viewModelOf(model, ranges);
  const logicalByUuid = new Map<string, number>();
  const timeByUuid = new Map<string, number>();
  for (const item of inWindow) {
    const origin = item.entry.origin;
    logicalByUuid.set(item.entry.uuid, origin && collected.extentById.has(origin.conversationId)
      ? view.at(item.effectiveTs, origin.conversationId, origin.position)
      : view.at(item.effectiveTs));
    timeByUuid.set(item.entry.uuid, item.effectiveTs);
  }
  const logicalStart = inWindow[0] ? logicalByUuid.get(inWindow[0].entry.uuid) ?? 0 : 0;
  const logicalEnd = bottomHole
    ? view.at(bottomHole.tsBefore, bottomHole.conversationId, bottomHole.startPosition)
    : view.total;

  const isHeld = (conversationId: string, position: number): boolean => {
    const extent = collected.extentById.get(conversationId);
    if (extent && position >= extent.tailStartPosition) return true;
    return input.blocks.some((block) => block.conversationId === conversationId
      && position >= (block.reachedStart ? 0 : block.startPosition) && position < block.endPosition);
  };
  const positionOf = (conversationId: string, ts: number): number =>
    positionAtTime(model.anchorsByConversation.get(conversationId) ?? [], ts);
  const aroundIn = (hole: ConversationHole, position: number): PageRequest => ({
    conversationId: hole.conversationId,
    direction: 'around',
    position: Math.round(position),
    untilPosition: hole.endPosition,
    sourceToken: hole.sourceToken ?? undefined,
  });

  const requestFor = (edge: 'top' | 'bottom'): PageRequest | null => {
    if (edge === 'top') {
      const hole = topHole;
      if (!hole) return null;
      const contiguous: PageRequest = {
        conversationId: hole.conversationId,
        direction: 'before',
        cursor: hole.endCursor,
        untilPosition: hole.tailStartPosition,
        sourceToken: hole.sourceToken ?? undefined,
      };
      if (!ranges) return contiguous;
      // The latest of the view's time inside the hole: read there rather than
      // through another column's time.
      let target = hole.tsAfter;
      for (const range of ranges) {
        if (range.start < hole.tsAfter && range.end > hole.tsBefore) target = Math.min(range.end, hole.tsAfter);
      }
      if (target >= hole.tsAfter) return contiguous;
      const position = positionOf(hole.conversationId, target);
      if (position <= hole.startPosition || position >= hole.endPosition || isHeld(hole.conversationId, position)) return contiguous;
      return aroundIn(hole, position);
    }
    const hole = bottomHole;
    if (!hole) return null;
    const contiguous: PageRequest = hole.startCursor === null
      ? aroundIn(hole, 0)
      : {
        conversationId: hole.conversationId,
        direction: 'after',
        cursor: hole.startCursor,
        untilPosition: hole.endPosition,
        sourceToken: hole.sourceToken ?? undefined,
      };
    if (!ranges) return contiguous;
    // The earliest of the view's time inside the hole.
    let target = hole.tsBefore;
    for (const range of ranges) {
      if (range.start < hole.tsAfter && range.end > hole.tsBefore) {
        target = Math.max(range.start, hole.tsBefore);
        break;
      }
    }
    if (target <= hole.tsBefore) return contiguous;
    const position = positionOf(hole.conversationId, target);
    if (position <= hole.startPosition || position >= hole.endPosition || isHeld(hole.conversationId, position)) return contiguous;
    return aroundIn(hole, position);
  };

  const requestForPosition = (conversationId: string, position: number): PageRequest | null => {
    const extent = collected.extentById.get(conversationId);
    if (!extent || !extent.pageable || isHeld(conversationId, position)) return null;
    return {
      conversationId,
      direction: 'around',
      position: Math.max(0, Math.min(Math.round(position), extent.tailStartPosition)),
      untilPosition: extent.tailStartPosition,
      sourceToken: input.blocks.find((block) => block.conversationId === conversationId)?.sourceToken,
    };
  };

  const requestForTime = (ts: number): PageRequest | null => {
    for (const hole of holes) {
      if (!(ts > hole.tsBefore && ts < hole.tsAfter)) continue;
      const position = Math.min(
        Math.max(positionOf(hole.conversationId, ts), hole.startPosition),
        Math.max(hole.startPosition, hole.endPosition - 1),
      );
      return requestForPosition(hole.conversationId, position);
    }
    return null;
  };

  const timeAt = (logical: number): number | null => {
    const located = view.targetAt(logical);
    if (!located) return null;
    if (collected.extentById.get(located.conversationId)?.hasTimestamps === false) return null;
    return located.ts > 0 && Number.isFinite(located.ts) ? located.ts : null;
  };

  return {
    entries,
    topHole,
    bottomHole,
    reachesTail: bottomHole === null,
    anchorTs,
    logicalByUuid,
    timeByUuid,
    logicalStart,
    logicalEnd: Math.max(logicalStart, logicalEnd),
    logicalTotal: view.total,
    targetAt: view.targetAt,
    timeAt,
    requestFor,
    requestForTime,
    requestForPosition,
  };
}

/**
 * Whether a page answers the request it was sent for: the right conversation,
 * and progress (an empty page is progress only when it reached the start). A
 * page that makes none would ask for the same page again forever.
 */
export function pageFitsRequest(request: PageRequest, page: HeldBlock): boolean {
  if (page.conversationId !== request.conversationId) return false;
  if (page.endPosition < page.startPosition) return false;
  if (request.direction === 'around') return true;
  return page.startPosition < page.endPosition || page.reachedStart;
}

/** Bytes of history a set of blocks holds. */
export function heldBytes(blocks: ReadonlyArray<HeldBlock>): number {
  let total = 0;
  for (const block of blocks) total += Math.max(0, block.endPosition - block.startPosition);
  return total;
}

function heldEntryCount(blocks: ReadonlyArray<HeldBlock>): number {
  let total = 0;
  for (const block of blocks) total += block.entries.length;
  return total;
}

/** A block's time span, from its entries' times. */
function blockTimeSpan(block: HeldBlock): { first: number; last: number } {
  let first = Infinity;
  let last = -Infinity;
  for (const entry of block.entries) {
    if (entry.ts <= 0) continue;
    if (entry.ts < first) first = entry.ts;
    if (entry.ts > last) last = entry.ts;
  }
  return { first, last };
}

/**
 * Add a page to the held blocks, then drop blocks past the caps, farthest from
 * the reader first. The block the reader is in and the one just added are never
 * dropped, so the window always keeps the stretch under the reader.
 */
export function insertBlock(
  blocks: ReadonlyArray<HeldBlock>,
  page: HeldBlock,
  readerTs: number,
  maxBytes: number = HISTORY_WINDOW_MAX_BYTES,
  maxEntries: number = MAX_HELD_PAGE_ENTRIES,
): HeldBlock[] {
  const next = [...blocks.filter((block) => !(block.conversationId === page.conversationId
    && block.startPosition === page.startPosition && block.endPosition === page.endPosition)), page];
  const distanceFromReader = (block: HeldBlock): number => {
    const span = blockTimeSpan(block);
    if (!Number.isFinite(span.first)) return Infinity;
    if (readerTs >= span.first && readerTs <= span.last) return -1;
    return readerTs < span.first ? span.first - readerTs : readerTs - span.last;
  };
  while (next.length > 1 && (heldBytes(next) > maxBytes || heldEntryCount(next) > maxEntries)) {
    let farthestIndex = -1;
    let farthestDistance = -Infinity;
    next.forEach((block, index) => {
      if (block === page) return;
      const distance = distanceFromReader(block);
      if (distance < 0) return;
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthestIndex = index;
      }
    });
    if (farthestIndex < 0) break;
    next.splice(farthestIndex, 1);
  }
  return next;
}

/**
 * Keep what a re-windowed tail dropped. The tail is the newest stretch of each
 * file and its start moves forward as the file grows; the entries it no longer
 * holds would leave a hole between the held pages and the new tail, under the
 * reader. They become a block between the two notices' cursors, so the adapter
 * still mints every cursor. Only for a conversation the window holds pages of:
 * with none, the window is the tail, as it always was.
 */
export function retainSeam(
  previousTail: ReadonlyArray<TranscriptEntry>,
  nextTail: ReadonlyArray<TranscriptEntry>,
  blocks: ReadonlyArray<HeldBlock>,
  readerTs: number,
): ReadonlyArray<HeldBlock> {
  if (blocks.length === 0 || previousTail === nextTail) return blocks;
  const before = noticesOf(previousTail);
  const after = noticesOf(nextTail);
  let result: ReadonlyArray<HeldBlock> = blocks;
  for (const [conversationId, previousNotice] of before) {
    const nextNotice = after.get(conversationId);
    if (!nextNotice || nextNotice.position <= previousNotice.position) continue;
    const held = result.find((block) => block.conversationId === conversationId);
    if (!held) continue;
    const entries = previousTail.filter((entry) => entry.origin?.conversationId === conversationId
      && entry.origin.position >= previousNotice.position
      && entry.origin.position < nextNotice.position);
    result = insertBlock(result, {
      conversationId,
      sourceToken: held.sourceToken,
      startCursor: previousNotice.cursor,
      endCursor: nextNotice.cursor,
      startPosition: previousNotice.position,
      endPosition: nextNotice.position,
      reachedStart: false,
      entries,
    }, readerTs);
  }
  return result;
}

/** The entry of a page at or just before a position, for where a jump opens. */
export function entryNearPosition(entries: ReadonlyArray<TranscriptEntry>, position: number): TranscriptEntry | null {
  let best: TranscriptEntry | null = null;
  for (const entry of entries) {
    if (!entry.origin) continue;
    if (entry.origin.position > position) {
      if (!best) best = entry;
      break;
    }
    best = entry;
  }
  return best ?? entries[0] ?? null;
}

/**
 * The Conversation window's history paging: the pages it holds, where its
 * window is anchored, the reads it sends the retrieval worker, and the jumps.
 * The pure model is `conversation-paging.ts`; this hook owns the state and the
 * bridge calls, and does nothing at all for a conversation the tail holds whole.
 *
 * One read is in flight per window. An edge read grows the window by a page and
 * re-anchors it on the reader's row, so a page dropped past the cap never takes
 * the rows under the reader with it. A jump (Jump to start, a far scrollbar
 * drag, a search hit, a column tab whose stays are unloaded) replaces the window
 * with the page it lands on and bumps `generation`, which remounts the view at
 * `opening`. A reply that arrives after its window moved on is dropped.
 *
 * Anything that would set state from an effect is derived during render
 * instead: the reset on a new tab or anchor, the seam a re-windowed tail leaves,
 * and a jump still owed to a column tab's opening stay.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ConversationExtent, TranscriptEntry, TranscriptGetResponse, TranscriptHistoryPage } from '../../../shared/types';
import { truncationNoticeText } from '../../../shared/conversation-history';
import {
  buildPagingWindow,
  entryNearPosition,
  insertBlock,
  isPagingMode,
  pageFitsRequest,
  retainSeam,
  type HeldBlock,
  type PageRequest,
  type PagingWindow,
  type TimeRange,
  type TimelineSample,
} from './conversation-paging';
import type { InitialPosition } from './ConversationView';

/** What an edge row says: the window is reading there, or the read failed. */
export type EdgeStatus = 'loading' | 'error';

/** Tries of a jump whose page landed beside its moment rather than on it. */
const MAX_TARGET_ATTEMPTS = 3;
/** Waits before asking again when the worker's queue was full. */
const BUSY_RETRY_MS = 1000;
const MAX_BUSY_RETRIES = 2;

const NO_TIMELINES: ReadonlyMap<string, ReadonlyArray<TimelineSample>> = new Map();
const NO_BLOCKS: ReadonlyArray<HeldBlock> = [];
const NO_ENTRIES: ReadonlyArray<TranscriptEntry> = [];

/** Where a jump opens the view: a row, the start, or a logical position resolved to a row. */
type Opening = InitialPosition | { kind: 'logical'; logical: number };

export interface PagingState {
  key: string;
  blocks: ReadonlyArray<HeldBlock>;
  anchorTs: number;
  generation: number;
  opening: Opening | null;
  errors: { top: boolean; bottom: boolean };
  /** A jump the window is waiting on, with the time its skeleton shows. */
  jump: { labelTs: number | null } | null;
  /** A moment the window must hold (a column tab's opening stay), and the tries spent on it. */
  target: { ts: number; attempts: number } | null;
  /** The last visit a Route row asked for, so the same one asked again moves again. */
  seenVisitTs: number | null;
  /** The tail the blocks were last reconciled against, for the seam. */
  seenTail: ReadonlyArray<TranscriptEntry> | null;
  /** A search hit outside the window, and whether its lookup is done. */
  locate: { uuid: string; done: boolean } | null;
}

export function initialState(key: string, openingTs: number | null, generation: number, seenVisitTs: number | null): PagingState {
  return {
    key,
    blocks: NO_BLOCKS,
    anchorTs: openingTs ?? Infinity,
    generation,
    opening: null,
    errors: { top: false, bottom: false },
    jump: null,
    target: openingTs !== null ? { ts: openingTs, attempts: 0 } : null,
    seenVisitTs,
    seenTail: null,
    locate: null,
  };
}

/**
 * The state the hook's inputs imply before its window is built: a new tab or
 * anchor drops every page, a re-windowed tail leaves its seam as a block, and
 * a Route row's visit becomes a moment the window must hold. Returns `state`
 * itself when nothing changes, so the hook sets state only when it must.
 */
export function reconcileInputs(state: PagingState, inputs: {
  resetKey: string;
  openingTs: number | null;
  visitTs: number | null;
  enabled: boolean;
  tail: ReadonlyArray<TranscriptEntry> | null;
}): PagingState {
  let next = state;
  if (next.key !== inputs.resetKey) {
    next = initialState(inputs.resetKey, inputs.openingTs, state.generation + 1, inputs.visitTs);
  }
  if (inputs.enabled && inputs.tail && next.seenTail !== inputs.tail) {
    const blocks = next.seenTail ? retainSeam(next.seenTail, inputs.tail, next.blocks, next.anchorTs) : next.blocks;
    next = { ...next, seenTail: inputs.tail, blocks };
  }
  if (inputs.visitTs !== next.seenVisitTs) {
    next = {
      ...next,
      seenVisitTs: inputs.visitTs,
      ...(inputs.visitTs !== null ? { anchorTs: inputs.visitTs, target: { ts: inputs.visitTs, attempts: 0 } } : {}),
    };
  }
  return next;
}

/**
 * The state the built window implies: a moment the window must hold is met
 * once the window is built around it, and a search hit the tail holds while
 * the window is anchored elsewhere sends the window back to the tail, once (a
 * hole in another file can still keep it out). Returns `state` itself when
 * nothing changes.
 */
export function reconcileWindow(state: PagingState, inputs: {
  window: PagingWindow | null;
  enabled: boolean;
  turnUuid: string | null;
  tail: ReadonlyArray<TranscriptEntry> | null;
}): PagingState {
  const { window: built, turnUuid } = inputs;
  let next = state;
  if (next.target && built && built.anchorTs === next.target.ts) next = { ...next, target: null };
  if (inputs.enabled && turnUuid && built && !built.timeByUuid.has(turnUuid) && next.locate?.uuid !== turnUuid
    && inputs.tail?.some((entry) => entry.uuid === turnUuid)) {
    next = {
      ...next,
      blocks: NO_BLOCKS,
      anchorTs: Infinity,
      generation: next.generation + 1,
      opening: null,
      locate: { uuid: turnUuid, done: true },
    };
  }
  return next;
}

/** Where a view opens after a jump: a logical opening resolves to the first row at or past it. */
export function resolveOpening(opening: Opening | null, built: PagingWindow | null): InitialPosition | null {
  if (!opening || opening.kind !== 'logical') return opening;
  if (!built) return null;
  for (const entry of built.entries) {
    const logical = built.logicalByUuid.get(entry.uuid);
    if (logical !== undefined && logical >= opening.logical) return { kind: 'uuid', uuid: entry.uuid };
  }
  const last = built.entries[built.entries.length - 1];
  return last ? { kind: 'uuid', uuid: last.uuid } : null;
}

export interface ConversationPagingOptions {
  response: TranscriptGetResponse | null;
  projectId: string | null;
  /** The window's anchor session: any session of the task. */
  sessionId: string;
  windowId: string;
  /** A change drops every page: a new anchor, project or tab. */
  resetKey: string;
  /** A column tab's stays, or undefined for All. */
  timeRanges?: ReadonlyArray<TimeRange>;
  /** Where a column tab opens: its first stay, or the stay a Route row asked for. */
  openingTs: number | null;
  /** A stay a Route row asked for while its tab is already open. */
  visitTs: number | null;
  /** A turn to scroll to (a search hit or a Knowledge Graph source row). */
  turnUuid: string | null;
}

export interface ConversationPaging {
  enabled: boolean;
  window: PagingWindow | null;
  /** What the window shows, before any Route slicing. */
  entries: ReadonlyArray<TranscriptEntry>;
  topEdge: EdgeStatus | null;
  bottomEdge: EdgeStatus | null;
  /** Bumps whenever a jump replaced the window: the view's key. */
  generation: number;
  /** Where the view opens after a jump, or null for its usual opening. */
  opening: InitialPosition | null;
  /** A jump is waiting on its page: show the skeleton, not the view. */
  jumping: boolean;
  jumpLabelTs: number | null;
  /** Part of the history is not loaded: the search covers loaded messages only. */
  historyUnloaded: boolean;
  /** The turn to hand the view: withheld while its page is being found. */
  turnTarget: string | null;
  /** The notice Copy puts first while older history is not loaded. */
  copyNotice: TranscriptEntry | null;
  onNearEdge: (edge: 'top' | 'bottom') => void;
  onReaderMove: (uuid: string | null) => void;
  retry: (edge: 'top' | 'bottom') => void;
  jumpToStart: () => void;
  jumpToLatest: () => void;
  jumpToLogical: (logical: number) => void;
}

type ReadOutcome =
  | { kind: 'page'; page: TranscriptHistoryPage }
  | { kind: 'reset' }
  | { kind: 'failed' }
  | { kind: 'busy' }
  | { kind: 'superseded' };

async function readPage(
  request: PageRequest,
  projectId: string | null,
  requestKey: string,
): Promise<ReadOutcome> {
  try {
    const response = await window.electronAPI.transcripts.page({ ...request, projectId, requestKey });
    if (response.status === 'ok') {
      const { status: _status, ...page } = response;
      return { kind: 'page', page };
    }
    if (response.status === 'reset') return { kind: 'reset' };
    if (response.status === 'busy') return { kind: 'busy' };
    if (response.status === 'superseded') return { kind: 'superseded' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  }
}

function blockOf(page: TranscriptHistoryPage): HeldBlock {
  const { totalPosition: _totalPosition, reachedEnd: _reachedEnd, ...block } = page;
  return block;
}

/** The effective time of the entry a page opens at for a position, or of its first dated entry. */
function timeNear(page: TranscriptHistoryPage, position: number): number {
  const near = entryNearPosition(page.entries, position);
  if (near && near.ts > 0) return near.ts;
  return page.entries.find((entry) => entry.ts > 0)?.ts ?? Infinity;
}

export function useConversationPaging(options: ConversationPagingOptions): ConversationPaging {
  const { response, projectId, sessionId, windowId, resetKey, timeRanges, openingTs, visitTs, turnUuid } = options;
  const conversations: ReadonlyArray<ConversationExtent> | undefined = response?.conversations;
  const enabled = isPagingMode(conversations);
  const requestKey = `conversation-window:${windowId}`;

  const [state, setState] = useState<PagingState>(() => initialState(resetKey, openingTs, 0, visitTs));
  // State the inputs already imply, applied during render (React restarts the
  // render with it before anything commits): a reset, the seam, a visit.
  const inputs = reconcileInputs(state, { resetKey, openingTs, visitTs, enabled, tail: response?.entries ?? null });
  if (inputs !== state) setState(inputs);

  // Timelines live outside the per-tab state: they describe the files, not a tab.
  const [timelineState, setTimelineState] = useState<{ key: string; timelines: ReadonlyMap<string, ReadonlyArray<TimelineSample>> }>(
    () => ({ key: sessionId, timelines: NO_TIMELINES }),
  );
  const timelines = timelineState.key === sessionId ? timelineState.timelines : NO_TIMELINES;

  const heldBlocks = inputs.blocks;
  const anchorTs = inputs.anchorTs;
  const pagingWindow = useMemo(() => {
    if (!enabled || !response || !conversations) return null;
    return buildPagingWindow({ tail: response.entries, conversations, blocks: heldBlocks, timelines, anchorTs, timeRanges });
  }, [enabled, response, conversations, heldBlocks, timelines, anchorTs, timeRanges]);

  // What the built window implies: a moment it now holds, or a search hit the
  // tail holds while the window is anchored elsewhere.
  const current = reconcileWindow(inputs, { window: pagingWindow, enabled, turnUuid, tail: response?.entries ?? null });
  if (current !== inputs) setState(current);
  const target = current.target;
  const owedTarget = enabled && target && target.attempts < MAX_TARGET_ATTEMPTS ? target : null;
  const turnHeld = !!turnUuid && (!pagingWindow || pagingWindow.timeByUuid.has(turnUuid));
  const locateDone = current.locate?.uuid === turnUuid && current.locate.done;
  const locating = enabled && !!turnUuid && !turnHeld && !locateDone;

  // Mirrors the callbacks read; written after commit, never during render.
  const windowRef = useRef<PagingWindow | null>(null);
  const stateKeyRef = useRef(resetKey);
  const currentKey = current.key;
  useLayoutEffect(() => {
    windowRef.current = pagingWindow;
    stateKeyRef.current = currentKey;
  });

  const readerUuidRef = useRef<string | null>(null);
  const readerTsRef = useRef<number>(Infinity);
  const slotRef = useRef<{ sequence: number; kind: 'top' | 'bottom' | 'jump' } | null>(null);
  const sequenceRef = useRef(0);
  const busyRetriesRef = useRef(0);
  const readEdgeRef = useRef<((edge: 'top' | 'bottom') => void) | null>(null);

  /** The reader's time: the row at the top of the view, or the last one known. */
  const readerTs = useCallback((): number => {
    const known = windowRef.current;
    const uuid = readerUuidRef.current;
    const ts = uuid && known ? known.timeByUuid.get(uuid) : undefined;
    if (ts !== undefined) {
      readerTsRef.current = ts;
      return ts;
    }
    if (Number.isFinite(readerTsRef.current)) return readerTsRef.current;
    const entries = known?.entries ?? [];
    const last = entries[entries.length - 1];
    return last && known ? known.timeByUuid.get(last.uuid) ?? Infinity : Infinity;
  }, []);

  /** Take the read slot. A jump takes it over; an edge read waits for it. */
  const claimSlot = useCallback((kind: 'top' | 'bottom' | 'jump'): number | null => {
    if (kind !== 'jump' && slotRef.current) return null;
    sequenceRef.current += 1;
    slotRef.current = { sequence: sequenceRef.current, kind };
    return sequenceRef.current;
  }, []);
  /** Release the slot; true when this read still owns the window it was sent for. */
  const releaseSlot = useCallback((sequence: number, key: string): boolean => {
    if (slotRef.current?.sequence !== sequence) return false;
    slotRef.current = null;
    return stateKeyRef.current === key;
  }, []);

  const jumpToLatest = useCallback(() => {
    slotRef.current = null;
    readerUuidRef.current = null;
    readerTsRef.current = Infinity;
    setState((previous) => ({
      ...previous,
      blocks: NO_BLOCKS,
      anchorTs: Infinity,
      generation: previous.generation + 1,
      opening: { kind: 'bottom' },
      errors: { top: false, bottom: false },
      jump: null,
      target: null,
    }));
  }, [setState]);

  /** Read the page a jump lands on, then replace the window with it. */
  const jumpWith = useCallback((
    request: PageRequest,
    labelTs: number | null,
    land: (page: TranscriptHistoryPage) => { anchorTs: number; opening: Opening | null },
  ) => {
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = stateKeyRef.current;
    setState((previous) => ({ ...previous, jump: { labelTs } }));
    void readPage(request, projectId, requestKey).then((outcome) => {
      if (!releaseSlot(sequence, key)) return;
      if (outcome.kind === 'reset') {
        jumpToLatest();
        return;
      }
      setState((previous) => {
        if (previous.key !== key) return previous;
        if (outcome.kind !== 'page') return { ...previous, jump: null };
        const landed = land(outcome.page);
        readerUuidRef.current = null;
        readerTsRef.current = landed.anchorTs;
        return {
          ...previous,
          blocks: [blockOf(outcome.page)],
          anchorTs: landed.anchorTs,
          generation: previous.generation + 1,
          opening: landed.opening,
          errors: { top: false, bottom: false },
          jump: null,
        };
      });
    });
  }, [claimSlot, releaseSlot, jumpToLatest, projectId, requestKey, setState]);

  const jumpToStart = useCallback(() => {
    const known = windowRef.current;
    if (!known) return;
    // The view's start: position 0, or a column tab's first stay.
    const start = known.targetAt(0);
    if (!start) return;
    const request = known.requestForPosition(start.conversationId, start.position);
    if (!request) {
      slotRef.current = null;
      setState((previous) => ({
        ...previous,
        anchorTs: -Infinity,
        generation: previous.generation + 1,
        opening: { kind: 'top' },
        target: null,
      }));
      return;
    }
    jumpWith(request, Number.isFinite(start.ts) ? start.ts : null, () => ({ anchorTs: -Infinity, opening: { kind: 'top' } }));
  }, [jumpWith, setState]);

  const jumpToLogical = useCallback((logical: number) => {
    const known = windowRef.current;
    if (!known) return;
    const located = known.targetAt(logical);
    if (!located) return;
    const request = known.requestForPosition(located.conversationId, located.position);
    if (!request) {
      setState((previous) => ({
        ...previous,
        anchorTs: located.ts,
        generation: previous.generation + 1,
        opening: { kind: 'logical', logical },
        target: null,
      }));
      return;
    }
    jumpWith(request, known.timeAt(logical), (page) => ({
      anchorTs: timeNear(page, located.position),
      opening: { kind: 'logical', logical },
    }));
  }, [jumpWith, setState]);

  const readEdge = useCallback((edge: 'top' | 'bottom') => {
    const known = windowRef.current;
    if (!known) return;
    const request = known.requestFor(edge);
    if (!request) return;
    const sequence = claimSlot(edge);
    if (sequence === null) return;
    const key = stateKeyRef.current;
    void readPage(request, projectId, requestKey).then((outcome) => {
      if (!releaseSlot(sequence, key)) return;
      if (outcome.kind === 'reset') {
        jumpToLatest();
        return;
      }
      if (outcome.kind === 'superseded') return;
      if (outcome.kind === 'busy') {
        // The queue was full: try again shortly, then say it failed.
        if (busyRetriesRef.current < MAX_BUSY_RETRIES) {
          busyRetriesRef.current += 1;
          setTimeout(() => readEdgeRef.current?.(edge), BUSY_RETRY_MS);
          return;
        }
      }
      busyRetriesRef.current = 0;
      const page = outcome.kind === 'page' && pageFitsRequest(request, blockOf(outcome.page)) ? outcome.page : null;
      const reader = readerTs();
      setState((previous) => {
        if (previous.key !== key) return previous;
        if (!page) return { ...previous, errors: { ...previous.errors, [edge]: true } };
        return {
          ...previous,
          blocks: insertBlock(previous.blocks, blockOf(page), reader),
          anchorTs: reader,
          errors: { ...previous.errors, [edge]: false },
        };
      });
    });
  }, [claimSlot, releaseSlot, jumpToLatest, projectId, readerTs, requestKey, setState]);
  useLayoutEffect(() => {
    readEdgeRef.current = readEdge;
  });

  const errors = current.errors;
  const jumping = enabled && (!!current.jump || !!owedTarget || locating);
  const onNearEdge = useCallback((edge: 'top' | 'bottom') => {
    if (errors[edge]) return;
    readEdge(edge);
  }, [errors, readEdge]);
  const retry = useCallback((edge: 'top' | 'bottom') => {
    setState((previous) => ({ ...previous, errors: { ...previous.errors, [edge]: false } }));
    busyRetriesRef.current = 0;
    readEdge(edge);
  }, [readEdge, setState]);
  const onReaderMove = useCallback((uuid: string | null) => {
    readerUuidRef.current = uuid;
  }, []);

  // Timelines, once per conversation of this window: the thumb, the drag label
  // and a column tab's jumps read positions from them.
  const requestedTimelinesRef = useRef<{ sessionId: string; ids: Set<string> }>({ sessionId, ids: new Set() });
  useEffect(() => {
    if (!enabled || !conversations) return;
    if (requestedTimelinesRef.current.sessionId !== sessionId) {
      requestedTimelinesRef.current = { sessionId, ids: new Set() };
    }
    const requested = requestedTimelinesRef.current.ids;
    for (const extent of conversations) {
      if (!extent.pageable || !extent.hasTimestamps || extent.tailStartPosition <= 0) continue;
      if (requested.has(extent.conversationId)) continue;
      requested.add(extent.conversationId);
      const conversationId = extent.conversationId;
      void window.electronAPI.transcripts
        .timeline({ projectId, conversationId, requestKey: `${requestKey}:timeline:${conversationId}` })
        .then((reply) => (reply.status === 'ok' ? reply.samples : []))
        .catch(() => [])
        .then((samples) => {
          setTimelineState((previous) => {
            const held = previous.key === sessionId ? previous.timelines : NO_TIMELINES;
            const next = new Map(held);
            next.set(conversationId, samples);
            return { key: sessionId, timelines: next };
          });
        });
    }
  }, [enabled, conversations, sessionId, projectId, requestKey]);
  const timelinesReady = !conversations || conversations.every((extent) =>
    !extent.pageable || !extent.hasTimestamps || extent.tailStartPosition <= 0 || timelines.has(extent.conversationId));

  // A jump still owed to a moment the window must hold (a column tab's opening
  // stay). The page it reads lands as the whole window; a page beside the
  // moment counts a try, so a timeline that misleads stops after a few.
  const owedTs = owedTarget?.ts ?? null;
  const owedAttempts = owedTarget?.attempts ?? 0;
  useEffect(() => {
    if (owedTs === null || !timelinesReady) return;
    const known = windowRef.current;
    const request = known?.requestForTime(owedTs) ?? null;
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = stateKeyRef.current;
    const settle = (blocks: ReadonlyArray<HeldBlock> | null): void => {
      setState((previous) => {
        if (previous.key !== key || previous.target?.ts !== owedTs) return previous;
        return {
          ...previous,
          ...(blocks ? { blocks, generation: previous.generation + 1 } : {}),
          anchorTs: owedTs,
          target: { ts: owedTs, attempts: previous.target.attempts + 1 },
        };
      });
    };
    if (!request) {
      releaseSlot(sequence, key);
      settle(null);
      return;
    }
    void readPage(request, projectId, requestKey).then((outcome) => {
      if (!releaseSlot(sequence, key)) return;
      settle(outcome.kind === 'page' ? [blockOf(outcome.page)] : null);
    });
  }, [owedTs, owedAttempts, timelinesReady, claimSlot, releaseSlot, projectId, requestKey]);

  // A search hit outside the window: the worker finds its page.
  const locateUuid = locating ? turnUuid : null;
  useEffect(() => {
    if (!locateUuid) return;
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = stateKeyRef.current;
    void window.electronAPI.transcripts
      .locate({ projectId, sessionId, turnUuid: locateUuid, requestKey: `${requestKey}:locate` })
      .catch(() => ({ status: 'not_found' as const }))
      .then((reply) => {
        if (!releaseSlot(sequence, key)) return;
        setState((previous) => {
          if (previous.key !== key) return previous;
          const done = { uuid: locateUuid, done: true };
          if (reply.status === 'found') {
            const entry = reply.page.entries.find((candidate) => candidate.uuid === locateUuid);
            return {
              ...previous,
              blocks: [blockOf(reply.page)],
              anchorTs: entry && entry.ts > 0 ? entry.ts : timeNear(reply.page, reply.page.startPosition),
              generation: previous.generation + 1,
              opening: null,
              errors: { top: false, bottom: false },
              locate: done,
            };
          }
          if (reply.status === 'in_tail') {
            return { ...previous, blocks: NO_BLOCKS, anchorTs: Infinity, generation: previous.generation + 1, opening: null, locate: done };
          }
          return { ...previous, locate: done };
        });
      });
  }, [locateUuid, claimSlot, releaseSlot, projectId, sessionId, requestKey]);

  const opening = resolveOpening(current.opening, pagingWindow);

  const copyNotice = useMemo((): TranscriptEntry | null => {
    const hole = pagingWindow?.topHole;
    if (!hole) return null;
    const extent = conversations?.find((candidate) => candidate.conversationId === hole.conversationId);
    if (!extent) return null;
    return {
      kind: 'system',
      uuid: `kangentic-truncated:${hole.conversationId}:${hole.endPosition}`,
      ts: 0,
      subtype: 'truncated',
      text: truncationNoticeText(hole.endPosition, extent.totalPosition),
    };
  }, [pagingWindow, conversations]);

  const entries = pagingWindow?.entries ?? response?.entries ?? NO_ENTRIES;
  const topEdge: EdgeStatus | null = pagingWindow?.topHole ? (errors.top ? 'error' : 'loading') : null;
  const bottomEdge: EdgeStatus | null = pagingWindow?.bottomHole ? (errors.bottom ? 'error' : 'loading') : null;

  return {
    enabled,
    window: pagingWindow,
    entries,
    topEdge,
    bottomEdge,
    generation: current.generation,
    opening,
    jumping,
    jumpLabelTs: current.jump?.labelTs ?? owedTarget?.ts ?? null,
    historyUnloaded: !!pagingWindow && (!!pagingWindow.topHole || !!pagingWindow.bottomHole),
    turnTarget: locating ? null : turnUuid,
    copyNotice,
    onNearEdge,
    onReaderMove,
    retry,
    jumpToStart,
    jumpToLatest,
    jumpToLogical,
  };
}

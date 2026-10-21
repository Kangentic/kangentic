/**
 * The Conversation window's history paging: the pages it holds, where its
 * window is anchored, the reads it sends the retrieval worker, and the jumps.
 * The pure model is `conversation-paging.ts`; this hook owns the state and the
 * bridge calls, and does nothing at all for a conversation the tail holds whole.
 *
 * One read is in flight per window. An edge read grows the window by a page and
 * re-anchors it on the reader's row, so a page dropped past the cap never takes
 * the rows under the reader with it. A jump (Jump to start, a search hit, a
 * column tab whose stays are unloaded) replaces the window with the page it
 * lands on and bumps `generation`, which remounts the view at `opening`. A far
 * scrollbar drag seeks instead: its page replaces the window with the view still
 * mounted, so the drag that asked for it keeps going over the rows it brought.
 * A reply that arrives after its window moved on is dropped.
 *
 * Anything that would set state from an effect is derived during render
 * instead: the reset on a new tab or anchor, the seam a re-windowed tail leaves,
 * and a jump still owed to a column tab's opening stay.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationExtent,
  TranscriptEntry,
  TranscriptGetResponse,
  TranscriptHistoryPage,
  TranscriptTimelineResponse,
} from '../../../shared/types';
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
import type { FarSeekOutcome } from './ConversationScrollbar';

/** What an edge row says: the window is reading there, or the read failed. */
export type EdgeStatus = 'loading' | 'error';

/** Tries of a jump whose page landed beside its moment rather than on it. */
const MAX_TARGET_ATTEMPTS = 3;
/** Waits before asking again when the worker's queue was full. */
const BUSY_RETRY_MS = 1000;
const MAX_BUSY_RETRIES = 2;
/**
 * A timeline the worker could not answer yet (busy, or restarting) is asked for
 * again after each of these waits, then the window goes without. Short, because
 * a column tab whose stay is not loaded waits on the timeline to open there:
 * opening without it lands in the wrong place.
 */
const TIMELINE_RETRY_DELAYS_MS = [1000, 3000];

const NO_TIMELINES: ReadonlyMap<string, ReadonlyArray<TimelineSample>> = new Map();
const NO_BLOCKS: ReadonlyArray<HeldBlock> = [];
const NO_EDGE_ERRORS: PagingState['errors'] = { top: false, bottom: false };
const NO_ENTRIES: ReadonlyArray<TranscriptEntry> = [];

/** What holds the window's one read: an edge read, a jump, or a far drag's seek. */
type SlotKind = 'top' | 'bottom' | 'jump' | 'seek';

export interface PagingState {
  key: string;
  blocks: ReadonlyArray<HeldBlock>;
  anchorTs: number;
  generation: number;
  opening: InitialPosition | null;
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
    errors: NO_EDGE_ERRORS,
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
  // A lookup answers for one turn: the same turn asked for again, after the
  // window moved away from it, is looked up again.
  if (next.locate && next.locate.uuid !== turnUuid) next = { ...next, locate: null };
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
  /** Load the page at a logical position into the window in place; null drops a seek in flight. */
  seekLogical: (logical: number | null) => Promise<FarSeekOutcome>;
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
  const turnUuidRef = useRef<string | null>(turnUuid);
  const currentKey = current.key;
  useLayoutEffect(() => {
    windowRef.current = pagingWindow;
    stateKeyRef.current = currentKey;
    turnUuidRef.current = turnUuid;
  });

  const readerUuidRef = useRef<string | null>(null);
  const readerTsRef = useRef<number>(Infinity);
  const slotRef = useRef<{ sequence: number; kind: SlotKind } | null>(null);
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

  /** Take the read slot. A jump or a seek takes it over; an edge read waits for it. */
  const claimSlot = useCallback((kind: SlotKind): number | null => {
    if ((kind === 'top' || kind === 'bottom') && slotRef.current) return null;
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

  /**
   * What a jump the reader asked for settles: the moment a column tab still
   * owed and the search hit still being looked up. Their reads lose the slot to
   * the jump and answer nothing, so left pending they would hold the skeleton.
   */
  const settledByJump = useCallback((): Pick<PagingState, 'target' | 'locate'> => {
    const turn = turnUuidRef.current;
    return { target: null, locate: turn ? { uuid: turn, done: true } : null };
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
      errors: NO_EDGE_ERRORS,
      jump: null,
      ...settledByJump(),
    }));
  }, [settledByJump, setState]);

  /** Read the page a jump lands on, then replace the window with it. */
  const jumpWith = useCallback((
    request: PageRequest,
    labelTs: number | null,
    land: (page: TranscriptHistoryPage) => { anchorTs: number; opening: InitialPosition | null },
  ) => {
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = stateKeyRef.current;
    // Settled now, not on landing: a jump whose read fails must not leave them pending.
    setState((previous) => ({ ...previous, jump: { labelTs }, ...settledByJump() }));
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
          errors: NO_EDGE_ERRORS,
          jump: null,
        };
      });
    });
  }, [claimSlot, releaseSlot, jumpToLatest, settledByJump, projectId, requestKey, setState]);

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
        ...settledByJump(),
      }));
      return;
    }
    jumpWith(request, Number.isFinite(start.ts) ? start.ts : null, () => ({ anchorTs: -Infinity, opening: { kind: 'top' } }));
  }, [jumpWith, settledByJump, setState]);

  const seekLogical = useCallback((logical: number | null): Promise<FarSeekOutcome> => {
    if (logical === null) {
      // The drag came back over loaded rows: a page still on its way is not wanted.
      if (slotRef.current?.kind === 'seek') slotRef.current = null;
      return Promise.resolve('dropped');
    }
    const known = windowRef.current;
    const located = known?.targetAt(logical) ?? null;
    if (!known || !located) return Promise.resolve('failed');
    const request = known.requestForPosition(located.conversationId, located.position);
    if (!request) {
      // Already held (the tail, or a page the window passed over): re-anchor on it.
      if (slotRef.current?.kind === 'seek') slotRef.current = null;
      setState((previous) => ({ ...previous, anchorTs: located.ts, target: null }));
      return Promise.resolve('landed');
    }
    const sequence = claimSlot('seek');
    if (sequence === null) return Promise.resolve('dropped');
    const key = stateKeyRef.current;
    return readPage(request, projectId, requestKey).then((outcome): FarSeekOutcome => {
      // A newer seek, a jump, or a cancel owns the window now.
      if (!releaseSlot(sequence, key)) return 'dropped';
      if (outcome.kind === 'reset') {
        jumpToLatest();
        return 'dropped';
      }
      if (outcome.kind !== 'page') return 'failed';
      const anchor = timeNear(outcome.page, located.position);
      readerUuidRef.current = null;
      readerTsRef.current = anchor;
      setState((previous) => {
        if (previous.key !== key) return previous;
        return {
          ...previous,
          blocks: [blockOf(outcome.page)],
          anchorTs: anchor,
          errors: NO_EDGE_ERRORS,
          target: null,
        };
      });
      return 'landed';
    });
  }, [claimSlot, releaseSlot, jumpToLatest, projectId, requestKey, setState]);

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
  // and a column tab's jumps read positions from them. One the worker could not
  // answer yet is asked for again a few times before the window goes without.
  const requestedTimelinesRef = useRef<{ sessionId: string; ids: Set<string>; tries: Map<string, number> }>(
    { sessionId, ids: new Set(), tries: new Map() },
  );
  const timelineRetryTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const [timelineRetries, setTimelineRetries] = useState(0);
  useEffect(() => {
    const timers = timelineRetryTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);
  useEffect(() => {
    if (!enabled || !conversations) return;
    if (requestedTimelinesRef.current.sessionId !== sessionId) {
      requestedTimelinesRef.current = { sessionId, ids: new Set(), tries: new Map() };
    }
    const requested = requestedTimelinesRef.current;
    for (const extent of conversations) {
      if (!extent.pageable || !extent.hasTimestamps || extent.tailStartPosition <= 0) continue;
      if (requested.ids.has(extent.conversationId)) continue;
      requested.ids.add(extent.conversationId);
      const conversationId = extent.conversationId;
      void window.electronAPI.transcripts
        .timeline({ projectId, conversationId, requestKey: `${requestKey}:timeline:${conversationId}` })
        .catch((): TranscriptTimelineResponse => ({ status: 'busy' }))
        .then((reply) => {
          // A newer request for the same timeline took this one's place, and answers itself.
          if (reply.status === 'superseded') return;
          // The window moved to another session while this was out: its answer
          // would replace the new session's timelines, which are never asked for again.
          if (requestedTimelinesRef.current !== requested) return;
          const tries = (requested.tries.get(conversationId) ?? 0) + 1;
          requested.tries.set(conversationId, tries);
          const retryable = reply.status === 'busy' || (reply.status === 'unavailable' && reply.reason === 'worker_unavailable');
          const retryDelay = TIMELINE_RETRY_DELAYS_MS[tries - 1];
          if (retryable && retryDelay !== undefined) {
            const timer = setTimeout(() => {
              timelineRetryTimersRef.current.delete(timer);
              if (requestedTimelinesRef.current !== requested) return;
              requested.ids.delete(conversationId);
              setTimelineRetries((count) => count + 1);
            }, retryDelay);
            timelineRetryTimersRef.current.add(timer);
            return;
          }
          const samples = reply.status === 'ok' ? reply.samples : [];
          setTimelineState((previous) => {
            const held = previous.key === sessionId ? previous.timelines : NO_TIMELINES;
            const next = new Map(held);
            next.set(conversationId, samples);
            return { key: sessionId, timelines: next };
          });
        });
    }
  }, [enabled, conversations, sessionId, projectId, requestKey, timelineRetries]);
  const timelinesReady = !conversations || conversations.every((extent) =>
    !extent.pageable || !extent.hasTimestamps || extent.tailStartPosition <= 0 || timelines.has(extent.conversationId));

  // A jump still owed to a moment the window must hold (a column tab's opening
  // stay). The page it reads lands as the whole window; a page beside the
  // moment counts a try, so a timeline that misleads stops after a few.
  const owedTs = owedTarget?.ts ?? null;
  const owedAttempts = owedTarget?.attempts ?? 0;
  // Keyed on the tab too: a tab opened while the last one's read was out asks for itself.
  useEffect(() => {
    if (owedTs === null || !timelinesReady) return;
    const known = windowRef.current;
    const request = known?.requestForTime(owedTs) ?? null;
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = currentKey;
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
  }, [owedTs, owedAttempts, timelinesReady, currentKey, claimSlot, releaseSlot, projectId, requestKey]);

  // A search hit outside the window: the worker finds its page. Keyed on the
  // tab too, so a tab switch while the lookup ran looks it up again.
  const locateUuid = locating ? turnUuid : null;
  useEffect(() => {
    if (!locateUuid) return;
    const sequence = claimSlot('jump');
    if (sequence === null) return;
    const key = currentKey;
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
              errors: NO_EDGE_ERRORS,
              locate: done,
            };
          }
          if (reply.status === 'in_tail') {
            return { ...previous, blocks: NO_BLOCKS, anchorTs: Infinity, generation: previous.generation + 1, opening: null, locate: done };
          }
          return { ...previous, locate: done };
        });
      });
  }, [locateUuid, currentKey, claimSlot, releaseSlot, projectId, sessionId, requestKey]);

  const opening = current.opening;

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
    seekLogical,
  };
}

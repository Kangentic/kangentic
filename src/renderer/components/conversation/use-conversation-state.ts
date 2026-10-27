/**
 * The conversation viewer's state, independent of where it is hosted: the
 * transcript read, the task's Route and its tabs, history paging, the live
 * poll, Copy as Markdown, and where the view opens. `ConversationBody` draws
 * what this returns; the host (the Conversation window today) calls it, so its
 * own chrome can read the same state (the title, Copy, Jump to start).
 *
 * It reads no ambient store. The host passes the project, the anchor session,
 * the one-shot requests it holds (a tab, a turn to scroll to, the terminal
 * viewport at open) and a callback to clear each, so a host on any layer (the
 * board, the Agent Monitor, the Knowledge Graph) can mount the same body.
 *
 * The anchor is any session of the task, used only to resolve which task to
 * show: `transcripts.get` always returns that task's ENTIRE lifecycle (every
 * session it has ever accumulated, stitched into one timeline), regardless of
 * which of its sessions the anchor points at. There is deliberately no session
 * picker: which session shows is not a setting.
 *
 * Open-at-position: `initialPosition` is computed once, synchronously, the
 * moment the transcript first loads. Precedence is a scroll target the host
 * already holds (handled inside ConversationView itself, since it wins there
 * too), then a `tuiAnchor` match (the task's terminal viewport at the moment
 * the user clicked "open conversation", see `tui-anchor.ts`), then the bottom.
 *
 * Route tabs: a task whose Route (`sessions.getTaskRoute`, the same route the
 * completed task view's Route card draws) has two or more columns gets a tab
 * row, All plus one tab per column. A tab shows the slice `route-slice.ts`
 * cuts: All with a divider at each column move, a column with only its stays,
 * each opened by its date. Search and Copy follow the tab. The route is re-read
 * on every new transcript revision, so a live task's tabs follow its moves, and
 * on every tab request, which catches a move that wrote no turn. A tab request
 * (a Route pill asking for its column) switches to that column; a scroll target
 * (a search hit or a Knowledge Graph source row) switches to All, where every
 * turn is. A column an isolated session ran in carries the Split icon after its
 * name, on its tab and on its dividers in All.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useConversationPaging, type ConversationPaging } from './use-conversation-paging';
import { reconcileDisplayRows } from './display-rows';
import { matchTuiViewportToRow } from './tui-anchor';
import {
  ALL_CONVERSATION_TAB,
  columnTimeRanges,
  firstEntryOfStay,
  isolatedSwimlaneIdsFromKey,
  isolatedSwimlaneIdsKey,
  sliceConversationByRoute,
  type ConversationSlice,
} from './route-slice';
import type { ConversationViewPaging, InitialPosition } from './ConversationView';
import { transcriptToMarkdown } from '../../../shared/transcript-format';
import {
  applyTranscriptDelta,
  type ConversationTabRequest,
  type TaskReportRouteColumn,
  type TranscriptEntry,
  type TranscriptDeltaResponse,
  type TranscriptGetResponse,
  type TranscriptUnchangedResponse,
} from '../../../shared/types';

/** How often to re-fetch the transcript while its session is still live, so an
 *  open viewer follows new turns as the agent produces them. */
const LIVE_REFRESH_MS = 2500;

/** How long to wait before asking again after the first read failed. */
const READER_RETRY_MS = 5000;

const EMPTY_ROUTE: TaskReportRouteColumn[] = [];
const EMPTY_ENTRIES: TranscriptEntry[] = [];
const ALL_SELECTION: ConversationTabRequest = { swimlaneId: null };

/** The terminal viewport captured when the viewer was opened (`tui-anchor.ts`). */
export interface ConversationTuiAnchor {
  sessionId: string;
  visibleLines: string[];
}

export interface ConversationStateOptions {
  /** The project the transcript lives in: the task's own, which can differ from the open board's. */
  projectId: string | null;
  /** Any session of the task. It only resolves which task to show. */
  anchorSessionId: string;
  /**
   * Keys this viewer's history reads in the retrieval worker's queue, where a
   * newer read under the same key supersedes an older one. Two viewers mounted
   * at once need two keys.
   */
  requestKey: string;
  /**
   * A tab to show (a null swimlane is All). Compared by reference: each new
   * object switches tabs once, so the host must hold it in state or a store,
   * never build it inline on every render. The host clears it once read.
   */
  tabRequest?: ConversationTabRequest | null;
  /** A one-shot turn to scroll to. It switches to All, where every turn is. */
  scrollTarget?: string | null;
  /** Called once the view has consumed `scrollTarget`, found or not. */
  onScrollConsumed?: () => void;
  /** The terminal viewport at open. Used only when its session is the anchor. */
  tuiAnchor?: ConversationTuiAnchor | null;
  /** Called once a matching `tuiAnchor` has been read, so the host can drop it. */
  onTuiAnchorConsumed?: () => void;
  /**
   * Whether the host knows of a running or queued session for the task. Read
   * during render alongside the transcript's own status, which goes stale in
   * the gap between an isolated move suspending one session and spawning the
   * next. Omitted, only the transcript's status keeps the poll going.
   */
  isTaskLive?: (taskId: string) => boolean;
}

export interface ConversationState {
  response: TranscriptGetResponse | null;
  /** The first read for this anchor and project, and the task's first route read, have answered. */
  ready: boolean;
  taskId: string | null;
  route: ReadonlyArray<TaskReportRouteColumn>;
  /** The route has two or more columns: the body draws a tab row. */
  showTabs: boolean;
  /** The tab on screen: `ALL_CONVERSATION_TAB` or a swimlane id. */
  activeTab: string;
  /** The column whose tab is on screen, or null for All (and always null with no tab row). */
  columnOnScreen: TaskReportRouteColumn | null;
  /** The columns an isolated session ran in. */
  isolatedSwimlaneIds: ReadonlySet<string>;
  selectTab: (tab: string) => void;
  paging: ConversationPaging;
  viewPaging: ConversationViewPaging | undefined;
  slice: ConversationSlice | null;
  /** What the view shows: the tab's slice of the paged entries. */
  visibleEntries: ReadonlyArray<TranscriptEntry>;
  /** The turn to hand the view, withheld while a paged window finds its page. */
  viewScrollTarget: string | null;
  consumeScroll: () => void;
  /** Where the view opens on mount. */
  viewInitialPosition: InitialPosition;
  searchPlaceholder: string | undefined;
  /** A copy just succeeded: the brief "copied" confirmation. */
  copied: boolean;
  /** Copy the tab on screen as Markdown. */
  copyMarkdown: () => void;
}

/** What the slicing reads of a route: each column and its stays' starts. A
 *  live task's re-read changes only durations, which keeps this the same, so
 *  the held route (and the slice built from it) is kept. */
function routeSignature(route: ReadonlyArray<TaskReportRouteColumn>): string {
  return route
    .map((column) => `${column.swimlaneId}:${column.name}:${column.color}:${column.icon ?? ''}:${column.visits.map((visit) => visit.startedAt).join(',')}`)
    .join('|');
}

type TranscriptReply = TranscriptGetResponse | TranscriptUnchangedResponse | TranscriptDeltaResponse;

function isUnchangedResponse(value: TranscriptReply): value is TranscriptUnchangedResponse {
  return (value as TranscriptUnchangedResponse).unchanged === true;
}

/**
 * The response a reply leaves the viewer holding: the reply itself when it
 * is whole, the held entries patched when it is a delta against the held
 * revision, and null when it is a delta against some other revision (the
 * caller then fetches the whole conversation). An unchanged reply never
 * reaches here.
 */
function responseAfterReply(
  held: TranscriptGetResponse | null,
  reply: TranscriptGetResponse | TranscriptDeltaResponse,
): TranscriptGetResponse | null {
  if (!('delta' in reply)) return reply;
  if (!held || held.revision !== reply.baseRevision) return null;
  const { delta: _delta, baseRevision: _baseRevision, length: _length, upserts: _upserts, ...meta } = reply;
  return { ...meta, entries: applyTranscriptDelta(held.entries, reply) };
}

/**
 * Cheap fingerprint of a transcript response, so a live poll that returns
 * identical content skips the state update entirely (the common case between
 * actual new turns). This is a client-side complement to the IPC-layer
 * revision short-circuit (`knownRevision` below), which already skips the
 * full structured clone on an idle poll - kept as defense in depth in case a
 * genuinely new revision ever ships with an unchanged tail. Captures appends
 * (entry count), a streaming last turn (its content length grows in place),
 * status/degraded/source flips, and a change in which columns ran an isolated
 * session (their tabs and dividers carry its icon) - the changes that actually
 * warrant a repaint. A mid-transcript edit with an unchanged length is not detected,
 * but transcripts are append-and-stream, so that does not occur in practice. */
function transcriptSignature(response: TranscriptGetResponse | null): string {
  if (!response) return 'null';
  const count = response.entries.length;
  const last = count > 0 ? response.entries[count - 1] : null;
  let lastLength = 0;
  if (last) {
    if (last.kind === 'assistant') {
      lastLength = last.blocks.reduce((sum, block) => sum + (block.type === 'tool_use' ? 0 : block.text.length), 0);
    } else if (last.kind === 'tool_result') {
      lastLength = last.content.length;
    } else {
      lastLength = last.text.length;
    }
  }
  return `${count}:${last?.uuid ?? ''}:${last?.ts ?? 0}:${lastLength}:${response.sessionStatus ?? ''}:${response.degraded ? 1 : 0}:${response.source}:${isolatedSwimlaneIdsKey(response.sessions)}`;
}

export function useConversationState(options: ConversationStateOptions): ConversationState {
  const {
    projectId,
    anchorSessionId,
    requestKey,
    tabRequest,
    scrollTarget,
    onScrollConsumed,
    tuiAnchor,
    onTuiAnchorConsumed,
    isTaskLive,
  } = options;

  const [response, setResponse] = useState<TranscriptGetResponse | null>(null);
  // "Loading" is derived: the mount fetch for THIS anchor + project has not
  // settled. Keyed rather than a flag an effect sets (the cascading-render
  // shape the compiler rules forbid), so a change of either reads as loading
  // at once.
  const fetchKey = JSON.stringify([anchorSessionId, projectId]);
  const [settledFetchKey, setSettledFetchKey] = useState<string | null>(null);
  const loading = settledFetchKey !== fetchKey;
  const [copied, setCopied] = useState(false);

  // Mirrors `response` so the live-poll interval (armed once per live viewer,
  // not re-armed on every response update) can read the CURRENT revision at
  // each tick without stale-closure risk.
  const responseRef = useRef<TranscriptGetResponse | null>(null);
  useEffect(() => {
    responseRef.current = response;
  }, [response]);

  // Fetch the transcript on mount. The anchor only resolves WHICH task to
  // show - the response always spans that task's entire lifecycle. No
  // knownRevision on this first fetch (nothing to compare against yet), so
  // the handler always returns the full payload here.
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchWhole = (): void => {
      window.electronAPI.transcripts
        .get({ sessionId: anchorSessionId, projectId })
        .then((result) => {
          if (cancelled) return;
          // No knownRevision was sent, so the reply is whole.
          if (!isUnchangedResponse(result)) setResponse(responseAfterReply(null, result));
          setSettledFetchKey(fetchKey);
        })
        .catch(() => {
          if (cancelled) return;
          setResponse(null);
          setSettledFetchKey(fetchKey);
          // The reader (the retrieval worker) may be restarting after a
          // crash: try again while the viewer is open, so it fills in by
          // itself once the reader is back.
          retryTimer = setTimeout(fetchWhole, READER_RETRY_MS);
        });
    };
    fetchWhole();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [anchorSessionId, projectId, fetchKey]);

  const taskId = response?.taskId ?? null;
  const revision = response?.revision ?? null;

  // The task's Route, re-read on every new transcript revision so a live
  // task's tabs follow its moves, and on every tab request (`routeReadRequest`,
  // bumped below): a move that wrote no turn, such as the one into Done, leaves
  // the revision where it was, and a pill that names a column the held route
  // lacks would otherwise land on All. A failed first read leaves no tab row,
  // the viewer as it was before tabs; a failed re-read keeps the route already
  // held, so one transient failure never drops a working tab row. The held
  // route is kept while its stays are the same, so a re-read that only grew a
  // duration re-slices nothing. `readRequest` is the tab request the held
  // route answers, so a request for a column it lacks can tell a re-read still
  // on its way from a column the task never worked in.
  const [routeState, setRouteState] = useState<{ taskId: string; route: TaskReportRouteColumn[]; readRequest: number } | null>(null);
  const [routeReadRequest, setRouteReadRequest] = useState(0);
  useEffect(() => {
    if (!taskId || !projectId) return;
    let cancelled = false;
    // `route` is null for a failed read.
    const keep = (route: TaskReportRouteColumn[] | null): void => {
      if (cancelled) return;
      setRouteState((previous) => {
        const held = previous && previous.taskId === taskId ? previous : null;
        const next = route ?? held?.route ?? EMPTY_ROUTE;
        if (!held || routeSignature(held.route) !== routeSignature(next)) {
          return { taskId, route: next, readRequest: routeReadRequest };
        }
        return held.readRequest === routeReadRequest ? held : { ...held, readRequest: routeReadRequest };
      });
    };
    window.electronAPI.sessions
      .getTaskRoute(projectId, taskId)
      .then(keep)
      .catch(() => keep(null));
    return () => {
      cancelled = true;
    };
  }, [taskId, projectId, revision, routeReadRequest]);
  // Wait for the first read of this task's route before showing anything, so
  // a viewer opened on a column tab never paints All first.
  const routeLoaded = !taskId || !projectId || routeState?.taskId === taskId;
  const route = routeState && routeState.taskId === taskId ? routeState.route : EMPTY_ROUTE;
  const showTabs = route.length >= 2;

  // The tab asked for (a null swimlane is All) and, from a repeat-stay row, the
  // stay to scroll to once that tab shows. Set by the user's click on a tab, by
  // the host's tab request (applied here during render; the host clears its
  // copy), or to All for a scroll target, since All is where every turn is.
  const [selection, setSelection] = useState<ConversationTabRequest>(ALL_SELECTION);
  const [appliedTabRequest, setAppliedTabRequest] = useState<ConversationTabRequest | undefined>(undefined);
  if (tabRequest && tabRequest !== appliedTabRequest) {
    setAppliedTabRequest(tabRequest);
    setRouteReadRequest((count) => count + 1);
    setSelection(tabRequest);
  }

  const activeScrollUuid = scrollTarget ?? null;
  const [appliedScrollUuid, setAppliedScrollUuid] = useState<string | null>(null);
  if (activeScrollUuid !== appliedScrollUuid) {
    // Tracking the consumed (null) state too lets the same turn asked for again
    // switch to All again.
    setAppliedScrollUuid(activeScrollUuid);
    if (activeScrollUuid) setSelection(ALL_SELECTION);
  }

  // A column the route does not hold shows All, but only once the re-read the
  // request started has answered: until then the viewer keeps the tab it shows
  // (`shownTab`), so a pill for a column added since the last read switches once,
  // straight to that column, instead of passing through All.
  const requestedSwimlaneId = selection.swimlaneId;
  const requestedColumn = requestedSwimlaneId === null
    ? null
    : route.find((column) => column.swimlaneId === requestedSwimlaneId) ?? null;
  const awaitingColumn = requestedSwimlaneId !== null && !requestedColumn
    && routeState?.readRequest !== routeReadRequest;
  const [shownTab, setShownTab] = useState<string>(ALL_CONVERSATION_TAB);
  const shownColumn = route.find((column) => column.swimlaneId === shownTab) ?? null;
  // The column whose tab is on screen, or null for All (and always null with no tab row).
  const columnOnScreen = showTabs ? (awaitingColumn ? shownColumn : requestedColumn) : null;
  const activeTab = columnOnScreen ? columnOnScreen.swimlaneId : ALL_CONVERSATION_TAB;
  if (!awaitingColumn && shownTab !== activeTab) setShownTab(activeTab);
  // The columns an isolated session ran in, from the sessions this conversation
  // was stitched from: what ran, not what the column is set to now, which is
  // also what the Usage tab marks. Built from a key so a live poll keeps the
  // same set and the tabs it feeds.
  const isolatedKey = isolatedSwimlaneIdsKey(response?.sessions ?? []);
  const isolatedSwimlaneIds = useMemo(() => isolatedSwimlaneIdsFromKey(isolatedKey), [isolatedKey]);

  // A transcript larger than the tail pages its history (`useConversationPaging`).
  // A column tab loads only its own stays, and opens at the first one (or the
  // stay a Route row asked for), loading it first when it is not held.
  const visitStartedAt = selection.visitStartedAt;
  const timeRanges = useMemo(
    () => (activeTab === ALL_CONVERSATION_TAB ? undefined : columnTimeRanges(route, activeTab)),
    [route, activeTab],
  );
  const parsedVisitTs = requestedSwimlaneId !== null && requestedSwimlaneId === activeTab && visitStartedAt
    ? Date.parse(visitStartedAt)
    : NaN;
  const visitTs = Number.isNaN(parsedVisitTs) ? null : parsedVisitTs;
  const openingTs = timeRanges && timeRanges.length > 0 ? visitTs ?? timeRanges[0].start : null;
  const paging = useConversationPaging({
    response,
    projectId,
    sessionId: anchorSessionId,
    requestKey,
    resetKey: `${fetchKey}|${activeTab}`,
    timeRanges,
    openingTs,
    visitTs,
    turnUuid: activeScrollUuid,
  });
  const pagedEntries = paging.entries;
  // With older history not loaded, the entries start partway through: a stay
  // that began before them draws no divider (`sliceConversationByRoute`).
  const loadedFromMs = paging.window?.topHole ? pagedEntries.find((entry) => entry.ts > 0)?.ts : undefined;
  const slice = useMemo(
    () => (showTabs && response
      ? sliceConversationByRoute(pagedEntries, route, activeTab, isolatedSwimlaneIds, loadedFromMs)
      : null),
    [showTabs, response, pagedEntries, route, activeTab, isolatedSwimlaneIds, loadedFromMs],
  );
  const visibleEntries = slice?.entries ?? (response ? pagedEntries : EMPTY_ENTRIES);
  // A repeat-stay row asks for its stay's first turn; it scrolls there once the
  // slice holds it.
  const visitScrollUuid = requestedSwimlaneId !== null && visitStartedAt && slice && requestedSwimlaneId === activeTab
    ? firstEntryOfStay(slice, requestedSwimlaneId, visitStartedAt)
    : null;
  const selectTab = useCallback((tab: string) => {
    setSelection(tab === ALL_CONVERSATION_TAB ? ALL_SELECTION : { swimlaneId: tab });
  }, []);

  // Live-follow: re-fetch on an interval (no loading spinner) while EITHER the
  // latest contributing session is still running/queued, OR the host knows of
  // any live session for this task at all (`isTaskLive`). The second check is
  // load-bearing for an isolated-swimlane move: the anchor session can go
  // 'suspended' and a brand-new isolated session can spawn moments later, and
  // there is a real gap between those two events where the poll's own
  // last-fetched sessionStatus is stale (still the old, now-suspended
  // session) - without the host's check, polling would stop right there and
  // never resume, even though a new session starts seconds later. The effect
  // depends only on primitives/derived booleans, so a refresh that leaves
  // "still live" true does not re-arm the timer.
  const sessionStatus = response?.sessionStatus ?? null;
  const taskHasLiveSession = taskId && isTaskLive ? isTaskLive(taskId) : false;
  useEffect(() => {
    const live = sessionStatus === 'running' || sessionStatus === 'queued' || taskHasLiveSession;
    if (!live) return;
    let cancelled = false;
    // Set when a delta did not fit what this viewer holds: the next tick asks
    // for the whole conversation.
    let wantWhole = false;
    // One read at a time: a tick that finds the last one still out skips, so a
    // slow read (the worker busy with history pages) never stacks a second.
    let inFlight = false;
    const interval = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const held = responseRef.current;
      window.electronAPI.transcripts
        .get({
          sessionId: anchorSessionId,
          projectId,
          knownRevision: wantWhole ? undefined : held?.revision,
        })
        .then((result) => {
          if (cancelled) return;
          // Nothing changed: the reader sent only a revision.
          if (isUnchangedResponse(result)) return;
          // A delta carries only the entries that changed since the held
          // revision; unchanged ones keep their objects.
          const next = responseAfterReply(responseRef.current, result);
          if (!next) {
            wantWhole = true;
            return;
          }
          wantWhole = false;
          // Returning the SAME reference when nothing changed makes React bail
          // out of the re-render, so an idle live session does not repaint the
          // viewer every 2.5s.
          setResponse((previous) =>
            transcriptSignature(previous) === transcriptSignature(next) ? previous : next,
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }, LIVE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sessionStatus, taskHasLiveSession, anchorSessionId, projectId]);

  const copyNotice = paging.copyNotice;
  const copyMarkdown = useCallback(() => {
    if (!response) return;
    // Copies the tab on screen: a column tab copies that column's stays, each
    // opened by its date as a heading, and All copies everything. A paged
    // window copies what it holds, opened by the notice of what it leaves out.
    // Only flip to "copied" once the write actually resolves; a rejected write
    // (unfocused document / denied permission) must not falsely signal success
    // or surface as an unhandled rejection.
    void navigator.clipboard
      .writeText(transcriptToMarkdown(copyNotice ? [copyNotice, ...visibleEntries] : [...visibleEntries]))
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  }, [response, visibleEntries, copyNotice]);

  // What the view and its scrollbar read of a paged window.
  const {
    window: pagingWindow,
    topEdge,
    bottomEdge,
    onNearEdge,
    onReaderMove,
    retry: retryEdge,
    jumpToStart,
    jumpToLatest,
    seekLogical,
  } = paging;
  const viewPaging = useMemo((): ConversationViewPaging | undefined => {
    if (!pagingWindow) return undefined;
    return {
      topEdge,
      bottomEdge,
      reachesTail: pagingWindow.reachesTail,
      logicalByUuid: pagingWindow.logicalByUuid,
      logicalStart: pagingWindow.logicalStart,
      logicalEnd: pagingWindow.logicalEnd,
      logicalTotal: pagingWindow.logicalTotal,
      timeAt: pagingWindow.timeAt,
      onNearEdge,
      onReaderMove,
      onRetry: retryEdge,
      onJumpToStart: jumpToStart,
      onJumpToLatest: jumpToLatest,
      onFarSeek: seekLogical,
    };
  }, [pagingWindow, topEdge, bottomEdge, onNearEdge, onReaderMove, retryEdge, jumpToStart, jumpToLatest, seekLogical]);
  let searchPlaceholder: string | undefined;
  const columnName = columnOnScreen?.name ?? '';
  if (paging.historyUnloaded) {
    searchPlaceholder = columnOnScreen
      ? i18n._(msg`Search loaded ${{ columnName }} messages`)
      : i18n._(msg`Search loaded messages`);
  } else if (columnOnScreen) {
    searchPlaceholder = i18n._(msg`Search ${{ columnName }}`);
  }

  const consumeScroll = useCallback(() => {
    // A scroll target is the host's own one-shot, so the host clears it. With
    // none, the scroll was a repeat-stay row's, which is this viewer's state.
    if (activeScrollUuid) onScrollConsumed?.();
    else setSelection((current) => (current.visitStartedAt ? { swimlaneId: current.swimlaneId } : current));
  }, [activeScrollUuid, onScrollConsumed]);

  // The terminal viewport counts only when it was captured for this anchor.
  const matchingTuiAnchor = tuiAnchor && tuiAnchor.sessionId === anchorSessionId ? tuiAnchor : null;

  // Open-at-position: computed ONCE, synchronously, on the render where
  // `response` first becomes available - so it is ready before ConversationView
  // even mounts (avoiding the top-flash the settle-loop's visibility gate is
  // built to prevent). Held in state and set during render (React's "storing
  // information from previous renders" pattern) rather than cached in a ref,
  // which render may neither read nor write: React discards this render and
  // restarts it with the value set, so nothing commits with the fallback.
  const [cachedInitialPosition, setCachedInitialPosition] = useState<InitialPosition | null>(null);
  let initialPosition = cachedInitialPosition;
  if (initialPosition === null && response) {
    // Deliberately NOT gated on anchor.atBottom: Claude Code's TUI manages
    // in-session scrollback internally (redrawing text at a fixed cursor
    // position, printing its own "N new messages (ctrl+End)" hint) rather
    // than moving the real terminal scroll position, so xterm's own
    // viewportY/baseY reads as "at bottom" even while the user is looking at
    // an earlier turn. Matching unconditionally is safe: when the terminal
    // truly is caught up, the sampled center lines are themselves the latest
    // turn, so the match naturally lands on (or very near) the last row
    // anyway; a genuine miss (no signal in the sample) still falls back to
    // bottom exactly as before.
    if (matchingTuiAnchor) {
      const rowsForMatch = reconcileDisplayRows([], response.entries);
      const matchedUuid = matchTuiViewportToRow(matchingTuiAnchor.visibleLines, rowsForMatch);
      initialPosition = matchedUuid ? { kind: 'uuid', uuid: matchedUuid } : { kind: 'bottom' };
    } else {
      initialPosition = { kind: 'bottom' };
    }
    setCachedInitialPosition(initialPosition);
  }

  // Consume the one-shot TUI anchor exactly once, after the above has had a
  // chance to read it (a host update never invalidates the position already
  // computed this render).
  useEffect(() => {
    if (!response) return;
    if (matchingTuiAnchor) onTuiAnchorConsumed?.();
  }, [response, matchingTuiAnchor, onTuiAnchorConsumed]);

  // All opens where the viewer always has; a column tab opens at its first
  // stay; a jump opens where it landed.
  const viewInitialPosition: InitialPosition = paging.opening ?? (columnOnScreen && visibleEntries[0]
    ? { kind: 'uuid', uuid: visibleEntries[0].uuid }
    : initialPosition ?? { kind: 'bottom' });

  return {
    response,
    ready: !loading && response !== null && routeLoaded,
    taskId,
    route,
    showTabs,
    activeTab,
    columnOnScreen,
    isolatedSwimlaneIds,
    selectTab,
    paging,
    viewPaging,
    slice,
    visibleEntries,
    // A search hit in history the viewer has not loaded is held back until
    // the page holding it is.
    viewScrollTarget: paging.turnTarget ?? visitScrollUuid,
    consumeScroll,
    viewInitialPosition,
    searchPlaceholder,
    copied,
    copyMarkdown,
  };
}

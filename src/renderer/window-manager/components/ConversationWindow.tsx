/**
 * Conversation viewer, hosted inside a managed window on the board task-detail
 * layer. Its `anchor` is the Kangentic session id that opened it, used only to
 * resolve which task to show - `transcripts.get` always returns that task's
 * ENTIRE lifecycle (every session it has ever accumulated, stitched into one
 * timeline), regardless of which of its sessions the anchor points at. There
 * is deliberately no session picker: which session shows is not a setting.
 *
 * Fetches the structured transcript directly via `window.electronAPI.transcripts.get`
 * (precedent: the completed task view's `useTaskReport` calls the IPC bridge directly), renders it
 * through the pure `ConversationView`, and offers an "Open task" jump and a
 * "Copy as Markdown" export.
 *
 * The title bar reuses the same panel.* keybindings + structural-Escape pattern
 * as TaskDetailWindow (gated on `isFocused`). The in-viewer search bar is
 * always visible (ConversationView owns it, including the `conversation.find`
 * Mod+F binding that focuses it - there is no open/close state to toggle
 * here). Close routes through the frame's animated `requestClose`; the
 * conversation window bridge mirrors the closure back to clearing
 * `conversationSessionId`.
 *
 * Open-at-position: computes `initialPosition` once, synchronously, the moment
 * the transcript first loads - precedence is an already-set `scrollToTurnUuid`
 * (handled inside ConversationView itself, since it wins there too), then a
 * `pendingTuiAnchor` match (the task's terminal viewport at the moment the
 * user clicked "open conversation" - see `tui-anchor.ts`), then the bottom.
 *
 * Route tabs: a task whose Route (`sessions.getTaskRoute`, the same route the
 * completed task view's Route card draws) has two or more columns gets a tab
 * row, All plus one tab per column. A tab shows the slice `route-slice.ts`
 * cuts: All with a divider at each column move, a column with only its stays,
 * each opened by its date. Search and Copy follow the tab. The route is re-read
 * on every new transcript revision, so a live task's tabs follow its moves, and
 * on every open request, which catches a move that wrote no turn. A
 * Route pill asks for its column through `managedWindow.conversationTab`, and
 * an open window switches to it; a search hit or a Knowledge Graph source row
 * (`scrollToTurnUuid`) switches to All, where every turn is. A column an
 * isolated session ran in carries the Split icon after its name, on its tab and
 * on its dividers in All.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, X, SquareTerminal, Copy, Check, Loader2, PictureInPicture2, ArrowUpToLine } from 'lucide-react';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { MaximizeToggleButton } from '../../components/dialogs/dialog-maximize';
import { KebabMenu, KebabMenuItem } from '../../components/KebabMenu';
import { HeaderActionButton } from '../../components/HeaderActionButton';
import { Tooltip } from '../../components/Tooltip';
import { ConversationView, type ConversationViewPaging, type InitialPosition } from '../../components/conversation/ConversationView';
import { ConversationSkeleton } from '../../components/conversation/ConversationSkeleton';
import { useConversationPaging } from '../../components/conversation/use-conversation-paging';
import { reconcileDisplayRows } from '../../components/conversation/display-rows';
import { matchTuiViewportToRow } from '../../components/conversation/tui-anchor';
import {
  ALL_CONVERSATION_TAB,
  columnTimeRanges,
  firstEntryOfStay,
  isolatedSwimlaneIdsFromKey,
  isolatedSwimlaneIdsKey,
  sliceConversationByRoute,
} from '../../components/conversation/route-slice';
import { Tabs, tabIds, type TabItem } from '../../components/Tabs';
import { ColumnGlyph } from '../../utils/swimlane-icons';
import { IsolatedIcon } from '../../components/IsolatedBadge';
import { transcriptToMarkdown } from '../../../shared/transcript-format';
import { useLayerStore, useWindowManager } from '../context';
import type { ManagedWindow } from '../store/types';
import {
  applyTranscriptDelta,
  type ConversationTabRequest,
  type TaskReportRouteColumn,
  type TranscriptEntry,
  type TranscriptDeltaResponse,
  type TranscriptGetResponse,
  type TranscriptUnchangedResponse,
} from '../../../shared/types';

interface ConversationWindowProps {
  managedWindow: ManagedWindow;
  isFocused: boolean;
  isMaximized: boolean;
  titleBarPointerDown: (event: React.PointerEvent) => void;
  requestClose: () => void;
}

/** How often to re-fetch the transcript while its session is still live, so an
 *  open viewer follows new turns as the agent produces them. */
const LIVE_REFRESH_MS = 2500;

/** How long to wait before asking again after the first read failed. */
const READER_RETRY_MS = 5000;

const EMPTY_ROUTE: TaskReportRouteColumn[] = [];
const EMPTY_ENTRIES: TranscriptEntry[] = [];
const TAB_ID_PREFIX = 'conversation-route';
const ALL_SELECTION: ConversationTabRequest = { swimlaneId: null };

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
 * The response a reply leaves the window holding: the reply itself when it
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
  let lastLen = 0;
  if (last) {
    if (last.kind === 'assistant') {
      lastLen = last.blocks.reduce((sum, block) => sum + (block.type === 'tool_use' ? 0 : block.text.length), 0);
    } else if (last.kind === 'tool_result') {
      lastLen = last.content.length;
    } else {
      lastLen = last.text.length;
    }
  }
  return `${count}:${last?.uuid ?? ''}:${last?.ts ?? 0}:${lastLen}:${response.sessionStatus ?? ''}:${response.degraded ? 1 : 0}:${response.source}:${isolatedSwimlaneIdsKey(response.sessions)}`;
}

// Controls whose own click/drag must win over a window drag or maximize toggle
// (mirrors TaskDetailWindow's selector).
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="menuitem"], [contenteditable="true"], [data-no-drag]';

/** HeaderActionButton takes an icon COMPONENT, not a pre-rendered element, so the
 *  brief "copied" confirmation (green check, same as the kebab twin) is its own
 *  tiny component rather than an inline conditional element. */
function CopiedCheckIcon({ size }: { size?: number }) {
  return <Check size={size} className="text-green-400" />;
}

function isInteractiveTarget(event: React.PointerEvent | React.MouseEvent): boolean {
  const interactive = (event.target as HTMLElement).closest(INTERACTIVE_SELECTOR);
  return !!interactive && (event.currentTarget as HTMLElement).contains(interactive);
}

export function ConversationWindow({
  managedWindow,
  isFocused,
  isMaximized,
  titleBarPointerDown,
  requestClose,
}: ConversationWindowProps) {
  const openProjectId = useProjectStore((state) => state.currentProject?.id ?? null);
  // A window the Knowledge Graph opened from another project's island reads its
  // transcript from THAT project; every other window reads the open one.
  const currentProjectId = managedWindow.projectId ?? openProjectId;
  const scrollToTurnUuid = useSessionStore((state) => state.scrollToTurnUuid);
  const setScrollToTurnUuid = useSessionStore((state) => state.setScrollToTurnUuid);
  const conversationSessionId = useSessionStore((state) => state.conversationSessionId);
  const pendingTuiAnchor = useSessionStore((state) => state.pendingTuiAnchor);
  const setPendingTuiAnchor = useSessionStore((state) => state.setPendingTuiAnchor);
  const sessions = useSessionStore((state) => state.sessions);

  // Whether THIS layer can put a task detail somewhere the user will see it. The
  // board supplies the route, and so does the in-app Knowledge Graph (it closes
  // the graph first); the detached graph does not (see
  // `WindowManagerLayerOptions.revealTaskDetail`), so "Open task" hides there
  // rather than doing nothing at all.
  const { layer } = useWindowManager();
  const revealTaskDetail = layer.revealTaskDetail;

  const layerStore = useLayerStore();
  const toggleMaximizeWindow = layerStore((state) => state.toggleMaximizeWindow);
  const untileWindow = layerStore((state) => state.untileWindow);
  const isTiled = layerStore((state) => state.windows[managedWindow.id]?.state === 'tiled');

  const [response, setResponse] = useState<TranscriptGetResponse | null>(null);
  // "Loading" is derived: the mount fetch for THIS anchor + project has not
  // settled. Keyed rather than a flag an effect sets (the cascading-render
  // shape the compiler rules forbid), so a change of either reads as loading
  // at once.
  const fetchKey = JSON.stringify([managedWindow.anchor, currentProjectId]);
  const [settledFetchKey, setSettledFetchKey] = useState<string | null>(null);
  const loading = settledFetchKey !== fetchKey;
  const [copied, setCopied] = useState(false);
  const [isHovering, setIsHovering] = useState(false);

  // Auto-follow new turns only when the user is neither focused on nor
  // hovering this window - otherwise a live poll would yank them away from
  // whatever part of the transcript they are reading.
  const autoFollowNewMessages = !isFocused && !isHovering;

  // Mirrors `response` so the live-poll interval (armed once per live window,
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
        .get({ sessionId: managedWindow.anchor, projectId: currentProjectId })
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
          // crash: try again while the window is open, so it fills in by
          // itself once the reader is back.
          retryTimer = setTimeout(fetchWhole, READER_RETRY_MS);
        });
    };
    fetchWhole();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [managedWindow.anchor, currentProjectId, fetchKey]);

  const taskId = response?.taskId ?? null;
  const revision = response?.revision ?? null;

  // The task's Route, re-read on every new transcript revision so a live
  // task's tabs follow its moves, and on every open request (`routeReadRequest`,
  // bumped below): a move that wrote no turn, such as the one into Done, leaves
  // the revision where it was, and a pill that names a column the held route
  // lacks would otherwise land on All. A failed first read leaves no tab row,
  // the window as it was before tabs; a failed re-read keeps the route already
  // held, so one transient failure never drops a working tab row. The held
  // route is kept while its stays are the same, so a re-read that only grew a
  // duration re-slices nothing. `readRequest` is the open request the held
  // route answers, so a request for a column it lacks can tell a re-read still
  // on its way from a column the task never worked in.
  const [routeState, setRouteState] = useState<{ taskId: string; route: TaskReportRouteColumn[]; readRequest: number } | null>(null);
  const [routeReadRequest, setRouteReadRequest] = useState(0);
  useEffect(() => {
    if (!taskId || !currentProjectId) return;
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
      .getTaskRoute(currentProjectId, taskId)
      .then(keep)
      .catch(() => keep(null));
    return () => {
      cancelled = true;
    };
  }, [taskId, currentProjectId, revision, routeReadRequest]);
  // Wait for the first read of this task's route before showing anything, so
  // a window opened on a column tab never paints All first.
  const routeLoaded = !taskId || !currentProjectId || routeState?.taskId === taskId;
  const route = routeState && routeState.taskId === taskId ? routeState.route : EMPTY_ROUTE;
  const showTabs = route.length >= 2;

  // The tab asked for (a null swimlane is All) and, from a repeat-stay row, the
  // stay to scroll to once that tab shows. Set by the user's click on a tab, by
  // a Route pill's open request (`managedWindow.conversationTab`, applied here
  // during render and cleared from the store in an effect), or to All for a
  // scroll-to-turn request, since All is where every turn is.
  const [selection, setSelection] = useState<ConversationTabRequest>(ALL_SELECTION);
  const tabRequest = managedWindow.conversationTab;
  const [appliedTabRequest, setAppliedTabRequest] = useState<ConversationTabRequest | undefined>(undefined);
  if (tabRequest && tabRequest !== appliedTabRequest) {
    setAppliedTabRequest(tabRequest);
    setRouteReadRequest((count) => count + 1);
    setSelection(tabRequest);
  }
  const clearConversationTab = layerStore((state) => state.clearConversationTab);
  useEffect(() => {
    if (tabRequest) clearConversationTab(managedWindow.id);
  }, [tabRequest, clearConversationTab, managedWindow.id]);

  const windowScrollTarget = managedWindow.scrollToTurnUuid;
  // Only this window (the one the signal points at) consumes the one-shot scroll,
  // so a second open conversation window never races to clear it.
  const activeScrollUuid = windowScrollTarget
    ?? (managedWindow.anchor === conversationSessionId ? scrollToTurnUuid : null);
  const [appliedScrollUuid, setAppliedScrollUuid] = useState<string | null>(null);
  if (activeScrollUuid !== appliedScrollUuid) {
    // Tracking the consumed (null) state too lets the same turn asked for again
    // switch to All again.
    setAppliedScrollUuid(activeScrollUuid);
    if (activeScrollUuid) setSelection(ALL_SELECTION);
  }

  // A column the route does not hold shows All, but only once the re-read the
  // request started has answered: until then the window keeps the tab it shows
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
    projectId: currentProjectId,
    sessionId: managedWindow.anchor,
    windowId: managedWindow.id,
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
  const tabItems = useMemo<Array<TabItem<string>>>(
    () => [
      { id: ALL_CONVERSATION_TAB, label: 'All' },
      ...route.map((column) => ({
        id: column.swimlaneId,
        label: column.name,
        icon: <ColumnGlyph column={column} size={14} color={column.color} />,
        badge: isolatedSwimlaneIds.has(column.swimlaneId) ? <IsolatedIcon size={13} explained /> : undefined,
      })),
    ],
    [route, isolatedSwimlaneIds],
  );
  const handleSelectTab = useCallback((tab: string) => {
    setSelection(tab === ALL_CONVERSATION_TAB ? ALL_SELECTION : { swimlaneId: tab });
  }, []);

  // Live-follow: re-fetch on an interval (no loading spinner) while EITHER the
  // latest contributing session is still running/queued, OR the reactive
  // session store shows any live session for this task at all. The second
  // check is load-bearing for an isolated-swimlane move: the anchor session
  // can go 'suspended' and a brand-new isolated session can spawn moments
  // later, and there is a real gap between those two events where the poll's
  // own last-fetched sessionStatus is stale (still the old, now-suspended
  // session) - without the store check, polling would stop right there and
  // never resume, even though a new session starts seconds later. The effect
  // depends only on primitives/derived booleans, so a refresh that leaves
  // "still live" true does not re-arm the timer.
  const sessionStatus = response?.sessionStatus ?? null;
  const taskHasLiveSession = taskId
    ? sessions.some((session) => session.taskId === taskId && (session.status === 'running' || session.status === 'queued'))
    : false;
  useEffect(() => {
    const live = sessionStatus === 'running' || sessionStatus === 'queued' || taskHasLiveSession;
    if (!live) return;
    let cancelled = false;
    // Set when a delta did not fit what this window holds: the next tick asks
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
          sessionId: managedWindow.anchor,
          projectId: currentProjectId,
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
  }, [sessionStatus, taskHasLiveSession, managedWindow.anchor, currentProjectId]);

  const copyNotice = paging.copyNotice;
  const handleCopyMarkdown = useCallback(() => {
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
    seeking,
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
      seeking,
    };
  }, [pagingWindow, topEdge, bottomEdge, onNearEdge, onReaderMove, retryEdge, jumpToStart, jumpToLatest, seekLogical, seeking]);
  let searchPlaceholder: string | undefined;
  if (paging.historyUnloaded) {
    searchPlaceholder = columnOnScreen ? `Search loaded ${columnOnScreen.name} messages` : 'Search loaded messages';
  } else if (columnOnScreen) {
    searchPlaceholder = `Search ${columnOnScreen.name}`;
  }

  const handleOpenTask = useCallback(() => {
    // A window opened from another project's island names that project, so the
    // task opens there rather than being looked up on the open board.
    if (taskId) revealTaskDetail?.(taskId, managedWindow.projectId);
  }, [taskId, revealTaskDetail, managedWindow.projectId]);

  /** Both "Open task" affordances gate on this: a real task AND a layer that can
   *  actually show it. */
  const canOpenTask = taskId !== null && revealTaskDetail !== undefined;

  const clearWindowScrollTarget = layerStore((state) => state.clearWindowScrollTarget);
  const consumeScroll = useCallback(() => {
    // A per-window target (the Knowledge Graph's source rows) is this window's
    // own; the session-store one-shot belongs to the board's bridge. With
    // neither, the scroll was a repeat-stay row's, which is this window's state.
    if (windowScrollTarget) clearWindowScrollTarget(managedWindow.id);
    else if (activeScrollUuid) setScrollToTurnUuid(null);
    else setSelection((current) => (current.visitStartedAt ? { swimlaneId: current.swimlaneId } : current));
  }, [windowScrollTarget, activeScrollUuid, clearWindowScrollTarget, managedWindow.id, setScrollToTurnUuid]);

  const handleToggleMaximized = useCallback(() => toggleMaximizeWindow(managedWindow.id), [toggleMaximizeWindow, managedWindow.id]);
  const handleUndock = useCallback(() => untileWindow(managedWindow.id), [untileWindow, managedWindow.id]);

  // Task-detail parity keybindings (capture phase, gated on focus). No new
  // registry entries for maximize/close: reuse panel.maximize / panel.close.
  // conversation.find is registered inside ConversationView itself, which
  // owns the always-visible search bar it focuses.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true, enabled: isFocused });
  useKeybinding('panel.close', requestClose, { capture: true, enabled: isFocused });

  // Structural Escape (keybindings-registry exception, like BaseDialog /
  // TaskDetailWindow): bubble-phase, gated on focus. The search bar has no
  // open/close state to special-case here - Escape always closes the window
  // (the search input's own Escape handler stops propagation before this
  // listener sees it, so typing Escape while focused in search just blurs it).
  useEffect(() => {
    if (!isFocused) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      requestClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isFocused, requestClose]);

  const onTitleBarPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0 || isInteractiveTarget(event)) return;
    titleBarPointerDown(event);
  }, [titleBarPointerDown]);

  const onTitleBarDoubleClick = useCallback((event: React.MouseEvent) => {
    if (isInteractiveTarget(event)) return;
    handleToggleMaximized();
  }, [handleToggleMaximized]);

  const taskTitle = response?.taskTitle || 'Session';
  const agentName = response?.agentName ?? '';

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
    const anchor =
      pendingTuiAnchor && pendingTuiAnchor.sessionId === managedWindow.anchor ? pendingTuiAnchor : null;
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
    if (anchor) {
      const rowsForMatch = reconcileDisplayRows([], response.entries);
      const matchedUuid = matchTuiViewportToRow(anchor.visibleLines, rowsForMatch);
      initialPosition = matchedUuid ? { kind: 'uuid', uuid: matchedUuid } : { kind: 'bottom' };
    } else {
      initialPosition = { kind: 'bottom' };
    }
    setCachedInitialPosition(initialPosition);
  }

  // Consume the one-shot pendingTuiAnchor exactly once, after the above has
  // had a chance to read it (a store update never invalidates the ref already
  // computed this render).
  useEffect(() => {
    if (!response) return;
    const anchor =
      pendingTuiAnchor && pendingTuiAnchor.sessionId === managedWindow.anchor ? pendingTuiAnchor : null;
    if (anchor) setPendingTuiAnchor(null);
  }, [response, pendingTuiAnchor, managedWindow.anchor, setPendingTuiAnchor]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden"
      data-testid="conversation-window"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        className="border-b border-edge flex-shrink-0 select-none"
        data-testid="conversation-titlebar"
        onPointerDown={onTitleBarPointerDown}
        onDoubleClick={onTitleBarDoubleClick}
      >
        <div className="flex items-center gap-2 px-4 py-3 min-w-0">
          <MessageSquare size={15} className="flex-shrink-0 text-fg-muted" />
          <div className="min-w-0 flex-1">
            {/* Just the task title. Agent name and timestamp now live on each
                message (pill + per-message time), so the header stays minimal. */}
            <div className="text-sm font-semibold text-fg truncate" data-testid="conversation-title">
              {taskTitle}
            </div>
          </div>

          {/* Promoted from kebab-only to visible icon buttons (shared component,
              matching TaskDetailHeader's header row): common enough in a
              read-only viewer to earn a one-tap affordance rather than living only
              behind "...". The kebab entries stay too (same pill+kebab redundancy
              TaskDetailHeader uses for "View conversation"). Search has no toggle
              button here - it is always visible inside ConversationView. */}
          {canOpenTask && (
            <HeaderActionButton
              icon={SquareTerminal}
              onClick={handleOpenTask}
              tip="Open task"
              testId="conversation-open-task-button"
            />
          )}
          <HeaderActionButton
            icon={copied ? CopiedCheckIcon : Copy}
            onClick={handleCopyMarkdown}
            disabled={!response}
            tip="Copy conversation as Markdown"
            ariaLabel="Copy conversation"
            testId="conversation-copy-markdown-button"
          />

          <KebabMenu>
            {(close) => (
              <>
                {canOpenTask && (
                  <KebabMenuItem
                    icon={<SquareTerminal size={13} />}
                    label="Open task"
                    onClick={() => {
                      handleOpenTask();
                      close();
                    }}
                    data-testid="conversation-open-task"
                  />
                )}
                <KebabMenuItem
                  icon={copied ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
                  label="Copy conversation"
                  onClick={() => {
                    handleCopyMarkdown();
                    close();
                  }}
                  disabled={!response}
                  data-testid="conversation-copy-markdown"
                />
                {paging.enabled && (
                  <KebabMenuItem
                    icon={<ArrowUpToLine size={13} />}
                    label="Jump to start"
                    onClick={() => {
                      jumpToStart();
                      close();
                    }}
                    data-testid="conversation-jump-to-start"
                  />
                )}
              </>
            )}
          </KebabMenu>

          <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
          {isTiled && (
            <Tooltip label="Float this window out of the tiled layout">
              <button
                type="button"
                onClick={handleUndock}
                aria-label="Pop out"
                data-testid={`conversation-undock-${managedWindow.id}`}
                className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
              >
                <PictureInPicture2 size={16} />
              </button>
            </Tooltip>
          )}
          <MaximizeToggleButton
            isMaximized={isMaximized}
            onToggle={handleToggleMaximized}
            testId={`conversation-maximize-${managedWindow.id}`}
          />
          <Tooltip label="Close window" keys="panel.close">
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close window"
              data-testid="conversation-close"
              className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      {loading || !response || !routeLoaded ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-fg-muted" />
        </div>
      ) : (
        <>
          {showTabs && (
            <Tabs
              tabs={tabItems}
              selectedId={activeTab}
              onSelect={handleSelectTab}
              ariaLabel="Conversation sections"
              idPrefix={TAB_ID_PREFIX}
              fit="icons-then-scroll"
              testId="conversation-route-tabs"
            />
          )}
          {/* One view at one position, tab row or not, so a live task's first
              move (one column to two) adds the tab row above the conversation
              without remounting it. */}
          <div
            role={showTabs ? 'tabpanel' : undefined}
            id={showTabs ? tabIds(TAB_ID_PREFIX, activeTab).panelId : undefined}
            aria-labelledby={showTabs ? tabIds(TAB_ID_PREFIX, activeTab).tabId : undefined}
            className="flex min-h-0 flex-1 flex-col"
          >
            {paging.jumping ? (
              // A jump is reading the page it lands on: placeholder rows, with
              // the moment it is headed for when it knows one.
              <ConversationSkeleton labelTs={paging.jumpLabelTs} className="min-h-0 flex-1" />
            ) : columnOnScreen && visibleEntries.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="conversation-route-empty">
                <MessageSquare size={24} className="text-fg-disabled" />
                <div className="text-sm font-semibold text-fg-tertiary">No conversation in {columnOnScreen.name}</div>
                <div className="text-sm text-fg-muted">The agent did not run while the task was in {columnOnScreen.name}.</div>
              </div>
            ) : (
              <ConversationView
                // A tab is its own list: switching remounts the view so it opens
                // at that tab's own position rather than the last tab's scroll.
                // A jump that replaced a paged window's rows remounts it too.
                key={`${activeTab}:${paging.generation}`}
                entries={visibleEntries}
                degraded={response.degraded}
                source={response.source}
                unavailableReason={response.unavailableReason}
                agentName={agentName}
                archivedAgentName={response.archivedAgentName ?? null}
                // A search hit in history the window has not loaded is held
                // back until the page holding it is.
                scrollToTurnUuid={paging.turnTarget ?? visitScrollUuid}
                onConsumedScroll={consumeScroll}
                autoFollowNewMessages={autoFollowNewMessages}
                // All opens where the window always has; a column tab opens at
                // its first stay; a jump opens where it landed.
                initialPosition={paging.opening ?? (columnOnScreen && visibleEntries[0]
                  ? { kind: 'uuid', uuid: visibleEntries[0].uuid }
                  : initialPosition ?? { kind: 'bottom' })}
                isFocused={isFocused}
                dividerColumns={slice?.dividerColumns}
                isolatedDividers={slice?.isolatedDividers}
                searchPlaceholder={searchPlaceholder}
                paging={viewPaging}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

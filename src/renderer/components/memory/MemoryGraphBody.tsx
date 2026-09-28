/**
 * Memory Graph body: the map, its floating controls, and its states.
 *
 * Shared by both hosts (the in-app overlay and the detached pop-out) so they
 * cannot drift, and lazy-loaded by `LazyMemoryGraph` - which is load-bearing
 * beyond bundle size now that three.js lives behind it: `PopOutMemoryRoot` is
 * statically reachable from the renderer entry via the pop-out surface registry,
 * so anything it imports eagerly would drag three into the startup path.
 * `scripts/build.js`'s `assertVendorChunksLazy` fails the build if that happens.
 *
 * The map is FULL-BLEED and the chrome floats over it. That is a deliberate
 * inversion of the earlier layout, where a coverage strip, a search row and a
 * control strip stacked above the canvas and took a third of the height before
 * anything was drawn. A spatial view is the content; the controls are an overlay
 * on it.
 *
 * Four states this must get right, because each looks like a bug if presented as
 * an empty map: no project open, semantic search off, a first build in progress
 * (minutes on a large corpus), and a genuinely empty index. Only the last is
 * really "nothing here".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Compass, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useConfigStore } from '../../stores/config-store';
import { MemoryChat } from './MemoryChat';
import { MemoryCoverageStrip } from './MemoryCoverageStrip';
import { MemoryGraphCanvas, type MemoryGraphColorMode } from './MemoryGraphCanvas';
import type { RememberedCamera } from './useMemoryGraphScene';
import {
  MemoryGraphControls,
  EMPTY_FACETS,
  NO_FACETS_AVAILABLE,
  TIME_WINDOW_DAYS,
  OUTCOME_ORDER,
  facetsAreEmpty,
  type MemoryGraphFacets,
  type FacetAvailability,
} from './MemoryGraphControls';

import { availableGranularities, DEFAULT_GRANULARITY, resolveClustering } from './active-clustering';
import { availableColorModes } from './color-mode-availability';
import { answerFocusIndices } from './answer-focus';
import { answerSetupGap, resolveAnswerAgent } from '../../../shared/answer-agent';
import { HoverTip } from '../HoverTip';
import type { MemoryGraphGranularity, MemoryRelatedTask } from '../../../shared/types';
import { useChromeInsets } from './useChromeInsets';
import { MemoryNodeDetail, openConversationForNode } from './MemoryNodeDetail';
import { openMemoryConversation } from './open-memory-conversation';
import { useGraphView } from './use-graph-view';
import { MemoryProjectsPicker } from './MemoryProjectsPicker';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Neighbours listed in the detail panel. Enough to be useful, short enough to
 *  read without scrolling. */
const DETAIL_NEIGHBOR_COUNT = 6;

/** Below this many conversations, an answer's own nodes also take the white ring. */
const FEW_LIT = 3;
/** A related task's strength is scaled by this in the one answered map that
 *  still shows the related set: an answer whose tasks have no node of their own. */
const RELATED_AFTER_ANSWER = 0.3;

function CenteredNotice({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-8">
      <div className="max-w-md text-center">
        <div className="flex justify-center text-fg-muted mb-3" aria-hidden>{icon}</div>
        <div className="text-sm font-semibold text-fg mb-1">{title}</div>
        <p className="text-sm text-fg-muted">{body}</p>
      </div>
    </div>
  );
}

interface MemoryGraphBodyProps {
  /** See `LazyMemoryGraph`: where a question goes before an agent is chosen. */
  onChooseAnswerAgent?: () => void;
  /** See `LazyMemoryGraph`: how a row with no conversation reaches its task. */
  onRevealTask?: (taskId: string, projectId?: string) => void;
  /** See `LazyMemoryGraph`: the Index flyout's way to Settings > Search. */
  onOpenSettings?: () => void;
}

export function MemoryGraphBody({ onChooseAnswerAgent, onRevealTask, onOpenSettings }: MemoryGraphBodyProps) {
  // The open project's snapshot, or several projects composed into islands.
  const graphView = useGraphView();
  const snapshot = graphView.snapshot;
  const projects = useMemoryGraphStore((state) => state.projects);
  const scopeProjectIds = useMemoryGraphStore((state) => state.scopeProjectIds);
  const setScope = useMemoryGraphStore((state) => state.setScope);
  const loaded = useMemoryGraphStore((state) => state.loaded);
  const projectId = useMemoryGraphStore((state) => state.projectId);
  const thread = useMemoryGraphStore((state) => state.thread);
  const focusedTurnId = useMemoryGraphStore((state) => state.focusedTurnId);
  const askQuestion = useMemoryGraphStore((state) => state.askQuestion);
  const retryTurn = useMemoryGraphStore((state) => state.retryTurn);
  const focusTurn = useMemoryGraphStore((state) => state.focusTurn);
  const endChat = useMemoryGraphStore((state) => state.endChat);
  /**
   * The camera as the last map left it, so the next map in this visit (a
   * project added to or taken out of the scope, a finished pass) flies from
   * there instead of cutting to its framing. Held here rather than in the
   * canvas, which unmounts while a scope's maps are all still building.
   */
  const cameraMemory = useRef<RememberedCamera | null>(null);

  /**
   * Who answers, and what is still missing before anyone can, through the SAME
   * rule the main process uses, so the box can never send the user to settings
   * for a question main would have run, or run one the settings row does not
   * show. Gated on the CAPABILITY rather than on any agent's name
   * (`.claude/rules/agent-adapters-boundary.md`).
   *
   * Explicit: the configured agent and model, with no fallback to the project's
   * agent or to any capable one. `requireFound` here and not in main: this list
   * carries a detection flag, and an agent that is not installed is not chosen.
   */
  const agentList = useConfigStore((state) => state.agentList);
  const configuredAnswerAgent = useConfigStore((state) => state.config.memory?.answerAgent ?? null);
  const configuredAnswerModel = useConfigStore((state) => state.config.memory?.answerModel ?? null);
  const setupGap = useMemo(
    () => answerSetupGap({
      agents: agentList,
      configured: configuredAnswerAgent,
      configuredModel: configuredAnswerModel,
      requireFound: true,
    }),
    [agentList, configuredAnswerAgent, configuredAnswerModel],
  );
  const askAgentLabel = useMemo(
    () => resolveAnswerAgent({ agents: agentList, configured: configuredAnswerAgent, requireFound: true })?.displayName
      ?? 'the agent',
    [agentList, configuredAnswerAgent],
  );
  // Shown only in a host with no settings panel to open (the detached window),
  // and only once Enter was pressed, so the map is never covered by a notice.
  const [showSetupHint, setShowSetupHint] = useState(false);

  const queryText = useMemoryGraphStore((state) => state.draftQuestion);
  const setQueryText = useMemoryGraphStore((state) => state.setDraftQuestion);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [showEdges, setShowEdges] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showTitles, setShowTitles] = useState(true);
  const [colorMode, setColorMode] = useState<MemoryGraphColorMode>('cluster');
  /**
   * How finely the map is cut. All three carve-ups ship with the projection,
   * so this is a lookup rather than a rebuild - which is the only reason it is
   * a display control at all.
   */
  const [granularity, setGranularity] = useState<MemoryGraphGranularity>(DEFAULT_GRANULARITY);
  const [facets, setFacets] = useState<MemoryGraphFacets>(EMPTY_FACETS);
  /**
   * "Explore from here": the map scoped to one conversation and its exact links.
   *
   * The step the surface was missing. After a search narrowed the map you could
   * select a node and then had nowhere to go - the panel listed neighbours but
   * the MAP still showed the query's results, so following a neighbour meant
   * losing your place. This makes the neighbourhood itself the new scope.
   */
  const [exploreFromIndex, setExploreFromIndex] = useState<number | null>(null);
  /**
   * Where the detail panel was reached FROM, innermost last.
   *
   * Following a neighbour replaces the panel, so without a trail there is no way
   * back to what you were reading - you have to recognise it in some other list.
   * Only neighbour hops push; picking a node on the map or in the results is a
   * fresh entry point and clears the trail, because a "back" that returns to an
   * unrelated branch is worse than no back at all.
   */
  const [detailTrail, setDetailTrail] = useState<number[]>([]);
  /**
   * "Now" for the time facets, fixed when the surface mounts.
   *
   * The windows are days wide, so a clock read once per open is exact enough,
   * and a ticking one would hand every facet memo a new identity on each tick
   * for nothing. Read in a lazy initializer because render must stay pure.
   */
  const [nowMs] = useState(() => Date.now());

  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /**
   * Which part of the canvas is clear of the floating panels.
   *
   * Keyed on what MOUNTS a panel rather than on a resize: opening the rail
   * changes nothing an observer would see, and it is the single largest change
   * to the visible pane this surface can make.
   */
  const chatOpen = thread.length > 0;
  const chromeInsets = useChromeInsets(
    surfaceRef,
    // The chat panel mounts with the first question, so the key moves with it.
    `${selectedIndex !== null}:${chatOpen}`,
  );

  /** The turn whose tasks the map shows: the one the reader picked, or the latest. */
  const activeTurn = useMemo(
    () => thread.find((turn) => turn.id === focusedTurnId) ?? thread[thread.length - 1] ?? null,
    [thread, focusedTurnId],
  );

  // A new question replaces any neighbourhood being explored rather than
  // compounding with it. Adjusted during render on the transition, React's
  // documented pattern for state that resets when an input changes.
  const [turnSeen, setTurnSeen] = useState(activeTurn?.id ?? null);
  if ((activeTurn?.id ?? null) !== turnSeen) {
    setTurnSeen(activeTurn?.id ?? null);
    setExploreFromIndex(null);
  }

  const nodes = snapshot?.projection?.nodes;

  /** A fresh entry point: select, and drop the trail. */
  const selectNode = useCallback((index: number | null) => {
    setSelectedIndex(index);
    setDetailTrail([]);
  }, []);

  /** A hop along a link: remember where we came from. */
  const followNeighbor = useCallback((index: number) => {
    setSelectedIndex((current) => {
      if (current !== null) setDetailTrail((trail) => [...trail, current]);
      return index;
    });
  }, []);

  const goBack = useCallback(() => {
    setDetailTrail((trail) => {
      if (trail.length === 0) return trail;
      setSelectedIndex(trail[trail.length - 1]);
      return trail.slice(0, -1);
    });
  }, []);

  const indexByDocKey = useMemo(() => {
    const map = new Map<string, number>();
    nodes?.forEach((node, index) => map.set(node.docKey, index));
    return map;
  }, [nodes]);

  /** The explored node plus everything it links to. */
  const exploreIndices = useMemo(() => {
    if (exploreFromIndex === null || !snapshot?.projection) return null;
    // Same source as the panel's neighbour list, so "explore from here" scopes
    // the map to exactly the conversations the panel just named. Reading the
    // pruned mesh instead made the two disagree.
    const set = new Set<number>([exploreFromIndex]);
    for (const entry of snapshot.projection.nodeNeighbors?.[exploreFromIndex] ?? []) {
      set.add(entry.index);
    }
    return set;
  }, [exploreFromIndex, snapshot]);

  /**
   * Which filter segments can narrow this corpus.
   *
   * A segment that could only return what "Any" returns is disabled with its
   * reason, so each one is measured rather than assumed. Time is the one that
   * is not simply "is the field populated": if every conversation falls inside
   * the NARROWEST window then all four options select identically, despite
   * every timestamp being present. A status is the same when every node has it.
   */
  const facetAvailability = useMemo<FacetAvailability>(() => {
    if (!nodes || nodes.length === 0) return NO_FACETS_AVAILABLE;
    const narrowestCutoff = nowMs - TIME_WINDOW_DAYS['7d'] * DAY_MS;
    const outcomeCounts = new Map<string, number>();
    let hasOlderThanNarrowest = false;
    for (const node of nodes) {
      if (node.outcome) outcomeCounts.set(node.outcome, (outcomeCounts.get(node.outcome) ?? 0) + 1);
      if (node.lastActivityMs !== null && node.lastActivityMs < narrowestCutoff) {
        hasOlderThanNarrowest = true;
      }
    }
    // In a fixed display order, whatever order the corpus yielded.
    const presentOutcomes = OUTCOME_ORDER.filter((outcome) => outcomeCounts.has(outcome));
    return {
      since: hasOlderThanNarrowest,
      outcomes: presentOutcomes.filter((outcome) => outcomeCounts.get(outcome) !== nodes.length),
      presentOutcomes,
    };
  }, [nodes, nowMs]);

  // A selection can outlive the option that offered it - switch to a project
  // where nothing was abandoned and the scope would silently hold at zero on a
  // segment that is now disabled. Healed during render, so no frame ever
  // commits the dead scope.
  if (facets.outcome !== 'any' && !facetAvailability.outcomes.includes(facets.outcome)) {
    setFacets((current) => ({ ...current, outcome: 'any' }));
  }
  if (facets.since !== 'any' && !facetAvailability.since) {
    setFacets((current) => ({ ...current, since: 'any' }));
  }

  // A rebuild re-clusters from scratch, so region 4 in the old projection is not
  // region 4 in the new one. Carrying the old exclusions across would hide an
  // arbitrary area the user never chose, with a panel that agrees it is hidden
  // and no way to tell it is wrong. Cleared on a signature change instead.
  const projectionSignature = snapshot?.projection?.signature ?? null;
  const [signatureSeen, setSignatureSeen] = useState(projectionSignature);
  if (projectionSignature !== signatureSeen) {
    setSignatureSeen(projectionSignature);
    setFacets((current) =>
      current.hiddenRegions.size === 0 ? current : { ...current, hiddenRegions: new Set() },
    );
  }

  /** Which detail settings this corpus can actually express - often only one,
   *  in which case the control does not render. */
  const grainOptions = useMemo(
    () => availableGranularities(snapshot?.projection),
    [snapshot],
  );

  /**
   * A selection can outlive the corpus that offered it: switch to a project
   * whose index is too small to cut three ways and "Fine" is still selected with
   * no control left on screen to explain it. Heal back to the default, the same
   * way a stale outcome filter does.
   */
  if (grainOptions.length > 0 && !grainOptions.includes(granularity)) {
    setGranularity(DEFAULT_GRANULARITY);
  }

  const clustering = useMemo(
    () => resolveClustering(snapshot?.projection ?? { clusterings: [] }, granularity),
    [snapshot, granularity],
  );

  /**
   * The map's regions, with how many conversations each holds.
   *
   * Counted from the NODES rather than read off `cluster.size`, so the number
   * beside a region is the number of points the user can actually see in it.
   */
  const regions = useMemo(() => {
    if (clustering.regions.length === 0) return [];
    const counts = new Map<number, number>();
    for (const node of nodes ?? []) {
      const region = clustering.regionOf(node);
      counts.set(region, (counts.get(region) ?? 0) + 1);
    }
    // Named by project when the map holds several, so the list groups.
    const projectNames = graphView.regionProjectNames?.[granularity];
    return clustering.regions.map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      count: counts.get(cluster.id) ?? 0,
      ...(projectNames?.[cluster.id] ? { group: projectNames[cluster.id] } : {}),
    }));
  }, [clustering, nodes, graphView.regionProjectNames, granularity]);

  /** Node indices surviving the facet rows, or null when nothing is scoped. */
  const facetIndices = useMemo(() => {
    if (!nodes || facetsAreEmpty(facets)) return null;
    const cutoff =
      facets.since === 'any' ? null : nowMs - TIME_WINDOW_DAYS[facets.since] * DAY_MS;
    const surviving = new Set<number>();
    nodes.forEach((node, index) => {
      if (facets.hiddenRegions.has(clustering.regionOf(node))) return;
      if (facets.outcome !== 'any' && node.outcome !== facets.outcome) return;
      // A conversation with no timestamp cannot satisfy a time window. Dropping
      // it is the honest reading of "last 30 days"; keeping it would quietly
      // widen every window to mean "or unknown".
      if (cutoff !== null && (node.lastActivityMs === null || node.lastActivityMs < cutoff)) return;
      surviving.add(index);
    });
    return surviving;
  }, [nodes, facets, clustering, nowMs]);

  /**
   * The facet scope as an array, for the camera's default framing.
   *
   * Deliberately NOT `highlighted`: the camera's idea of "the whole map" has to
   * follow a persistent re-scoping and must not follow a search, or Reset view
   * would frame the hits and there would be no way back out of a query.
   */
  const framingIndices = useMemo(
    () => (facetIndices ? [...facetIndices] : null),
    [facetIndices],
  );

  /**
   * Which colour modes this index can express. A selection that outlives its
   * option heals back to Topic rather than leaving the map in a mode with no
   * control left on screen to explain it - the same rule the outcome facet and
   * the Detail chips already follow.
   */
  const colorModes = useMemo(() => availableColorModes(nodes ?? []), [nodes]);
  // Topic is always offered, so this converges in one extra render.
  if (!colorModes.includes(colorMode)) setColorMode('cluster');

  /**
   * How strongly each conversation on the map relates to the active turn.
   *
   * Two pictures, one per stage. While the agent reads, the related set, by
   * match strength: what retrieval handed over. Once the answer lands, the
   * tasks it is ABOUT and nothing else, so the map is the answer: eleven
   * dictation tasks when it names eleven, one conversation when it names one
   * (decided 2026-09-28). The related set used to stay dimly behind the answer,
   * and a small answer brought its neighbours back as context; both left the
   * reader looking at two dozen nodes for a one-task answer.
   */
  const turnStrengths = useMemo(() => {
    if (!activeTurn || (!activeTurn.related && activeTurn.rows.length === 0)) return null;
    // An answer that names no tasks lights nothing: the map goes back to how it
    // looked before the question. Retrieval always hands over its closest
    // matches, so a question about something that is not here still has a
    // related set, and lighting it contradicted an answer saying nothing matched.
    if (activeTurn.status === 'done' && activeTurn.rows.length === 0) return null;
    const strengths = new Map<number, number>();
    const light = (docKeys: ReadonlyArray<string>, strength: number): void => {
      for (const docKey of docKeys) {
        const index = indexByDocKey.get(docKey);
        if (index === undefined) continue;
        strengths.set(index, Math.max(strengths.get(index) ?? 0, strength));
      }
    };
    const answered = activeTurn.status === 'done';
    if (answered) {
      for (const row of activeTurn.rows) light(row.docKeys, 1);
      if (strengths.size > 0) return strengths;
      // None of the answer's tasks has a node of its own (found by their task
      // records alone). The related set stays, dimmed, so the map still points
      // at the part of the work the answer drew on rather than at everything.
      for (const task of activeTurn.related ?? []) light(task.docKeys, task.strength * RELATED_AFTER_ANSWER);
      return strengths.size > 0 ? strengths : null;
    }
    for (const task of activeTurn.related ?? []) light(task.docKeys, task.strength);
    for (const row of activeTurn.rows) light(row.docKeys, 1);
    return strengths.size > 0 ? strengths : null;
  }, [activeTurn, indexByDocKey]);

  /**
   * Nodes drawn with the white ring: what the agent's own searches found while
   * it reads, and the answer itself when it is about so few conversations that
   * they are the whole point of the picture. A search hit outside the answer
   * goes with the rest of the related set once the answer lands.
   */
  const ringed = useMemo(() => {
    if (!activeTurn) return undefined;
    const set = new Set<number>();
    const answeredTurn = activeTurn.status === 'done' && activeTurn.rows.length > 0;
    for (const search of answeredTurn ? [] : activeTurn.searches) {
      for (const docKey of search.docKeys) {
        const index = indexByDocKey.get(docKey);
        if (index !== undefined) set.add(index);
      }
    }
    const answered = activeTurn.rows.flatMap((row) => row.docKeys
      .map((docKey) => indexByDocKey.get(docKey))
      .filter((index): index is number => index !== undefined));
    if (answered.length > 0 && answered.length < FEW_LIT) for (const index of answered) set.add(index);
    return set.size > 0 ? set : undefined;
  }, [activeTurn, indexByDocKey]);

  const highlighted = useMemo(() => {
    // Explore wins: it is the most recent, most specific thing the user asked
    // for, and it is dismissible without losing the chat underneath it.
    let asked: Set<number> | undefined;
    if (exploreIndices) asked = exploreIndices;
    else if (turnStrengths) {
      asked = new Set(turnStrengths.keys());
      for (const index of ringed ?? []) asked.add(index);
    }

    // Filters INTERSECT rather than replace. They are the scope of the
    // question, so what an answer lights has to stay inside them.
    if (!facetIndices) return asked;
    if (!asked) return facetIndices;
    const both = new Set<number>();
    for (const index of asked) if (facetIndices.has(index)) both.add(index);
    return both;
  }, [exploreIndices, turnStrengths, ringed, facetIndices]);

  /**
   * Where the camera goes once an answer lands: the tasks it is about, not the
   * whole related set around them. Explore frames its own neighbourhood.
   */
  const answerFocus = useMemo(
    () => (activeTurn?.status === 'done' && !exploreIndices
      ? answerFocusIndices(activeTurn.rows, indexByDocKey, facetIndices)
      : null),
    [activeTurn, exploreIndices, indexByDocKey, facetIndices],
  );

  /** The conversations inside the map's filters: a question's scope. */
  const scopeDocKeys = useMemo(() => {
    if (!facetIndices || !nodes) return null;
    return [...facetIndices].map((index) => nodes[index]?.docKey).filter((docKey): docKey is string => Boolean(docKey));
  }, [facetIndices, nodes]);

  /** The project each conversation belongs to, when a scope is set. */
  const projectBySession = useMemo(() => {
    const map = new Map<string, string>();
    const owners = graphView.nodeProjectIds;
    if (!owners || !nodes) return map;
    nodes.forEach((node, index) => {
      if (node.sessionId && owners[index]) map.set(node.sessionId, owners[index]);
    });
    return map;
  }, [graphView.nodeProjectIds, nodes]);

  /** The conversation a task opens at: its best passage's, else its newest. */
  const conversationFor = useCallback((task: MemoryRelatedTask): string | null => {
    if (task.passage?.sessionId) return task.passage.sessionId;
    let newest: { sessionId: string; lastActivityMs: number } | null = null;
    for (const docKey of task.docKeys) {
      const index = indexByDocKey.get(docKey);
      const node = index === undefined ? null : nodes?.[index];
      if (!node?.sessionId) continue;
      const lastActivityMs = node.lastActivityMs ?? 0;
      if (!newest || lastActivityMs > newest.lastActivityMs) newest = { sessionId: node.sessionId, lastActivityMs };
    }
    return newest?.sessionId ?? null;
  }, [indexByDocKey, nodes]);

  /**
   * Open a task a row or a `#N` mark names: its most relevant conversation,
   * over the map, at the passage the answer used. A task with no recorded
   * conversation (it is on the board, but nothing of it was indexed) opens on
   * the board instead, where the host has one.
   */
  const openTask = useCallback((task: MemoryRelatedTask) => {
    const sessionId = conversationFor(task);
    if (sessionId) {
      openMemoryConversation(
        sessionId,
        projectId,
        task.passage?.sessionId === sessionId ? task.passage.turnUuid : null,
        task.projectId ?? projectBySession.get(sessionId) ?? null,
      );
      return;
    }
    if (task.taskId && onRevealTask) onRevealTask(task.taskId, task.projectId);
  }, [conversationFor, projectId, onRevealTask, projectBySession]);

  /** Whether a row or mark can lead anywhere in this host. */
  const canOpenTask = useCallback(
    (task: MemoryRelatedTask): boolean => conversationFor(task) !== null || (task.taskId !== null && onRevealTask !== undefined),
    [conversationFor, onRevealTask],
  );

  /** Ask, or send the question where the missing setup is made. */
  const ask = useCallback((question: string): boolean => {
    if (!question.trim()) return false;
    // Nothing is inferred: before an agent (and, where it takes one, a model)
    // is chosen, the question goes to where that choice is made, and stays
    // typed for when the user comes back.
    if (setupGap) {
      if (onChooseAnswerAgent) onChooseAnswerAgent();
      else setShowSetupHint(true);
      return false;
    }
    void askQuestion(question, { granularity, scopeDocKeys });
    return true;
  }, [setupGap, onChooseAnswerAgent, askQuestion, granularity, scopeDocKeys]);

  // A question handed in from Quick Find's Ask row: ask it here, through the
  // same path as the box, once. A store subscription rather than an effect on
  // the value, because asking can set this component's own state (the setup
  // hint), and the ref keeps the subscription on the latest `ask`.
  const askRef = useRef(ask);
  useEffect(() => { askRef.current = ask; });
  useEffect(() => {
    const askQueued = (): void => {
      const question = useMemoryGraphStore.getState().takeQueuedQuestion();
      if (question) askRef.current(question);
    };
    // Usually queued before this body mounts: Quick Find queues, then opens.
    queueMicrotask(askQueued);
    return useMemoryGraphStore.subscribe((state, previous) => {
      if (state.queuedQuestion !== null && state.queuedQuestion !== previous.queuedQuestion) askQueued();
    });
  }, []);

  /**
   * Where "Back" goes, if anywhere. Two dead ends, one control:
   *
   *  - mid-trail, it returns to the conversation you hopped from;
   *  - at the start of a trail with a chat open, it returns to the CHAT, which
   *    selecting a conversation on the map had otherwise replaced with no way
   *    back.
   */
  const selectedNode = selectedIndex !== null ? nodes?.[selectedIndex] ?? null : null;
  const exploredNode = exploreFromIndex !== null ? nodes?.[exploreFromIndex] ?? null : null;

  const detailBack = useMemo(() => {
    if (detailTrail.length > 0) {
      const previous = nodes?.[detailTrail[detailTrail.length - 1]];
      return { run: goBack, label: previous?.title ?? 'the previous conversation' };
    }
    if (chatOpen) {
      return { run: () => selectNode(null), label: 'the chat' };
    }
    return null;
  }, [detailTrail, nodes, goBack, chatOpen, selectNode]);

  /** The selected node's strongest links, read off the exact similarity edges
   *  rather than off screen distance. */
  const selectedNeighbors = useMemo(() => {
    if (selectedIndex === null || !snapshot?.projection || !nodes) return [];
    // The projection's own kNN, NOT the drawn edge list. The mesh is
    // quantile-pruned for legibility, so reading neighbours off it listed
    // whichever of a node's true neighbours happened to survive that cut - often
    // one, for a conversation with several. Already sorted most-similar-first.
    const lists = snapshot.projection.nodeNeighbors ?? [];
    return (lists[selectedIndex] ?? [])
      .filter((entry) => nodes[entry.index])
      .slice(0, DETAIL_NEIGHBOR_COUNT)
      .map((entry) => ({ index: entry.index, node: nodes[entry.index], similarity: entry.similarity }));
  }, [selectedIndex, snapshot, nodes]);

  // The box says when a question will be asked across several projects, since
  // the answer then names each task's project.
  const askPlaceholder = scopeProjectIds && scopeProjectIds.length > 1
    ? `Ask across ${scopeProjectIds.length} projects`
    : 'Ask about your tasks, conversations and code';

  // Only offered with two or more indexed projects: a one-option scope is a
  // dead control.
  const indexedProjectCount = projects.filter((project) => project.conversations > 0).length;
  const projectsPicker = indexedProjectCount >= 2 ? (
    <MemoryProjectsPicker
      projects={projects}
      openProjectId={projectId}
      selectedIds={scopeProjectIds ?? (projectId ? [projectId] : [])}
      pendingIds={graphView.pendingProjectIds}
      onChange={setScope}
    />
  ) : undefined;

  if (!loaded) {
    return (
      <CenteredNotice
        icon={<Loader2 size={22} className="animate-spin" />}
        title="Reading the index"
        body="Loading what this project has indexed."
      />
    );
  }

  if (!snapshot) {
    return (
      <CenteredNotice
        icon={<Brain size={22} />}
        title="No project open"
        body="Open a project to see what its conversation index has learned."
      />
    );
  }

  if (!snapshot.semanticAvailable) {
    // Deliberately NOT a structural fallback graph. Without embeddings there is
    // no meaningful notion of "near", and a structural tree would imply a
    // meaning the data cannot support.
    return (
      <div className="flex-1 min-h-0 flex flex-col" data-testid="memory-graph-body">
        <MemoryCoverageStrip coverage={snapshot.coverage} semanticAvailable={false} />
        <CenteredNotice
          icon={<Sparkles size={22} />}
          title="Semantic search is off"
          body="The map places conversations by meaning, which needs embeddings. Turn on semantic search in Settings > Search to build it. The coverage above is accurate either way."
        />
      </div>
    );
  }

  if (snapshot.projection === null) {
    return (
      <div className="flex-1 min-h-0 flex flex-col" data-testid="memory-graph-body">
        <MemoryCoverageStrip coverage={snapshot.coverage} semanticAvailable />
        {/* A scope whose maps are all still building keeps its picker, or the
            only way back to a drawable map would be closing the graph. */}
        {scopeProjectIds && projectsPicker ? (
          <div className="w-72 px-4 pt-3" data-testid="memory-graph-pending-scope">{projectsPicker}</div>
        ) : null}
        <CenteredNotice
          icon={<Loader2 size={22} className={snapshot.building ? 'animate-spin' : ''} />}
          title={snapshot.building ? 'Building the map' : 'No map yet'}
          body={
            snapshot.building
              ? 'Reading every embedding in the index. This runs in the background and only happens once per project; later updates are near-instant.'
              : 'Nothing has been indexed for this project yet.'
          }
        />
      </div>
    );
  }

  const projection = snapshot.projection;
  return (
    <div ref={surfaceRef} className="relative flex-1 min-h-0" data-testid="memory-graph-body">
      <MemoryGraphCanvas
        chromeInsets={chromeInsets}
        granularity={granularity}
        projection={projection}
        highlighted={highlighted}
        strengths={exploreIndices ? undefined : turnStrengths ?? undefined}
        ringed={exploreIndices ? undefined : ringed}
        focusIndices={answerFocus}
        islands={graphView.islands ?? undefined}
        worldExtent={graphView.worldExtent}
        cameraMemory={cameraMemory}
        cameraMemoryKey={projectId}
        framingIndices={framingIndices}
        selectedIndex={selectedIndex}
        onSelect={selectNode}
        onActivate={(index) => {
          const node = projection.nodes[index];
          if (node) openConversationForNode(node, graphView.nodeProjectIds?.[index] ?? null);
        }}
        showEdges={showEdges}
        showLabels={showLabels}
        showTitles={showTitles}
        colorMode={colorMode}
      />

      {/* Top-center: the box while no chat is open, and the explore chip.

          ONE box, ONE path. Type, press Enter, the agent answers. There used to
          be a live search underneath that re-filtered the map on every
          keystroke and a separate Ask that fired on Enter when a regex judged
          the text to be a question; the two answered the same input and the
          second overwrote the first. Once asked, the question moves into the
          chat on the right and the box goes, so there is one place to type. */}
      <div
        data-graph-chrome="top"
        className="absolute left-1/2 top-4 z-10 w-[35rem] max-w-[calc(100%-30rem)] -translate-x-1/2"
      >
        {chatOpen ? null : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              ask(queryText);
            }}
          >
            <div className="flex items-center gap-2.5 rounded-[10px] border border-edge-input bg-surface-raised/95 px-3.5 py-[11px] shadow-xl backdrop-blur-md">
              <Sparkles size={16} className="flex-shrink-0 text-accent-fg" aria-hidden />
              <input
                value={queryText}
                onChange={(event) => { setQueryText(event.target.value); setShowSetupHint(false); }}
                placeholder={askPlaceholder}
                aria-label={askPlaceholder}
                data-testid="memory-graph-search-input"
                className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted outline-none"
              />
              {/* Who answers stays STATED, as a tip on the submit glyph rather
                  than a second control. Enter is the button; the glyph is for
                  discoverability and for the mouse. Before an agent is chosen,
                  the tip says where the choice is made instead. */}
              {queryText.trim() ? (
                <HoverTip
                  label={setupGap
                    ? 'Choose the Knowledge Graph agent and model in Settings > Search.'
                    : `Ask ${askAgentLabel}. It reads the related work and can search your conversations.`}
                  testId="memory-graph-ask-tip"
                >
                  <button
                    type="submit"
                    aria-label={`Ask ${askAgentLabel}`}
                    data-testid="memory-graph-ask"
                    className="rounded p-1 text-accent-fg hover:bg-surface-hover cursor-pointer"
                  >
                    <CornerDownLeft size={14} />
                  </button>
                </HoverTip>
              ) : null}
            </div>
          </form>
        )}
        {showSetupHint && setupGap ? (
          <div
            className="mt-1.5 rounded-md border border-edge bg-surface-raised/85 px-2 py-1 text-xs text-fg-muted backdrop-blur"
            data-testid="memory-graph-setup-hint"
          >
            Choose the Knowledge Graph agent and model in Settings &gt; Search, in the main window.
          </div>
        ) : null}
        {/* Says what the map is currently scoped to, and takes it back. Without
            this the explored neighbourhood is an unexplained narrowing the user
            cannot undo except by ending the chat. */}
        {exploredNode ? (
          <div
            className="mx-auto mt-1.5 flex max-w-[26rem] items-center gap-2 rounded-md border border-edge bg-surface-raised/85 px-2 py-1 text-[11px] text-fg-muted backdrop-blur"
            data-testid="memory-graph-explore-chip"
          >
            <Compass size={11} className="flex-shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              Around &ldquo;{exploredNode.title ?? 'Untitled conversation'}&rdquo;
            </span>
            <button
              type="button"
              onClick={() => setExploreFromIndex(null)}
              className="rounded p-0.5 hover:bg-surface-hover hover:text-fg cursor-pointer"
              aria-label="Stop exploring this neighbourhood"
              data-testid="memory-graph-explore-clear"
            >
              <X size={11} />
            </button>
          </div>
        ) : null}
      </div>

      {/* Full height so the panel can cap itself at the space it has and scroll
          past it; clicks pass through the empty part below the panel to the map. */}
      <div data-graph-chrome="left" className="pointer-events-none absolute bottom-3 left-3 top-3 z-10 flex flex-col">

        <MemoryGraphControls
          colorMode={colorMode}
          onColorModeChange={setColorMode}
          availableColorModes={colorModes}
          showLabels={showLabels}
          onShowLabelsChange={setShowLabels}
          showTitles={showTitles}
          onShowTitlesChange={setShowTitles}
          showEdges={showEdges}
          onShowEdgesChange={setShowEdges}
          facets={facets}
          onFacetsChange={setFacets}
          facetAvailability={facetAvailability}
          regions={regions}
          granularity={granularity}
          availableGranularities={grainOptions}
          onGranularityChange={setGranularity}
          coverage={snapshot.coverage}
          index={snapshot.index}
          semanticAvailable={snapshot.semanticAvailable}
          edgeCount={projection.edges.length}
          building={snapshot.building}
          projectsPicker={projectsPicker}
          onOpenSettings={onOpenSettings}
        />
      </div>

      {/* The detail panel wins the right slot when a node is selected: it is the
          more specific view, and its Back returns to the chat.

          Both panels run the full height. Reset view used to hold the bottom
          right corner, which cut them short; it now sits in the camera toolbar
          centred at the bottom of the map, between the panels. */}
      {selectedNode ? (
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-3 right-3 top-3 z-10 w-[26rem]">
          <div className="h-full overflow-hidden rounded-lg border border-edge bg-surface-raised/85 shadow-xl backdrop-blur-md">
            <MemoryNodeDetail
              node={selectedNode}
              cluster={clustering.regions.find(
                (entry) => entry.id === clustering.regionOf(selectedNode),
              ) ?? null}
              neighbors={selectedNeighbors}
              onSelectNeighbor={followNeighbor}
              onExploreFrom={selectedIndex === null ? undefined : () => setExploreFromIndex(selectedIndex)}
              onBack={detailBack?.run}
              backLabel={detailBack?.label}
              nodeProjectId={selectedIndex !== null ? graphView.nodeProjectIds?.[selectedIndex] ?? null : null}
            />
          </div>
        </div>
      ) : chatOpen ? (
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-3 right-3 top-3 z-10 w-[25.25rem]">
          <MemoryChat
            thread={thread}
            agentName={askAgentLabel}
            onAsk={ask}
            onRetry={(turnId) => { void retryTurn(turnId, { granularity, scopeDocKeys }); }}
            onEnd={endChat}
            onOpenTask={openTask}
            canOpenTask={canOpenTask}
            onFocusTurn={focusTurn}
            homeProjectId={projectId}
          />
        </div>
      ) : null}
    </div>
  );
}

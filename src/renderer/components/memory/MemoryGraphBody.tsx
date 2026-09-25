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
import { Compass, CornerDownLeft, Loader2, Network, Sparkles, X } from 'lucide-react';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { MemoryAnswer } from './MemoryAnswer';
import { MemoryCoverageStrip } from './MemoryCoverageStrip';
import { MemoryGraphCanvas, type MemoryGraphColorMode } from './MemoryGraphCanvas';
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
import { resolveAnswerAgent } from '../../../shared/answer-agent';
import { HoverTip } from '../HoverTip';
import type { MemoryGraphGranularity, MemoryGraphNode } from '../../../shared/types';
import {
  DEFAULT_TASK_VIEW,
  formatTaskCost,
  formatTaskDuration,
  visibleTaskColumns,
} from '../../../shared/memory-task-fields';
import { useChromeInsets } from './useChromeInsets';
import { MemoryNodeDetail, openConversationForNode } from './MemoryNodeDetail';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Neighbours listed in the detail panel. Enough to be useful, short enough to
 *  read without scrolling. */
const DETAIL_NEIGHBOR_COUNT = 6;

/** A date for a conversation row. Short, and the same shape the catalog uses. */
function shortDate(epochMs: number | null): string | null {
  if (epochMs === null) return null;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

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

export function MemoryGraphBody() {
  const snapshot = useMemoryGraphStore((state) => state.snapshot);
  const loaded = useMemoryGraphStore((state) => state.loaded);
  const answer = useMemoryGraphStore((state) => state.answer);
  const answering = useMemoryGraphStore((state) => state.answering);
  const streamingAnswer = useMemoryGraphStore((state) => state.streamingAnswer);
  const streamingStatus = useMemoryGraphStore((state) => state.streamingStatus);
  const askQuestion = useMemoryGraphStore((state) => state.askQuestion);
  const clearAnswer = useMemoryGraphStore((state) => state.clearAnswer);

  /**
   * Who answers, resolved through the SAME chain the main process uses, so the
   * button can never name one agent while a different one replies. Gated on the
   * CAPABILITY rather than on any agent's name
   * (`.claude/rules/agent-adapters-boundary.md`).
   *
   * `requireFound` here and not in main: this list carries a detection flag and
   * must not offer Ask for an agent that is not installed, where main detects
   * the CLI itself a moment later and reports a precise reason.
   *
   * In a pop-out `currentProject` is never populated, so the chain falls through
   * to any capable agent - which is what the handler resolves to as well.
   */
  const agentList = useConfigStore((state) => state.agentList);
  const configuredAnswerAgent = useConfigStore((state) => state.config.memory?.answerAgent ?? null);
  const projectAgent = useProjectStore((state) => state.currentProject?.default_agent ?? null);
  const askAdapter = useMemo(
    () => resolveAnswerAgent({
      agents: agentList,
      configured: configuredAnswerAgent,
      projectAgent,
      requireFound: true,
    }),
    [agentList, configuredAnswerAgent, projectAgent],
  );
  const canAsk = askAdapter !== null;
  const askAgentLabel = askAdapter?.displayName ?? 'the agent';

  const [queryText, setQueryText] = useState('');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  /**
   * A task the reader clicked in an answer.
   *
   * Its own scope rather than reusing `exploreFromIndex`: explore follows one
   * conversation's LINKS, where this is a task's own conversations, and a task
   * with three sessions is not a neighbourhood. Carries the title so the
   * breadcrumb can name what it scoped to.
   */
  const [taskScope, setTaskScope] = useState<
    { ref: number; title: string; indices: Set<number> } | null
  >(null);
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
  const chromeInsets = useChromeInsets(
    surfaceRef,
    // The rail mounts the moment an answer starts arriving, so the key has to
    // move on the stream and not only on the settled answer.
    `${selectedIndex !== null}:${answer !== null || streamingAnswer !== '' || streamingStatus !== null}`,
  );

  // Nothing happens while typing. The box does one thing, on Enter: ask.
  //
  // It used to search live on every keystroke, and separately ask on Enter
  // when a regex judged the text to be a question. Two systems answered the
  // same input and the second overwrote the first, so the user watched a
  // hairball of raw passages appear and then vanish under the actual answer.
  // Nothing on screen explained why "mobile pairing" and "what did we do about
  // mobile pairing?" behaved differently, because the reason was a regex they
  // could not see. One path now, and no heuristic deciding which.
  //
  // A cleared box still clears the answer with it, or an answer would stand
  // over an empty box claiming to be about nothing.
  useEffect(() => {
    if (queryText.trim()) return;
    clearAnswer();
  }, [queryText, clearAnswer]);

  // A new answer is a new question, so it replaces any neighbourhood being
  // explored and any task drilled into, rather than compounding with them.
  // Adjusted during render on the transition, React's documented pattern for
  // state that resets when an input changes: the render restarts at once, so
  // nothing ever commits a stale scope beside a fresh answer.
  const [answerSeen, setAnswerSeen] = useState(answer);
  if (answer !== answerSeen) {
    setAnswerSeen(answer);
    setExploreFromIndex(null);
    setTaskScope(null);
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
   * Which facet rows can do anything on this corpus.
   *
   * A control that can only ever return the same set is worse than no control,
   * so each row is measured rather than assumed. Time is the one that is not
   * simply "is the field populated": if every conversation falls inside the
   * NARROWEST window then all four options select identically, and the row is
   * dead despite every timestamp being present.
   */
  const facetAvailability = useMemo<FacetAvailability>(() => {
    if (!nodes || nodes.length === 0) return NO_FACETS_AVAILABLE;
    const narrowestCutoff = nowMs - TIME_WINDOW_DAYS['7d'] * DAY_MS;
    const outcomes = new Set<string>();
    let hasOlderThanNarrowest = false;
    for (const node of nodes) {
      if (node.outcome) outcomes.add(node.outcome);
      if (node.lastActivityMs !== null && node.lastActivityMs < narrowestCutoff) {
        hasOlderThanNarrowest = true;
      }
    }
    return {
      since: hasOlderThanNarrowest,
      // Only outcomes this corpus actually contains, in a fixed display order.
      outcomes: OUTCOME_ORDER.filter((outcome) => outcomes.has(outcome)),
    };
  }, [nodes, nowMs]);

  // A selection can outlive the option that offered it - switch to a project
  // where nothing was abandoned and the scope would silently hold at zero with
  // no control left on screen to explain why. Healed during render, so no
  // frame ever commits the dead scope.
  if (facets.outcome !== 'any' && !facetAvailability.outcomes.includes(facets.outcome)) {
    setFacets((current) => ({ ...current, outcome: 'any' }));
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
    return clustering.regions.map((cluster) => ({
      id: cluster.id,
      label: cluster.label,
      count: counts.get(cluster.id) ?? 0,
    }));
  }, [clustering, nodes]);

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
   * The tasks an answer is ABOUT, whether or not it used the protocol line.
   *
   * `selectedDocKeys` is the explicit statement and wins when present. But the
   * agent emits that line inconsistently - asked which mobile task was biggest
   * it named six tasks in prose and emitted nothing - and the result was an
   * answer discussing six tasks beside a rail reading "1 of 673". Those refs
   * are already resolved for the inline chips, so falling back to them costs
   * nothing and makes the rail agree with the answer above it.
   *
   * MENTIONED is a weaker claim than SELECTED, and only the rail consumes the
   * fallback - clicking a chip still scopes deliberately, which is the user
   * saying "this one" rather than the surface guessing.
   */
  const answerTaskRefs = useMemo(
    () => (answer?.ok ? answer.taskRefs ?? [] : []),
    [answer],
  );

  /**
   * The columns the rows actually render.
   *
   * Chosen by the ANSWER (which knows what it ranked on) and then filtered by
   * the rows themselves: a column whose every value is identical spends width
   * to say nothing. `?? DEFAULT_TASK_VIEW` covers both an answer that declined
   * the protocol and one that predates the field entirely - a good answer
   * either way, and reading `.select` off undefined would unmount this whole
   * surface through PanelErrorBoundary.
   */
  const answerColumns = useMemo(
    () => visibleTaskColumns(
      (answer?.ok ? answer.view : null) ?? DEFAULT_TASK_VIEW,
      answerTaskRefs,
    ),
    [answer, answerTaskRefs],
  );

  const answerIndices = useMemo(() => {
    // Optional-chained deliberately: an answer that predates the selection
    // field (one in flight across a reload, or a detached window's older
    // payload) is a perfectly good prose answer, and reading `.length` off it
    // unmounts the whole surface through PanelErrorBoundary. The type says the
    // field is always there; the wire does not have to agree.
    if (!answer?.ok) return null;
    const docKeys = answer.selectedDocKeys?.length
      ? answer.selectedDocKeys
      : answerTaskRefs.flatMap((entry) => entry.docKeys);
    if (docKeys.length === 0) return null;
    const set = new Set<number>();
    for (const docKey of docKeys) {
      const index = indexByDocKey.get(docKey);
      if (index !== undefined) set.add(index);
    }
    // An answer whose every task has since left the map scopes to nothing,
    // which would read as a broken filter rather than a stale one.
    return set.size > 0 ? set : null;
  }, [answer, answerTaskRefs, indexByDocKey]);

  /**
   * The conversations the rail lists under the answer, or null for task rows.
   *
   * Two ways here, one list. Drilling into a task lists that task's
   * conversations: a task is not its conversations, and the row above says it
   * ran four, so this is where those four belong. An answer that SELECTED
   * conversations without naming a task (a `SELECTED:` line and no `T<n>` in
   * the prose) lists what it selected, because the map is scoped to them and
   * a scoped map over an empty rail reads as a filter that lost its list.
   *
   * Narrowed by the facets, as the map is. A facet asks "which part of the
   * index", and a list that ignored it would disagree with the map beside it.
   * Newest first, which is the order someone re-reading their own work wants.
   */
  const listedConversations = useMemo(() => {
    // Read off the snapshot rather than the `projection` local, which is only
    // bound after this component's early returns - a hook cannot wait for it.
    const nodes = snapshot?.projection?.nodes;
    if (!nodes) return null;
    const source = taskScope
      ? taskScope.indices
      : answerTaskRefs.length === 0 ? answerIndices : null;
    if (!source) return null;
    return [...source]
      .filter((index) => !facetIndices || facetIndices.has(index))
      .map((index) => ({ index, node: nodes[index] }))
      .filter((entry): entry is { index: number; node: MemoryGraphNode } => Boolean(entry.node))
      .sort((left, right) => (right.node.lastActivityMs ?? 0) - (left.node.lastActivityMs ?? 0));
  }, [taskScope, answerTaskRefs, answerIndices, facetIndices, snapshot]);

  /**
   * The task rows a facet leaves standing.
   *
   * A row whose every conversation the facet hid would sit beside a map
   * showing none of them. A task with no conversation on the map at all is
   * kept: its row is disabled and names a task the answer gave, and a facet
   * has nothing of it to hide.
   */
  const listedTaskRefs = useMemo(() => {
    if (!facetIndices) return answerTaskRefs;
    return answerTaskRefs.filter((entry) => {
      const indices = entry.docKeys
        .map((docKey) => indexByDocKey.get(docKey))
        .filter((index): index is number => index !== undefined);
      return indices.length === 0 || indices.some((index) => facetIndices.has(index));
    });
  }, [answerTaskRefs, facetIndices, indexByDocKey]);

  const highlighted = useMemo(() => {
    // Explore wins: it is the most recent, most specific thing the user asked
    // for, and it is dismissible without losing the answer underneath it. A
    // task the reader clicked comes next, then what the answer itself named.
    let asked: Set<number> | undefined;
    if (exploreIndices) asked = exploreIndices;
    else if (taskScope) asked = taskScope.indices;
    else if (answerIndices) asked = answerIndices;

    // Facets INTERSECT rather than replace. They answer a different question
    // from an answer - "which part of the index" versus "which conversations" -
    // so an answer scoped to Abandoned has to mean the abandoned ones among
    // what it named, not one of the two arbitrarily winning.
    if (!facetIndices) return asked;
    if (!asked) return facetIndices;
    const both = new Set<number>();
    for (const index of asked) if (facetIndices.has(index)) both.add(index);
    return both;
  }, [exploreIndices, taskScope, answerIndices, facetIndices]);

  /**
   * Where "Back" goes, if anywhere. Two dead ends, one control:
   *
   *  - mid-trail, it returns to the conversation you hopped from;
   *  - at the start of a trail with an answer on screen, it returns to the
   *    ANSWER, which selecting a task's conversation had otherwise replaced
   *    with no way back.
   */
  const selectedNode = selectedIndex !== null ? nodes?.[selectedIndex] ?? null : null;
  const exploredNode = exploreFromIndex !== null ? nodes?.[exploreFromIndex] ?? null : null;

  const detailBack = useMemo(() => {
    if (detailTrail.length > 0) {
      const previous = nodes?.[detailTrail[detailTrail.length - 1]];
      return { run: goBack, label: previous?.title ?? 'the previous conversation' };
    }
    if (answer?.ok) {
      return { run: () => selectNode(null), label: 'the answer' };
    }
    return null;
  }, [detailTrail, nodes, goBack, answer, selectNode]);

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
        icon={<Network size={22} />}
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
          body="The map places conversations by meaning, which needs embeddings. Turn on semantic search in Settings > Memory to build it. The coverage above is accurate either way."
        />
      </div>
    );
  }

  if (snapshot.projection === null) {
    return (
      <div className="flex-1 min-h-0 flex flex-col" data-testid="memory-graph-body">
        <MemoryCoverageStrip coverage={snapshot.coverage} semanticAvailable />
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
        framingIndices={framingIndices}
        selectedIndex={selectedIndex}
        onSelect={selectNode}
        onActivate={(index) => {
          const node = projection.nodes[index];
          if (node) openConversationForNode(node);
        }}
        showEdges={showEdges}
        showLabels={showLabels}
        showTitles={showTitles}
        colorMode={colorMode}
      />

      {/* The box floats top-center: it is the surface's one verb, and centring
          it keeps it off the controls and off the rail.

          ONE box, ONE path. Type, press Enter, the agent answers. There used to
          be a live search underneath that re-filtered the map on every
          keystroke and a separate Ask that fired on Enter when a regex judged
          the text to be a question; the two answered the same input and the
          second overwrote the first. What the user saw was a hairball of raw
          passages appear and then vanish under the actual answer, for a reason
          nothing on screen explained. */}
      <form
        data-graph-chrome="top"
        className="absolute left-1/2 top-3 z-10 w-[26rem] max-w-[calc(100%-30rem)] -translate-x-1/2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAsk || answering) return;
          void askQuestion(queryText, granularity);
        }}
      >
        <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-raised/80 px-3 py-2 shadow-xl backdrop-blur-md">
          {answering
            ? <Loader2 size={14} className="flex-shrink-0 animate-spin text-accent-fg" aria-hidden />
            : <Sparkles size={14} className="flex-shrink-0 text-accent-fg" aria-hidden />}
          <input
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder={canAsk ? 'Ask about your tasks and conversations' : 'No agent can answer here'}
            aria-label="Ask a question about your tasks and conversations"
            disabled={!canAsk}
            data-testid="memory-graph-search-input"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted outline-none disabled:cursor-not-allowed"
          />
          {/* Who answers, and that it costs a call, stays STATED - as a tip on
              the submit glyph rather than a second control. Enter is the button;
              the glyph is for discoverability and for the mouse. */}
          {canAsk && queryText.trim() && !answer && !answering ? (
            <HoverTip
              label={`${askAgentLabel} reads every task and searches your conversations. One agent call.`}
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
          {/* The count names the UNIT the rail is showing, and only when there
              is one: tasks the answer named, or the conversations it selected
              or the reader drilled into. Counted AFTER the facets, so the
              number is the number of rows beneath it. */}
          {listedConversations || listedTaskRefs.length > 0 ? (
            <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-muted">
              {listedConversations
                ? `${listedConversations.length} ${listedConversations.length === 1 ? 'conversation' : 'conversations'}`
                : `${listedTaskRefs.length} ${listedTaskRefs.length === 1 ? 'task' : 'tasks'}`}
            </span>
          ) : null}
          {answer || streamingAnswer ? (
            <button
              type="button"
              onClick={() => { setQueryText(''); clearAnswer(); }}
              className="rounded p-1 text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
              aria-label="Clear"
              data-testid="memory-graph-clear-search"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        {/* A task the reader clicked in an answer. Same shape as the explore
            chip, because it is the same promise: the map is narrowed, here is
            what to, and here is how to undo it. */}
        {taskScope ? (
          <div
            className="mt-1.5 flex items-center gap-2 rounded-md border border-edge bg-surface-raised/85 px-2 py-1 text-[11px] text-fg-muted backdrop-blur"
            data-testid="memory-graph-task-chip"
          >
            <Network size={11} className="flex-shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {taskScope.title} ({taskScope.indices.size}{' '}
              {taskScope.indices.size === 1 ? 'conversation' : 'conversations'})
            </span>
            <button
              type="button"
              onClick={() => setTaskScope(null)}
              className="rounded p-0.5 hover:bg-surface-hover hover:text-fg cursor-pointer"
              aria-label="Stop scoping to this task"
              data-testid="memory-graph-task-clear"
            >
              <X size={11} />
            </button>
          </div>
        ) : null}
        {/* Says what the map is currently scoped to, and takes it back. Without
            this the explored neighbourhood is an unexplained narrowing the user
            cannot undo except by clearing the search. */}
        {exploredNode ? (
          <div
            className="mt-1.5 flex items-center gap-2 rounded-md border border-edge bg-surface-raised/85 px-2 py-1 text-[11px] text-fg-muted backdrop-blur"
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
      </form>

      <div data-graph-chrome="left" className="absolute left-3 top-3 z-10">
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
          semanticAvailable={snapshot.semanticAvailable}
          edgeCount={projection.edges.length}
          storageBytes={projection.storageBytes}
          building={snapshot.building}
        />
      </div>

      {/* The detail panel wins the rail when a node is selected: it is the more
          specific answer, and the search results stay one click away on the map.

          Both rails stop short of the bottom (`bottom-14`) so Reset view keeps
          its corner. Reset view used to slide left by the rail's width instead,
          which meant the one control that gets you un-lost moved every time a
          panel opened - and when the chrome measurement was wrong it vanished
          underneath the rail entirely. A control that does not move is easier to
          find than one that is correctly placed. */}
      {selectedNode ? (
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-14 right-3 top-3 z-10 w-[26rem]">
          <div className={`h-full overflow-hidden rounded-lg border border-edge bg-surface-raised/85 shadow-xl backdrop-blur-md`}>
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
            />
          </div>
        </div>
      ) : answer || streamingAnswer || streamingStatus ? (
        /* The rail opens the moment an answer starts ARRIVING, not when it has
           finished. That is the whole point of streaming: content at first-token
           time rather than a spinner until completion. */
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-14 right-3 top-3 z-10 w-[26rem]">
          <aside
            className="h-full overflow-y-auto rounded-lg border border-edge bg-surface-raised/85 shadow-xl backdrop-blur-md"
            data-testid="memory-graph-results"
          >
            {/* The box is the input surface and the rail is the output one, so
                the answer lives here rather than floating over the map. */}
            <MemoryAnswer
              answer={answer}
              streamingAnswer={streamingAnswer}
              streamingStatus={streamingStatus}
              agentName={askAgentLabel}
              onDismiss={clearAnswer}
              // A task ref names a whole task, which is usually several
              // conversations. So it EXPLORES rather than selects - the map
              // scopes to that task's work and the rail lists it.
              onSelectTask={(entry) => {
                const indices = entry.docKeys
                  .map((docKey) => indexByDocKey.get(docKey))
                  .filter((index): index is number => index !== undefined);
                if (indices.length === 0) return;
                setTaskScope({ ref: entry.ref, title: entry.title, indices: new Set(indices) });
                // Deliberately does NOT select a conversation. Selecting swaps
                // the rail to the detail panel, so clicking a task would drop
                // the reader into ONE of its conversations and hide the list of
                // the others - the opposite of what naming a task asks for.
                selectNode(null);
              }}
            />

            {/* TASK rows, when the answer is about tasks.
                A conversation card shows the best-matching PASSAGE, which is
                right for "find conversations about X" and useless for "which
                task is biggest" - the reported case rendered
                `Tool: ToolSearch {"query":...}` under an answer ranking tasks
                by cost. These rows show what the answer was reasoning over. */}
            {listedConversations ? (
              /* CONVERSATION rows: one task's, drilled into, or the ones an
                 answer selected outright.
                 Clicking a task row used to set a scope the map was already
                 holding - `answerIndices` falls back to the refs' docKeys, so
                 an answer naming one task had already scoped to it - and the
                 click moved nothing at all. A task is not its conversations,
                 so this is the level where they belong: the row above says a
                 task ran four of them, and this says which four. */
              <ul data-testid="memory-graph-task-conversations">
                {listedConversations.map(({ index, node }) => (
                  <li key={node.docKey}>
                    <button
                      type="button"
                      onClick={() => selectNode(index)}
                      onDoubleClick={() => openConversationForNode(node)}
                      className="w-full border-b border-edge px-4 py-3 text-left hover:bg-surface-hover cursor-pointer"
                      data-testid="memory-graph-task-conversation-row"
                    >
                      <div className="truncate text-xs font-medium text-fg">
                        {node.title ?? 'Untitled conversation'}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
                        {shortDate(node.lastActivityMs) ? (
                          <span>{shortDate(node.lastActivityMs)}</span>
                        ) : null}
                        {node.agent ? <span>{node.agent}</span> : null}
                        {formatTaskCost(node.costUsd) ? (
                          <span className="tabular-nums">{formatTaskCost(node.costUsd)}</span>
                        ) : null}
                        {formatTaskDuration(node.durationMs) ? (
                          <span className="tabular-nums">{formatTaskDuration(node.durationMs)}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : listedTaskRefs.length > 0 ? (
              /* TASK rows, aligned into columns.
                 A conversation card shows the best-matching PASSAGE, which is
                 right for "find conversations about X" and useless for "which
                 task is biggest" - the reported case rendered
                 `Tool: ToolSearch {"query":...}` under an answer ranking tasks
                 by cost.

                 The COLUMNS come from the answer, not from this file. They used
                 to be four hardcoded chips, which is right for a cost question
                 and wrong for every other one: asked which tasks used the most
                 tokens, the prose named a token figure and every row printed a
                 dollar amount. */
              <ul data-testid="memory-graph-answer-tasks">
                <li
                  className="sticky top-0 z-10 flex items-center gap-3 border-b border-edge bg-surface-raised px-4 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-faint"
                  data-testid="memory-graph-answer-task-header"
                >
                  <span className="min-w-0 flex-1">Task</span>
                  {answerColumns.map((field) => (
                    <span key={field.key} className="w-24 flex-shrink-0 text-right">
                      {field.label}
                    </span>
                  ))}
                </li>
                {listedTaskRefs.map((entry) => {
                  const indices = entry.docKeys
                    .map((docKey) => indexByDocKey.get(docKey))
                    .filter((index): index is number => index !== undefined);
                  return (
                    <li key={entry.ref}>
                      <button
                        type="button"
                        onClick={() => {
                          if (indices.length === 0) return;
                          setTaskScope({
                            ref: entry.ref,
                            title: entry.title,
                            indices: new Set(indices),
                          });
                          selectNode(null);
                        }}
                        disabled={indices.length === 0}
                        className="flex w-full items-center gap-3 border-b border-edge px-4 py-2.5 text-left hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent cursor-pointer"
                        data-testid="memory-graph-answer-task-row"
                        data-task-ref={entry.ref}
                      >
                        <span className="flex min-w-0 flex-1 items-baseline gap-2">
                          {/* The board's own `#N`, which is the number the
                              reader has seen on a card. `T14` is the agent's
                              vocabulary and a different number for the same
                              task, so it stays on the wire and off the screen -
                              except where there is no ticket at all, which is a
                              conversation with no board task. */}
                          <span className="flex-shrink-0 font-mono text-[11px] text-fg-muted">
                            {entry.displayId != null ? `#${entry.displayId}` : `T${entry.ref}`}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                            {entry.title}
                          </span>
                        </span>
                        {answerColumns.map((field) => (
                          <span
                            key={field.key}
                            className="w-24 flex-shrink-0 truncate text-right text-[11px] tabular-nums text-fg-secondary"
                            data-field={field.key}
                          >
                            {/* An empty cell means the fact was never recorded.
                                Never a zero, which would make an unmeasured
                                task look like a free one. */}
                            {field.display(entry) ?? ''}
                          </span>
                        ))}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

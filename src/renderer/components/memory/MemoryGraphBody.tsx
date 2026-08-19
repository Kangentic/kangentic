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
import { Compass, Loader2, Network, Search, Sparkles, X } from 'lucide-react';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
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
import type { MemoryGraphGranularity } from '../../../shared/types';
import { useChromeInsets } from './useChromeInsets';
import { MemoryNodeDetail, openConversationForNode } from './MemoryNodeDetail';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Search-as-you-type delay. Retrieval is local and fast, so this only needs to
 *  coalesce a burst of keystrokes. */
const QUERY_DEBOUNCE_MS = 220;
/** Neighbours listed in the detail panel. Enough to be useful, short enough to
 *  read without scrolling. */
const DETAIL_NEIGHBOR_COUNT = 6;

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
  const query = useMemoryGraphStore((state) => state.query);
  const querying = useMemoryGraphStore((state) => state.querying);
  const runQuery = useMemoryGraphStore((state) => state.runQuery);
  const clearQuery = useMemoryGraphStore((state) => state.clearQuery);

  const [queryText, setQueryText] = useState('');
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
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    `${selectedIndex !== null}:${query !== null}`,
  );

  // Search as you type. The premise is watching matches light up on the map,
  // which a submit-to-search box cannot do; retrieval is local and free, so
  // there is no cost reason to make the user press Enter.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void runQuery(queryText);
    }, QUERY_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [queryText, runQuery]);

  // A new query is a new question, so it replaces any neighbourhood being
  // explored rather than compounding with it.
  useEffect(() => {
    setExploreFromIndex(null);
  }, [query]);

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

  /** Indices matching the current query, in result order. */
  const queryIndices = useMemo(() => {
    if (!query) return null;
    const set = new Set<number>();
    for (const hit of query.hits) {
      const index = indexByDocKey.get(hit.docKey);
      if (index !== undefined) set.add(index);
    }
    return set;
  }, [query, indexByDocKey]);

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
    const narrowestCutoff = Date.now() - TIME_WINDOW_DAYS['7d'] * DAY_MS;
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
  }, [nodes]);

  // A selection can outlive the option that offered it - switch to a project
  // where nothing was abandoned and the scope would silently hold at zero with
  // no control left on screen to explain why.
  useEffect(() => {
    if (facets.outcome === 'any') return;
    if (facetAvailability.outcomes.includes(facets.outcome)) return;
    setFacets((current) => ({ ...current, outcome: 'any' }));
  }, [facetAvailability, facets.outcome]);

  // A rebuild re-clusters from scratch, so region 4 in the old projection is not
  // region 4 in the new one. Carrying the old exclusions across would hide an
  // arbitrary area the user never chose, with a panel that agrees it is hidden
  // and no way to tell it is wrong. Cleared on a signature change instead.
  const projectionSignature = snapshot?.projection?.signature ?? null;
  useEffect(() => {
    setFacets((current) =>
      current.hiddenRegions.size === 0 ? current : { ...current, hiddenRegions: new Set() },
    );
  }, [projectionSignature]);

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
  useEffect(() => {
    if (grainOptions.length === 0 || grainOptions.includes(granularity)) return;
    setGranularity(DEFAULT_GRANULARITY);
  }, [grainOptions, granularity]);

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
      facets.since === 'any' ? null : Date.now() - TIME_WINDOW_DAYS[facets.since] * DAY_MS;
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
  }, [nodes, facets, clustering]);

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
   * Whether anything here has a recorded cost.
   *
   * Conversations indexed before the metrics were captured carry none, and an
   * index made entirely of those would offer a mode that paints every node the
   * same. Same rule the outcome facet follows, and the same healing: a selection
   * that outlives its option falls back to Topic rather than leaving the map in
   * a mode with no control left on screen to explain it.
   */
  const costAvailable = useMemo(
    () => (nodes ?? []).some((node) => node.costUsd !== null),
    [nodes],
  );
  useEffect(() => {
    if (colorMode === 'cost' && !costAvailable) setColorMode('cluster');
  }, [colorMode, costAvailable]);

  const highlighted = useMemo(() => {
    // Explore wins: it is the most recent, most specific thing the user asked
    // for, and it is dismissible without losing the query underneath it.
    let asked: Set<number> | undefined;
    if (exploreIndices) asked = exploreIndices;
    else if (queryIndices) asked = queryIndices;

    // Facets INTERSECT rather than replace. They answer a different question
    // from search - "which part of the index" versus "which conversations" - so
    // "pairing" scoped to Abandoned has to mean abandoned pairing work, not one
    // of the two arbitrarily winning.
    if (!facetIndices) return asked;
    if (!asked) return facetIndices;
    const both = new Set<number>();
    for (const index of asked) if (facetIndices.has(index)) both.add(index);
    return both;
  }, [exploreIndices, queryIndices, facetIndices]);

  /**
   * The search hits that survive the facet rows.
   *
   * The list has to agree with the map. Rendering `query.hits` directly meant a
   * scoped map could show four nodes under a header reading "23 of 150" beside
   * 23 cards, which reads as a broken filter rather than a narrowed one.
   */
  const visibleHits = useMemo(() => {
    if (!query) return [];
    if (!facetIndices) return query.hits;
    return query.hits.filter((hit) => {
      const index = indexByDocKey.get(hit.docKey);
      return index !== undefined && facetIndices.has(index);
    });
  }, [query, facetIndices, indexByDocKey]);

  const selectedNode = selectedIndex !== null ? nodes?.[selectedIndex] ?? null : null;

  /** The selected node's OWN search hit, so the panel can say why it is here. */
  const selectedQueryHit = useMemo(() => {
    if (!query || !selectedNode) return null;
    const rank = visibleHits.findIndex((hit) => hit.docKey === selectedNode.docKey);
    if (rank < 0) return null;
    // Ranked among what is SHOWING, so "result 2 of 4" cannot appear over a
    // list of four while claiming a position from an unfiltered twenty-three.
    return { hit: visibleHits[rank], rank: rank + 1, total: visibleHits.length };
  }, [query, selectedNode, visibleHits]);

  const exploredNode = exploreFromIndex !== null ? nodes?.[exploreFromIndex] ?? null : null;

  /**
   * Where "Back" goes, if anywhere. Two dead ends, one control:
   *
   *  - mid-trail, it returns to the conversation you hopped from;
   *  - at the start of a trail with a search running, it returns to the RESULTS,
   *    which selecting a card had otherwise replaced with no way back.
   */
  const detailBack = useMemo(() => {
    if (detailTrail.length > 0) {
      const previous = nodes?.[detailTrail[detailTrail.length - 1]];
      return { run: goBack, label: previous?.title ?? 'the previous conversation' };
    }
    if (query) {
      return { run: () => selectNode(null), label: `results (${visibleHits.length})` };
    }
    return null;
  }, [detailTrail, nodes, goBack, query, selectNode, visibleHits.length]);

  const resultDocKeys = useMemo(
    () => new Set((query?.hits ?? []).map((hit) => hit.docKey)),
    [query],
  );

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

      {/* Search floats top-center: it is the surface's primary verb, and centring
          it keeps it off the controls and off the detail rail. */}
      <form
        data-graph-chrome="top"
        className="absolute left-1/2 top-3 z-10 w-[26rem] max-w-[calc(100%-30rem)] -translate-x-1/2"
        onSubmit={(event) => {
          event.preventDefault();
          void runQuery(queryText);
        }}
      >
        <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-raised/80 px-3 py-2 shadow-xl backdrop-blur-md">
          <Search size={14} className="flex-shrink-0 text-fg-muted" aria-hidden />
          <input
            value={queryText}
            onChange={(event) => setQueryText(event.target.value)}
            placeholder="Search these conversations"
            aria-label="Search indexed conversations"
            data-testid="memory-graph-search-input"
            className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-muted outline-none"
          />
          {querying ? <Loader2 size={13} className="animate-spin text-fg-muted" aria-hidden /> : null}
          {query ? (
            <>
              <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-muted">
                {visibleHits.length} of {projection.nodes.length}
              </span>
              <button
                type="button"
                onClick={() => { setQueryText(''); clearQuery(); }}
                className="rounded p-1 text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
                aria-label="Clear search"
                data-testid="memory-graph-clear-search"
              >
                <X size={13} />
              </button>
            </>
          ) : null}
        </div>
        {query && !query.semantic ? (
          <p className="mt-1.5 rounded bg-surface-raised/80 px-2 py-1 text-[11px] text-fg-muted backdrop-blur">
            Searched text only. Turn on semantic search for meaning-based matches.
          </p>
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
          costAvailable={costAvailable}
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
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-14 right-3 top-3 z-10 w-80">
          <div className={`h-full overflow-hidden rounded-lg border border-edge bg-surface-raised/85 shadow-xl backdrop-blur-md`}>
            <MemoryNodeDetail
              node={selectedNode}
              cluster={clustering.regions.find(
                (entry) => entry.id === clustering.regionOf(selectedNode),
              ) ?? null}
              neighbors={selectedNeighbors}
              onSelectNeighbor={followNeighbor}
              queryHit={selectedQueryHit}
              resultDocKeys={resultDocKeys}
              onExploreFrom={selectedIndex === null ? undefined : () => setExploreFromIndex(selectedIndex)}
              onBack={detailBack?.run}
              backLabel={detailBack?.label}
            />
          </div>
        </div>
      ) : query ? (
        <div data-graph-chrome="right" className="overlay-panel-in absolute bottom-14 right-3 top-3 z-10 w-80">
          <aside
            className="h-full overflow-y-auto rounded-lg border border-edge bg-surface-raised/85 shadow-xl backdrop-blur-md"
            data-testid="memory-graph-results"
          >
            {visibleHits.length === 0 ? (
              <p className="p-4 text-sm text-fg-muted">
                Nothing in this project&apos;s indexed conversations matched.
              </p>
            ) : (
              <ul>
                {visibleHits.map((hit) => {
                  const index = indexByDocKey.get(hit.docKey);
                  return (
                    <li key={hit.sessionId}>
                      <button
                        type="button"
                        onClick={() => selectNode(index ?? null)}
                        onDoubleClick={() => {
                          const node = index !== undefined ? projection.nodes[index] : null;
                          if (node) openConversationForNode(node);
                        }}
                        className="w-full border-b border-edge px-4 py-3 text-left hover:bg-surface-hover cursor-pointer"
                        data-testid="memory-graph-result-card"
                      >
                        <div className="truncate text-xs font-medium text-fg">
                          {hit.taskTitle ?? 'Untitled conversation'}
                        </div>
                        <p className="mt-1 line-clamp-3 text-xs text-fg-muted">{hit.snippet}</p>
                        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-fg-muted">
                          <span>{hit.matchKind}</span>
                          {hit.matchCount > 1 ? <span>{hit.matchCount} matches</span> : null}
                          {/* A node the map does not hold: the projection is
                              older than this conversation. Said, not hidden. */}
                          {index === undefined ? <span>not on the map yet</span> : null}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      ) : null}
    </div>
  );
}

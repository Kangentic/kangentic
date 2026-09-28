/**
 * The Memory Graph's spatial view: a three.js point cloud you fly through.
 *
 * WHY WEBGL, having deliberately not used it at first. The surface originally
 * shipped on Canvas 2D specifically to avoid taking a WebGL context, because
 * `utils/terminal-webgl.ts` caps this page's contexts so Chromium's silent
 * oldest-context eviction never pushes a live terminal to its DOM fallback. That
 * held while the map was a flat diagram. It stopped holding once the spatial
 * view became the only view and had to feel good to fly: depth testing, additive
 * glow and damped camera motion are not things Canvas 2D does, and hand-writing
 * easing and camera choreography is precisely the part that has to be excellent.
 * So the context is taken - and ACCOUNTED FOR, via `reserveWebglContext`, which
 * is the generalization the original design deferred rather than dismissed.
 *
 * WHAT THE PICTURE MEANS. Positions come from a neighbour embedding of the real
 * vectors, measured at ~33% neighbourhood preservation on the real corpus
 * (against 28% for the same embedder flattened to two dimensions, and 1.4% for a
 * random scatter). Strong for 1024 dimensions reduced to three, but NOT exact -
 * so EDGES, computed in full dimensionality, carry the semantic claim, and
 * position is a readable arrangement. The UI says so rather than letting the
 * user assume otherwise.
 *
 * React owns mounting, props and the DOM overlays. It does not own frames: the
 * scene (`memory-graph-scene.ts`) and the loop (`useMemoryGraphScene.ts`) are
 * imperative, and cluster labels are positioned by writing transforms onto refs
 * inside the frame callback. Routing that through state would put React's
 * reconciler between the user's drag and the pixels.
 */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { Keyboard, RotateCcw } from 'lucide-react';
import { Color, Vector3 } from 'three';
import { useMemoryGraphScene } from './useMemoryGraphScene';
import {
  WORLD_SIZE,
  clusterHue,
  type MemoryGraphScene,
  type SceneNodeStyle,
  NO_VIEWPORT_INSETS,
  type ViewportInsets,
} from './memory-graph-scene';
import { HoverTip } from '../HoverTip';
import { humanizeModelId } from '../../../shared/model-id';
import type {
  MemoryGraphCluster,
  MemoryGraphGranularity,
  MemoryGraphNode,
  MemoryGraphProjection,
} from '../../../shared/types';
import { DEFAULT_GRANULARITY, resolveClustering } from './active-clustering';

/**
 * How nodes are tinted. Each answers a different question, which is why they
 * are modes rather than layers.
 *
 * `size`, `duration` and `cost` are three magnitudes and they are three
 * DIFFERENT magnitudes, which was measured rather than assumed. Rank
 * correlations on the real 648-conversation corpus: length to duration 0.507,
 * length to cost 0.560, duration to cost 0.664. Nothing above two thirds, so a
 * long conversation is not reliably a slow one and a slow one is not reliably an
 * expensive one. A mode that merely restated another would not earn its place.
 */
export type MemoryGraphColorMode = 'cluster' | 'recency' | 'outcome' | 'size' | 'duration' | 'cost';

export interface MemoryGraphCanvasProps {
  projection: MemoryGraphProjection;
  highlighted?: ReadonlySet<number>;
  selectedIndex?: number | null;
  onSelect?: (index: number | null) => void;
  onActivate?: (index: number) => void;
  showEdges?: boolean;
  showLabels?: boolean;
  /**
   * Conversation titles on the map itself.
   *
   * Defaults ON: this is the surface's main source of context clues, and a map
   * whose points are anonymous forces the user to hover every one of them in
   * turn. The control is an OFF switch for a map the user finds busy, not an
   * opt-in for a feature they have to discover.
   */
  showTitles?: boolean;
  colorMode?: MemoryGraphColorMode;
  /** Pixels of the canvas the floating panels cover, so the camera can aim at
   *  the part of it the user can actually see. */
  chromeInsets?: ViewportInsets;
  /** Which shipped carve-up of the map is on screen. */
  granularity?: MemoryGraphGranularity;
  /**
   * Nodes the FACET rows have left on the map, or null when nothing is scoped.
   *
   * Separate from `highlighted`, which folds in the search hits: a facet scope
   * redefines what the map is and so moves its default framing, where a search
   * is a question the camera flies to and returns from. Reset view frames this.
   */
  framingIndices?: ReadonlyArray<number> | null;
  /**
   * How strongly each lit node relates to the question, 0..1. A lit node with
   * no entry draws at full strength, so a caller that only scopes stays as it was.
   */
  strengths?: ReadonlyMap<number, number>;
  /** Nodes the agent's own searches found, drawn with a white ring. */
  ringed?: ReadonlySet<number>;
  /**
   * While a question lights the map: the in-scope nodes it did NOT light stay
   * on screen as small, faint grey context instead of vanishing, so the lit set
   * reads against the map it came from. `scope` is the filtered set, or null
   * when no filter is on (every node is in scope); a node outside it stays
   * hidden, since the filters redefine what the map is.
   */
  context?: { scope: ReadonlySet<number> | null };
  /**
   * The islands, when several projects' maps are composed: each project's name
   * and its node range. Their labels sit above each island, placed before the
   * region pills so a region name never covers a project's.
   */
  islands?: ReadonlyArray<{ name: string; start: number; end: number }>;
}

/** The dimmest a lit node draws: a weak relation, still readable as lit. */
const WEAKEST_LIT_ALPHA = 0.3;
/** How brightly an unlit node draws as context behind a question's lit set. */
const CONTEXT_ALPHA = 0.18;
/** Size multiplier for a context node: present, but clearly not part of the answer. */
const CONTEXT_SCALE = 0.7;
/** Size multiplier for a ringed node. */
const RINGED_SCALE = 1.35;
/** Below this strength a lit node draws as a dot, without a title or a region pill. */
const LABEL_MIN_STRENGTH = 0.5;

/**
 * Alpha for everything outside an active search or filter.
 *
 * ZERO: a query SCOPES the map rather than tinting it. Dimming was tried first
 * and does not work at this density - 150 conversations and 486 links dimmed to
 * a faint wash still drew every line, so a 30-hit query read as a hairball with
 * some green in it rather than as an answer. Hidden nodes also drop their links
 * and stop being pickable (see `memory-graph-scene.ts`), so what is left on
 * screen is the query's own structure.
 */
/**
 * How far the pointer may travel before a click becomes a camera drag.
 *
 * Zero is what shipped, via "any pointermove between down and up is a drag",
 * and it is too strict for a mouse: the hand moves a pixel on the way to
 * releasing a button, so genuine clicks were read as drags. It is also too
 * loose in the other direction, because that test never ran when the move
 * arrived in the same tick as the press.
 */
const DRAG_SLOP_PX = 3;
const HIDDEN_ALPHA = 0;
/** How brightly a conversation with no links draws, relative to a connected one. */
const ISOLATED_ALPHA = 0.55;

/** An unconnected conversation still has to be a legible point, not a speck. */
const MIN_NODE_SCALE = 0.9;
/** How much a node grows between no links and the most-linked node on the map. */
const DEGREE_SCALE_RANGE = 1.5;

/**
 * Node-title labelling.
 *
 * The problem these solve: "Explore from here" scopes the map to a conversation
 * and its links, which is exactly the moment the user most wants to know what
 * those are - and leaves them looking at seven anonymous points. The rail knows
 * the names; the canvas did not.
 *
 * The rule is cartographic. Everything eligible competes for space, NEAREST TO
 * CAMERA WINS, and anything that would overlap an already-placed label is not
 * drawn at all. Labels therefore never stack, which is the property that keeps a
 * busy map readable rather than turning it into a pile of text. It also means
 * the labelling changes as you fly, always naming what is in front of you.
 */
const NODE_LABEL_POOL = 48;
/** Titles are task titles and run long; past this they are clipped with an
 *  ellipsis so one verbose conversation cannot own a third of the screen. */
const NODE_LABEL_MAX_CHARS = 34;
/**
 * Approximate advance width per character at the label's font size.
 *
 * Estimated rather than measured on purpose: measuring each label per frame
 * means a forced layout per label per frame, which is precisely the read/write
 * thrash the frame loop exists to avoid. The collision test only needs boxes
 * that are approximately right, and a slight over-estimate errs toward more
 * space between labels, which is the safe direction.
 */
const NODE_LABEL_CHAR_WIDTH = 6.15;
/** Region labels are a size up from titles, so they need their own advance. */
const REGION_LABEL_CHAR_WIDTH = 6.7;
/** The region pill's own box, which is bigger than a title's: wider horizontal
 *  padding, a border, and taller vertical padding. The collision estimate has to
 *  track the real chrome or titles tuck under the pill's edges. */
const REGION_LABEL_PADDING = 22;
// Measured from the rendered pill (30px), not estimated: under-guessing the
// HEIGHT is the unsafe direction, since a title then tucks under its bottom
// edge. Over-guessing the width only spaces things out further.
const REGION_LABEL_HEIGHT = 30;
/**
 * How far the region pill sits ABOVE its centroid.
 *
 * A cluster's centroid is by definition where that cluster is densest, so a pill
 * centred on it covers the very nodes it names - which was true of five of the
 * nine regions at once. Lifting it clear labels the area without hiding it, the
 * way a map prints a place name beside its dot rather than over it.
 */
const REGION_LABEL_LIFT = 30;
/** World units an island's name sits above its highest node. */
const ISLAND_LABEL_LIFT = 4;
/** Estimated width of an island label: per character at text-xs semibold, plus padding. */
const ISLAND_LABEL_CHAR_WIDTH = 7.2;
const ISLAND_LABEL_PADDING = 22;
const ISLAND_LABEL_HEIGHT = 26;
/**
 * Visible nodes a region needs before its pill is drawn.
 *
 * TWO, because that is the smallest number for which a centroid is a place
 * BETWEEN things rather than a point on one thing. Below it the region name is a
 * second, vaguer label sitting on a conversation whose own title already names
 * it - which is what a search returning 42 conversations across 39 regions
 * produced: a wall of region pills, one per surviving hit, churning as the
 * camera moved.
 *
 * Inert on an unfiltered map, where the smallest region the clustering will
 * produce is far above this.
 */
const MIN_REGION_LABEL_NODES = 2;
const NODE_LABEL_PADDING = 14;
const NODE_LABEL_HEIGHT = 19;
/** Gap enforced between placed boxes, so near-misses still read as separate. */
const NODE_LABEL_GAP = 5;
/** Vertical offset from the node itself, so the chip sits under its point. */
const NODE_LABEL_OFFSET_Y = 13;

/**
 * Room the framing must leave for the LABELS, on top of the panels.
 *
 * The fit frames node POSITIONS, and what the eye meets at the edge of the map
 * is not a node - it is the chip drawn beside one. A title is centred on its
 * node and runs to `NODE_LABEL_MAX_CHARS`, so a node framed flush against the
 * right edge puts half a 220px label past it, which is exactly what "clipped"
 * looked like in the reported screenshot. Region pills are worse in the other
 * direction: they are LIFTED clear of their centroid, so a region near the top
 * hangs its pill above everything the fit measured.
 *
 * Conservative on purpose. Over-estimating costs a little air, which is the
 * side to err on for a view whose whole job is legibility; under-estimating
 * cuts words off the edge of the screen.
 */
function withLabelRoom(
  base: ViewportInsets,
  showTitles: boolean,
  showLabels: boolean,
): ViewportInsets {
  const halfTitle = showTitles
    ? (NODE_LABEL_MAX_CHARS * NODE_LABEL_CHAR_WIDTH + NODE_LABEL_PADDING) / 2
    : 0;
  return {
    left: base.left + halfTitle,
    right: base.right + halfTitle,
    top: base.top + (showLabels ? REGION_LABEL_LIFT + REGION_LABEL_HEIGHT : 0),
    bottom: base.bottom + (showTitles ? NODE_LABEL_OFFSET_Y + NODE_LABEL_HEIGHT : 0),
  };
}
/**
 * Past this the node is a speck and its title is noise.
 *
 * Measured against the DEFAULT framing, not guessed: the camera rests at
 * WORLD_SIZE * 1.15 from the centre, so the far side of the cube is already
 * ~1.65 away and half the diagonal adds more. A cap at the camera distance
 * therefore culled most of the map before the collision pass ever ran, and a
 * scoped view of 16 nodes came back with 3 titles.
 */
const NODE_LABEL_MAX_DISTANCE = WORLD_SIZE * 2.3;

const SELECTED_SCALE = 2.2;
const HOVERED_SCALE = 1.7;

function readCssColor(element: HTMLElement, token: string, fallback: string): string {
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  return value.length > 0 ? value : fallback;
}

/**
 * One 1x1 canvas, reused, purely as a CSS colour parser.
 *
 * Assigning to `fillStyle` makes the BROWSER normalize any colour it supports -
 * `hsl()` in either syntax, `oklch()`, `color-mix()`, named colours - and reading
 * it back returns `#rrggbb`. Module scope so this is one allocation for the
 * renderer's lifetime rather than one per colour.
 */
let colorParser: CanvasRenderingContext2D | null = null;

/** Scratch vectors reused by the per-frame label projection. Module scope
 *  because the frame loop must not allocate. */
const scratchForward = new Vector3();
const scratchToLabel = new Vector3();
const scratchProjected = new Vector3();

/**
 * css colour -> linear RGB triplet for the shader.
 *
 * Normalized through the browser FIRST, which is the whole point: three's
 * `Color` parses only a narrow set (hex, named, and the COMMA forms of
 * rgb()/hsl()), and silently keeps its default WHITE for anything else. Passing
 * it `hsl(200 62% 62%)` - the modern space-separated syntax - therefore painted
 * every node white and quietly made all four colour modes meaningless. The theme
 * tokens are the same hazard: they are authored in whatever colour syntax the
 * stylesheet uses, which is not this module's business to know.
 *
 * three's Color converts sRGB to linear on the way in and the renderer converts
 * back on output, so authored colours round-trip and additive blending happens in
 * linear space - which is what lets overlapping nodes brighten within their hue
 * instead of clipping.
 */
export function normalizeCssColor(css: string): string {
  if (!colorParser) {
    colorParser = document.createElement('canvas').getContext('2d');
  }
  if (!colorParser) return css;
  // Seeded first so an unparseable value leaves a known colour behind rather
  // than whatever the previous call set.
  colorParser.fillStyle = '#000000';
  colorParser.fillStyle = css;
  return colorParser.fillStyle as string;
}

function toLinearTriplet(css: string): [number, number, number] {
  const color = new Color(normalizeCssColor(css));
  return [color.r, color.g, color.b];
}

export function MemoryGraphCanvas({
  projection,
  highlighted,
  selectedIndex = null,
  onSelect,
  onActivate,
  showEdges = true,
  showLabels = true,
  showTitles = true,
  colorMode = 'cluster',
  granularity = DEFAULT_GRANULARITY,
  chromeInsets,
  framingIndices = null,
  strengths,
  ringed,
  context,
  islands,
}: MemoryGraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // One answer to "which region is this node in", rather than one per call site.
  const clustering = useMemo(
    () => resolveClustering(projection, granularity),
    [projection, granularity],
  );
  const regions = clustering.regions;
  const regionOf = clustering.regionOf;

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  /** Region pill under the cursor, when no node or title is. */
  const [hoveredRegion, setHoveredRegion] = useState<number | null>(null);
  /** Cursor position, in container coordinates, for the hover card. */
  // The container's size rides with the pointer, measured by the same handler,
  // so a hover card decides which way to flip from a size read at the moment it
  // was placed rather than from a ref read during render.
  const [pointer, setPointer] = useState<{ x: number; y: number; containerWidth: number; containerHeight: number }>(
    { x: 0, y: 0, containerWidth: 0, containerHeight: 0 },
  );
  const [isDragging, setIsDragging] = useState(false);
  const didDragRef = useRef(false);
  /** What the press landed on, resolved at press time. Null between gestures. */
  const pressRef = useRef<{ x: number; y: number; hit: number | null } | null>(null);

  // Cluster label elements, positioned imperatively each frame. Refs rather than
  // state for the same reason the scene is imperative.
  const labelRefs = useRef<Map<number, HTMLDivElement | null>>(new Map());
  /** One label per island, and where each is anchored in the world. */
  const islandLabelRefs = useRef<Array<HTMLDivElement | null>>([]);
  const islandAnchorsRef = useRef<Vector3[]>([]);
  /**
   * Where each region's pill sits, recomputed from the nodes STILL ON SCREEN.
   *
   * The projection's own centroid is the average of every node in the region,
   * which is right for an unfiltered map and wrong the moment a search or a
   * facet empties most of it: a 25-conversation region with one hit left still
   * put its name at the middle of where those 25 used to be, pointing at nothing.
   * A search returning 42 conversations across 39 regions therefore drew a wall
   * of pills over empty space, and they churned as the camera moved, which is
   * what made orbiting feel like the map was flying around.
   *
   * A ref because the frame loop reads it, written by the same effect that
   * decides which regions are visible at all - so a pill's POSITION and its
   * VISIBILITY can never disagree about which nodes they were computed from.
   */
  const labelWorldPositionsRef = useRef<Map<number, Vector3>>(new Map());
  const showLabelsRef = useRef(showLabels);

  /**
   * Clusters with enough nodes still on screen to name an AREA.
   *
   * A filter empties whole regions, and a region label hanging over the space
   * where its conversations USED to be is worse than no label: it names
   * something that is not there. The threshold is what makes that true of the
   * partial case too - with one node left the centroid is that node, and the
   * region name is then a second, vaguer label on a conversation whose own title
   * is already there. Held in a ref because the frame loop reads it and must not
   * depend on a React render having happened first.
   */
  const visibleClustersRef = useRef<Set<number>>(new Set());

  /**
   * Screen boxes of the region labels placed this frame.
   *
   * Titles are placed AFTER regions and start from these, so a conversation
   * title can never land on top of the region name. Regions win because there
   * are only a handful of them and they are the map's structural labels - a
   * title displaced by one simply goes unlabelled, which is the same trade the
   * titles already make against each other.
   */
  const regionBoxesRef = useRef<
    Array<{ id: number; left: number; top: number; right: number; bottom: number }>
  >([]);
  /** Reused across frames; the loop must not allocate. */
  const regionCandidatesRef = useRef<
    Array<{ id: number; label: string; depth: number; x: number; y: number }>
  >([]);

  /** Node indices still drawn (alpha above zero), for title eligibility. */
  const visibleNodesRef = useRef<Set<number>>(new Set());
  const showTitlesRef = useRef(showTitles);
  // The two toggles, mirrored for the frame loop, which runs on requestAnimation
  // Frame and therefore always after this layout effect has written them.
  useLayoutEffect(() => {
    showLabelsRef.current = showLabels;
    showTitlesRef.current = showTitles;
  });
  const titleRefs = useRef<Array<HTMLDivElement | null>>([]);
  /** Which node each pooled label currently shows, so its text is rewritten
   *  only when the assignment actually changes rather than every frame. */
  const titleAssignments = useRef<Int32Array>(new Int32Array(NODE_LABEL_POOL).fill(-1));
  /**
   * Screen boxes of the labels placed this frame, and the node each belongs to.
   *
   * Kept so the pointer handler can hit-test them. The label ELEMENTS stay
   * `pointer-events: none` deliberately: a real pointer target over the canvas
   * swallows the pointerdown that starts a camera drag, so dragging would break
   * whenever the gesture happened to begin on a label. Hit-testing the boxes in
   * JS gives the label the same hover and click behaviour with no such risk.
   */
  const titleBoxesRef = useRef<Array<{ index: number; left: number; top: number; right: number; bottom: number }>>([]);
  /** Reused across frames; the loop must not allocate. */
  /** Titles already placed this frame, so the same words never appear twice. */
  const placedTitlesRef = useRef<Set<string>>(new Set());
  const titleCandidatesRef = useRef<Array<{ index: number; depth: number; x: number; y: number }>>([]);

  /**
   * Position the cluster labels for this frame.
   *
   * Runs at frame rate, so it writes `style.transform` straight onto the nodes
   * and never touches React. Labels behind the camera are hidden rather than
   * projected: `Vector3.project` mirrors them to the opposite side of the screen
   * when w is negative, which reads as a label flying about at random.
   */
  const positionLabels = useCallback((scene: MemoryGraphScene) => {
    const container = containerRef.current;
    const regionBoxes = regionBoxesRef.current;
    regionBoxes.length = 0;
    if (!container) return;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const cameraPosition = scene.camera.position;
    // Module-scope scratch vectors, not fresh ones: this runs every frame, and
    // three allocations per frame is 180 objects a second of pure garbage for a
    // function whose whole job is to be cheap.
    scene.camera.getWorldDirection(scratchForward);

    // Island names first, and into the same box list, so the region pills
    // placed next step around them. Their width is estimated from the name
    // rather than measured: a layout read per label per frame is the cost this
    // loop exists to avoid.
    const islandAnchors = islandAnchorsRef.current;
    for (let slot = 0; slot < islandAnchors.length; slot += 1) {
      const element = islandLabelRefs.current[slot];
      if (!element) continue;
      const world = islandAnchors[slot];
      scratchToLabel.copy(world).sub(cameraPosition);
      if (scratchToLabel.dot(scratchForward) <= 0) {
        element.style.opacity = '0';
        continue;
      }
      scratchProjected.copy(world).project(scene.camera);
      const x = (scratchProjected.x * 0.5 + 0.5) * width;
      const y = (-scratchProjected.y * 0.5 + 0.5) * height;
      element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -100%)`;
      element.style.opacity = '1';
      const halfWidth = ((islands?.[slot]?.name.length ?? 0) * ISLAND_LABEL_CHAR_WIDTH + ISLAND_LABEL_PADDING) / 2;
      regionBoxes.push({
        id: -1 - slot,
        left: x - halfWidth - NODE_LABEL_GAP,
        right: x + halfWidth + NODE_LABEL_GAP,
        top: y - ISLAND_LABEL_HEIGHT - NODE_LABEL_GAP,
        bottom: y + NODE_LABEL_GAP,
      });
    }

    // Gather first, then place NEAREST FIRST - region pills collide with each
    // other, not just with titles. Two clusters whose centroids project close
    // together stacked their labels directly on top of one another, which is the
    // same failure the titles already avoid and looks worse here because a pill
    // is opaque. Now the closer region keeps its label and the farther one drops
    // it, so a name is never hidden underneath another name.
    const candidates = regionCandidatesRef.current;
    candidates.length = 0;
    for (const cluster of regions) {
      if (!showLabelsRef.current || !visibleClustersRef.current.has(cluster.id)) continue;
      const world = labelWorldPositionsRef.current.get(cluster.id);
      if (!world) continue;
      scratchToLabel.copy(world).sub(cameraPosition);
      // Behind the camera: `project` mirrors those to the opposite side of the
      // screen when w is negative, which reads as a label flying about at random.
      if (scratchToLabel.dot(scratchForward) <= 0) continue;
      const depth = scratchToLabel.length();
      scratchProjected.copy(world).project(scene.camera);
      candidates.push({
        id: cluster.id,
        label: cluster.label,
        depth,
        x: (scratchProjected.x * 0.5 + 0.5) * width,
        y: (-scratchProjected.y * 0.5 + 0.5) * height - REGION_LABEL_LIFT,
      });
    }
    candidates.sort((first, second) => first.depth - second.depth);

    const placedIds = new Set<number>();
    for (const candidate of candidates) {
      const boxWidth = candidate.label.length * REGION_LABEL_CHAR_WIDTH + REGION_LABEL_PADDING;
      const left = candidate.x - boxWidth / 2 - NODE_LABEL_GAP;
      const right = candidate.x + boxWidth / 2 + NODE_LABEL_GAP;
      const top = candidate.y - REGION_LABEL_HEIGHT / 2 - NODE_LABEL_GAP;
      const bottom = candidate.y + REGION_LABEL_HEIGHT / 2 + NODE_LABEL_GAP;

      let collides = false;
      for (const placed of regionBoxes) {
        if (left < placed.right && right > placed.left && top < placed.bottom && bottom > placed.top) {
          collides = true;
          break;
        }
      }
      if (collides) continue;

      const element = labelRefs.current.get(candidate.id);
      if (element) {
        element.style.transform =
          `translate3d(${candidate.x}px, ${candidate.y}px, 0) translate(-50%, -50%)`;
        // Floors higher than the titles do (0.5 against 0.28), because a region
        // name that has faded out has taken the map's orientation with it.
        element.style.opacity = String(
          Math.max(0.5, Math.min(1, 1.6 - candidate.depth / (WORLD_SIZE * 1.6))),
        );
      }
      placedIds.add(candidate.id);
      regionBoxes.push({ id: candidate.id, left, right, top, bottom });
    }

    // Everything that did not get placed is hidden explicitly, including the
    // ones dropped for colliding.
    for (const cluster of regions) {
      if (placedIds.has(cluster.id)) continue;
      const element = labelRefs.current.get(cluster.id);
      if (element) element.style.opacity = '0';
    }
  }, [regions, islands]);

  /**
   * Place the node titles for this frame.
   *
   * Nearest to camera wins. Candidates are sorted by depth and placed greedily;
   * anything whose box would touch an already-placed box is dropped entirely
   * rather than drawn underneath. That single rule is what keeps the map
   * readable at any density: labels never stack, so the worst case is fewer
   * names, never an unreadable pile of them.
   *
   * Runs inside the frame callback, so it writes styles directly and never
   * touches React. The one text write is guarded on the assignment actually
   * changing, since `textContent` invalidates layout.
   */
  const positionTitles = useCallback((scene: MemoryGraphScene) => {
    const container = containerRef.current;
    const boxes = titleBoxesRef.current;
    boxes.length = 0;
    if (!container) return;
    // Region labels are already placed for this frame and are not negotiable, so
    // they enter the collision set before any title competes for space.
    for (const region of regionBoxesRef.current) {
      boxes.push({
        index: -1,
        left: region.left,
        right: region.right,
        top: region.top,
        bottom: region.bottom,
      });
    }
    const placedTitles = placedTitlesRef.current;
    placedTitles.clear();

    const elements = titleRefs.current;
    const assignments = titleAssignments.current;
    if (!showTitlesRef.current) {
      for (let slot = 0; slot < elements.length; slot += 1) {
        const element = elements[slot];
        if (element) element.style.opacity = '0';
      }
      return;
    }

    const width = container.clientWidth;
    const height = container.clientHeight;
    const cameraPosition = scene.camera.position;
    scene.camera.getWorldDirection(scratchForward);

    const candidates = titleCandidatesRef.current;
    candidates.length = 0;
    const visible = visibleNodesRef.current;
    const hasFilter = visible.size > 0;

    for (let index = 0; index < scene.positions.length; index += 1) {
      if (hasFilter && !visible.has(index)) continue;
      if (!projection.nodes[index]?.title) continue;
      const world = scene.positions[index];
      scratchToLabel.copy(world).sub(cameraPosition);
      // Behind the camera: `project` mirrors those to the opposite side of the
      // screen when w is negative, which reads as text flying about at random.
      if (scratchToLabel.dot(scratchForward) <= 0) continue;
      const depth = scratchToLabel.length();
      if (depth > NODE_LABEL_MAX_DISTANCE) continue;
      scratchProjected.copy(world).project(scene.camera);
      const x = (scratchProjected.x * 0.5 + 0.5) * width;
      const y = (-scratchProjected.y * 0.5 + 0.5) * height + NODE_LABEL_OFFSET_Y;
      if (x < 0 || x > width || y < 0 || y > height) continue;
      candidates.push({ index, depth, x, y });
    }

    candidates.sort((first, second) => first.depth - second.depth);

    let slot = 0;
    for (const candidate of candidates) {
      if (slot >= NODE_LABEL_POOL) break;
      const title = projection.nodes[candidate.index].title ?? '';
      const clipped = title.length > NODE_LABEL_MAX_CHARS
        ? `${title.slice(0, NODE_LABEL_MAX_CHARS - 1)}\u2026`
        : title;
      const boxWidth = clipped.length * NODE_LABEL_CHAR_WIDTH + NODE_LABEL_PADDING;
      const left = candidate.x - boxWidth / 2 - NODE_LABEL_GAP;
      const right = candidate.x + boxWidth / 2 + NODE_LABEL_GAP;
      const top = candidate.y - NODE_LABEL_HEIGHT / 2 - NODE_LABEL_GAP;
      const bottom = candidate.y + NODE_LABEL_HEIGHT / 2 + NODE_LABEL_GAP;

      // One label per distinct TITLE. Several conversations can belong to one
      // task and a node is named after its task, so the same words legitimately
      // appear on several points - truthful, and it reads as a rendering bug.
      // The nearest one keeps the label; the rest go unlabelled exactly as a
      // collision-dropped node does.
      if (placedTitles.has(clipped)) continue;

      let collides = false;
      for (const placed of boxes) {
        if (left < placed.right && right > placed.left && top < placed.bottom && bottom > placed.top) {
          collides = true;
          break;
        }
      }
      if (collides) continue;

      const element = elements[slot];
      if (element) {
        if (assignments[slot] !== candidate.index) {
          element.textContent = clipped;
          assignments[slot] = candidate.index;
        }
        element.style.transform =
          `translate3d(${candidate.x}px, ${candidate.y}px, 0) translate(-50%, -50%)`;
        // Capped BELOW full strength on purpose: even the nearest title stays
        // subordinate to the region label it sits inside.
        element.style.opacity = String(
          Math.max(0.28, Math.min(0.82, 1.3 - candidate.depth / NODE_LABEL_MAX_DISTANCE)),
        );
      }
      // The un-padded box is what the pointer tests against, so the gap that
      // keeps labels apart does not become dead space that swallows hovers.
      placedTitles.add(clipped);
      boxes.push({
        index: candidate.index,
        left: left + NODE_LABEL_GAP,
        right: right - NODE_LABEL_GAP,
        top: top + NODE_LABEL_GAP,
        bottom: bottom - NODE_LABEL_GAP,
      });
      slot += 1;
    }

    for (let empty = slot; empty < elements.length; empty += 1) {
      const element = elements[empty];
      if (element) element.style.opacity = '0';
    }
  }, [projection.nodes]);

  /** Both DOM overlays in one frame callback: region labels, then titles. */
  /**
   * The node under the cursor, counting its TITLE as part of it.
   *
   * A label is a much larger target than the point it names, and it is the thing
   * the user is actually reading, so hovering the words has to mean hovering the
   * conversation. Done here rather than by giving the label element real pointer
   * events, because a pointer target sitting over the canvas swallows the
   * pointerdown that starts a camera drag - dragging would break whenever the
   * gesture happened to begin on top of a label.
   *
   * The point itself wins when both hit, since it is the more precise gesture.
   */
  /**
   * The region pill under the cursor, or null.
   *
   * Hit-tested against the boxes the frame loop placed, exactly as titles are,
   * so the pills stay `pointer-events: none` and cannot swallow the pointerdown
   * that starts a camera drag.
   */
  const pickRegion = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    for (const box of regionBoxesRef.current) {
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return box.id;
    }
    return null;
  }, []);

  const pickIncludingTitle = useCallback((clientX: number, clientY: number, direct: number | null) => {
    if (direct !== null) return direct;
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    // Boxes are in nearest-first order, so the first hit is the front-most
    // label - the same rule that decided which of them got drawn.
    for (const box of titleBoxesRef.current) {
      // Seeded region boxes carry -1: they reserve space but name no node.
      if (box.index < 0) continue;
      if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return box.index;
    }
    return null;
  }, []);

  const positionOverlays = useCallback((scene: MemoryGraphScene) => {
    positionLabels(scene);
    positionTitles(scene);
  }, [positionLabels, positionTitles]);

  /**
   * Link colour, read from the theme AFTER mount.
   *
   * State rather than a `useMemo`, because a memo runs during the FIRST render,
   * when `containerRef.current` is still null - so it could only ever return the
   * hardcoded fallback, and the theme token would never be read at all.
   *
   * Muted FOREGROUND, never the edge/border token: that one sits a couple of
   * values off the surface colour, so at link alpha it is invisible.
   */
  const [edgeColor, setEdgeColor] = useState('#8b949e');
  // The highlight accent, read the same way and for the same reason: the node
  // styles need it, and a memo that reached for the container during render
  // could only ever see the fallback on the first pass.
  const [accentColor, setAccentColor] = useState('#4ade80');
  // The grey a context node draws in, from the theme like the two above.
  const [contextColor, setContextColor] = useState('#71717a');
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setEdgeColor(normalizeCssColor(readCssColor(container, '--color-fg-muted', '#8b949e')));
    setAccentColor(readCssColor(container, '--kng-active', '#4ade80'));
    setContextColor(readCssColor(container, '--kng-fg-faint', '#71717a'));
  }, []);

  const framingInsets = useMemo(
    () => withLabelRoom(chromeInsets ?? NO_VIEWPORT_INSETS, showTitles, showLabels),
    [chromeInsets, showTitles, showLabels],
  );

  const graph = useMemoryGraphScene({
    canvasRef,
    containerRef,
    nodes: projection.nodes,
    edges: projection.edges,
    signature: projection.signature,
    edgeColor,
    regionOf,
    onFrame: positionOverlays,
    insets: framingInsets,
    framingIndices,
  });
  const { requestRender, resetView, frameNodes, setOrbitAnchor } = graph;

  // Each island's label anchor: above its highest node, over its centre.
  // Recomputed only when the scene or the islands change, never per frame.
  useEffect(() => {
    const scene = graph.scene;
    if (!scene || !islands || islands.length === 0) {
      islandAnchorsRef.current = [];
      return;
    }
    islandAnchorsRef.current = islands.map((island) => {
      let sumX = 0;
      let sumZ = 0;
      let highest = -Infinity;
      let count = 0;
      for (let index = island.start; index < island.end; index += 1) {
        const position = scene.positions[index];
        if (!position) continue;
        sumX += position.x;
        sumZ += position.z;
        if (position.y > highest) highest = position.y;
        count += 1;
      }
      return count > 0 ? new Vector3(sumX / count, highest + ISLAND_LABEL_LIFT, sumZ / count) : new Vector3();
    });
    requestRender();
  }, [graph.scene, islands, requestRender]);

  /**
   * The camera legend opens from a button instead of standing on the map. The
   * keys are learned once, and a card read on every open cost the corner the
   * chat now runs down into.
   *
   * While open it takes Escape first (the open-menu shape in
   * `keybindings-registry.md`: capture phase, registered only while open), so
   * Escape closes the legend and not the graph under it. A press anywhere
   * outside the legend and its button closes it too.
   */
  // The hover and selection the last style write saw, so that write can tell a
  // pointer change (snap) from an emphasis change (ease).
  const pointerStateRef = useRef<{ hovered: number | null; selected: number | null }>({ hovered: null, selected: null });
  const paneInsets = chromeInsets ?? NO_VIEWPORT_INSETS;
  // Half the toolbar's width, so the clamp below can keep its edges clear of
  // the rails. Its content never changes, so one measurement is enough.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [toolbarHalfWidth, setToolbarHalfWidth] = useState(0);
  useLayoutEffect(() => {
    if (toolbarRef.current) setToolbarHalfWidth(toolbarRef.current.offsetWidth / 2);
  }, []);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendRef = useRef<HTMLDivElement | null>(null);
  const legendButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!legendOpen) return;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setLegendOpen(false);
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target && (legendRef.current?.contains(target) || legendButtonRef.current?.contains(target))) return;
      setLegendOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [legendOpen]);

  /**
   * A selected node becomes the pivot.
   *
   * Asked for directly, and it is the right default for a spatial view: once you
   * have picked a conversation, "turn this around so I can see what is behind
   * it" is the next thing you want, and orbiting about the map's centre swings
   * your subject across the screen instead. The camera does not move when this
   * changes - only what a drag means.
   */
  useEffect(() => {
    setOrbitAnchor(selectedIndex ?? null);
  }, [selectedIndex, setOrbitAnchor]);

  // ---- per-node styling -----------------------------------------------------
  /** Newest-to-oldest position of each node, for recency tinting. Rank rather
   *  than raw age so one ancient conversation cannot flatten the whole scale. */
  const recencyRank = useMemo(() => {
    const withTs = projection.nodes
      .map((node, index) => ({ index, ts: node.lastActivityMs ?? 0 }))
      .sort((first, second) => second.ts - first.ts);
    const ranks = new Float32Array(projection.nodes.length);
    withTs.forEach((entry, position) => {
      ranks[entry.index] = withTs.length <= 1 ? 0 : position / (withTs.length - 1);
    });
    return ranks;
  }, [projection.nodes]);

  /**
   * Shortest-to-longest position of each node, for the length ramp.
   *
   * Rank, not the value, and not a log of it either - the same trap the link
   * weights and the similarity percentages both fell into. Measured on the real
   * 648-conversation corpus, `chunkCount` runs 1 to 1509 but the middle 80% sits
   * between 13 and 157, so a log scale against the maximum spends two thirds of
   * its range on a handful of outliers and squeezes almost every conversation
   * into a third of the ramp: 0.361 at the 10th percentile to 0.692 at the 90th.
   * At one hue that is a twenty-point saturation difference across four fifths
   * of the map, which is exactly the sea of blue it produced. A rank uses the
   * whole ramp whatever the distribution.
   */
  const lengthRank = useMemo(() => {
    const bySize = projection.nodes
      .map((node, index) => ({ index, chunks: node.chunkCount }))
      .sort((first, second) => first.chunks - second.chunks);
    const ranks = new Float32Array(projection.nodes.length);
    bySize.forEach((entry, position) => {
      ranks[entry.index] = bySize.length <= 1 ? 1 : position / (bySize.length - 1);
    });
    return ranks;
  }, [projection.nodes]);

  /**
   * Cheapest-to-dearest position, for the cost ramp.
   *
   * Rank for the same reason length is: measured on the real corpus, cost runs
   * $0 to $155.80 with a median of $15.33, so a linear or log scale hands most
   * of the range to a handful of expensive sessions.
   *
   * A conversation with no recorded cost sorts LAST and is drawn at the muted
   * end rather than being hidden. It is a real conversation; what is missing is
   * the metric, and hiding it would make the map lie about what the index holds.
   */
  const costRank = useMemo(
    () => rankByMetric(projection.nodes, (node) => node.costUsd),
    [projection.nodes],
  );

  /**
   * Shortest-to-longest WALL TIME, for the duration ramp.
   *
   * Its own mode rather than a rename of length, because they are not the same
   * thing: rank correlation 0.507 on the real corpus, where duration itself runs
   * a 33-minute median against a 9.6-hour longest. A conversation can be brief
   * and slow (a small model thinking) or long and quick.
   */
  const durationRank = useMemo(
    () => rankByMetric(projection.nodes, (node) => node.durationMs),
    [projection.nodes],
  );

  /**
   * How many links each node has in the mesh that is actually DRAWN.
   *
   * Deliberately the drawn edge list rather than the exact neighbour lists: this
   * drives a node's SIZE, so it is a claim the eye can check. A node that reads
   * as a hub should have visibly many lines leaving it, and sizing off links the
   * viewer cannot see would be a size that disagrees with the picture.
   */
  const degrees = useMemo(() => {
    const counts = new Int32Array(projection.nodes.length);
    for (const edge of projection.edges) {
      if (counts[edge.source] !== undefined) counts[edge.source] += 1;
      if (counts[edge.target] !== undefined) counts[edge.target] += 1;
    }
    return counts;
  }, [projection.nodes.length, projection.edges]);

  const maxDegree = useMemo(
    () => degrees.reduce((highest, degree) => Math.max(highest, degree), 1),
    [degrees],
  );

  const styles = useMemo<SceneNodeStyle[]>(() => {
    const hasHighlight = highlighted !== undefined && highlighted.size > 0;
    const accentTriplet = toLinearTriplet(accentColor);
    const contextTriplet = toLinearTriplet(contextColor);

    return projection.nodes.map((node, index) => {
      const isSelected = index === selectedIndex;
      const isHovered = index === hoveredIndex;
      const isLit = hasHighlight && highlighted.has(index);
      // An unlit node a question leaves in scope: grey context, not hidden.
      const isContext = hasHighlight && !isLit && !isSelected && context !== undefined
        && (context.scope === null || context.scope.has(index));

      // A lit node KEEPS its colour mode's colour: the answer's tasks read in
      // their topic's colour against grey context, the way the Ask mockup draws
      // them. Painting every lit node the one accent green hid which topics the
      // answer came from, and made a filter alone recolour the whole map.
      let color: [number, number, number];
      if (isSelected) {
        color = accentTriplet;
      } else if (isContext) {
        color = contextTriplet;
      } else if (colorMode === 'cluster') {
        color = toLinearTriplet(`hsl(${clusterHue(regionOf(node))} 62% 62%)`);
      } else if (colorMode === 'recency') {
        // Bright and warm for recent, dim and cool for old.
        const rank = recencyRank[index];
        color = toLinearTriplet(
          `hsl(${28 + rank * 180} ${Math.round(70 - rank * 45)}% ${Math.round(68 - rank * 30)}%)`,
        );
      } else if (colorMode === 'outcome') {
        // Green shipped, amber still on the board, grey abandoned. These are
        // genuinely separable now that the lane decides the outcome rather than
        // `archived_at`; while archiving won, everything finished landed in the
        // grey bucket and this mode painted a real board one flat colour.
        // Position still carries the topic, so this never relies on colour alone.
        if (node.outcome === 'done') color = toLinearTriplet('hsl(150 58% 55%)');
        else if (node.outcome === 'active') color = toLinearTriplet('hsl(38 75% 58%)');
        else if (node.outcome === 'abandoned') color = toLinearTriplet('hsl(0 0% 42%)');
        else color = toLinearTriplet('hsl(0 0% 55%)');
      } else {
        // The two MAGNITUDE modes share one ramp, deliberately: they are never
        // on screen together, and reading "brighter and warmer is more" once is
        // better than learning it twice.
        //
        // A ramp across HUE as well as lightness, not one hue at varying
        // saturation. The single-hue version could not separate its own middle:
        // deep indigo at the low end through blue and teal to a warm yellow at
        // the high one, which is the standard shape for a magnitude and stays
        // readable for a reader who cannot separate two hues, since lightness
        // rises monotonically with it.
        const rank = colorMode === 'cost'
          ? costRank[index]
          : colorMode === 'duration' ? durationRank[index] : lengthRank[index];
        color = toLinearTriplet(
          `hsl(${Math.round(265 - rank * 215)} ${Math.round(55 + rank * 25)}% ${Math.round(38 + rank * 30)}%)`,
        );
      }

      // Size carries CONNECTEDNESS, not length. Length already has a colour mode
      // of its own, so encoding it here too spent the size channel on a
      // dimension the map could already show, and left hubs indistinguishable
      // from the isolated conversations around them - which is the single thing
      // a node-graph is supposed to make obvious at a glance.
      //
      // Log-scaled against the busiest node so one hub cannot flatten the rest,
      // and floored well above zero so an unconnected conversation is still a
      // legible point rather than a speck. `chunkCount` keeps a small say, so
      // two equally-connected nodes are not perfectly interchangeable.
      const connectedness = Math.log10(1 + degrees[index]) / Math.log10(1 + maxDegree);
      const lengthNudge = Math.log10(1 + node.chunkCount) / 12;
      let scale = MIN_NODE_SCALE + connectedness * DEGREE_SCALE_RANGE + lengthNudge;
      if (isSelected) scale *= SELECTED_SCALE;
      else if (isHovered) scale *= HOVERED_SCALE;
      else if (isContext) scale *= CONTEXT_SCALE;

      // A conversation linked to nothing draws quieter than one that anchors a
      // region. They are the noisiest part of the wide view - scattered specks
      // with no structure to read - and quieting them lets the connected shape
      // come forward. NOT hidden: they are real, they are often the most worth
      // rediscovering, and the Unconnected filter exists to surface them. When
      // that filter or a search DOES light one, it goes back to full strength,
      // because at that point it is the answer rather than background.
      const isolated = degrees[index] === 0 && !isLit && !isSelected && !isHovered;
      // A lit node's strength is how closely it relates to the question, so the
      // related set reads as a gradient toward the tasks the answer is about.
      const strength = isLit ? strengths?.get(index) : undefined;
      let alpha: number;
      if (isContext) alpha = CONTEXT_ALPHA;
      else if (hasHighlight && !isLit && !isSelected) alpha = HIDDEN_ALPHA;
      else if (strength !== undefined && !isSelected && !isHovered) {
        alpha = WEAKEST_LIT_ALPHA + (1 - WEAKEST_LIT_ALPHA) * Math.max(0, Math.min(1, strength));
      } else alpha = isolated ? ISOLATED_ALPHA : 1;
      const ring = isLit && ringed?.has(index) ? 1 : 0;
      // A ringed node is one the reader should find first, so it also draws larger.
      return { color, scale: ring ? scale * RINGED_SCALE : scale, alpha, ring };
    });
  }, [
    projection.nodes, highlighted, selectedIndex, hoveredIndex, colorMode,
    recencyRank, lengthRank, durationRank, costRank, degrees, maxDegree, regionOf,
    accentColor, contextColor, strengths, ringed, context,
  ]);

  useEffect(() => {
    // Recomputed alongside the styles, from the same alphas the scene gets, so a
    // label can never disagree with whether its region is drawn.
    const drawn: number[] = [];
    const hasHighlight = highlighted !== undefined && highlighted.size > 0;
    for (let index = 0; index < styles.length; index += 1) {
      if (styles[index].alpha <= 0) continue;
      // Grey context behind a question draws but never labels: only what the
      // question lit names a region or carries a title, or every region on the
      // map would get its pill back the moment context stopped being hidden.
      if (hasHighlight && !highlighted.has(index) && index !== selectedIndex) continue;
      drawn.push(index);
    }
    // A weakly related node is context: a dot, with no title and no say in
    // which regions get a pill. Every lit node used to label itself and its
    // region, so tasks the answer never mentioned named half the map. Kept when
    // nothing stronger is drawn, or the map would lose every label at once.
    const prominent = drawn.filter(
      (index) => index === selectedIndex || (strengths?.get(index) ?? 1) >= LABEL_MIN_STRENGTH,
    );
    const labelled = prominent.length > 0 ? prominent : drawn;

    const visibleNodes = new Set<number>();
    // Running sum per region, so a pill lands on the conversations it still has
    // rather than on the middle of where its region used to be.
    const centroids = new Map<number, { x: number; y: number; z: number; count: number }>();
    for (const index of labelled) {
      visibleNodes.add(index);
      const node = projection.nodes[index];
      const region = regionOf(node);
      const running = centroids.get(region);
      if (running) {
        running.x += node.x;
        running.y += node.y;
        running.z += node.z;
        running.count += 1;
      } else {
        centroids.set(region, { x: node.x, y: node.y, z: node.z, count: 1 });
      }
    }

    const visible = new Set<number>();
    const positions = new Map<number, Vector3>();
    for (const [region, sum] of centroids) {
      if (sum.count < MIN_REGION_LABEL_NODES) continue;
      visible.add(region);
      positions.set(region, new Vector3(
        (sum.x / sum.count - 0.5) * WORLD_SIZE,
        (sum.y / sum.count - 0.5) * WORLD_SIZE,
        (sum.z / sum.count - 0.5) * WORLD_SIZE,
      ));
    }
    visibleClustersRef.current = visible;
    labelWorldPositionsRef.current = positions;
    // Titles follow the same alpha the scene gets, so a filtered-out
    // conversation cannot leave its name floating over the map.
    visibleNodesRef.current = visibleNodes;

    // Hover and selection answer the pointer, so they snap; a change of what the
    // map emphasises (a turn, a filter, a colour mode) eases. Easing a hover made
    // every pointer move lag by the transition.
    const pointerMoved = pointerStateRef.current.hovered !== hoveredIndex
      || pointerStateRef.current.selected !== selectedIndex;
    pointerStateRef.current = { hovered: hoveredIndex, selected: selectedIndex };
    graph.scene?.setNodeStyles(styles, { animate: !pointerMoved });
    requestRender();
  }, [styles, projection.nodes, graph.scene, requestRender, regionOf, strengths, selectedIndex, hoveredIndex, highlighted]);

  useEffect(() => {
    graph.scene?.setEdgeOpacity(showEdges ? 0.14 : 0);
    requestRender();
  }, [showEdges, graph.scene, requestRender]);

  useEffect(() => {
    requestRender();
  }, [showLabels, requestRender]);

  // Keyed on the overlay callback itself, so a change to the PLACEMENT logic
  // repaints too - not just a change to the flags. Without it a Fast Refresh
  // edit to this file leaves the last frame's labels frozen on screen until the
  // user happens to interact, because render-on-demand correctly sees no state
  // change to react to. Dev-only in practice, and the team dogfoods from
  // , so it has to look like a fresh boot.
  useEffect(() => {
    requestRender();
  }, [positionOverlays, showTitles, requestRender]);

  /**
   * Fly to frame the surviving set whenever a filter narrows the map.
   *
   * This is the other half of hiding the rest: scoping the view is only useful
   * if the camera then goes there, otherwise a query can leave you staring at
   * empty space where the non-matches used to be. Keyed on a stable signature of
   * the set, so re-renders that do not change WHICH nodes match never re-fly.
   *
   * Clearing the filter deliberately does NOT fly back. The user may have moved
   * the camera themselves, and yanking it somewhere on a clear is worse than
   * leaving it - "Reset view" is the explicit way home.
   */
  const highlightKey = highlighted && highlighted.size > 0
    ? `${highlighted.size}:${[...highlighted].slice(0, 8).join(',')}`
    : null;
  useEffect(() => {
    if (!highlightKey || !highlighted) return;
    frameNodes([...highlighted]);
    // `highlighted` is intentionally absent: a new Set with the same members
    // would otherwise re-fly on every unrelated re-render. `highlightKey` is the
    // stable identity of its CONTENTS.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [highlightKey, frameNodes]);

  // ---- picking --------------------------------------------------------------
  const pickAt = useCallback((clientX: number, clientY: number): number | null => {
    const container = containerRef.current;
    const scene = graph.scene;
    if (!container || !scene) return null;
    const rect = container.getBoundingClientRect();
    const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;
    return scene.pick(ndcX, ndcY);
  }, [graph.scene]);

  return (
    <div
      ref={containerRef}
      // A size container so the camera toolbar can compact on a narrow surface.
      className="@container absolute inset-0 overflow-hidden"
      // The camera cursor is `grab`/`grabbing`, which is NOT `pointer`, so light
      // dismiss classifies it as dead space and a drag here would close the
      // user's open windows. See .claude/rules/light-dismiss-denylist.md.
      data-no-dismiss
      data-testid="memory-graph-canvas"
      data-view-mode="3d"
    >
      {graph.unavailableReason ? (
        <div
          className="absolute inset-0 flex items-center justify-center p-8"
          data-testid="memory-graph-webgl-unavailable"
        >
          <div className="max-w-md text-center">
            <div className="mb-1 text-sm font-semibold text-fg">The map needs a GPU</div>
            <p className="text-sm text-fg-muted">
              This machine could not provide a 3D drawing context, so the map cannot be drawn.
              Coverage and search still work.
            </p>
          </div>
        </div>
      ) : null}

      <canvas
        ref={canvasRef}
        // Focusable so the fly keys have somewhere to land. Not in the tab order:
        // it is a direct-manipulation surface, and a tab stop that swallows WASD
        // would be a trap for keyboard users passing through.
        tabIndex={-1}
        className="block h-full w-full outline-none"
        style={{ cursor: isDragging ? 'grabbing' : hoveredIndex !== null ? 'pointer' : 'grab' }}
        onPointerDown={(event) => {
          didDragRef.current = false;
          pressRef.current = {
            x: event.clientX,
            y: event.clientY,
            // Resolved HERE, against the frame the user actually clicked on.
            // Re-picking at release instead was the bug: `setViewOffset` and the
            // camera's own damping both keep moving between down and up, so the
            // same screen point can miss the node it hit a moment earlier - the
            // panel opened on the press and vanished on the release.
            hit: pickIncludingTitle(event.clientX, event.clientY, pickAt(event.clientX, event.clientY)),
          };
          setIsDragging(true);
          canvasRef.current?.focus();
        }}
        onPointerMove={(event) => {
          const press = pressRef.current;
          if (press) {
            // A real drag, not a hand tremor. `isDragging` is React state set in
            // the pointerdown handler, so a move arriving in the same tick still
            // reads the OLD value - the slop test has to run off the ref.
            if (
              Math.abs(event.clientX - press.x) > DRAG_SLOP_PX
              || Math.abs(event.clientY - press.y) > DRAG_SLOP_PX
            ) {
              didDragRef.current = true;
            }
            return;
          }
          // The region PILL wins, and that ordering is not arbitrary: the pill is
          // opaque, so whatever sits behind it is not visible, and pointing at
          // something you cannot see cannot be what you meant. Letting the node
          // win instead meant the region card almost never appeared, because a
          // pill sits over its own cluster where the nodes are densest.
          const region = pickRegion(event.clientX, event.clientY);
          const hit = region !== null
            ? null
            : pickIncludingTitle(event.clientX, event.clientY, pickAt(event.clientX, event.clientY));
          if (hit !== null || region !== null) {
            const container = containerRef.current;
            const rect = container?.getBoundingClientRect();
            if (container && rect) {
              setPointer({
                x: event.clientX - rect.left,
                y: event.clientY - rect.top,
                containerWidth: container.clientWidth,
                containerHeight: container.clientHeight,
              });
            }
          }
          if (hit !== hoveredIndex) setHoveredIndex(hit);
          if (region !== hoveredRegion) setHoveredRegion(region);
        }}
        onPointerUp={() => {
          // Selection is decided once, by the whole gesture: what the press
          // landed on, and whether the pointer then travelled. A drag is camera
          // work and changes nothing; a clean click selects what it hit, or
          // clears when it hit nothing.
          const press = pressRef.current;
          pressRef.current = null;
          setIsDragging(false);
          if (!press || didDragRef.current) return;
          onSelect?.(press.hit);
        }}
        onPointerLeave={() => {
          pressRef.current = null;
          setIsDragging(false);
          setHoveredIndex(null);
          setHoveredRegion(null);
        }}
        onDoubleClick={(event) => {
          const hit = pickIncludingTitle(event.clientX, event.clientY, pickAt(event.clientX, event.clientY));
          if (hit !== null) onActivate?.(hit);
        }}
      />

      {/* Cluster labels as DOM, not painted into the scene: sharper at any pixel
          ratio, theme-aware, selectable, and no texture atlas to manage. Their
          transforms are written by `positionLabels` inside the frame loop. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden={!showLabels}>
        {regions.map((cluster) => (
          <ClusterLabel
            key={cluster.id}
            cluster={cluster}
            tinted={colorMode === 'cluster'}
            ref={(element) => { labelRefs.current.set(cluster.id, element); }}
          />
        ))}
      </div>

      {/* Island names: the projects, over each one's island. Always shown,
          since they name where you are, not a topic; positioned by
          `positionLabels`. */}
      {islands && islands.length > 0 ? (
        <div className="pointer-events-none absolute inset-0">
          {islands.map((island, slot) => (
            <div
              key={`${island.name}:${island.start}`}
              ref={(element) => { islandLabelRefs.current[slot] = element; }}
              className="absolute left-0 top-0 whitespace-nowrap rounded-md border border-edge bg-surface-raised/90 px-2.5 py-1 text-xs font-semibold text-fg shadow-sm will-change-transform"
              style={{ opacity: 0 }}
              data-testid="memory-graph-island-label"
            >
              {island.name}
            </div>
          ))}
        </div>
      ) : null}

      {/* A fixed POOL of title chips, reassigned each frame rather than one
          element per node: the map can hold hundreds of conversations and only
          a few dozen can ever be legible at once, so the DOM stays small and
          stable while the frame loop decides who currently owns each slot.
          `pointer-events-none` is load-bearing - see `pickIncludingTitle`. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {Array.from({ length: NODE_LABEL_POOL }, (_unused, slot) => (
          <div
            key={slot}
            ref={(element) => { titleRefs.current[slot] = element; }}
            data-testid="memory-graph-node-title"
            // Deliberately QUIET. A solid raised chip with a shadow made the
            // detail layer louder than the structural one: conversation titles
            // read as the map's content and the region names - which say what
            // an AREA is about - receded behind them. Titles keep just enough
            // backing to stay legible over the link mesh and nothing more.
            className="absolute left-0 top-0 max-w-[15rem] truncate rounded bg-surface/45 px-1.5 py-0.5 text-[11px] text-fg-muted backdrop-blur-[2px] whitespace-nowrap"
            // Starts hidden: the first frame places it. Without this every chip
            // flashes at the container origin on mount.
            style={{ opacity: 0 }}
          />
        ))}
      </div>

      {hoveredIndex === null && hoveredRegion !== null ? (
        <RegionHoverCard
          cluster={regions.find((entry) => entry.id === hoveredRegion) ?? null}
          regionOf={regionOf}
          nodes={projection.nodes}
          x={pointer.x}
          y={pointer.y}
          containerWidth={pointer.containerWidth}
          containerHeight={pointer.containerHeight}
        />
      ) : null}

      {hoveredIndex !== null ? (
        <HoverCard
          node={projection.nodes[hoveredIndex]}
          cluster={regions.find(
            (entry) => entry.id === regionOf(projection.nodes[hoveredIndex]),
          ) ?? null}
          x={pointer.x}
          y={pointer.y}
          containerWidth={pointer.containerWidth}
          containerHeight={pointer.containerHeight}
        />
      ) : null}

      {/* The camera toolbar: Reset view, and the key legend behind a labelled
          button, centred at the bottom of the map where design tools keep
          their canvas controls.

          Both used to sit in corners that panels own. Reset view held the
          bottom right, which cut the chat short, and a bottom-left cluster
          slid under the left rail on a tall window, since that rail grows with
          its region list. Reset view is the control reached for most while
          navigating, so it is a full-size labelled button, not a chip.

          It holds the surface's centre and does not move when the chat opens:
          centring on the pane between the rails slid it sideways on every
          open. The clamp only moves it on a window too narrow for the centre
          to clear a rail, where overlapping the chat would be worse.

          Marked as chrome so the framing keeps the map clear of it. */}
      <div
        ref={toolbarRef}
        data-graph-chrome="bottom"
        data-testid="memory-graph-camera-controls"
        className="absolute bottom-3 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-edge bg-surface-raised/90 p-1 shadow-xl backdrop-blur-md"
        style={{
          left: `clamp(${paneInsets.left + toolbarHalfWidth}px, 50%, calc(100% - ${paneInsets.right + toolbarHalfWidth}px))`,
        }}
      >
        <button
          type="button"
          onClick={resetView}
          onPointerDown={(event) => event.stopPropagation()}
          title="Fly back to the opening view"
          data-testid="memory-graph-reset-view"
          className="flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium text-fg transition-colors hover:bg-surface-hover cursor-pointer"
        >
          <RotateCcw size={14} aria-hidden />
          Reset view
        </button>
        <span className="h-5 w-px bg-edge" aria-hidden />
        <button
          ref={legendButtonRef}
          type="button"
          onClick={() => setLegendOpen((open) => !open)}
          onPointerDown={(event) => event.stopPropagation()}
          title="Show the camera keys"
          aria-label="Controls"
          aria-expanded={legendOpen}
          data-testid="memory-graph-camera-toggle"
          className={`flex h-8 items-center gap-2 rounded-md px-3 text-xs transition-colors hover:bg-surface-hover hover:text-fg cursor-pointer ${legendOpen ? 'bg-surface-hover text-fg' : 'text-fg-muted'}`}
        >
          <Keyboard size={14} aria-hidden />
          {/* Dropped on a narrow surface: at the 900px floor with the chat open,
              the gap between the rails is about 200px, and the labelled
              toolbar is wider than that. Reset view keeps its label. */}
          <span className="hidden @[1100px]:inline">Controls</span>
        </button>

        {/* A control LEGEND, in the shape games use: the keys, and nothing else
            until you point at one.

            Three earlier forms were wrong, each for its own reason. A SENTENCE
            with a help icon reads as prose to be parsed rather than a mapping to
            be glanced at. Keys with their verbs permanently beside them fixed
            that and spent a third of the card on words nobody re-reads. A shared
            caption line under the keys fixed THAT and still reserved a whole row
            of the panel to say nothing most of the time. What earns space is the
            part you cannot deduce - which keys do anything at all - so the verb
            is a tooltip and the card is the keys. This is the only surface in the
            app navigated by flying, so none of these gestures transfer from the
            rest of the UI.

            It opens above the toolbar, over the map. Absolutely positioned, so
            it adds nothing to the toolbar's measured chrome and opening it does
            not re-aim the camera. */}
        {legendOpen ? (
          <div
            ref={legendRef}
            data-testid="memory-graph-camera-hint"
            className="pointer-events-none absolute bottom-full left-1/2 mb-2 flex w-max -translate-x-1/2 items-center gap-3 rounded-md border border-edge bg-surface-raised/95 px-3 py-2 shadow-xl backdrop-blur"
          >
            {/* KEYBOARD, in the physical arrangement - W over A S D, with Q and E
                beside them where they sit on the board. A flat row of the same
                letters is a list of letters; this is a picture of where your
                fingers go, and it is recognised rather than read. */}
            <LegendGroup binding="move" label="Fly Forward and Sideways">
              <KeyCap>W</KeyCap>
              <div className="flex gap-[3px]">
                <KeyCap>A</KeyCap>
                <KeyCap>S</KeyCap>
                <KeyCap>D</KeyCap>
              </div>
            </LegendGroup>

            {/* A SHORTER, quieter rule inside the keyboard group. W A S D and Q E do
                different jobs and were reading as one run of keys, but they are
                still the same hand - so the separation has to be visibly weaker
                than the one dividing keyboard from mouse, or the hierarchy flattens
                and the panel becomes five equal things. */}
            <span className="h-4 w-px bg-edge/60" aria-hidden />

            <LegendGroup binding="up-and-down" label="Fly Up and Down">
              <div className="flex gap-[3px]">
                <KeyCap>Q</KeyCap>
                <KeyCap>E</KeyCap>
              </div>
            </LegendGroup>

            <span className="h-7 w-px bg-edge" aria-hidden />

            {/* MOUSE. `Right Drag`, not `Shift + Drag`: camera-controls binds
                actions to left / middle / right / wheel and has no shift-modified
                button at all, so the gesture the legend used to advertise did
                nothing whatsoever. A legend that names a control the app does not
                have is worse than no legend. */}
            <LegendGroup binding="orbit" label="Orbit the Map">
              <KeyCap>Drag</KeyCap>
            </LegendGroup>
            <LegendGroup binding="pan" label="Pan the View">
              <KeyCap>Right Drag</KeyCap>
            </LegendGroup>
            <LegendGroup binding="zoom" label="Zoom In and Out">
              <KeyCap>Scroll</KeyCap>
            </LegendGroup>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One input, drawn as a key.
 *
 * `kbd` because that is what it is: the element carries the meaning for a
 * screen reader and the styling only makes it look like the thing you press.
 * The heavier bottom border is the whole trick - it reads as the lip of a
 * keycap, which is what separates "a letter in a box" from "a key".
 */
const KeyCap = ({ children }: { children: string }) => (
  <kbd className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-[4px] border border-edge border-b-2 bg-surface px-1 font-sans text-[11px] leading-none text-fg">
    {children}
  </kbd>
);

/**
 * One binding: its keys, and the verb in a tooltip above them.
 *
 * Hover state is pure CSS. Routing it through React would re-render the whole
 * canvas component on every pointer crossing, which is exactly the kind of work
 * this surface keeps off the main thread - and there is nothing here React needs
 * to know about.
 *
 * The KEYS capture the pointer, not the card. The card sits over a canvas whose
 * drag IS the camera, so anything that swallows a pointerdown is a patch you
 * cannot start an orbit from; the background stays `pointer-events-none` and
 * only the key boxes take events, which keeps the dead area to a handful of
 * 19px targets. The tooltip itself never takes events, so it cannot flicker by
 * stealing the hover it was opened by.
 */
const LegendGroup = ({
  binding,
  label,
  children,
}: {
  /** Stable id, so the copy can be rewritten without breaking a selector. */
  binding: string;
  label: string;
  children: ReactNode;
}) => (
  <HoverTip
    label={label}
    testId="memory-graph-camera-tip"
    // The KEYS capture the pointer, not the card. The card sits over a canvas
    // whose drag IS the camera, so anything that swallows a pointerdown is a
    // patch you cannot start an orbit from; the background stays
    // `pointer-events-none` and only these boxes take events.
    className="pointer-events-auto flex cursor-help flex-col items-center gap-[3px]"
  >
    <span data-binding={binding} className="flex flex-col items-center gap-[3px]">
      {children}
    </span>
  </HoverTip>
);

const ClusterLabel = ({
  cluster,
  tinted,
  ref,
}: {
  cluster: MemoryGraphCluster;
  tinted: boolean;
  ref: (element: HTMLDivElement | null) => void;
}) => (
  <div
    ref={ref}
    className="absolute left-0 top-0 whitespace-nowrap will-change-transform"
    data-testid="memory-graph-cluster-label"
    data-cluster={cluster.id}
    // Starts hidden: the first frame positions it. Without this a label flashes
    // at the container's origin for one frame on every scene rebuild.
    style={{ opacity: 0 }}
  >
    <div
      // A PILL, not floating text. Size, tracking and tint were not enough on
      // their own: everything on this canvas is text on black, so a region name
      // still read as one more string among the conversation titles instead of
      // as the map's annotation layer. A container changes the KIND of thing it
      // is, which is what actually separates the two layers - the titles keep
      // their much fainter wash, so the ordering is unambiguous.
      //
      // No hover or pointer affordance, deliberately: these are labels, not
      // controls, and a border that implied a click would promise a filter this
      // does not perform.
      className="rounded-md border border-edge/70 bg-surface-raised/90 px-2 py-1 text-[13px] font-semibold tracking-wide shadow-md backdrop-blur-sm"
      style={{
        color: tinted
          ? `hsl(${clusterHue(cluster.id)} 70% 80%)`
          : 'var(--color-fg)',
      }}
    >
      {cluster.label}
    </div>
  </div>
);

/** Gap between the cursor and the card, so the pointer never covers the text. */
const HOVER_CARD_OFFSET = 16;
const HOVER_CARD_WIDTH = 260;
/** Roughly the card at its tallest (two-line title plus every fact), used only
 *  to decide which side of the cursor it opens on. */
const HOVER_CARD_MAX_HEIGHT = 190;

/**
 * How each outcome presents on the hover card.
 *
 * A table rather than a chain of ternaries so a new outcome cannot be added
 * without deciding how it reads. Tones match the map's own outcome colouring, so
 * the card and the nodes agree.
 */
const OUTCOME_PRESENTATION: Readonly<
  Record<'done' | 'active' | 'abandoned' | 'none', { label: string; dot: string } | null>
> = {
  done: { label: 'Finished', dot: 'bg-active' },
  active: { label: 'Still open', dot: 'bg-amber-400' },
  abandoned: { label: 'Dropped', dot: 'bg-fg-faint' },
  // A conversation with no task has no outcome to report, and saying so would
  // be noise on every hover in a project that does not link tasks.
  none: null,
};

/**
 * Cheapest-to-dearest (or briefest-to-longest) position of each node.
 *
 * RANK rather than the value, which is the third time this surface has needed
 * the lesson: every one of these metrics is heavily skewed, so a linear or log
 * scale hands most of its range to a handful of extremes and squeezes the body
 * of the corpus into a sliver. A rank uses the whole ramp whatever the shape.
 *
 * A node with no recorded value sorts LAST and draws at the muted end rather
 * than being hidden. It is a real conversation; what is missing is the metric.
 */
function rankByMetric(
  nodes: ReadonlyArray<MemoryGraphNode>,
  valueOf: (node: MemoryGraphNode) => number | null,
): Float32Array {
  const ordered = nodes
    .map((node, index) => ({ index, value: valueOf(node) }))
    .sort((first, second) => {
      if (first.value === null) return second.value === null ? 0 : 1;
      if (second.value === null) return -1;
      return first.value - second.value;
    });
  const ranks = new Float32Array(nodes.length);
  ordered.forEach((entry, position) => {
    ranks[entry.index] = ordered.length <= 1 ? 1 : position / (ordered.length - 1);
  });
  return ranks;
}

/** Wall time as someone would say it: "3m", "1h 12m", "2d 4h". */
export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.round(milliseconds / 60000);
  if (totalMinutes < 1) return 'under a minute';
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours === 0 ? `${days}d` : `${days}d ${remainingHours}h`;
}

/**
 * Cost to the cent, at every scale.
 *
 * Rounding to whole dollars above ten was tried and is wrong here: these are
 * real amounts someone may be reconciling against a bill, and "$41" hides
 * whether that was 41.02 or 41.98. Only a genuinely sub-cent amount collapses,
 * because "$0.00" reads as free when it was not.
 */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Cost with its token count folded in, since the two answer one question and
 * a reader comparing them should not have to look at two rows to do it.
 *
 * The guards are `== null`, not `=== null`, and that is load-bearing rather
 * than stylistic. The parameters are typed `number | null` because that is what
 * the projection's SQL produces, but a node reaching here is a JSON payload:
 * a field that is absent rather than null arrives as `undefined`, sails past a
 * `=== null` check, and reaches `usd.toLocaleString()`. That throws inside
 * `HoverCard`, `PanelErrorBoundary` catches it, and the ENTIRE Memory Graph
 * unmounts - which reads as the panel flashing open and vanishing, not as a
 * crash. Hovering one conversation whose session never recorded a cost took the
 * whole surface down.
 */
export function formatCostWithTokens(
  usd: number | null | undefined,
  tokens: number | null | undefined,
): string | null {
  if (usd == null && tokens == null) return null;
  if (usd == null) return `${formatCompactCount(tokens ?? 0)} tokens`;
  const cost = formatCost(usd);
  return tokens ? `${cost} (${formatCompactCount(tokens)} tokens)` : cost;
}

/** Large counts as k / M, since a raw seven-digit token count is unreadable. */
export function formatCompactCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

function HoverFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="flex-shrink-0 text-[11px] text-fg-faint">{label}</dt>
      <dd className="min-w-0 truncate text-[11px] text-fg-muted">{value}</dd>
    </div>
  );
}

/**
 * What a REGION is, on hover.
 *
 * The map names an area but says nothing about it, so the only way to judge
 * whether an area is worth flying into was to sample its conversations one at a
 * time. This answers the questions a region actually raises: how much work is in
 * here, did it ship, when was it live, and what did it cost.
 *
 * Aggregated in the renderer from the nodes it already has, so this needs no
 * projection change and stays correct when a filter hides part of the map.
 */
function RegionHoverCard({
  cluster,
  regionOf,
  nodes,
  x,
  y,
  containerWidth,
  containerHeight,
}: {
  cluster: MemoryGraphCluster | null;
  /** Passed in rather than read off the node: which carve-up is on screen is
   *  the caller's choice. */
  regionOf: (node: MemoryGraphProjection['nodes'][number]) => number;
  nodes: MemoryGraphProjection['nodes'];
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
}) {
  const summary = useMemo(() => {
    if (!cluster) return null;
    let count = 0;
    let done = 0;
    let costUsd = 0;
    let tokens = 0;
    let durationMs = 0;
    let earliest = Number.POSITIVE_INFINITY;
    let latest = 0;
    for (const node of nodes) {
      if (regionOf(node) !== cluster.id) continue;
      count += 1;
      if (node.outcome === 'done') done += 1;
      costUsd += node.costUsd ?? 0;
      tokens += node.tokens ?? 0;
      durationMs += node.durationMs ?? 0;
      if (node.lastActivityMs) {
        earliest = Math.min(earliest, node.lastActivityMs);
        latest = Math.max(latest, node.lastActivityMs);
      }
    }
    return { count, done, costUsd, tokens, durationMs, earliest, latest };
  }, [cluster, nodes, regionOf]);

  if (!cluster || !summary || summary.count === 0) return null;

  const flipX = x + HOVER_CARD_OFFSET + HOVER_CARD_WIDTH > containerWidth;
  const flipY = y + HOVER_CARD_MAX_HEIGHT > containerHeight;
  const activeRange = summary.latest > 0
    ? `${new Date(summary.earliest).toLocaleDateString()} to ${new Date(summary.latest).toLocaleDateString()}`
    : null;

  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-edge bg-surface-raised/90 px-3 py-2 shadow-lg backdrop-blur"
      data-testid="memory-graph-region-card"
      style={{
        width: HOVER_CARD_WIDTH,
        left: flipX ? undefined : x + HOVER_CARD_OFFSET,
        right: flipX ? containerWidth - x + HOVER_CARD_OFFSET : undefined,
        top: flipY ? undefined : y + HOVER_CARD_OFFSET,
        bottom: flipY ? containerHeight - y + HOVER_CARD_OFFSET : undefined,
      }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-2 w-2 flex-shrink-0 rounded-full"
          style={{ backgroundColor: `hsl(${clusterHue(cluster.id)} 68% 70%)` }}
          aria-hidden
        />
        <span className="min-w-0 truncate text-xs font-semibold text-fg">{cluster.label}</span>
      </div>
      <div className="mt-0.5 text-[11px] text-fg-faint">Region of the map</div>

      <dl className="mt-2 border-t border-edge pt-1.5 space-y-0.5">
        <HoverFact label="Conversations" value={summary.count.toLocaleString()} />
        {/* Shipped versus total, because "12 conversations" says nothing about
            whether the area went anywhere. */}
        <HoverFact label="Finished" value={`${summary.done} of ${summary.count}`} />
        {summary.durationMs > 0 ? (
          <HoverFact label="Time spent" value={formatDuration(summary.durationMs)} />
        ) : null}
        {summary.costUsd > 0 ? (
          <HoverFact
            label="Cost"
            value={formatCostWithTokens(summary.costUsd, summary.tokens) ?? formatCost(summary.costUsd)}
          />
        ) : null}
        {activeRange ? <HoverFact label="Active" value={activeRange} /> : null}
      </dl>
    </div>
  );
}

function HoverCard({
  node,
  cluster,
  x,
  y,
  containerWidth,
  containerHeight,
}: {
  node: MemoryGraphProjection['nodes'][number];
  cluster: MemoryGraphCluster | null;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
}) {
  /*
   * Anchored to the CURSOR, not to a corner of the surface.
   *
   * It sat bottom-left while selecting a node opened the panel top-right, so the
   * same node's information appeared in opposite corners depending on whether you
   * were pointing or clicking, and hovering trained the eye on the wrong side of
   * the screen. Transient information belongs on the thing it describes;
   * persistent information belongs in the panel.
   *
   * It does not chase the pointer, because it only exists while the pointer is
   * resting ON a node - the position updates only on a hit.
   */
  // Flip across the cursor near an edge so the card is never clipped, which is
  // most likely exactly where the interesting outlying nodes are.
  const flipX = x + HOVER_CARD_OFFSET + HOVER_CARD_WIDTH > containerWidth;
  // Taller than it was now that it carries outcome, region and facts, so the
  // edge test has to grow with it or the card clips at the bottom of the map.
  const flipY = y + HOVER_CARD_MAX_HEIGHT > containerHeight;
  const outcome = OUTCOME_PRESENTATION[node.outcome ?? 'none'];
  const modelName = node.model ? humanizeModelId(node.model) ?? node.model : null;
  const spend = formatCostWithTokens(node.costUsd, node.tokens);
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border border-edge bg-surface-raised/90 px-3 py-2 shadow-lg backdrop-blur"
      data-testid="memory-graph-hover-card"
      style={{
        width: HOVER_CARD_WIDTH,
        left: flipX ? undefined : x + HOVER_CARD_OFFSET,
        right: flipX ? containerWidth - x + HOVER_CARD_OFFSET : undefined,
        top: flipY ? undefined : y + HOVER_CARD_OFFSET,
        bottom: flipY ? containerHeight - y + HOVER_CARD_OFFSET : undefined,
      }}
    >
      <div className="text-xs font-semibold leading-snug text-fg line-clamp-2">
        {node.title ?? 'Untitled conversation'}
      </div>

      {/* The two things that place a conversation before you commit a click:
          where it ended up, and which area of the map it belongs to. Both use a
          colour dot rather than a coloured word, so the meaning survives for a
          reader who cannot separate the hues - the text says it either way. */}
      <div className="mt-1.5 space-y-1">
        {outcome ? (
          <div className="flex items-center gap-1.5 text-[11px]">
            <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${outcome.dot}`} aria-hidden />
            <span className="text-fg-muted">{outcome.label}</span>
          </div>
        ) : null}
        {cluster ? (
          <div className="flex items-center gap-1.5 text-[11px]">
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ backgroundColor: `hsl(${clusterHue(cluster.id)} 68% 70%)` }}
              aria-hidden
            />
            <span className="truncate text-fg-muted">{cluster.label}</span>
          </div>
        ) : null}
      </div>

      {/* Facts, smallest last. Separated by a rule rather than by mid-dots so a
          long agent name cannot run into the next value. */}
      <dl className="mt-2 border-t border-edge pt-1.5 space-y-0.5">
        {node.agent ? (
          <HoverFact label="Agent" value={node.model ? `${node.agent}, ${modelName}` : node.agent} />
        ) : null}
        {/* What the work COST, not how the index stored it. "N indexed chunks"
            is an artifact of chunking and answers nothing anyone asks about a
            past conversation; how long it ran and what it spent do. Each row is
            omitted when its metric was never captured, rather than printing a
            zero the conversation has not earned. */}
        {node.durationMs ? <HoverFact label="Ran for" value={formatDuration(node.durationMs)} /> : null}
        {spend ? <HoverFact label="Cost" value={spend} /> : null}
        {node.lastActivityMs ? (
          <HoverFact label="Last active" value={new Date(node.lastActivityMs).toLocaleDateString()} />
        ) : null}
      </dl>
    </div>
  );
}

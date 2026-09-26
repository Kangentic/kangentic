/**
 * The Memory Graph's three.js scene: construction, updates, and teardown, with
 * no React in it.
 *
 * Kept framework-free on purpose. A scene is imperative, long-lived, GPU-backed
 * state; expressing it as React elements would put reconciliation between the
 * user's drag and the frame, which is exactly the budget this surface cannot
 * afford. React owns mounting and props, this owns the frames.
 *
 * PERFORMANCE, which is the requirement here rather than a nice-to-have:
 *
 *  - **Two draw calls, always.** Every node is one vertex of a single
 *    `THREE.Points`; every link is two vertices of a single `THREE.LineSegments`.
 *    Node count therefore costs vertex bandwidth, not draw calls, and a 640-node
 *    corpus and a 60,000-node one render the same way.
 *  - **Nothing reallocates on interaction.** Selecting, hovering, searching and
 *    recolouring write into the existing `color` / `size` attributes and set
 *    `needsUpdate`. Geometry is rebuilt only when the PROJECTION itself changes.
 *  - **Render on demand.** This module never starts a loop. It exposes
 *    `renderFrame()` and lets the host decide, so an idle graph costs zero
 *    frames - the one property the Canvas 2D version had that had to survive the
 *    move to WebGL, because this page also hosts live terminals.
 *
 * The node shader draws a soft round sprite from `gl_PointCoord` rather than
 * sampling a texture: no atlas to allocate, upload, or lose with the context,
 * and it stays crisp at any device pixel ratio.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  LineSegments,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { MemoryGraphEdge, MemoryGraphNode } from '../../../shared/types';

/** Layout coordinates arrive in the unit box; spread them over a world cube of
 *  this size so camera distances and point sizes are in comfortable units. */
export const WORLD_SIZE = 100;

/** Vertical field of view. Narrow enough that perspective reads as depth rather
 *  than as distortion when you fly inside the cloud. */
const FIELD_OF_VIEW = 45;
const NEAR_PLANE = 0.1;
const FAR_PLANE = 4000;

/** Device pixel ratio ceiling. Above 2 the cost is quadratic and the visual
 *  difference on a point cloud is not perceptible. */
const MAX_PIXEL_RATIO = 2;

/** Base sprite weight, before the per-node size multiplier. */
const BASE_POINT_SIZE = 2.6;
/**
 * Converts the perspective-divided weight into pixels.
 *
 * Tuned WITH the pixel-ratio correction below, not before it: `gl_PointSize` is
 * in DEVICE pixels, so on a 2x display every node was drawn at half the CSS size
 * intended and the map read as a field of specks under its own links.
 */
const POINT_SIZE_SCALE = 240;
/** Hit radius for picking, in world units. Generous relative to the sprite so a
 *  node is easy to hit while flying. */
/**
 * How much wider a sprite is drawn than its visible core, to leave room for the
 * halo. The core shrinks by the same factor in the fragment shader, so a node's
 * drawn size is unchanged - this buys glow, not bulk.
 *
 * It is a fragment-cost multiplier of roughly its square, which is why it is a
 * named constant and not a taste dial: raising it is the one change here that
 * can move the frame budget.
 */
const HALO_EXPANSION = 5.5;
/**
 * Peak halo brightness relative to the core.
 *
 * Kept well under 1 because additive blending ACCUMULATES it: this is the
 * per-node contribution, and a dense region reaches nebula brightness by
 * overlap rather than by any single node being bright. Raising it past ~1 fogs
 * the empty space between clusters, which destroys the structure the map exists
 * to show.
 */
const HALO_STRENGTH = 1.45;

/**
 * Atmospheric depth.
 *
 * Until now the only depth cues were perspective size and the glow, so a cloud
 * that genuinely occupies three dimensions read almost flat - every node arrived
 * at the same brightness whether it was in front of you or across the map.
 *
 * The band is RELATIVE TO THE CAMERA, recomputed each frame, not a fixed pair of
 * world distances. Fixed distances were tried first and are simply wrong: the
 * default framing sits about 1.5 WORLD_SIZE back, so a band starting at 0.45
 * put the ENTIRE map deep in the fade and dimmed everything at once. What the
 * cue has to express is depth WITHIN the visible cloud, which means it has to
 * move with the viewer - and it then keeps working when you fly in among the
 * nodes, where the spread of depths is much smaller.
 */
const FOG_SPAN_NEAR = 0.85;
const FOG_SPAN_FAR = 1.15;
/**
 * Brightness of the farthest node relative to the nearest.
 *
 * Deliberately high. This is a depth CUE, not a dimmer: at 0.3 the middle of the
 * map rendered near half brightness and the whole thing looked switched off. The
 * shader ramps from this floor to 1 across the band rather than clamping to it,
 * so the average node stays bright and only the genuinely distant recede.
 */
const FOG_FLOOR = 0.62;

/**
 * Hue for a region, generated rather than listed.
 *
 * The GOLDEN ANGLE (137.5 degrees). Stepping by it never revisits a hue and
 * keeps every prefix of the sequence well spread, which is the property a fixed
 * list cannot have: the region count is now chosen from the data and can reach
 * the mid twenties, so any hand-written palette would either run out or have to
 * guess the count in advance.
 *
 * It also degrades correctly at small counts - the first few entries land far
 * apart on their own, so a three-region map is as legible as a twenty-region
 * one. The previous ten hand-picked hues had green at 150 and teal at 175 only
 * 25 degrees apart, which is the failure this removes rather than re-tunes.
 *
 * Lives here rather than in the canvas because links are tinted by region too,
 * and one palette in two files is a palette that drifts. No red/green pair
 * carries meaning on its own - position and the labels do.
 */
const GOLDEN_ANGLE_DEGREES = 137.508;

export function clusterHue(cluster: number): number {
  return (cluster * GOLDEN_ANGLE_DEGREES) % 360;
}

const PICK_THRESHOLD = 2.2;
/** Resting link opacity. Faint: 2,000 links at full strength is a hairball. */
const BASE_EDGE_OPACITY = 0.14;

export interface SceneNodeStyle {
  /** Linear RGB triplet, 0..1. */
  color: [number, number, number];
  /** Multiplier on the base sprite size. */
  scale: number;
  /**
   * 0..1. Zero means genuinely HIDDEN, not merely faint: a filtered-out node is
   * skipped by picking and drops the links that touch it, so the remaining
   * structure is the answer to the query rather than a bright subset buried in
   * everything else.
   */
  alpha: number;
  /** 1 draws a white ring around the node: a hit of the agent's own search. */
  ring?: number;
}

/** Below this a node counts as filtered out rather than dim. */
const HIDDEN_ALPHA = 0.001;

export interface MemoryGraphSceneOptions {
  canvas: HTMLCanvasElement;
  nodes: ReadonlyArray<MemoryGraphNode>;
  edges: ReadonlyArray<MemoryGraphEdge>;
  /** Link colour, read from the theme by the caller (never hardcoded here). */
  edgeColor: string;
  /** A node's region at the ACTIVE granularity. Passed in rather than read off
   *  the node, because which of the shipped clusterings is on screen is the
   *  caller's choice. */
  regionOf: (node: MemoryGraphNode) => number;
}

export interface MemoryGraphScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly renderer: WebGLRenderer;
  /** World position of each node, for camera framing and label placement. */
  readonly positions: ReadonlyArray<Vector3>;
  /** Resize, and re-aim the frustum at the clear area. Returns what it applied,
   *  since the framing fit needs the same numbers. */
  setSize(width: number, height: number, insets?: ViewportInsets): ViewportDescription;
  /** Rewrite per-node colour/size/alpha. No allocation, no geometry rebuild. */
  setNodeStyles(styles: ReadonlyArray<SceneNodeStyle>): void;
  /** Global link opacity, so "Links" can be toggled without touching geometry. */
  setEdgeOpacity(opacity: number): void;
  /** Nearest node under normalized device coords, or null. */
  pick(ndcX: number, ndcY: number): number | null;
  renderFrame(): void;
  dispose(): void;
}

const NODE_VERTEX_SHADER = `
attribute vec3 nodeColor;
attribute float nodeSize;
uniform float haloExpansion;
uniform float fogNear;
uniform float fogFar;
uniform float fogFloor;
attribute float nodeAlpha;
attribute float nodeRing;
uniform float pixelRatio;
uniform float sizeScale;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
varying float vRing;
void main() {
  vColor = nodeColor;
  vAlpha = nodeAlpha;
  vRing = nodeRing;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  // Perspective size attenuation: the divide by -z is what makes distance
  // readable, and is the same divide the projection matrix applies to position.
  //
  // The pixelRatio factor is not optional. gl_PointSize is in DEVICE pixels
  // while everything the user perceives is CSS pixels, so without it a node on a
  // 2x display draws at half the size it does on a 1x one - which is how the map
  // ended up as specks buried under its own links.
  gl_PointSize = nodeSize * haloExpansion * pixelRatio * (sizeScale / -viewPosition.z);
  vFog = fogFloor + (1.0 - fogFloor) * clamp(1.0 - (-viewPosition.z - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const EDGE_VERTEX_SHADER = `
attribute float edgeAlpha;
attribute vec3 edgeColor;
uniform float fogNear;
uniform float fogFar;
uniform float fogFloor;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
void main() {
  vColor = edgeColor;
  vAlpha = edgeAlpha;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vFog = fogFloor + (1.0 - fogFloor) * clamp(1.0 - (-viewPosition.z - fogNear) / (fogFar - fogNear), 0.0, 1.0);
  gl_Position = projectionMatrix * viewPosition;
}
`;

const EDGE_FRAGMENT_SHADER = `
uniform float baseOpacity;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
void main() {
  // Links fade with depth like the nodes they join, or a far mesh stays as loud
  // as a near one and the whole cloud flattens out again.
  float alpha = vAlpha * baseOpacity * vFog;
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(vColor, alpha);
}
`;

const NODE_FRAGMENT_SHADER = `
uniform float haloExpansion;
uniform float haloStrength;
varying vec3 vColor;
varying float vAlpha;
varying float vFog;
varying float vRing;
void main() {
  // Soft round sprite straight from the point coord - no texture atlas to
  // allocate, upload, or rebuild after a context loss.
  //
  // WHY THE GLOW IS HERE AND NOT A BLOOM PASS. The reference look (Obsidian and
  // its neighbours) is nodes that read as light sources, and the obvious route
  // is UnrealBloomPass through an EffectComposer. For a POINT CLOUD that buys
  // very little and costs a lot: extra render targets, a full-screen blur chain
  // every frame, and a transparent-canvas compositing problem this surface would
  // rather not have - against a measured 0.2ms budget that is the reason the map
  // can sit beside live terminals at all. A wide per-sprite falloff under
  // ADDITIVE blending produces the same effect where it matters, because
  // overlapping halos accumulate: a dense region blooms into a nebula on its
  // own, from geometry that is already being drawn, in the same single draw call.
  //
  // d is 0 at the centre and 1 at the sprite edge. The sprite was inflated by
  // haloExpansion in the vertex shader, so the CORE has to shrink by the same
  // factor to keep its drawn size unchanged - the node is not getting bigger,
  // it is getting room to glow. Picking is world-space and unaffected, so the
  // halo is light rather than a larger hit target.
  vec2 offset = gl_PointCoord - vec2(0.5);
  float d = length(offset) * 2.0;
  if (d > 1.0) discard;

  float coreRadius = 1.0 / haloExpansion;
  float core = 1.0 - smoothstep(coreRadius * 0.62, coreRadius, d);
  // TWO terms, because one does not look like light. A single steep falloff
  // (quartic was tried first) is invisible by mid-sprite and reads as a slightly
  // soft dot; a single shallow one is a flat disc with a blurry edge. Real glow
  // has a bright tight skirt around the source AND a wide faint wash, so the
  // curve is the sum of both.
  float falloff = 1.0 - d;
  float wide = falloff * falloff;
  float tight = wide * wide * wide;
  float halo = wide * 0.45 + tight * 0.55;

  // The core SCALES the node's own colour rather than adding a white term:
  // adding pushed every channel toward 1.0, so a blue node and an amber one both
  // arrived at near-white and the colour modes stopped meaning anything. Scaling
  // keeps the hue and lets overlaps brighten within it, which is what makes
  // additive blending safe for the glow.
  vec3 lit = vColor * (0.55 + core * 0.85);
  // Distance takes SATURATION as well as brightness. Dimming alone reads as a
  // darker node of the same colour; losing chroma too is what the eye actually
  // reads as "far away", and it keeps a distant cluster from competing with a
  // near one for the same hue.
  float luma = dot(lit, vec3(0.299, 0.587, 0.114));
  // Chroma loss is SLIGHT. Dimming already carries the cue, and stacking a
  // heavy desaturation on top drained the colour that makes the regions
  // readable in the first place - the map went grey before it went deep.
  vec3 faded = mix(vec3(luma), lit, mix(0.82, 1.0, vFog)) * vFog;
  float intensity = core + halo * haloStrength;
  // A search hit's ring: a thin white band just outside the core, drawn in the
  // halo's room so the node keeps its size. White rather than the node's hue,
  // because the ring says "the agent looked here", which no colour mode means.
  float ringCenter = coreRadius * 1.55;
  float ringBand = 1.0 - smoothstep(coreRadius * 0.14, coreRadius * 0.26, abs(d - ringCenter));
  float ring = ringBand * vRing;
  vec3 color = mix(faded, vec3(vFog), ring);
  gl_FragColor = vec4(color, max(intensity, ring * 1.2) * vAlpha);
}
`;

/**
 * Direction the default view looks from. A DIRECTION, not a position: the
 * distance is computed from the content so the whole map always fits.
 *
 * The fixed distance this replaced was WORLD_SIZE * 1.15, which cannot work and
 * was cutting the bottom of the map off on every reset. At a 45 degree vertical
 * field of view the visible height is 2 * d * tan(22.5) = 0.83 * d, so that
 * distance showed 0.94 * WORLD_SIZE of height - against content that is a full
 * WORLD_SIZE cube seen off-axis, whose projected extent is at least that and up
 * to its diagonal. The frustum was simply smaller than the thing in it.
 *
 * Layout outliers made it worse: the projection fits the p2-p98 range to the
 * unit box, so a few nodes legitimately sit OUTSIDE it. Fitting to the real
 * bounding sphere covers them without anyone having to know that.
 */
export const DEFAULT_VIEW_DIRECTION = new Vector3(0.45, 0.35, 0.8).normalize();
/** Matches three's default camera up, which camera-controls preserves. */
const WORLD_UP = new Vector3(0, 1, 0);

/**
 * Breathing room around the content, INSIDE the safe area.
 *
 * This used to be the only thing standing between the map and the chrome, and
 * so it had to be generous enough to clear a ~210px panel and a search box it
 * knew nothing about - a guess that was too tight on a small window and wasted
 * a third of a large one. The safe area now models that chrome in pixels, so
 * this constant is back to the one job a padding should have: air.
 *
 * Air is not decoration here. The default framing is where the SHAPE of the
 * index is read - how many regions, how they sit, where the dense parts are -
 * before flying in. Content flush to the edge reads as a wall rather than a map,
 * which is the note this value is tuned against: with the chrome and the label
 * chips both accounted for, a fit that merely CLEARS them still arrives looking
 * stretched to the edges. This is the margin that makes it sit in the view.
 */
const FRAME_PADDING = 1.18;

/**
 * Share of nodes the default view is fitted to contain.
 *
 * Not 1. The layout fits its p2-p98 range to the unit box, so a small tail sits
 * outside it by construction, and framing for the very furthest node hands the
 * whole view over to a handful of extremes.
 *
 * Deliberately close to 1 so this stays a robustness measure rather than a
 * cropping policy - at 150 conversations it disregards about four.
 */
const FRAME_COVERAGE = 0.97;

/** Above this ratio of thinnest to widest spread the cloud is treated as a ball
 *  and the fixed direction is kept. */
const ISOTROPY_LIMIT = 0.72;

/** Passes of measure-then-recentre. Convergence is fast because each pass
 *  removes almost all of the remaining offset; three is well past it. */
const CENTERING_PASSES = 3;

/** Floor on a point's depth from the camera while centring, as a share of the
 *  camera distance. Guards the division, not the framing. */
const MIN_DEPTH_FRACTION = 0.05;

/** Pixels of the canvas each edge loses to floating chrome. */
export interface ViewportInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const NO_VIEWPORT_INSETS: ViewportInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/**
 * The least of an axis the safe area may shrink to.
 *
 * The panels are fixed pixel widths, so on a narrow enough window they cover
 * most of the canvas - and a map fitted into the leftover sliver would be
 * unreadable, which is worse than a map partly behind a translucent panel. Past
 * this point the safe area stops shrinking and starts overlapping instead.
 */
const MIN_SAFE_FRACTION = 0.4;

export interface ViewportDescription {
  readonly aspect: number;
  /** Principal-point shift, in pixels, for `PerspectiveCamera.setViewOffset`. */
  readonly offsetX: number;
  readonly offsetY: number;
  /** Share of the frustum the safe area occupies, per axis. */
  readonly safeFractionX: number;
  readonly safeFractionY: number;
}

/** One axis of the safe area, as a start offset and a size in pixels. */
function safeSpan(nearInset: number, farInset: number, extent: number): { start: number; size: number } {
  const near = Math.max(0, nearInset);
  const far = Math.max(0, farInset);
  const remaining = extent - near - far;
  const minimum = extent * MIN_SAFE_FRACTION;
  if (remaining >= minimum) return { start: near, size: remaining };
  // Keep the overlap balanced between the two panels rather than letting one of
  // them push the map entirely under the other.
  const middle = near + remaining / 2;
  const start = Math.min(Math.max(middle - minimum / 2, 0), Math.max(0, extent - minimum));
  return { start, size: Math.min(minimum, extent) };
}

/**
 * Where the map may actually be drawn, given a canvas and the chrome over it.
 *
 * This canvas is FULL-BLEED with its panels floating on top, so the pane the
 * user perceives is not the pane three renders into. Two numbers come out of
 * that gap:
 *
 * - a principal-point SHIFT, so the camera's axis lands at the centre of the
 *   clear area rather than the centre of the canvas. Everything aimed at the
 *   camera then arrives where it can be seen: the default framing, the fly-to
 *   after a search, and a double-click's dolly all inherit it for free.
 * - the safe FRACTIONS, which are what a fit must shrink by so the content it
 *   frames lands inside that area rather than under a panel.
 *
 * Pure, so the fit, the camera and the framing test can all read one answer.
 */
export function describeViewport(
  width: number,
  height: number,
  insets: ViewportInsets,
): ViewportDescription {
  if (width <= 0 || height <= 0) {
    return { aspect: 1, offsetX: 0, offsetY: 0, safeFractionX: 1, safeFractionY: 1 };
  }
  const horizontal = safeSpan(insets.left, insets.right, width);
  const vertical = safeSpan(insets.top, insets.bottom, height);
  return {
    aspect: width / height,
    // Positive `offsetX` slides three's frustum right, which moves the image
    // LEFT, so the sign is the mirror of the safe centre's own displacement.
    offsetX: width / 2 - (horizontal.start + horizontal.size / 2),
    offsetY: height / 2 - (vertical.start + vertical.size / 2),
    safeFractionX: horizontal.size / width,
    safeFractionY: vertical.size / height,
  };
}

/**
 * Point a camera at the safe area of a canvas of this size.
 *
 * `setViewOffset` is three's own mechanism for an off-centre frustum. It is
 * documented for multi-monitor walls, but a sub-window the same size as the
 * full frame and merely displaced is exactly an off-axis principal point - and
 * because it lands in the projection MATRIX, picking, label projection and the
 * fog all follow it without knowing it exists. Shifting the orbit target would
 * have moved the map too, at the cost of orbiting about a point that is not the
 * map's centre.
 */
export function applyViewport(
  camera: PerspectiveCamera,
  width: number,
  height: number,
  insets: ViewportInsets,
): ViewportDescription {
  const viewport = describeViewport(width, height, insets);
  if (viewport.offsetX === 0 && viewport.offsetY === 0) {
    camera.clearViewOffset();
    camera.aspect = viewport.aspect;
  } else {
    // Sets `aspect` to fullWidth / fullHeight itself, which is what we want.
    camera.setViewOffset(width, height, viewport.offsetX, viewport.offsetY, width, height);
  }
  camera.updateProjectionMatrix();
  return viewport;
}

/**
 * The exact framing for the default view: where to look, and from how far.
 *
 * Fitted to the cloud's PROJECTED extent along this specific view direction,
 * not to a bounding sphere. A sphere is the right tool for `frameNodes`, which
 * flies to an arbitrary subset from wherever the camera happens to be and must
 * frame it identically from any angle - but it circumscribes, and this layout is
 * a flattened, elongated cloud rather than a ball, so a sphere fit left the map
 * occupying about half the viewport with the rest empty.
 *
 * The default view has ONE known orientation, so the tight answer is available:
 * for every point, the camera must be far enough that the point falls inside
 * both frustum planes. A point nearer the camera needs more distance than a far
 * one at the same offset, which is why depth enters the constraint rather than
 * being averaged away.
 */
/**
 * The direction to view the cloud FROM, derived from its own shape.
 *
 * A fixed direction is a guess, and it was a bad one: the layout has no
 * preferred orientation (the embedder is free to rotate it), so a constant
 * camera vector looks at some corpora face-on and at others nearly edge-on -
 * which is what "the default view doesn't show the depth, I had to turn it"
 * describes. The cloud is flattest along its least-varying axis, so looking ALONG
 * that axis presents its widest face and the structure is visible on arrival.
 *
 * Eigenvectors of the 3x3 covariance matrix, by Jacobi rotation. Symmetric and
 * tiny, so this is a handful of iterations on a projection change - never per
 * frame.
 *
 * Falls back to the fixed direction when the cloud is roughly isotropic, since
 * then no axis is meaningfully thinner and picking one would just spin the map
 * differently on every rebuild for no gain.
 */
function principalViewDirection(positions: ReadonlyArray<Vector3>, center: Vector3): Vector3 {
  if (positions.length < 8) return DEFAULT_VIEW_DIRECTION.clone();

  // Covariance, upper triangle mirrored.
  const covariance = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const offset = new Vector3();
  for (const position of positions) {
    offset.copy(position).sub(center);
    const components = [offset.x, offset.y, offset.z];
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        covariance[row][column] += components[row] * components[column];
      }
    }
  }
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) covariance[row][column] /= positions.length;
  }

  // Jacobi: rotate away the largest off-diagonal until the matrix is diagonal.
  const vectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep += 1) {
    let p = 0;
    let q = 1;
    let largest = Math.abs(covariance[0][1]);
    if (Math.abs(covariance[0][2]) > largest) {
      largest = Math.abs(covariance[0][2]);
      p = 0;
      q = 2;
    }
    if (Math.abs(covariance[1][2]) > largest) {
      largest = Math.abs(covariance[1][2]);
      p = 1;
      q = 2;
    }
    if (largest < 1e-9) break;

    const theta = (covariance[q][q] - covariance[p][p]) / (2 * covariance[p][q]);
    const sign = theta >= 0 ? 1 : -1;
    const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const cosine = 1 / Math.sqrt(t * t + 1);
    const sine = t * cosine;

    for (let index = 0; index < 3; index += 1) {
      const rowP = covariance[index][p];
      const rowQ = covariance[index][q];
      covariance[index][p] = cosine * rowP - sine * rowQ;
      covariance[index][q] = sine * rowP + cosine * rowQ;
    }
    for (let index = 0; index < 3; index += 1) {
      const columnP = covariance[p][index];
      const columnQ = covariance[q][index];
      covariance[p][index] = cosine * columnP - sine * columnQ;
      covariance[q][index] = sine * columnP + cosine * columnQ;
    }
    for (let index = 0; index < 3; index += 1) {
      const vectorP = vectors[index][p];
      const vectorQ = vectors[index][q];
      vectors[index][p] = cosine * vectorP - sine * vectorQ;
      vectors[index][q] = sine * vectorP + cosine * vectorQ;
    }
  }

  const spread = [covariance[0][0], covariance[1][1], covariance[2][2]];
  let thinnest = 0;
  let widest = 0;
  for (let axis = 1; axis < 3; axis += 1) {
    if (spread[axis] < spread[thinnest]) thinnest = axis;
    if (spread[axis] > spread[widest]) widest = axis;
  }
  // Roughly a ball: no axis is meaningfully thinner, so any choice is arbitrary.
  if (spread[widest] <= 0 || spread[thinnest] / spread[widest] > ISOTROPY_LIMIT) {
    return DEFAULT_VIEW_DIRECTION.clone();
  }

  const direction = new Vector3(
    vectors[0][thinnest],
    vectors[1][thinnest],
    vectors[2][thinnest],
  ).normalize();
  // An eigenvector's SIGN is arbitrary, so pin it: without this the same corpus
  // could be viewed from opposite sides on consecutive rebuilds.
  const dominant = Math.abs(direction.x) >= Math.abs(direction.y)
    && Math.abs(direction.x) >= Math.abs(direction.z)
    ? direction.x
    : Math.abs(direction.y) >= Math.abs(direction.z) ? direction.y : direction.z;
  if (dominant < 0) direction.multiplyScalar(-1);

  // Tilted off the exact axis so the view is not perfectly orthographic-looking
  // and the near/far cue still reads, and so the direction can never be parallel
  // to world up (which would make the camera's right vector degenerate).
  return direction.multiplyScalar(0.92).addScaledVector(WORLD_UP, 0.28).normalize();
}

/** Median of one axis. Allocates a scratch array per call, which is fine: this
 *  runs on a projection change and a reset, never per frame. */
function medianOfAxis(positions: ReadonlyArray<Vector3>, axis: 'x' | 'y' | 'z'): number {
  const values = Float64Array.from(positions, (position) => position[axis]);
  values.sort();
  const middle = values.length >> 1;
  return values.length % 2 === 0 ? (values[middle - 1] + values[middle]) / 2 : values[middle];
}

/**
 * Midpoint of a projected axis, discarding the same share of nodes at each end
 * that the distance fit disregards. Sorts in place, which is fine: the arrays
 * are scratch and this runs on a projection change, a resize and a reset.
 */
function trimmedMidpoint(values: Float64Array): number {
  if (values.length === 0) return 0;
  values.sort();
  const drop = Math.floor((values.length * (1 - FRAME_COVERAGE)) / 2);
  return (values[drop] + values[values.length - 1 - drop]) / 2;
}

export function fitDefaultView(
  positions: ReadonlyArray<Vector3>,
  verticalFovDegrees: number,
  viewport: ViewportDescription,
  /**
   * Where to look FROM, when the caller already has an answer.
   *
   * The default view derives its own direction from the cloud's shape, which is
   * right for arriving at a map and wrong for a fly to a subset: that one has to
   * frame the subset from where the user is currently standing, or the camera
   * swings round as a side effect of a search. Everything else about the fit -
   * the percentile distance, the iterative re-centring, the safe area and the
   * padding - is what makes the two land with the SAME air, which is the whole
   * reason a fly reuses this rather than a bounding sphere.
   */
  viewDirection?: Vector3,
): { center: Vector3; direction: Vector3; distance: number } | null {
  if (positions.length === 0) return null;

  // The MEDIAN of each axis, not the bounding box's midpoint.
  //
  // The distance below is already outlier-resistant, and that alone was not
  // enough: a bounding-box centre is dragged by the same extremes, so one point
  // at six times WORLD_SIZE moved the centre out to meet it and left the entire
  // body of the map far off to one side - the required distances all grew and
  // the fit collapsed again. A median moves by at most one rank however far a
  // straggler goes.
  const worldCenter = new Vector3(
    medianOfAxis(positions, 'x'),
    medianOfAxis(positions, 'y'),
    medianOfAxis(positions, 'z'),
  );

  // View basis. Signs are irrelevant below because only magnitudes are used.
  const toCamera = viewDirection
    ? viewDirection.clone().normalize()
    : principalViewDirection(positions, worldCenter);
  const right = new Vector3().crossVectors(WORLD_UP, toCamera).normalize();
  // Degenerate only if the view direction were parallel to world up, which this
  // constant is not - but a zero-length right would silently produce NaNs.
  if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
  const up = new Vector3().crossVectors(toCamera, right).normalize();

  // Shrunk by the safe area, so the fit frames the content into the clear part
  // of the canvas rather than into the whole of it.
  const halfFov = Math.tan((verticalFovDegrees / 2) * (Math.PI / 180));
  const tanVertical = halfFov * viewport.safeFractionY;
  const tanHorizontal = halfFov * Math.max(viewport.aspect, 0.0001) * viewport.safeFractionX;

  // Re-centred on what the camera will actually SEE, not on the world median.
  //
  // The median is the right centre for resisting outliers and the wrong one for
  // framing: a cloud is rarely symmetric about it, so the fit sized itself for
  // the long side and left the short side as dead canvas - measured on the real
  // corpus, 215px of empty space under the map against 84px over it, and the
  // map smaller than it needed to be to pay for the gap.
  //
  // Done in PROJECTED coordinates and iterated, because the obvious version -
  // the midpoint of the lateral offsets - is an orthographic answer to a
  // perspective question. Depth scales lateral offset, so a near node covers
  // more of the frame than a far one at the same distance off-axis, and
  // centring on the world midpoint still left a visible band of empty canvas
  // (0.22 of the frame, in the test that pins this). Each pass measures where
  // the points actually land, slides the target to put that midpoint on the
  // camera's axis, and re-fits the distance for the target it just moved. Three
  // passes is well past convergence for any layout this surface produces; the
  // whole thing is a handful of linear scans, on a resize or a reset.
  const center = worldCenter.clone();
  let distance = percentileDistance(positions, center, toCamera, right, up, tanHorizontal, tanVertical);
  const projectedRight = new Float64Array(positions.length);
  const projectedUp = new Float64Array(positions.length);
  const offset = new Vector3();
  for (let pass = 0; pass < CENTERING_PASSES; pass += 1) {
    for (let index = 0; index < positions.length; index += 1) {
      offset.copy(positions[index]).sub(center);
      // Depth measured FROM the camera. Clamped off zero: a node the fit has
      // deliberately left in front of the near plane would otherwise project to
      // infinity and drag the centre with it.
      const depth = Math.max(
        distance - offset.dot(toCamera),
        distance * MIN_DEPTH_FRACTION,
        // Absolute floor as well as a relative one: a single node, or a
        // perfectly coincident cluster, fits at distance zero and every
        // relative floor collapses with it.
        1e-6,
      );
      projectedRight[index] = offset.dot(right) / (depth * tanHorizontal);
      projectedUp[index] = offset.dot(up) / (depth * tanVertical);
    }
    const shiftRight = trimmedMidpoint(projectedRight);
    const shiftUp = trimmedMidpoint(projectedUp);
    center
      .addScaledVector(right, shiftRight * distance * tanHorizontal)
      .addScaledVector(up, shiftUp * distance * tanVertical);
    distance = percentileDistance(positions, center, toCamera, right, up, tanHorizontal, tanVertical);
  }

  // A single node, or a perfectly coincident cluster, yields zero - which would
  // dolly the camera onto the point and through the near plane.
  return {
    center,
    direction: toCamera,
    distance: Math.max(distance * FRAME_PADDING, WORLD_SIZE * 0.25),
  };
}

/**
 * How far back the camera must sit for this centre, as a high PERCENTILE of what
 * each point on its own would need.
 *
 * The maximum is what a naive fit uses and it is wrong for this layout: the
 * projection fits the p2-p98 range to the unit box, so a few nodes legitimately
 * land far outside it. Taking the max let a handful of stragglers set the
 * framing for everything, and the map arrived occupying about a third of the
 * viewport with the structure too small to read. Ignoring the last few percent
 * frames the body of the map properly; those outliers sit near or just past an
 * edge, which is the correct trade for points the layout itself treats as
 * extremes.
 */
function percentileDistance(
  positions: ReadonlyArray<Vector3>,
  center: Vector3,
  toCamera: Vector3,
  right: Vector3,
  up: Vector3,
  tanHorizontal: number,
  tanVertical: number,
): number {
  const required = new Float64Array(positions.length);
  const offset = new Vector3();
  for (let index = 0; index < positions.length; index += 1) {
    offset.copy(positions[index]).sub(center);
    const depth = offset.dot(toCamera);
    const horizontal = Math.abs(offset.dot(right));
    const vertical = Math.abs(offset.dot(up));
    required[index] = Math.max(depth + horizontal / tanHorizontal, depth + vertical / tanVertical);
  }
  required.sort();
  const cutoff = Math.max(0, Math.ceil(required.length * FRAME_COVERAGE) - 1);
  return required[cutoff] ?? 0;
}

/** Map a unit-box layout coordinate onto the world cube, centred on the origin. */
function toWorld(value: number): number {
  return (value - 0.5) * WORLD_SIZE;
}

/** Weakest link at `MIN_EDGE_STRENGTH`, strongest at 1, by rank. */
const MIN_EDGE_STRENGTH = 0.35;

export function buildEdgeStrengths(
  edges: ReadonlyArray<{ readonly similarity: number }>,
): Float32Array {
  const strengths = new Float32Array(edges.length);
  if (edges.length === 0) return strengths;
  if (edges.length === 1) {
    strengths[0] = 1;
    return strengths;
  }
  const order = edges.map((edge, index) => ({ index, similarity: edge.similarity }));
  order.sort((first, second) => first.similarity - second.similarity);
  const span = order.length - 1;
  for (let rank = 0; rank < order.length; rank += 1) {
    strengths[order[rank].index] = MIN_EDGE_STRENGTH + (1 - MIN_EDGE_STRENGTH) * (rank / span);
  }
  return strengths;
}

export function createMemoryGraphScene(options: MemoryGraphSceneOptions): MemoryGraphScene {
  const { canvas, nodes, edges, edgeColor, regionOf } = options;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(FIELD_OF_VIEW, 1, NEAR_PLANE, FAR_PLANE);

  // ---- nodes: one Points, one draw call -----------------------------------
  const nodeCount = nodes.length;
  const nodePositions = new Float32Array(nodeCount * 3);
  const nodeColors = new Float32Array(nodeCount * 3);
  const nodeSizes = new Float32Array(nodeCount);
  const nodeAlphas = new Float32Array(nodeCount);
  const nodeRings = new Float32Array(nodeCount);
  const worldPositions: Vector3[] = [];

  for (let index = 0; index < nodeCount; index += 1) {
    const node = nodes[index];
    const x = toWorld(node.x);
    const y = toWorld(node.y);
    const z = toWorld(node.z);
    nodePositions[index * 3] = x;
    nodePositions[index * 3 + 1] = y;
    nodePositions[index * 3 + 2] = z;
    nodeSizes[index] = BASE_POINT_SIZE;
    nodeAlphas[index] = 1;
    worldPositions.push(new Vector3(x, y, z));
  }

  const nodeGeometry = new BufferGeometry();
  nodeGeometry.setAttribute('position', new BufferAttribute(nodePositions, 3));
  nodeGeometry.setAttribute('nodeColor', new BufferAttribute(nodeColors, 3));
  nodeGeometry.setAttribute('nodeSize', new BufferAttribute(nodeSizes, 1));
  nodeGeometry.setAttribute('nodeAlpha', new BufferAttribute(nodeAlphas, 1));
  nodeGeometry.setAttribute('nodeRing', new BufferAttribute(nodeRings, 1));

  const nodeMaterial = new ShaderMaterial({
    vertexShader: NODE_VERTEX_SHADER,
    fragmentShader: NODE_FRAGMENT_SHADER,
    uniforms: {
      pixelRatio: { value: renderer.getPixelRatio() },
      sizeScale: { value: POINT_SIZE_SCALE },
      haloExpansion: { value: HALO_EXPANSION },
      haloStrength: { value: HALO_STRENGTH },
      fogNear: { value: 1 },
      fogFar: { value: 2 },
      fogFloor: { value: FOG_FLOOR },
    },
    transparent: true,
    // Depth WRITE off, depth TEST on: overlapping translucent sprites must blend
    // rather than punch holes in each other, but they still respect the links
    // and each other's ordering against the camera.
    depthWrite: false,
    blending: AdditiveBlending,
  });

  const points = new Points(nodeGeometry, nodeMaterial);
  // The cloud is centred on the origin and the camera orbits it, so three's own
  // frustum culling can only ever produce a wrong answer for the whole object.
  points.frustumCulled = false;
  scene.add(points);

  // ---- links: one LineSegments, one draw call ------------------------------
  const edgePositions = new Float32Array(edges.length * 6);
  for (let index = 0; index < edges.length; index += 1) {
    const from = worldPositions[edges[index].source];
    const to = worldPositions[edges[index].target];
    if (!from || !to) continue;
    edgePositions[index * 6] = from.x;
    edgePositions[index * 6 + 1] = from.y;
    edgePositions[index * 6 + 2] = from.z;
    edgePositions[index * 6 + 3] = to.x;
    edgePositions[index * 6 + 4] = to.y;
    edgePositions[index * 6 + 5] = to.z;
  }
  // Per-vertex alpha, which a LineBasicMaterial cannot express: it only has one
  // global opacity, and dropping the links that touch a filtered-out node is the
  // difference between "the query's structure" and "the query's nodes buried in
  // every other link".
  const edgeAlphas = new Float32Array(edges.length * 2).fill(1);
  /**
   * Per-vertex colour, so a link can say whether it stays WITHIN a region or
   * crosses between two.
   *
   * One flat grey for every link made each region's internal mesh and the
   * bridges between regions indistinguishable, which threw away the most
   * interesting thing the edge list knows. An intra-region link now takes that
   * region's own hue, so a cluster reads as one connected body; a cross-region
   * link stays neutral, which turns the remaining grey lines into the visible
   * bridges between topics rather than undifferentiated background.
   *
   * Set once at build time: cluster membership is a property of the projection,
   * not of the current selection, so nothing here changes per frame.
   */
  const edgeColors = new Float32Array(edges.length * 6);
  const neutral = new Color(edgeColor);
  const tint = new Color();
  for (let index = 0; index < edges.length; index += 1) {
    const from = nodes[edges[index].source];
    const to = nodes[edges[index].target];
    const fromRegion = from ? regionOf(from) : -1;
    const toRegion = to ? regionOf(to) : -2;
    if (from && to && fromRegion === toRegion) {
      tint.setHSL(clusterHue(fromRegion) / 360, 0.62, 0.62);
    } else {
      tint.copy(neutral);
    }
    for (let vertex = 0; vertex < 2; vertex += 1) {
      edgeColors[index * 6 + vertex * 3] = tint.r;
      edgeColors[index * 6 + vertex * 3 + 1] = tint.g;
      edgeColors[index * 6 + vertex * 3 + 2] = tint.b;
    }
  }
  const edgeGeometry = new BufferGeometry();
  edgeGeometry.setAttribute('position', new BufferAttribute(edgePositions, 3));
  edgeGeometry.setAttribute('edgeAlpha', new BufferAttribute(edgeAlphas, 1));
  edgeGeometry.setAttribute('edgeColor', new BufferAttribute(edgeColors, 3));
  const edgeMaterial = new ShaderMaterial({
    vertexShader: EDGE_VERTEX_SHADER,
    fragmentShader: EDGE_FRAGMENT_SHADER,
    uniforms: {
      baseOpacity: { value: BASE_EDGE_OPACITY },
      fogNear: { value: 1 },
      fogFar: { value: 2 },
      fogFloor: { value: FOG_FLOOR },
    },
    transparent: true,
    depthWrite: false,
  });
  // Per-edge strength on a 0.35..1 ramp, from each edge's RANK among the others
  // rather than its raw cosine. Raw would be useless here: Phase 1 measured
  // anisotropy putting over 98% of top-10 pairs above 0.8, so the values arrive
  // compressed into a band far too narrow to see. Rank spreads whatever range
  // this corpus actually has, and it is computed ONCE because the ordering is a
  // property of the projection, not of the current selection.
  const edgeStrengths = buildEdgeStrengths(edges);

  // The cloud's own centre and radius, measured once. The fog band is derived
  // from these and the live camera distance every frame, so the depth cue tracks
  // wherever the viewer is rather than assuming the default framing.
  const contentCenter = new Vector3();
  let contentRadius = WORLD_SIZE * 0.5;
  if (worldPositions.length > 0) {
    const low = worldPositions[0].clone();
    const high = worldPositions[0].clone();
    for (const position of worldPositions) {
      low.min(position);
      high.max(position);
    }
    contentCenter.copy(low).add(high).multiplyScalar(0.5);
    contentRadius = Math.max(high.distanceTo(low) * 0.5, WORLD_SIZE * 0.1);
  }

  const lines = new LineSegments(edgeGeometry, edgeMaterial);
  lines.frustumCulled = false;
  scene.add(lines);

  // ---- picking -------------------------------------------------------------
  const raycaster = new Raycaster();
  // Points have no area to hit, so the threshold IS the hit radius (world units).
  raycaster.params.Points.threshold = PICK_THRESHOLD;
  const pointer = new Vector2();

  return {
    scene,
    camera,
    renderer,
    positions: worldPositions,

    setSize(width, height, insets = NO_VIEWPORT_INSETS) {
      if (width === 0 || height === 0) return describeViewport(0, 0, insets);
      // Re-read rather than assume: dragging the window to a display with a
      // different density changes it, and a stale value would silently halve or
      // double every node.
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
      nodeMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio();
      // Aspect AND the off-centre principal point. The offset is in PIXELS, so
      // it must be recomputed here rather than set once: a resize would
      // otherwise leave the map aimed at a canvas that no longer exists.
      // `false` so three never writes width/height styles onto the canvas: the
      // element is laid out by CSS (full-bleed), and letting three set inline
      // styles fights that and produces a feedback loop with the ResizeObserver.
      renderer.setSize(width, height, false);
      return applyViewport(camera, width, height, insets);
    },

    setNodeStyles(styles) {
      const colorAttribute = nodeGeometry.getAttribute('nodeColor') as BufferAttribute;
      const sizeAttribute = nodeGeometry.getAttribute('nodeSize') as BufferAttribute;
      const alphaAttribute = nodeGeometry.getAttribute('nodeAlpha') as BufferAttribute;
      const ringAttribute = nodeGeometry.getAttribute('nodeRing') as BufferAttribute;
      const count = Math.min(styles.length, nodeCount);
      for (let index = 0; index < count; index += 1) {
        const style = styles[index];
        nodeColors[index * 3] = style.color[0];
        nodeColors[index * 3 + 1] = style.color[1];
        nodeColors[index * 3 + 2] = style.color[2];
        nodeSizes[index] = BASE_POINT_SIZE * style.scale;
        nodeAlphas[index] = style.alpha;
        nodeRings[index] = style.ring ?? 0;
      }
      colorAttribute.needsUpdate = true;
      sizeAttribute.needsUpdate = true;
      alphaAttribute.needsUpdate = true;
      ringAttribute.needsUpdate = true;

      // Link visibility is DERIVED here rather than exposed as a second API: an
      // edge is only meaningful when both of its endpoints are on screen, and
      // making that an invariant of this one call means a caller cannot leave a
      // link dangling into hidden space.
      //
      // Multiplied by the edge's own STRENGTH so the mesh has texture instead of
      // being one flat wash. A strong link and a marginal one drew identically
      // before, which is what made a dense area read as noise rather than as
      // structure.
      for (let index = 0; index < edges.length; index += 1) {
        const from = nodeAlphas[edges[index].source] ?? 0;
        const to = nodeAlphas[edges[index].target] ?? 0;
        const visible = from > HIDDEN_ALPHA && to > HIDDEN_ALPHA ? Math.min(from, to) : 0;
        const alpha = visible * edgeStrengths[index];
        edgeAlphas[index * 2] = alpha;
        edgeAlphas[index * 2 + 1] = alpha;
      }
      (edgeGeometry.getAttribute('edgeAlpha') as BufferAttribute).needsUpdate = true;
    },

    setEdgeOpacity(opacity) {
      edgeMaterial.uniforms.baseOpacity.value = opacity;
      edgeMaterial.visible = opacity > 0;
    },

    pick(ndcX, ndcY) {
      pointer.set(ndcX, ndcY);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObject(points, false);
      // Sorted by distance, so the first hit is the nearest to the camera - which
      // is the one the user is looking at when two nodes overlap. Hidden nodes are
      // skipped rather than returned: they are still IN the buffer (filtering is
      // an alpha change, not a geometry rebuild), so without this a filtered-out
      // conversation would still be selectable by clicking empty space.
      for (const hit of hits) {
        const index = hit.index ?? null;
        if (index === null) continue;
        if (nodeAlphas[index] <= HIDDEN_ALPHA) continue;
        return index;
      }
      return null;
    },

    renderFrame() {
      // Recomputed per frame, which is a handful of arithmetic and no allocation.
      // Anchored on the camera's distance to the content so the nearest node
      // sits at full strength and the farthest at the floor, at any zoom.
      const viewDistance = camera.position.distanceTo(contentCenter);
      const near = Math.max(viewDistance - contentRadius * FOG_SPAN_NEAR, 0.01);
      const far = Math.max(viewDistance + contentRadius * FOG_SPAN_FAR, near + 0.01);
      nodeMaterial.uniforms.fogNear.value = near;
      nodeMaterial.uniforms.fogFar.value = far;
      edgeMaterial.uniforms.fogNear.value = near;
      edgeMaterial.uniforms.fogFar.value = far;
      renderer.render(scene, camera);
    },

    dispose() {
      // Order matters only in that the renderer must go last: disposing it tears
      // down the GL context the geometry/material disposals report into.
      nodeGeometry.dispose();
      nodeMaterial.dispose();
      edgeGeometry.dispose();
      edgeMaterial.dispose();
      scene.clear();
      renderer.dispose();
    },
  };
}

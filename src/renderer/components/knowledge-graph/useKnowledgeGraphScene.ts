/**
 * Owns the Knowledge Graph's three.js scene, its camera, and its frame loop.
 *
 * THE RENDER LOOP IS THE POINT. It is on demand: a frame runs only while the
 * camera is actually moving (camera-controls' `update(delta)` reports that) or
 * while something asked for one. When the camera settles, the loop stops and the
 * surface costs literally nothing.
 *
 * That is not an optimization, it is a constraint. This page also hosts live
 * agent terminals, and a permanently-running rAF beside them is exactly the
 * main-thread pressure this project has measured and fought before. The Canvas
 * 2D version had this property for free by only drawing on interaction; moving
 * to WebGL had to keep it.
 *
 * The scene is rebuilt only when the PROJECTION changes (a new signature). Every
 * other change - colour mode, search highlight, selection, hover, link toggle -
 * writes into existing buffers and asks for one frame.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Box3,
  Matrix4,
  Quaternion,
  Raycaster,
  Sphere,
  Spherical,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import CameraControls from 'camera-controls';
import {
  WORLD_SIZE,
  DEFAULT_VIEW_DIRECTION,
  createKnowledgeGraphScene,
  fitDefaultView,
  describeViewport,
  NO_VIEWPORT_INSETS,
  type ViewportInsets,
  type KnowledgeGraphScene,
} from './knowledge-graph-scene';
import { reserveWebglContext } from '../../utils/terminal-webgl';
import type { KnowledgeGraphEdge, KnowledgeGraphNode } from '../../../shared/types';

/**
 * camera-controls is installed with only the nine three classes it actually
 * uses, which is the library's own documented way to avoid pulling the whole of
 * three into its dependency graph. Module scope so the install happens exactly
 * once per renderer, not per mount.
 */
CameraControls.install({
  THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

/** How close the camera may get before it stops. Small enough to fly INSIDE a
 *  cluster, which is the whole point of a spatial view. */
const MIN_DISTANCE = 1;
const MAX_DISTANCE = WORLD_SIZE * 6;
/** World units per second of keyboard flight. Tuned against the world cube, not
 *  in absolute units, so it feels the same at any corpus size. */
const FLY_SPEED = WORLD_SIZE * 0.55;
/**
 * Smallest neighbourhood a fly may frame, as a share of the world cube.
 *
 * A one-hit query has no extent at all, so the fit that serves it would land the
 * camera on a single point with nothing around it to place it. Carried over from
 * the bounding sphere this replaced, whose radius floor was the same 0.12 and
 * for the same reason.
 */
const FLY_MIN_RADIUS = 0.12;

export interface KnowledgeGraphSceneHandle {
  /** Ask for one frame. Cheap and idempotent within a frame. */
  requestRender: () => void;
  /** Animated return to the opening framing. */
  resetView: () => void;
  /**
   * Orbit around ONE node instead of the map's centre, without moving the
   * camera. Pass null to hand the orbit back to the map.
   */
  setOrbitAnchor: (index: number | null) => void;
  /**
   * Fly the camera to frame exactly these nodes. Empty or unknown indices are a
   * no-op, so a query that matches nothing leaves the view where the user put it
   * rather than lurching somewhere arbitrary.
   */
  frameNodes: (indices: ReadonlyArray<number>) => void;
  /** The live scene once its WebGL context exists, for the consumer's style
   *  and label effects to write into. Null before, and when WebGL failed. */
  scene: KnowledgeGraphScene | null;
  /**
   * Set when WebGL could not be initialized at all - a blocklisted driver, a
   * software-rendering environment that refuses a context, or a headless run.
   *
   * Surfaced rather than thrown. A spatial view has no lesser mode to fall back
   * to (unlike a terminal, which has xterm's DOM renderer), so the honest
   * outcome is to say the map cannot be drawn here, not to crash the surface and
   * take the coverage numbers and search down with it.
   */
  unavailableReason: string | null;
}

interface UseKnowledgeGraphSceneOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodes: ReadonlyArray<KnowledgeGraphNode>;
  edges: ReadonlyArray<KnowledgeGraphEdge>;
  /** Rebuild key. The projection's signature: a new one means new geometry. */
  signature: string;
  edgeColor: string;
  /** A node's region at the ACTIVE granularity, for the edge tint. */
  regionOf: (node: KnowledgeGraphNode) => number;
  /** Runs inside every rendered frame, after the camera has been updated and
   *  before the draw - where DOM label positions are written. Kept out of React
   *  state on purpose: this runs at frame rate. */
  onFrame?: (scene: KnowledgeGraphScene) => void;
  /** Pixels of the canvas covered by the floating panels, so the camera can aim
   *  at the part of it the user can actually see. */
  insets?: ViewportInsets;
  /**
   * Nodes the DEFAULT VIEW frames, or null for the whole map.
   *
   * This is the FACET scope (regions, time, outcome), never the search
   * highlight, and the difference is the reason it is a separate input rather
   * than "whatever is drawn". A facet exclusion is a persistent re-scoping: with
   * regions switched off the map IS the remaining regions, so its canonical
   * framing moves with them. A search is a transient question the camera FLIES
   * to (`frameNodes`), and Reset view is the documented way back from one -
   * which it could not be if it framed the hits.
   */
  framingIndices?: ReadonlyArray<number> | null;
  /** How many unit boxes wide the map is (composed islands spread past one). The
   *  camera may pull back that much further, so the whole map still fits. */
  worldExtent?: number;
  /**
   * Where the camera was when the last scene went, held by a host that outlives
   * the canvas. A new map inside an open graph (a project added to or taken out
   * of the scope, a finished map pass) starts from that pose and FLIES to its
   * framing, where a fresh camera would snap there. Absent on the first open.
   */
  cameraMemory?: React.MutableRefObject<RememberedCamera | null>;
  /**
   * Whose map the remembered pose belongs to: the open project. A pose from
   * another project is never flown from, since a project switch paints flat
   * (`.claude/rules/restore-no-animation-replay.md`).
   */
  cameraMemoryKey?: string | null;
}

/** The camera as the last scene left it. */
export interface RememberedCamera {
  key: string | null;
  /** The map it was looking at. The same map built again (React's StrictMode
   *  runs the scene effect twice at mount) takes the pose back without a fly. */
  signature: string;
  position: Vector3;
  target: Vector3;
  /** Whether it sat at the default framing, which the new map then flies to.
   *  Otherwise the reader had gone somewhere, and the pose is kept. */
  viewWasDefault: boolean;
}

export function useKnowledgeGraphScene(options: UseKnowledgeGraphSceneOptions): KnowledgeGraphSceneHandle {
  const {
    canvasRef, containerRef, nodes, edges, signature, edgeColor, regionOf, onFrame,
    insets = NO_VIEWPORT_INSETS, framingIndices = null, worldExtent = 1,
    cameraMemory, cameraMemoryKey = null,
  } = options;
  // Read by the scene effect, which must not re-run for a new key alone.
  const cameraMemoryKeyRef = useRef(cameraMemoryKey);
  /** Whether this scene started from a remembered pose, so its first fit flies
   *  too rather than snapping over the fly it just began. */
  const flyOnArrivalRef = useRef(false);

  // Read inside effects that must not re-run when a panel opens: the scene is
  // never rebuilt for chrome, only re-aimed.
  const insetsRef = useRef(insets);
  // Read when the controls are built; a later change is applied by its own
  // effect below rather than by rebuilding the scene.
  const worldExtentRef = useRef(worldExtent);
  // Same reason: a facet change must not rebuild the scene. It is read at FIT
  // time, which is the only moment the framing is recomputed.
  const framingIndicesRef = useRef(framingIndices);

  const sceneRef = useRef<KnowledgeGraphScene | null>(null);
  const controlsRef = useRef<CameraControls | null>(null);
  const frameRef = useRef<number | null>(null);
  // Held keys for the fly camera. A Set rather than React state: it is read
  // inside the frame loop and must never cause a re-render.
  const heldKeysRef = useRef<Set<string>>(new Set());
  const onFrameRef = useRef(onFrame);

  // The latest inputs, mirrored for the effects and the frame loop that read
  // them without re-running on them. Written in a LAYOUT effect rather than in
  // render: every layout effect of a commit runs before any passive one, and
  // every reader here is a passive effect, a callback, or the frame loop, so
  // none of them can see a stale value.
  useLayoutEffect(() => {
    insetsRef.current = insets;
    framingIndicesRef.current = framingIndices;
    onFrameRef.current = onFrame;
    worldExtentRef.current = worldExtent;
    cameraMemoryKeyRef.current = cameraMemoryKey;
  });

  // A composed map is wider than one project's, so the camera may pull back in
  // proportion. The scene is rebuilt for a new composition anyway (its signature
  // changes); this keeps the limit right if the extent ever moves without it.
  useEffect(() => {
    if (controlsRef.current) controlsRef.current.maxDistance = MAX_DISTANCE * worldExtent;
  }, [worldExtent]);

  /**
   * Whether the camera is still sitting at the framing we computed for it.
   *
   * A resize re-frames only while this holds. That distinction is the whole
   * point: recomputing the fit is what keeps the default view safe at any window
   * size, and doing it to someone who has flown somewhere would throw away the
   * place they went to look at.
   *
   * Deliberately NOT driven by camera-controls' `control` event, which fires for
   * programmatic transitions too - the animated Reset view would mark its own
   * result as user-adjusted the moment it started moving.
   */
  const viewIsDefaultRef = useRef(false);
  /** Whether the camera has taken its aim from a chrome measurement yet. The
   *  first one lands; later ones only feed the next fit. See the effect below. */
  const aimedRef = useRef(false);

  /**
   * The node the camera currently orbits around, and the map centre to hand the
   * orbit back to.
   *
   * Kept as state the hook re-applies rather than a one-shot call, because a
   * re-fit (a resize, a panel opening) rewrites the target through `setLookAt`
   * and would silently drop the anchor otherwise - the user would still have a
   * node selected and the map would quietly go back to spinning about its own
   * middle.
   */
  const orbitAnchorRef = useRef<Vector3 | null>(null);
  const framingCenterRef = useRef<Vector3 | null>(null);
  /** Removes the `sleep` listener an anchor set mid-flight is waiting on, or
   *  null when none waits. A fly or a reset that re-targets the camera cancels
   *  it: fired after that move, it re-pivoted the orbit on the whole map. */
  const cancelPendingOrbitRef = useRef<(() => void) | null>(null);

  // The scene effect must not list `applyDefaultView` as a dependency - a new
  // identity would tear down the whole WebGL context and rebuild it - and it
  // still has to call the one canonical framing. A ref is the seam.
  const applyDefaultViewRef = useRef<((animate: boolean) => void) | null>(null);

  /**
   * What the last scene build produced: the live scene, or why there is none.
   *
   * State rather than a read of `sceneRef` in render, because the consumer's
   * style and label effects have to re-run once the scene exists, and a ref
   * change schedules nothing. One object so a build reports both halves in a
   * single update.
   */
  const [build, setBuild] = useState<{ scene: KnowledgeGraphScene | null; unavailableReason: string | null }>(
    { scene: null, unavailableReason: null },
  );

  const requestRender = useCallback(() => {
    if (frameRef.current !== null) return;
    // Timed here rather than with three's Clock (deprecated) or Timer: the loop
    // needs one number, and owning it keeps the first frame's delta honest -
    // a freshly constructed clock reports the time since construction, which on
    // a wake after an idle pause is however long the user sat still.
    let previousTime = performance.now();
    const step = (): void => {
      const scene = sceneRef.current;
      const controls = controlsRef.current;
      if (!scene || !controls) {
        frameRef.current = null;
        return;
      }

      const now = performance.now();
      // Clamped: a backgrounded window or a long main-thread stall would
      // otherwise hand the camera one enormous step and teleport it.
      const delta = Math.min((now - previousTime) / 1000, 0.1);
      previousTime = now;
      let flying: boolean;
      let cameraMoved: boolean;
      let easing: boolean;
      try {
        flying = applyKeyboardFlight(controls, heldKeysRef.current, delta);
        cameraMoved = controls.update(delta);
        onFrameRef.current?.(scene);
        easing = scene.renderFrame();
      } catch (error) {
        // A frame that throws must not leave the loop marked as running, or
        // requestRender refuses every later frame and the map stays frozen.
        frameRef.current = null;
        throw error;
      }

      // Keep going only while something is still moving: the camera, or a style
      // change easing in. When both settle this stops, and the surface goes back
      // to costing nothing until the next interaction or data change.
      if (cameraMoved || flying || easing) {
        frameRef.current = requestAnimationFrame(step);
        return;
      }
      frameRef.current = null;
    };
    frameRef.current = requestAnimationFrame(step);
  }, []);

  // ---- scene lifecycle ------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    // Claim a slot in the page's WebGL budget BEFORE creating the context, so a
    // terminal mounting in the same frame sees the reduced headroom rather than
    // racing us to Chromium's cap.
    const releaseContext = reserveWebglContext('knowledge-graph');

    let created: KnowledgeGraphScene | null = null;
    let unavailableReason: string | null = null;
    try {
      created = createKnowledgeGraphScene({ canvas, nodes, edges, edgeColor, regionOf });
    } catch (error) {
      // `new WebGLRenderer` throws when a context cannot be acquired. Release
      // the slot immediately: holding a reservation for a context we never got
      // would shrink the terminals' budget for nothing.
      releaseContext();
      unavailableReason = error instanceof Error ? error.message : 'WebGL is unavailable';
      console.warn('[knowledge-graph] WebGL unavailable; the map cannot be drawn here:', error);
    }
    // A WebGL context can only be created against the committed canvas, so
    // this effect is where the scene comes into existence, and whether it did
    // is exactly what the surface renders: the map, or the reason it cannot be.
    setBuild({ scene: created, unavailableReason });
    if (!created) return;
    const scene = created;
    sceneRef.current = scene;
    // The anchor is a position in the LAST scene. A rebuild moves every node,
    // so the framing below must not re-apply it; the host declares it again
    // against this scene (`setOrbitAnchor`) once the scene is in its hands.
    orbitAnchorRef.current = null;
    cancelPendingOrbitRef.current?.();
    cancelPendingOrbitRef.current = null;

    const controls = new CameraControls(scene.camera, canvas);
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE * worldExtentRef.current;
    // Damping is what makes it feel like a camera rather than a slider: the
    // glide after you let go. `update()` reports non-settled until it decays,
    // which is what keeps the frame loop alive through that glide.
    //
    // `smoothTime`, not the older `dampingFactor` - camera-controls deprecated
    // the factor form and warns on it. These are SECONDS to settle, so smaller
    // is snappier; slightly under the library defaults (0.25 / 0.125) because a
    // point cloud has no scenery to sell a long, slow drift.
    controls.smoothTime = 0.18;
    controls.draggingSmoothTime = 0.1;
    controls.dollyToCursor = true;
    controls.infinityDolly = false;
    controlsRef.current = controls;

    // SIZE FIRST. The framing below reads `camera.aspect`, and the camera is
    // constructed at aspect 1 - so fitting before this call sized the view to a
    // square on a 2:1 window and pushed the camera roughly twice as far back as
    // it needed to be, leaving the map marooned in the middle of the viewport.
    scene.setSize(container.clientWidth, container.clientHeight, insetsRef.current);

    // Framed to the content rather than to a constant, through the SAME call
    // Reset view and a resize make - so "initial", "reset" and "re-fitted"
    // cannot drift apart. `saveState` still runs so camera-controls has a sane
    // baseline, but nothing relies on it any more.
    //
    // A NEW map inside an open graph flies instead: every change to what the
    // map shows moves the camera by flying, never by a cut. The camera starts
    // where the last scene left it and goes to the new framing; one the reader
    // had flown away from stays put, and a fly target the host still holds is
    // flown to again by the host once this scene exists.
    // This scene's own key, taken now: by the time its cleanup runs, the ref
    // already holds the NEXT scene's, which would let a project switch fly.
    const sceneKey = cameraMemoryKeyRef.current;
    const remembered = cameraMemory?.current ?? null;
    if (remembered && remembered.key === sceneKey) {
      // A different map flies; the same map built again only takes its pose
      // back, or StrictMode's second mount turned the opening fit into a fly.
      const newMap = remembered.signature !== signature;
      flyOnArrivalRef.current = newMap;
      controls.setLookAt(
        remembered.position.x, remembered.position.y, remembered.position.z,
        remembered.target.x, remembered.target.y, remembered.target.z,
        false,
      );
      if (remembered.viewWasDefault) applyDefaultViewRef.current?.(newMap);
      else viewIsDefaultRef.current = false;
    } else {
      flyOnArrivalRef.current = false;
      applyDefaultViewRef.current?.(false);
    }
    controls.saveState();

    // Any user interaction restarts the loop. `control` covers camera-controls'
    // own pointer handling; the raw listeners are the belt-and-braces half, so a
    // restart never depends on one library event name.
    const wake = (): void => requestRender();
    // `controlstart` is the USER-gesture event; `control` also fires for our own
    // animated transitions, so only this one may retire the default view.
    const takeOver = (): void => {
      viewIsDefaultRef.current = false;
      requestRender();
    };
    controls.addEventListener('control', wake);
    controls.addEventListener('transitionstart', wake);
    controls.addEventListener('controlstart', takeOver);
    canvas.addEventListener('pointerdown', wake);
    canvas.addEventListener('wheel', takeOver, { passive: true });
    // three restores its own state after a GPU reset, but frames are drawn on
    // demand, so an idle map stays blank until something asks for one.
    canvas.addEventListener('webglcontextrestored', wake);

    // The size the fit above was made for. The observer reports once as soon as
    // it starts watching, at that same size. That report still re-aims, since
    // the chrome may have been measured since, but a scene flying in from a
    // remembered pose re-aims as a fly, or it would cut its own fly short.
    let fittedWidth = Math.round(container.clientWidth);
    let fittedHeight = Math.round(container.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const resized = Math.round(rect.width) !== fittedWidth || Math.round(rect.height) !== fittedHeight;
      fittedWidth = Math.round(rect.width);
      fittedHeight = Math.round(rect.height);
      scene.setSize(rect.width, rect.height, insetsRef.current);
      // A fit is a function of the pane, so a pane that changed shape has a
      // different answer. Without this, narrowing the window cropped the map
      // and widening it left the map marooned in the middle - and the only way
      // back was a control the user had to know to press. Re-framed instantly
      // rather than animated: a drag-resize fires this on every frame, and an
      // animation would fight itself the whole way across the screen.
      if (viewIsDefaultRef.current) applyDefaultViewRef.current?.(!resized && flyOnArrivalRef.current);
      requestRender();
    });
    observer.observe(container);

    requestRender();

    return () => {
      observer.disconnect();
      controls.removeEventListener('control', wake);
      controls.removeEventListener('transitionstart', wake);
      controls.removeEventListener('controlstart', takeOver);
      canvas.removeEventListener('pointerdown', wake);
      canvas.removeEventListener('wheel', takeOver);
      canvas.removeEventListener('webglcontextrestored', wake);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      // Where the next map in this graph flies from.
      if (cameraMemory) {
        const position = new Vector3();
        const target = new Vector3();
        controls.getPosition(position);
        controls.getTarget(target);
        cameraMemory.current = {
          key: sceneKey,
          signature,
          position,
          target,
          viewWasDefault: viewIsDefaultRef.current,
        };
      }
      controls.dispose();
      // `dispose` frees the GPU resources but not the context, which lives
      // until the canvas is collected. On a real unmount the canvas has already
      // left the document, so the context is lost here; a rebuild for a new map
      // (and StrictMode's rehearsal) keeps the canvas, and the next scene takes
      // a context on that same element, so losing it there would blank the map.
      const unmounting = !canvas.isConnected;
      scene.dispose();
      if (unmounting) scene.renderer.forceContextLoss();
      controlsRef.current = null;
      sceneRef.current = null;
      // Released only after the context is genuinely gone, so the coordinator
      // never hands the freed slot to a terminal while we still hold it.
      releaseContext();
    };
    // Rebuilt only on a genuinely new projection. `nodes`/`edges` are read at
    // construction and are stable for a given signature; listing them would
    // rebuild the whole scene on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature IS the identity of nodes/edges; see above
  }, [signature, canvasRef, containerRef, requestRender]);

  // Link colour follows the theme, which can change without the data changing.
  // The scene is built with the colour of its own render, and the host reads
  // the theme token a commit later, so the first scene needs this too.
  useEffect(() => {
    sceneRef.current?.setEdgeColor(edgeColor);
    requestRender();
  }, [edgeColor, requestRender]);

  /**
   * A panel opened or closed, so the clear area moved.
   *
   * Treated exactly like a resize, because it is one: the framing is a function
   * of the pane the user can SEE, and that pane just changed shape. One rule
   * covers both, which also covers the first paint - the panels are measured
   * after the scene mounts, so the opening fit would otherwise be the one
   * computed for a canvas with no chrome on it.
   */
  useEffect(() => {
    const scene = sceneRef.current;
    const container = containerRef.current;
    if (!scene || !container) return;
    // The FIRST measurement only. The panels are measured after the scene
    // mounts, so without this the opening fit would be the one computed for a
    // canvas with no chrome on it.
    //
    // Every LATER change is deliberately ignored, and that is a reversal. It
    // used to re-aim on every chrome change, so that a rail sliding in would
    // slide the map out from under it. In use that is the wrong trade by a wide
    // margin: the detail rail opens on every node click, so the entire map
    // lurched sideways each time the user selected something - while they were
    // looking at the thing they had just clicked. A panel is an overlay; it
    // should cover part of the view, not push it. The insets are still read at
    // FIT time (`applyDefaultView`), so the opening frame and Reset view both
    // still clear the chrome; only the involuntary mid-session re-aim is gone.
    if (aimedRef.current) return;
    aimedRef.current = true;
    scene.setSize(container.clientWidth, container.clientHeight, insets);
    // A scene that began from a remembered pose is mid-fly: re-aim it the same
    // way rather than cutting to the end.
    if (viewIsDefaultRef.current) applyDefaultViewRef.current?.(flyOnArrivalRef.current);
    requestRender();
  }, [insets, containerRef, requestRender]);

  // ---- keyboard flight ------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Captured once: the Set instance is created with the ref and never
    // reassigned, so this is the same object the frame loop reads - and it keeps
    // the cleanup from reaching through a ref that could, in general, have moved.
    const heldKeys = heldKeysRef.current;

    const onKeyDown = (event: KeyboardEvent): void => {
      // A chord is an app shortcut (Mod+S, Mod+Shift+D), not flight. macOS also
      // sends no keyup for a letter released while Cmd is held, so a chord that
      // started flight would never stop it.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (!FLY_KEYS.has(key)) return;
      event.preventDefault();
      heldKeys.add(key);
      requestRender();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      heldKeys.delete(event.key.toLowerCase());
    };
    // Clearing on blur matters: a key released while the canvas is not focused
    // never fires keyup here, and the camera would fly forever.
    const onBlur = (): void => heldKeys.clear();

    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);
    return () => {
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      heldKeys.clear();
    };
  }, [canvasRef, requestRender]);

  /**
   * Point the orbit at the anchored node, or back at the map's centre.
   *
   * `setOrbitPoint` moves no pixels - it re-expresses the same camera around a
   * different pivot - so selecting a node changes what a DRAG does without the
   * view jumping first, which is the whole point: you keep looking at what you
   * were looking at, and it now turns about the thing you picked.
   */
  const applyOrbitPoint = useCallback(() => {
    const controls = controlsRef.current;
    const point = orbitAnchorRef.current ?? framingCenterRef.current;
    if (!controls || !point) return;
    // `setOrbitPoint` re-expresses the camera around a new pivot by reading the
    // camera OBJECT's current position - which camera-controls only writes
    // during `update()`. Called before the first frame it reads the position
    // the camera was constructed at, computes a nonsense offset, and teleports
    // the map off screen. Syncing first costs nothing: with no transition in
    // flight a zero delta simply flushes the pending state onto the camera.
    controls.update(0);
    controls.setOrbitPoint(point.x, point.y, point.z);
    requestRender();
  }, [requestRender]);

  /**
   * The canonical view: default direction, distance fitted to the map on screen.
   *
   * Used by BOTH the mount path and Reset view, so "initial" and "reset" cannot
   * drift apart - which is the property that made the clipping so confusing,
   * since resetting reproduced the broken framing faithfully.
   */
  const applyDefaultView = useCallback((animate: boolean) => {
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    if (!scene || !controls) return;

    const container = containerRef.current;
    // A FIT is the one moment the viewport is re-established, and the scene has
    // to be told before the framing is computed against it.
    //
    // Without this the two disagree: the chrome effect below deliberately stops
    // re-aiming after the first measurement, so the camera keeps ITS view offset
    // while this fit computes for whatever the panels measure NOW. Toggling
    // regions resizes the Regions list, and Reset view then framed for one safe
    // area while rendering through another - the map bunched into a corner with
    // dead space opposite. Re-establishing it here keeps "do not move when a
    // panel opens" and "frame correctly when asked to" from pulling against each
    // other, because only an explicit fit moves the viewport now.
    if (container) scene.setSize(container.clientWidth, container.clientHeight, insetsRef.current);
    const viewport = describeViewport(
      container?.clientWidth ?? 0,
      container?.clientHeight ?? 0,
      insetsRef.current,
    );
    // The default view frames what is DRAWN, not every node the projection
    // holds. A facet exclusion re-scopes the map, so fitting the whole cloud
    // framed a map that was no longer there: measured on the real
    // 648-conversation corpus with 9 of 39 regions on, the visible 177 filled
    // 0.57 of the safe area's height, against the 0.88 the same fit gives an
    // unfiltered map. Reset view was therefore the one control that pulled the
    // view further OUT after a filter.
    let framed: ReadonlyArray<Vector3> = scene.positions;
    const scope = framingIndicesRef.current;
    if (scope && scope.length > 0) {
      const subset: Vector3[] = [];
      for (const index of scope) {
        const position = scene.positions[index];
        if (position) subset.push(position);
      }
      // An empty scope keeps the whole map. Nothing is drawn at that point, so
      // there is nothing to frame, and the map's own default is a better place
      // to be standing when a region comes back on.
      if (subset.length > 0) framed = subset;
    }
    // A projection with no nodes has no shape to fit, so fall back to the fixed
    // vantage rather than leaving the camera wherever it was constructed.
    const framing = fitDefaultView(framed, scene.camera.fov, viewport);
    const center = framing?.center ?? new Vector3(0, 0, 0);
    const direction = framing?.direction ?? DEFAULT_VIEW_DIRECTION;
    const distance = framing?.distance ?? WORLD_SIZE * 1.6;
    // Around the content's own centre, not the origin: the layout is fitted to a
    // percentile box, so its centre of mass is not necessarily at 0,0,0.
    controls.setLookAt(
      center.x + direction.x * distance,
      center.y + direction.y * distance,
      center.z + direction.z * distance,
      center.x, center.y, center.z,
      animate,
    );
    framingCenterRef.current = center.clone();
    viewIsDefaultRef.current = true;
    // `setLookAt` has just rewritten the orbit target, so an anchored orbit has
    // to be re-declared. Not while a transition is running: camera-controls
    // documents `setOrbitPoint` as unsafe mid-animation, and Reset view is the
    // one animated caller - which clears the anchor anyway.
    // Only when there is an anchor to RESTORE. With none, `setLookAt` has
    // already pointed the orbit at the map's centre, and re-declaring it would
    // be a second write for no change.
    if (!animate && orbitAnchorRef.current) applyOrbitPoint();
    requestRender();
  }, [containerRef, requestRender, applyOrbitPoint]);
  // Mirrored in a layout effect for the reason the inputs above are: the scene
  // effect and the resize observer that call it are passive, so they always
  // run after this has been written.
  useLayoutEffect(() => {
    applyDefaultViewRef.current = applyDefaultView;
  }, [applyDefaultView]);

  const resetView = useCallback(() => {
    // A reset means the map as a whole - the whole of whatever the facets have
    // scoped it to - so it drops the anchor rather than flying back to the
    // default framing and continuing to orbit one conversation.
    orbitAnchorRef.current = null;
    cancelPendingOrbitRef.current?.();
    cancelPendingOrbitRef.current = null;
    applyDefaultView(true);
  }, [applyDefaultView]);

  const setOrbitAnchor = useCallback((index: number | null) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const position = index === null ? null : scene.positions[index] ?? null;
    // Nothing to do when the anchor has not actually changed. Mount runs this
    // with no selection, and re-declaring "orbit the centre" there is a write
    // against a camera that has not been placed yet.
    if (position === null && orbitAnchorRef.current === null) return;
    orbitAnchorRef.current = position ? position.clone() : null;
    const controls = controlsRef.current;
    // camera-controls documents `setOrbitPoint` as unsafe mid-transition, and a
    // new map arriving flies to its framing: the pivot lands once the camera
    // has stopped. Read from the ref then, so the latest anchor wins.
    cancelPendingOrbitRef.current?.();
    cancelPendingOrbitRef.current = null;
    if (controls?.active) {
      const onSleep = (): void => {
        controls.removeEventListener('sleep', onSleep);
        cancelPendingOrbitRef.current = null;
        applyOrbitPoint();
      };
      controls.addEventListener('sleep', onSleep);
      cancelPendingOrbitRef.current = () => controls.removeEventListener('sleep', onSleep);
      return;
    }
    applyOrbitPoint();
  }, [applyOrbitPoint]);

  const frameNodes = useCallback((indices: ReadonlyArray<number>) => {
    const scene = sceneRef.current;
    const controls = controlsRef.current;
    if (!scene || !controls || indices.length === 0) return;

    const points: Vector3[] = [];
    for (const index of indices) {
      const position = scene.positions[index];
      if (position) points.push(position);
    }
    if (points.length === 0) return;

    // THE SAME FIT the default view uses, along the camera's CURRENT direction.
    //
    // It was `controls.fitToSphere`, and two fits that disagree is exactly what
    // reads as inconsistent. A sphere CIRCUMSCRIBES, and this layout is a
    // flattened, elongated cloud rather than a ball, so it framed nothing like
    // the default view did - and it knows nothing about the floating panels or
    // the label chips either. Measured on the real corpus with three of
    // thirty-nine regions on: a facet toggle left 54px of clearance above the
    // map, against Reset view's 208, and the top inset alone is 50 - so the top
    // row of titles sat under the search box.
    //
    // Direction is the one thing this fly must keep and the default fit
    // deliberately does not: a fly frames a subset from where the user is
    // standing, where arriving at a map picks the angle that shows its shape.
    const container = containerRef.current;
    const viewport = describeViewport(
      container?.clientWidth ?? 0,
      container?.clientHeight ?? 0,
      insetsRef.current,
    );
    // Allocated rather than scratched: this runs on a fly, not per frame.
    const direction = new Vector3();
    const currentTarget = new Vector3();
    controls.getPosition(direction);
    controls.getTarget(currentTarget);
    direction.sub(currentTarget);
    // Degenerate only before the camera has been placed at all, where there is
    // no orientation worth keeping.
    if (direction.lengthSq() < 1e-6) direction.copy(DEFAULT_VIEW_DIRECTION);
    else direction.normalize();

    const framing = fitDefaultView(points, scene.camera.fov, viewport, direction);
    if (!framing) return;

    // A one-hit query fits at zero distance, and the shared fit's own floor is a
    // camera DISTANCE rather than a framed volume - it would stop 25 units from
    // a lone point with nothing around it. What a fly needs floored is the
    // NEIGHBOURHOOD it lands in, which is what the bounding sphere's radius
    // floor used to express, so that is restored here in the same terms.
    const halfFov = Math.tan((scene.camera.fov / 2) * (Math.PI / 180));
    const halfAngle = Math.atan(Math.min(
      halfFov * viewport.safeFractionY,
      halfFov * Math.max(viewport.aspect, 0.0001) * viewport.safeFractionX,
    ));
    const distance = Math.max(framing.distance, (WORLD_SIZE * FLY_MIN_RADIUS) / Math.sin(halfAngle));

    // A deliberate departure from the default view, so a later resize leaves it
    // alone rather than yanking the camera back out to the whole map.
    viewIsDefaultRef.current = false;
    // The fly re-targets the camera on the subset, and camera-controls forbids
    // `setOrbitPoint` mid-transition - so the anchor is dropped here rather
    // than fought with, along with a pivot still waiting for the last move.
    orbitAnchorRef.current = null;
    cancelPendingOrbitRef.current?.();
    cancelPendingOrbitRef.current = null;
    void controls.setLookAt(
      framing.center.x + framing.direction.x * distance,
      framing.center.y + framing.direction.y * distance,
      framing.center.z + framing.direction.z * distance,
      framing.center.x, framing.center.y, framing.center.z,
      true,
    );
    requestRender();
  }, [containerRef, requestRender]);

  return {
    requestRender,
    resetView,
    setOrbitAnchor,
    frameNodes,
    scene: build.scene,
    unavailableReason: build.unavailableReason,
  };
}

const FLY_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

/**
 * Translate the camera for held movement keys. Returns whether anything moved,
 * so the frame loop knows to keep going.
 *
 * `forward` and `truck` move the TARGET as well as the eye, which is what makes
 * this flight rather than orbiting: you can pass through the cloud and keep
 * going, instead of being tethered to a fixed point.
 */
function applyKeyboardFlight(
  controls: CameraControls,
  heldKeys: ReadonlySet<string>,
  delta: number,
): boolean {
  if (heldKeys.size === 0) return false;
  const step = FLY_SPEED * delta;
  let moved = false;

  if (heldKeys.has('w')) { controls.forward(step, false); moved = true; }
  if (heldKeys.has('s')) { controls.forward(-step, false); moved = true; }
  if (heldKeys.has('a')) { controls.truck(-step, 0, false); moved = true; }
  if (heldKeys.has('d')) { controls.truck(step, 0, false); moved = true; }
  if (heldKeys.has('q')) { controls.truck(0, -step, false); moved = true; }
  if (heldKeys.has('e')) { controls.truck(0, step, false); moved = true; }

  return moved;
}

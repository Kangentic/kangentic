/**
 * Owns the Memory Graph's three.js scene, its camera, and its frame loop.
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

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
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
  createMemoryGraphScene,
  fitDefaultView,
  describeViewport,
  NO_VIEWPORT_INSETS,
  type ViewportInsets,
  type MemoryGraphScene,
} from './memory-graph-scene';
import { reserveWebglContext } from '../../utils/terminal-webgl';
import type { MemoryGraphEdge, MemoryGraphNode } from '../../../shared/types';

/**
 * camera-controls is installed with only the nine three classes it actually
 * uses, which is the library's own documented way to avoid pulling the whole of
 * three into its dependency graph. Module scope so the install happens exactly
 * once per renderer, not per mount.
 */
CameraControls.install({
  THREE: { Vector2, Vector3, Vector4, Quaternion, Matrix4, Spherical, Box3, Sphere, Raycaster },
});

/** Opening camera distance, as a multiple of the world cube's half-extent. */
/** How close the camera may get before it stops. Small enough to fly INSIDE a
 *  cluster, which is the whole point of a spatial view. */
const MIN_DISTANCE = 1;
const MAX_DISTANCE = WORLD_SIZE * 6;
/** World units per second of keyboard flight. Tuned against the world cube, not
 *  in absolute units, so it feels the same at any corpus size. */
const FLY_SPEED = WORLD_SIZE * 0.55;

export interface MemoryGraphSceneHandle {
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
  scene: MemoryGraphScene | null;
  controls: CameraControls | null;
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

interface UseMemoryGraphSceneOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  nodes: ReadonlyArray<MemoryGraphNode>;
  edges: ReadonlyArray<MemoryGraphEdge>;
  /** Rebuild key. The projection's signature: a new one means new geometry. */
  signature: string;
  edgeColor: string;
  /** A node's region at the ACTIVE granularity, for the edge tint. */
  regionOf: (node: MemoryGraphNode) => number;
  /** Runs inside every rendered frame, after the camera has been updated and
   *  before the draw - where DOM label positions are written. Kept out of React
   *  state on purpose: this runs at frame rate. */
  onFrame?: (scene: MemoryGraphScene) => void;
  /** Pixels of the canvas covered by the floating panels, so the camera can aim
   *  at the part of it the user can actually see. */
  insets?: ViewportInsets;
}

export function useMemoryGraphScene(options: UseMemoryGraphSceneOptions): MemoryGraphSceneHandle {
  const {
    canvasRef, containerRef, nodes, edges, signature, edgeColor, regionOf, onFrame,
    insets = NO_VIEWPORT_INSETS,
  } = options;

  // Read inside effects that must not re-run when a panel opens: the scene is
  // never rebuilt for chrome, only re-aimed.
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  const sceneRef = useRef<MemoryGraphScene | null>(null);
  const controlsRef = useRef<CameraControls | null>(null);
  const frameRef = useRef<number | null>(null);
  // Held keys for the fly camera. A Set rather than React state: it is read
  // inside the frame loop and must never cause a re-render.
  const heldKeysRef = useRef<Set<string>>(new Set());
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  /**
   * Nothing reads this value - the POINT is the re-render.
   *
   * The scene is created inside an effect, but the handle returned from this hook
   * reads `sceneRef.current` during RENDER. Without a state update once the scene
   * exists, React never re-renders, `handle.scene` stays null forever, and the
   * consumer's style/edge effects never get a scene to write into. This is what
   * turns "the scene now exists" into something the React tree can observe.
   */
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

  // The scene effect must not list `applyDefaultView` as a dependency - a new
  // identity would tear down the whole WebGL context and rebuild it - and it
  // still has to call the one canonical framing. A ref is the seam.
  const applyDefaultViewRef = useRef<((animate: boolean) => void) | null>(null);

  const [, markSceneBuilt] = useReducer((count: number) => count + 1, 0);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);

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
      const flying = applyKeyboardFlight(controls, heldKeysRef.current, delta);
      const cameraMoved = controls.update(delta);

      onFrameRef.current?.(scene);
      scene.renderFrame();

      // Keep going only while something is still moving. When the camera settles
      // this stops, and the surface goes back to costing nothing until the next
      // interaction or data change.
      if (cameraMoved || flying) {
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
    const releaseContext = reserveWebglContext('memory-graph');

    let scene: MemoryGraphScene;
    try {
      scene = createMemoryGraphScene({ canvas, nodes, edges, edgeColor, regionOf });
    } catch (error) {
      // `new WebGLRenderer` throws when a context cannot be acquired. Release
      // the slot immediately: holding a reservation for a context we never got
      // would shrink the terminals' budget for nothing.
      releaseContext();
      setUnavailableReason(error instanceof Error ? error.message : 'WebGL is unavailable');
      console.warn('[memory-graph] WebGL unavailable; the map cannot be drawn here:', error);
      return;
    }
    setUnavailableReason(null);
    sceneRef.current = scene;

    const controls = new CameraControls(scene.camera, canvas);
    controls.minDistance = MIN_DISTANCE;
    controls.maxDistance = MAX_DISTANCE;
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
    applyDefaultViewRef.current?.(false);
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

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      scene.setSize(rect.width, rect.height, insetsRef.current);
      // A fit is a function of the pane, so a pane that changed shape has a
      // different answer. Without this, narrowing the window cropped the map
      // and widening it left the map marooned in the middle - and the only way
      // back was a control the user had to know to press. Re-framed instantly
      // rather than animated: a drag-resize fires this on every frame, and an
      // animation would fight itself the whole way across the screen.
      if (viewIsDefaultRef.current) applyDefaultViewRef.current?.(false);
      requestRender();
    });
    observer.observe(container);

    markSceneBuilt();
    requestRender();

    return () => {
      observer.disconnect();
      controls.removeEventListener('control', wake);
      controls.removeEventListener('transitionstart', wake);
      controls.removeEventListener('controlstart', takeOver);
      canvas.removeEventListener('pointerdown', wake);
      canvas.removeEventListener('wheel', takeOver);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      controls.dispose();
      scene.dispose();
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
  useEffect(() => {
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
    if (viewIsDefaultRef.current) applyDefaultViewRef.current?.(false);
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
   * The canonical view: default direction, distance fitted to the whole map.
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
    const viewport = describeViewport(
      container?.clientWidth ?? 0,
      container?.clientHeight ?? 0,
      insetsRef.current,
    );
    // A projection with no nodes has no shape to fit, so fall back to the fixed
    // vantage rather than leaving the camera wherever it was constructed.
    const framing = fitDefaultView(scene.positions, scene.camera.fov, viewport);
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
  applyDefaultViewRef.current = applyDefaultView;

  const resetView = useCallback(() => {
    // A reset means the whole map, so it drops the anchor rather than flying
    // back to the default framing and continuing to orbit one conversation.
    orbitAnchorRef.current = null;
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

    // A bounding sphere rather than a box: `fitToSphere` frames it the same way
    // from any angle, so the fly does not also swing the camera around to suit a
    // box's axes.
    const sphere = new Sphere().setFromPoints(points);
    // A single hit has radius 0, which would fit the camera to a point and dolly
    // to the near plane. Give it enough room to see the neighbourhood it sits in.
    sphere.radius = Math.max(sphere.radius, WORLD_SIZE * 0.12);
    // A deliberate departure from the default view, so a later resize leaves it
    // alone rather than yanking the camera back out to the whole map.
    viewIsDefaultRef.current = false;
    // The fly re-targets the camera on the subset, and camera-controls forbids
    // `setOrbitPoint` mid-transition - so the anchor is dropped here rather
    // than fought with.
    orbitAnchorRef.current = null;
    void controls.fitToSphere(sphere, true);
    requestRender();
  }, [requestRender]);

  return {
    requestRender,
    resetView,
    setOrbitAnchor,
    frameNodes,
    scene: sceneRef.current,
    controls: controlsRef.current,
    unavailableReason,
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

/**
 * The default view must contain the whole map, and put it where it can be seen.
 *
 * Two bugs are pinned here, both of which shipped.
 *
 * The first was arithmetic: the camera sat at a CONSTANT distance
 * (WORLD_SIZE * 1.15) regardless of the content, and at a 45 degree vertical
 * field of view that frames 0.94 * WORLD_SIZE of height against a full
 * WORLD_SIZE cube seen off-axis. The frustum was smaller than the thing inside
 * it, so the bottom of the map was cut off - on first open and on every Reset
 * view, faithfully.
 *
 * The second was geometry: the fit centred on the world MEDIAN, which resists
 * outliers and is not the middle of anything you can see. A cloud that leans is
 * the normal case, so the fit sized itself for the long side and left the short
 * side as dead canvas - 215px of empty space under the map against 84px over it
 * on the real corpus. And the canvas is full-bleed under floating panels, so
 * "on screen" was never the same rectangle as "visible".
 *
 * The assertions are properties rather than numbers: project every point with
 * the returned camera placement and require it to land inside the SAFE area,
 * reaching it on at least one axis. That holds for any layout, aspect ratio,
 * field of view and panel arrangement, which a distance constant never could.
 */

import { describe, it, expect } from 'vitest';
import { Vector3, PerspectiveCamera } from 'three';
import {
  WORLD_SIZE,
  NO_VIEWPORT_INSETS,
  fitDefaultView,
  describeViewport,
  applyViewport,
  type ViewportInsets,
} from '../../src/renderer/components/knowledge-graph/knowledge-graph-scene';

const FOV = 45;

interface Pane {
  readonly width: number;
  readonly height: number;
  readonly insets: ViewportInsets;
}

const WIDE: Pane = { width: 2560, height: 1266, insets: NO_VIEWPORT_INSETS };
const TALL: Pane = { width: 700, height: 1200, insets: NO_VIEWPORT_INSETS };
/** The real surface: a ~208px Display panel on the left and the search box on
 *  top, both floating over the canvas. */
const WITH_PANELS: Pane = {
  width: 2000,
  height: 1000,
  insets: { left: 232, right: 12, top: 64, bottom: 0 },
};

/**
 * The camera the surface would actually build for this pane, including the
 * off-centre principal point. Placing a plain camera here would measure a
 * framing that never renders, which is exactly how the previous version of this
 * helper went stale.
 */
function buildCamera(points: Vector3[], pane: Pane) {
  const viewport = describeViewport(pane.width, pane.height, pane.insets);
  const framing = fitDefaultView(points, FOV, viewport);
  if (!framing) throw new Error('expected a framing');
  const camera = new PerspectiveCamera(FOV, viewport.aspect, 0.1, WORLD_SIZE * 100);
  applyViewport(camera, pane.width, pane.height, pane.insets);
  camera.position.set(
    framing.center.x + framing.direction.x * framing.distance,
    framing.center.y + framing.direction.y * framing.distance,
    framing.center.z + framing.direction.z * framing.distance,
  );
  camera.lookAt(framing.center);
  camera.updateMatrixWorld(true);
  return { framing, viewport, camera };
}

/** Normalized device coords of every point, as the real camera would compute. */
function projectAll(points: Vector3[], pane: Pane): Array<{ x: number; y: number }> {
  const { camera } = buildCamera(points, pane);
  return points.map((point) => {
    const projected = point.clone().project(camera);
    return { x: projected.x, y: projected.y };
  });
}

/**
 * How far the content reaches toward the safe area's edge, per axis, where 1 is
 * flush against it. The frustum's axis IS the safe area's centre, so a plain
 * NDC magnitude scaled by the safe fraction is the whole conversion.
 */
function reach(points: Vector3[], pane: Pane): { x: number; y: number } {
  const viewport = describeViewport(pane.width, pane.height, pane.insets);
  const projected = projectAll(points, pane);
  return {
    x: Math.max(...projected.map((point) => Math.abs(point.x))) / viewport.safeFractionX,
    y: Math.max(...projected.map((point) => Math.abs(point.y))) / viewport.safeFractionY,
  };
}

/** Canvas pixels, y measured DOWN from the top like the DOM. */
function toPixels(ndc: { x: number; y: number }, pane: Pane): { x: number; y: number } {
  return { x: ((ndc.x + 1) / 2) * pane.width, y: ((1 - ndc.y) / 2) * pane.height };
}

/** The unit cube the layout is fitted into, mapped onto the world cube. */
function cubeCorners(): Vector3[] {
  const points: Vector3[] = [];
  for (const x of [0, 0.5, 1]) {
    for (const y of [0, 0.5, 1]) {
      for (const z of [0, 0.5, 1]) {
        points.push(new Vector3((x - 0.5) * WORLD_SIZE, (y - 0.5) * WORLD_SIZE, (z - 0.5) * WORLD_SIZE));
      }
    }
  }
  return points;
}

/**
 * A cloud whose MEDIAN is nowhere near the middle of its extent: two thirds of
 * it packed into one end, the rest trailing away from it. This is the ordinary
 * shape of a real corpus (a few dense regions and a long thin tail), and it is
 * the shape a median-centred fit frames badly.
 */
function leaningCloud(): Vector3[] {
  const points: Vector3[] = [];
  for (let index = 0; index < 100; index += 1) {
    const angle = (index / 100) * Math.PI * 2;
    points.push(new Vector3(
      Math.cos(angle) * WORLD_SIZE * 0.12,
      Math.sin(angle) * WORLD_SIZE * 0.12 - WORLD_SIZE * 0.35,
      ((index % 5) - 2) * WORLD_SIZE * 0.05,
    ));
  }
  for (let index = 0; index < 50; index += 1) {
    const along = index / 49;
    points.push(new Vector3(
      (along - 0.5) * WORLD_SIZE * 0.5,
      (along * 0.9 - 0.2) * WORLD_SIZE,
      ((index % 3) - 1) * WORLD_SIZE * 0.08,
    ));
  }
  return points;
}

describe('default view framing', () => {
  it('contains the whole unit cube on a wide window', () => {
    const reached = reach(cubeCorners(), WIDE);
    expect(reached.x).toBeLessThanOrEqual(1);
    expect(reached.y).toBeLessThanOrEqual(1);
  });

  it('contains it on a TALL window too, where horizontal is the limiting axis', () => {
    // The old code fitted against the vertical field of view alone. On a
    // portrait window that is the wrong constraint, and the map would be clipped
    // left and right instead of top and bottom.
    const reached = reach(cubeCorners(), TALL);
    expect(reached.x).toBeLessThanOrEqual(1);
    expect(reached.y).toBeLessThanOrEqual(1);
  });

  it('contains points that fall OUTSIDE the unit box', () => {
    // Not hypothetical: the projection fits the p2-p98 range to the unit box, so
    // a few nodes legitimately sit beyond it every time.
    const points = cubeCorners();
    points.push(new Vector3(WORLD_SIZE * 0.9, -WORLD_SIZE * 0.85, WORLD_SIZE * 0.8));
    const reached = reach(points, WIDE);
    expect(reached.x).toBeLessThanOrEqual(1);
    expect(reached.y).toBeLessThanOrEqual(1);
  });

  it('fills the safe area rather than huddling in the middle of it', () => {
    // Two failures bracketed here, because fixing either one alone reintroduces
    // the other. Too tight and the outermost conversations sit flush against the
    // edges, underneath the floating panels. Too loose - which a circumscribing
    // bounding sphere produced - and the map occupies half the frame with the
    // rest empty, so the shape is unreadable for the opposite reason.
    const reached = reach(cubeCorners(), WIDE);
    expect(Math.max(reached.x, reached.y)).toBeLessThanOrEqual(1);
    expect(Math.max(reached.x, reached.y)).toBeGreaterThan(0.8);
  });

  it('does not let a few far outliers shrink the whole map', () => {
    // The reported symptom: the map arrived occupying about a third of the
    // viewport, too small to read, and the cause was framing for the single
    // furthest point. The layout fits its p2-p98 range to the unit box, so a
    // small tail sits outside it BY CONSTRUCTION - a fit that respects the
    // maximum hands the view to those extremes every time.
    const body: Vector3[] = [];
    for (let index = 0; index < 150; index += 1) {
      const angle = (index / 150) * Math.PI * 2;
      body.push(new Vector3(
        Math.cos(angle) * WORLD_SIZE * 0.3,
        Math.sin(angle) * WORLD_SIZE * 0.3,
        ((index % 5) - 2) * WORLD_SIZE * 0.1,
      ));
    }
    const withOutliers = [
      ...body,
      new Vector3(WORLD_SIZE * 6, 0, 0),
      new Vector3(0, -WORLD_SIZE * 5, WORLD_SIZE * 4),
    ];

    const viewport = describeViewport(WIDE.width, WIDE.height, WIDE.insets);
    const tight = fitDefaultView(body, FOV, viewport);
    const withStragglers = fitDefaultView(withOutliers, FOV, viewport);

    // Two stragglers out of 152 must barely move the camera. Before the
    // percentile fit this ratio was several times over.
    expect(withStragglers!.distance).toBeLessThan(tight!.distance * 1.3);

    // And the body of the map still reaches the frame rather than huddling in
    // the middle, which is what the user actually saw.
    expect(Math.max(...Object.values(reach(body, WIDE)))).toBeGreaterThan(0.8);
  });

  it('centres a LEANING cloud, rather than framing it for its long side', () => {
    // The bug this replaced: the world median is not the middle of the projected
    // extent, so one side of the map sat flush against the frame while the other
    // left a band of empty canvas that the fit had paid to keep clear.
    const projected = projectAll(leaningCloud(), WIDE);
    for (const axis of ['x', 'y'] as const) {
      const values = projected.map((point) => point[axis]);
      const low = Math.min(...values);
      const high = Math.max(...values);
      // The trimmed midpoint sits at the origin, so the two margins agree to
      // within the few points the trim deliberately disregards.
      expect(Math.abs(low + high)).toBeLessThan(0.12);
    }
  });

  it('centres on the content, not on the origin', () => {
    // The layout's centre of mass is not necessarily 0,0,0.
    //
    // Deliberately a wide tolerance rather than an exact match: the centring
    // balances where the points LAND, and under perspective a symmetric cube is
    // not symmetric on screen - seen corner-on from this distance its nearest
    // corner projects several times larger than its furthest. The residual is
    // that correction, not drift, and it is small against the WORLD_SIZE * 2
    // displacement this test is actually about.
    const offset = new Vector3(WORLD_SIZE * 2, WORLD_SIZE * 2, WORLD_SIZE * 2);
    const shifted = cubeCorners().map((point) => point.clone().add(offset));
    const viewport = describeViewport(WIDE.width, WIDE.height, WIDE.insets);
    const framing = fitDefaultView(shifted, FOV, viewport);
    expect(framing).not.toBeNull();
    expect(Math.abs(framing!.center.x - offset.x)).toBeLessThan(WORLD_SIZE * 0.25);
    expect(Math.abs(framing!.center.y - offset.y)).toBeLessThan(WORLD_SIZE * 0.25);
  });

  it('keeps a lone node off the near plane', () => {
    const viewport = describeViewport(WIDE.width, WIDE.height, WIDE.insets);
    const framing = fitDefaultView([new Vector3(0, 0, 0)], FOV, viewport);
    expect(framing!.distance).toBeGreaterThan(WORLD_SIZE * 0.2);
  });

  it('has nothing to frame when there are no nodes', () => {
    expect(fitDefaultView([], FOV, describeViewport(1600, 900, NO_VIEWPORT_INSETS))).toBeNull();
  });

  it('frames from a supplied direction with the same air as its own', () => {
    // What a fly to a subset needs, and the reason it reuses this fit rather
    // than a bounding sphere. `fitToSphere` circumscribes, knows nothing about
    // the panels, and adds no padding, so the two framings disagreed: measured
    // on the real corpus with three of thirty-nine regions on, a facet toggle
    // left 54px of clearance above the map against Reset view's 208, and the top
    // inset alone is 50 - the first row of titles sat under the search box.
    //
    // Direction is the only thing a fly may differ on: it frames a subset from
    // where the user is standing, where arriving at a map picks the angle that
    // shows its shape. Everything that decides the AIR has to be shared.
    const points = cubeCorners();
    const viewport = describeViewport(WITH_PANELS.width, WITH_PANELS.height, WITH_PANELS.insets);
    const derived = fitDefaultView(points, FOV, viewport)!;

    // Handing back the direction it chose must reproduce its own answer exactly,
    // which is what says the override changes nothing else about the fit.
    const echoed = fitDefaultView(points, FOV, viewport, derived.direction)!;
    expect(echoed.distance).toBeCloseTo(derived.distance, 6);
    expect(echoed.center.distanceTo(derived.center)).toBeLessThan(1e-6);

    // And an unrelated direction still frames inside the safe area, still with
    // room to spare - the same bracket the default view is held to.
    for (const direction of [
      new Vector3(1, 0, 0),
      new Vector3(0.3, 0.9, -0.2).normalize(),
      new Vector3(-0.6, 0.2, 0.7).normalize(),
    ]) {
      const framing = fitDefaultView(points, FOV, viewport, direction)!;
      const camera = new PerspectiveCamera(FOV, viewport.aspect, 0.1, WORLD_SIZE * 100);
      applyViewport(camera, WITH_PANELS.width, WITH_PANELS.height, WITH_PANELS.insets);
      camera.position.copy(framing.center).addScaledVector(framing.direction, framing.distance);
      camera.lookAt(framing.center);
      camera.updateMatrixWorld(true);
      const projected = points.map((point) => point.clone().project(camera));
      const reachedX = Math.max(...projected.map((p) => Math.abs(p.x))) / viewport.safeFractionX;
      const reachedY = Math.max(...projected.map((p) => Math.abs(p.y))) / viewport.safeFractionY;
      expect(Math.max(reachedX, reachedY)).toBeLessThanOrEqual(1);
      expect(Math.max(reachedX, reachedY)).toBeGreaterThan(0.8);
    }
  });
});

describe('the safe area under the floating panels', () => {
  it('aims at the clear part of the canvas, not at its middle', () => {
    const viewport = describeViewport(WITH_PANELS.width, WITH_PANELS.height, WITH_PANELS.insets);
    // A panel on the left means the clear area's centre is to the RIGHT of the
    // canvas centre, and three's offset moves the frustum the opposite way.
    expect(viewport.offsetX).toBeLessThan(0);
    // A search box on top means it is lower, too.
    expect(viewport.offsetY).toBeLessThan(0);
    expect(viewport.safeFractionX).toBeCloseTo((2000 - 244) / 2000, 6);
    expect(viewport.safeFractionY).toBeCloseTo((1000 - 64) / 1000, 6);
  });

  it('takes nothing off a canvas with no panels over it', () => {
    const viewport = describeViewport(1600, 900, NO_VIEWPORT_INSETS);
    expect(viewport.offsetX).toBe(0);
    expect(viewport.offsetY).toBe(0);
    expect(viewport.safeFractionX).toBe(1);
    expect(viewport.safeFractionY).toBe(1);
  });

  it('stops giving ground once the panels would leave a sliver', () => {
    // The panels are fixed pixel widths, so on a narrow window they cover most
    // of the canvas. Shrinking to fit whatever is left would make the map
    // unreadable, which is worse than letting it run under a translucent panel.
    const viewport = describeViewport(420, 900, { left: 232, right: 332, top: 64, bottom: 0 });
    expect(viewport.safeFractionX).toBeGreaterThanOrEqual(0.4);
  });

  it('keeps the whole map clear of the panels', () => {
    // The property the pixels are for: every node lands inside the rectangle the
    // user can actually see, not merely inside the canvas.
    const points = leaningCloud();
    const projected = projectAll(points, WITH_PANELS);
    const { insets, width, height } = WITH_PANELS;
    for (const ndc of projected) {
      const pixel = toPixels(ndc, WITH_PANELS);
      expect(pixel.x).toBeGreaterThanOrEqual(insets.left - 1);
      expect(pixel.x).toBeLessThanOrEqual(width - insets.right + 1);
      expect(pixel.y).toBeGreaterThanOrEqual(insets.top - 1);
      expect(pixel.y).toBeLessThanOrEqual(height - insets.bottom + 1);
    }
  });

  it('re-fits rather than cropping when the pane changes shape', () => {
    // What a resize does. The same cloud framed for a wide pane and then for a
    // narrow one must be contained BOTH times: a fit carried across unchanged is
    // exactly the clipping this whole file exists to prevent.
    const points = leaningCloud();
    const narrow: Pane = { width: 900, height: 1000, insets: WITH_PANELS.insets };
    for (const pane of [WITH_PANELS, narrow]) {
      const reached = reach(points, pane);
      expect(Math.max(reached.x, reached.y)).toBeLessThanOrEqual(1);
      expect(Math.max(reached.x, reached.y)).toBeGreaterThan(0.8);
    }
  });
});

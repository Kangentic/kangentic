/**
 * The pointer a choreography draws: `@kangentic/branding`'s demo pointer (`assets/pointer/`), the
 * dot kangentic.com's hero draws too (its `DemoPointer.astro`, with its own beat). The package owns
 * how it looks and moves: the drawing, the tones, the press, the pop and the ring, all read from
 * `pointer.json` here and never retyped. The choreography owns where it goes and when.
 *
 * Three things the package leaves to its consumer, and how this one does them:
 *  - Size. Its lengths are page pixels at host scale 1. A host that shows the frame scaled posts
 *    `kangentic-demo-scale` and boot.js writes `--demo-pointer-scale` on `<html>`; every size here
 *    divides by it in CSS, so a resting dot follows a resize with no script.
 *  - Tone. Cream over a dark ground, ink over a light one, read on every draw from the first opaque
 *    background under eight points around the dot, so the dot stays visible over a terminal on a
 *    light theme and a hairline under its center does not flip it.
 *  - The ring. One per press, left where the press landed, removed once it has faded.
 *
 * Everything lives inside the `[data-demo-cursor]` element, so the show and hide, a cut's veil and a
 * visitor's takeover reach the rings too.
 */
import dotSource from '@kangentic/branding/assets/pointer/pointer.svg?raw';
import ringSource from '@kangentic/branding/assets/pointer/pointer-ring.svg?raw';
import pointerSpec from '@kangentic/branding/assets/pointer/pointer.json';

export type PointerTone = 'cream' | 'ink';

interface PointerPoint { x: number; y: number }

export interface DemoPointer {
  /** The `[data-demo-cursor]` element. Its own `style.opacity` is the pointer's show and hide. */
  element: HTMLElement;
  /** Put the dot's center on a point and take the tone of the ground there. */
  drawAt(point: PointerPoint): void;
  /** A button goes down: the core steps to pressed. With `animate`, the halo pops and a ring runs out where it landed. */
  press(animate: boolean): void;
  /** The button comes up: the core goes back to rest. A release draws no ring. */
  release(): void;
}

/** The custom property boot.js writes on `<html>` from the host's scale message. */
const SCALE_PROPERTY = '--demo-pointer-scale';
/** The host's scale in CSS, 1 until a host posts one. */
const SCALE = `var(${SCALE_PROPERTY}, 1)`;
/** Points read around the halo's edge to find the ground the dot sits on. */
const GROUND_SAMPLES = 8;
/** Below this ground luminance the dot is cream, at or above it ink. */
const CREAM_BELOW = pointerSpec.tones.rule.creamBelow;

function isPointerTone(value: string): value is PointerTone {
  return value === 'cream' || value === 'ink';
}

/** The tone the package names for a dot with no ground read yet. */
const DEFAULT_TONE: PointerTone = ((): PointerTone => {
  const named = pointerSpec.tones.default;
  if (!isPointerTone(named)) throw new Error(`@kangentic/branding's pointer names a default tone "${named}" that is neither cream nor ink`);
  return named;
})();

/** A length in page pixels, divided by the host's scale. */
function scaled(pixels: number): string {
  return `calc(${pixels}px / ${SCALE})`;
}

/** WCAG relative luminance of an sRGB color given as 0 to 255 channels. */
export function relativeLuminance(red: number, green: number, blue: number): number {
  const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

/** The tone that reads over a ground of this luminance. */
export function toneForLuminance(luminance: number): PointerTone {
  return luminance < CREAM_BELOW ? 'cream' : 'ink';
}

/**
 * How far past the threshold a ground must be before a drawn tone changes. A dot dragged along the
 * edge between a light rail and a black terminal reads half of each, a mean a few hundredths from
 * the threshold, and without a band the tone flipped with every pixel of the drag.
 */
export const TONE_HYSTERESIS = 0.1;

/** The tone to draw next: the first one straight from the threshold, then a change only once the ground clears the band. */
export function nextTone(current: PointerTone | null, luminance: number): PointerTone {
  if (current === null) return toneForLuminance(luminance);
  if (current === 'cream') return luminance >= CREAM_BELOW + TONE_HYSTERESIS ? 'ink' : 'cream';
  return luminance < CREAM_BELOW - TONE_HYSTERESIS ? 'cream' : 'ink';
}

/** The tone a draw takes: the drawn one (the package's default before any) when no ground was read, `nextTone` otherwise. */
export function toneToDraw(current: PointerTone | null, groundLuminance: number | null): PointerTone {
  return groundLuminance === null ? (current ?? DEFAULT_TONE) : nextTone(current, groundLuminance);
}

/** The points read for the ground, spaced evenly around the halo's edge at its page size for any host scale. */
export function groundSamplePoints(center: PointerPoint, hostScale: number): PointerPoint[] {
  const radius = pointerSpec.dot.halo.diameter / 2 / hostScale;
  const points: PointerPoint[] = [];
  for (let index = 0; index < GROUND_SAMPLES; index++) {
    const angle = (index / GROUND_SAMPLES) * Math.PI * 2;
    points.push({ x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius });
  }
  return points;
}

/** The mean of the luminances that were read, null when none was. */
export function meanLuminance(readings: Array<number | null>): number | null {
  let total = 0;
  let count = 0;
  for (const reading of readings) {
    if (reading === null) continue;
    total += reading;
    count += 1;
  }
  return count > 0 ? total / count : null;
}

function parseSvg(source: string): SVGSVGElement {
  const template = document.createElement('template');
  template.innerHTML = source.trim();
  const svg = template.content.firstElementChild;
  if (!(svg instanceof SVGSVGElement)) throw new Error('@kangentic/branding shipped a pointer asset that is not an svg');
  return svg;
}

function partOf(root: Element, name: string): SVGElement {
  const part = root.querySelector(`[data-part="${name}"]`);
  if (!(part instanceof SVGElement)) throw new Error(`@kangentic/branding's pointer has no "${name}" part`);
  return part;
}

/**
 * Reads a computed color through a 1x1 canvas, which parses every form a browser computes
 * (`rgb()`, `color()`, `oklch()`). Null for a color that is not fully opaque: the ground is
 * whatever shows through it. A string the canvas cannot parse is null too. The fill is reset to
 * transparent first, because an assignment the canvas refuses keeps the previous fill.
 */
function createGroundReader(): (color: string) => number | null {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const luminanceByColor = new Map<string, number | null>();
  return (color) => {
    const known = luminanceByColor.get(color);
    if (known !== undefined) return known;
    let luminance: number | null = null;
    if (context) {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = 'transparent';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
      luminance = alpha === 255 ? relativeLuminance(red, green, blue) : null;
    }
    luminanceByColor.set(color, luminance);
    return luminance;
  };
}

export function createPointer(): DemoPointer {
  const { dot, ring, tones, states, motion } = pointerSpec;
  const crossfade = `${tones.rule.crossfadeMs}ms`;

  const element = document.createElement('div');
  element.setAttribute('data-demo-cursor', '');
  element.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;opacity:0;transition:opacity 300ms ease';

  const holder = document.createElement('div');
  holder.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;will-change:transform';
  const dotSvg = parseSvg(dotSource);
  dotSvg.style.cssText = `position:absolute;left:0;top:0;display:block;transform:translate(-50%,-50%);width:${scaled(dot.box)};height:${scaled(dot.box)};transition:color ${crossfade}`;
  holder.appendChild(dotSvg);
  element.appendChild(holder);

  const core = partOf(dotSvg, 'core');
  const halo = partOf(dotSvg, 'halo');
  const haloFill = partOf(dotSvg, 'halo-fill');
  const haloEdge = partOf(dotSvg, 'halo-edge');
  haloFill.style.transition = `fill-opacity ${crossfade}`;
  haloEdge.style.transition = `stroke-opacity ${crossfade}`;

  const ringTemplate = parseSvg(ringSource);
  const groundLuminance = createGroundReader();
  let lastPoint: PointerPoint = { x: 0, y: 0 };
  let tone: PointerTone | null = null;

  function setTone(next: PointerTone): void {
    if (next === tone) return;
    tone = next;
    const weights = tones[next];
    element.setAttribute('data-tone', next);
    dotSvg.style.color = weights.color;
    haloFill.style.fillOpacity = String(weights['halo-fill']);
    haloEdge.style.strokeOpacity = String(weights['halo-edge']);
  }

  /**
   * The luminance of the first opaque background under a point, the theme's surface failing that.
   * `luminanceByElement` is shared across one draw's samples, which mostly land on one ancestor
   * chain, so each element's style is read once a draw.
   */
  function groundUnder(point: PointerPoint, luminanceByElement: Map<Element, number | null>): number | null {
    for (let candidate = document.elementFromPoint(point.x, point.y); candidate; candidate = candidate.parentElement) {
      let luminance = luminanceByElement.get(candidate);
      if (luminance === undefined) {
        luminance = groundLuminance(getComputedStyle(candidate).backgroundColor);
        luminanceByElement.set(candidate, luminance);
      }
      if (luminance !== null) return luminance;
    }
    const surface = getComputedStyle(document.documentElement).getPropertyValue('--color-surface').trim();
    return surface ? groundLuminance(surface) : null;
  }

  /**
   * The ground the dot sits on: the mean luminance under eight points on the halo's edge. One point
   * at the center would read a hairline as the ground. A terminal seam on a light theme is a 2px
   * light line between two black terminals, and a drag along it flipped the tone on every frame.
   * On the ring of points only the two that fall on the line read it light. The scale is read from
   * `<html>`'s own style, where boot.js writes it, so a draw forces no style recalc for it.
   */
  function groundAt(point: PointerPoint): number | null {
    const hostScale = Number.parseFloat(document.documentElement.style.getPropertyValue(SCALE_PROPERTY)) || 1;
    const luminanceByElement = new Map<Element, number | null>();
    return meanLuminance(groundSamplePoints(point, hostScale).map((sample) => groundUnder(sample, luminanceByElement)));
  }

  function spawnRing(): void {
    const ringSvg = ringTemplate.cloneNode(true);
    if (!(ringSvg instanceof SVGSVGElement)) return;
    const ringColor = tones[tone ?? DEFAULT_TONE].color;
    ringSvg.style.cssText = `position:absolute;left:${lastPoint.x}px;top:${lastPoint.y}px;display:block;transform:translate(-50%,-50%);width:${scaled(ring.box)};height:${scaled(ring.box)};color:${ringColor}`;
    const circle = partOf(ringSvg, 'ring');
    // The stroke is non-scaling, so sizing the svg does not carry it: it divides by the scale itself.
    circle.style.strokeWidth = scaled(ring.strokeWidth);
    element.appendChild(ringSvg);
    const grow = circle.animate(motion.ringGrow.keyframes, { duration: motion.ringGrow.durationMs });
    const fade = circle.animate(motion.ringFade.keyframes, { duration: motion.ringFade.durationMs });
    // A finished animation leaves the ring at rest (opacity 0), so a rejection (the element went
    // with a stopped player) leaves nothing to see either way.
    Promise.all([grow.finished, fade.finished]).then(() => ringSvg.remove(), () => ringSvg.remove());
  }

  return {
    element,
    drawAt(point) {
      lastPoint = point;
      holder.style.transform = `translate(${point.x}px, ${point.y}px)`;
      setTone(toneToDraw(tone, groundAt(point)));
    },
    press(animate) {
      core.style.transform = states.pressed.core;
      if (!animate) return;
      halo.animate(motion.pop.keyframes, { duration: motion.pop.durationMs });
      spawnRing();
    },
    release() {
      core.style.transform = states.rest.core;
    },
  };
}

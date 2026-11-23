/**
 * The poster gate's cases and its pixel comparison (tests/captures/features/poster-gate.capture.ts).
 *
 * Every poster in demo-posters-<version>.zip is a promise that the live frame shows the same thing
 * (kangentic.com #137). The release job therefore boots each poster's scene from the very bytes the
 * release deployed, on Windows, macOS and Linux, at the display scales a visitor has, and compares:
 *
 *   layout    every scene at 1, 1.25, 1.5 and 2 in rust, and in clay at the poster's own 2: every
 *             text node's text and wraps and every terminal's grid and rect at ready, against the
 *             layout the rig recorded beside the poster (frame-measure.ts), and each line box's
 *             position at a scale a poster was shot at.
 *   pixels    where a poster exists at that scale (every scene at 2x, the hero at 1x and 2x): the
 *             frame against the poster, where only antialiasing may differ. On Linux, the OS the
 *             posters are shot on, every pixel; on Windows and macOS every pixel outside the text,
 *             since each OS rasterizes glyphs its own way (PIXEL_COMPARISON). A clock or a counter
 *             that moved on since the poster is left out of the pixels on every OS, and the rest of
 *             the frame is still compared.
 *   the hero  also booted as the site's hero boots it, `loop=1`, whose layout at ready has to be
 *             the still's: the frame a host lifts its poster onto (demo/boot.js, onReady).
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { clockTextPairs, type FrameMeasure, type MeasuredBox } from './frame-measure';
import { HERO_POSTER, POSTER_SCALE, POSTER_THEMES, heroFileName, heroLayoutFileName, posterFileName, posterLayoutFileName } from '../../../scripts/lib/demo-posters.mjs';

/** The display scales a visitor's browser runs at that the gate boots every scene in. */
export const GATE_SCALES = [1, 1.25, 1.5, 2] as const;

/** The theme every scale is checked in; the poster's own scale is checked in every poster theme. */
export const GATE_LAYOUT_THEME = 'rust';

export interface GateCase {
  /** A name for the test and the report. */
  title: string;
  scene: string;
  theme: string;
  scale: number;
  motion: 'still' | 'loop';
  viewport: { width: number; height: number };
  /** The layout sidecar this case's frame must match. */
  layoutFile: string;
  /** The poster this case's pixels must match, when one exists at this scale. */
  posterFile: string | null;
  /**
   * Whether line boxes are held to the poster's positions: only at a scale a poster was shot at
   * (frame-measure.ts, CompareOptions). Wraps, text and terminals are held at every scale.
   */
  comparePositions: boolean;
}

/**
 * Scenes whose live frame differs from its poster for a reason this gate cannot fix and knows,
 * with what it skips for them. Each is a finding, not a pass: the reason is printed on every run.
 *   graph-labels      a Knowledge Graph map: a WebGL drawing whose camera comes to rest a little
 *                     differently on each boot, so its pixels and the set of conversation titles it
 *                     labels (the text under [knowledge-graph-canvas]) differ. Every other text on
 *                     the page is held.
 *   held-terminals    a terminal held at a smaller type takes another grid at another display
 *                     scale; its terminals are held only at the poster's own scale.
 *   fractional-wraps  a long text breaks one word differently at 125 or 150 percent, where
 *                     Chromium lays text out with fractional advances; its text is held only at
 *                     whole scales.
 *   pixels            something on the frame is drawn to the frame's running clock, so where it
 *                     ends depends on when the shot lands; its layout and terminals are held.
 */
export type GateKnownDifference = 'graph-labels' | 'held-terminals' | 'fractional-wraps' | 'pixels';

/** The element path segment the Knowledge Graph's canvas carries; its labels sit under it. */
export const GRAPH_CANVAS_PATH = '[knowledge-graph-canvas]';

const GRAPH_LABELS_REASON = 'the map is a WebGL drawing whose camera comes to rest a little differently on each boot, so the conversation titles it labels differ boot to boot';

const HELD_TERMINAL_REASON = 'its terminal is held at a smaller type, and xterm conforms it to the largest type the pane takes at each display\'s own cell, so the grid differs by scale (130 columns at 100 percent, 118 at 200); holding one grid instead left the pane an empty band at 125 and 200 percent, and the poster would have shown it';

export const GATE_KNOWN_DIFFERENCES: Record<string, { skips: GateKnownDifference; reason: string }> = {
  'knowledge-graph': { skips: 'graph-labels', reason: GRAPH_LABELS_REASON },
  'knowledge-graph-contoso-web': { skips: 'graph-labels', reason: GRAPH_LABELS_REASON },
  'knowledge-graph-spring-petclinic': { skips: 'graph-labels', reason: GRAPH_LABELS_REASON },
  'knowledge-graph-online-boutique': { skips: 'graph-labels', reason: GRAPH_LABELS_REASON },
  changes: { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'changes-working': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'changes-staged': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'changes-history': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'changes-blame': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'changes-checks': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'task-mcp': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'command-terminal-tiled': { skips: 'held-terminals', reason: HELD_TERMINAL_REASON },
  'workflow-draft': { skips: 'fractional-wraps', reason: 'the draft\'s long description breaks one word later at 125 and 150 percent, where Chromium lays text out with fractional advances' },
  'settings-workflows': { skips: 'fractional-wraps', reason: 'the Workflow agent prompt breaks one word differently at 150 percent, where Chromium lays text out with fractional advances' },
  'browser-annotations': { skips: 'pixels', reason: 'the annotation badges draw their numbers in system-ui inside a closed shadow root (annotationLayerScript.ts keeps the page\'s CSS away from them), so each OS draws the digit in its own face and no measure can reach the text to leave it out; the page around them, and its layout, are held' },
  'activity-overlay': { skips: 'pixels', reason: 'the overlay draws each session\'s timeline up to the frame\'s running clock, so its bars end a few pixels further along on a slower runner (3 device px on macOS in run 45118082966); its text, clocks included, is held' },
  'ssh-remote-project': { skips: 'fractional-wraps', reason: 'the cut-short description on the "Fix flaky replication test on slow disks" card breaks one word later at 150 percent, where Chromium lays text out with fractional advances' },
  'ssh-remote-host': { skips: 'fractional-wraps', reason: 'the redis board under the panel has the "Fix flaky replication test on slow disks" card, whose cut-short description breaks one word later at 150 percent, where Chromium lays text out with fractional advances' },
};

/** What a case leaves out of its comparison. */
export interface GateSkips {
  /** Every text node. */
  text: boolean;
  /** Only the text under the Knowledge Graph's canvas (GRAPH_CANVAS_PATH). */
  graphLabels: boolean;
  terminals: boolean;
  pixels: boolean;
}

/**
 * What a scene's known difference leaves out of one case, as the kinds above describe: a held
 * terminal off the poster's scale, a fractional wrap only at a fractional scale (1x is held).
 */
export function knownDifferenceSkips(known: GateKnownDifference | undefined, gateCase: Pick<GateCase, 'scale' | 'comparePositions'>): GateSkips {
  const fractionalScale = !Number.isInteger(gateCase.scale);
  return {
    text: known === 'fractional-wraps' && fractionalScale,
    graphLabels: known === 'graph-labels',
    terminals: known === 'held-terminals' && !gateCase.comparePositions,
    pixels: known === 'graph-labels' || known === 'pixels',
  };
}

/** A measure with what `skips` leaves out removed, applied the same way to the poster's and the frame's. */
export function stripKnownDifference(measure: FrameMeasure, skips: GateSkips): FrameMeasure {
  // `text` leaves out every text node, so it wins over `graphLabels`, which leaves out some.
  let textNodes = measure.textNodes;
  if (skips.text) textNodes = [];
  else if (skips.graphLabels) textNodes = measure.textNodes.filter((node) => !node.path.includes(GRAPH_CANVAS_PATH));
  return { ...measure, textNodes, terminals: skips.terminals ? [] : measure.terminals };
}

export interface GateSet {
  scenes: string[];
  themes: readonly string[];
  frame: { width: number; height: number };
  posterScale: number;
  /** The rig's file names for a scene's poster and layout sidecar (scripts/lib/demo-posters.mjs). */
  posterFile(scene: string, theme: string): string;
  layoutFile(scene: string, theme: string): string;
  hero: { scene: string; theme: string; frame: { width: number; height: number }; scales: readonly number[]; file(scale: number): string; layoutFile(scale: number): string };
}

/** The release set's shape for these scenes: the rig's own file names, themes, scale and hero. */
export function posterGateSet(scenes: string[], frame: { width: number; height: number }): GateSet {
  return {
    scenes,
    themes: POSTER_THEMES,
    frame,
    posterScale: POSTER_SCALE,
    posterFile: posterFileName,
    layoutFile: posterLayoutFileName,
    hero: { scene: HERO_POSTER.scene, theme: HERO_POSTER.theme, frame: HERO_POSTER.frame, scales: HERO_POSTER.scales, file: heroFileName, layoutFile: heroLayoutFileName },
  };
}

/**
 * Every case the gate runs, scenes first in the set's order. A scale the hero has no still at is
 * checked against the still at the nearest scale below it, which has the same CSS layout.
 */
export function gateCases(set: GateSet): GateCase[] {
  const cases: GateCase[] = [];
  for (const scene of set.scenes) {
    for (const scale of GATE_SCALES) {
      const themes = scale === set.posterScale ? set.themes : set.themes.filter((theme) => theme === GATE_LAYOUT_THEME);
      for (const theme of themes) {
        cases.push({
          title: `${scene} ${theme} ${scale}x`,
          scene,
          theme,
          scale,
          motion: 'still',
          viewport: set.frame,
          layoutFile: `scenes/${set.layoutFile(scene, theme)}`,
          posterFile: scale === set.posterScale ? `scenes/${set.posterFile(scene, theme)}` : null,
          comparePositions: scale === set.posterScale,
        });
      }
    }
  }
  const heroScales = [...set.hero.scales].sort((left, right) => left - right);
  for (const scale of GATE_SCALES) {
    const reference = [...heroScales].reverse().find((heroScale) => heroScale <= scale) ?? heroScales[0];
    for (const motion of ['still', 'loop'] as const) {
      cases.push({
        title: `hero ${set.hero.theme} ${scale}x ${motion}`,
        scene: set.hero.scene,
        theme: set.hero.theme,
        scale,
        motion,
        viewport: set.hero.frame,
        layoutFile: `hero/${set.hero.layoutFile(reference)}`,
        // A loop frame moves on from ready, so only its layout at ready is held to the still.
        posterFile: motion === 'still' && heroScales.includes(scale) ? `hero/${set.hero.file(scale)}` : null,
        comparePositions: heroScales.includes(scale),
      });
    }
  }
  return cases;
}

/**
 * Which pixels the gate compares on each OS, and how many that are NOT antialiasing may differ.
 *
 *   full          every pixel. Linux, where the posters are shot: the frame and its poster draw
 *                 their glyphs through the same scaler, so this is the leg that fails on a change in
 *                 how text itself is drawn (its color, weight or face).
 *   outside-text  every pixel but the text's (textMaskBoxes). Windows and macOS rasterize glyphs
 *                 through their own scalers, and no budget separates that from a real change: in
 *                 v0.62.0 (run 45102383693) every 2x frame differed, welcome clay by 7212 pixels on
 *                 Windows and 4459 on macOS with the same text in the same places, and masking the
 *                 measured text took both to 0 and 2. What the mask hides is still held by the
 *                 layout comparison: every text's content, wraps and line boxes, and every
 *                 terminal's grid and rect.
 *
 * The budget is how many counted pixels may differ. Raise one only from a measured run of
 * demo-poster-gate.yml (demo/README.md, The poster gate), with its number and run beside it.
 * `countsLonePixels` says whether a differing pixel with no differing neighbour (PixelComparison's
 * `isolated`) counts against it: on Linux every pixel does, and on Windows and macOS a lone pixel is
 * an icon's edge their rasterizer shaded one step apart.
 */
export type PixelComparisonMode = 'full' | 'outside-text';

export interface PixelComparisonRule {
  mode: PixelComparisonMode;
  budget: number;
  countsLonePixels: boolean;
}

export const PIXEL_COMPARISON: Record<'linux' | 'win32' | 'darwin', PixelComparisonRule> = {
  // Run 45118082966: 0 on every case, with no lone pixels either.
  linux: { mode: 'full', budget: 0, countsLonePixels: true },
  // Run 45118082966: once the text in fields was left out, the largest residue was 41 pixels
  // (column-automation clay), the edges of lucide icons shaded a step apart in small clusters.
  win32: { mode: 'outside-text', budget: 60, countsLonePixels: false },
  // Run 45118082966: the same, largest 66 (completed-task-usage clay: the wrench and sidebar icons'
  // edges, 1 to 3 pixels a cluster). A swapped or recolored icon changes far more than this.
  darwin: { mode: 'outside-text', budget: 100, countsLonePixels: false },
};

/** The comparison for the OS running the gate; one the table does not name is held to Linux's. */
export function pixelComparisonFor(platform: string): PixelComparisonRule {
  return platform === 'win32' || platform === 'darwin' || platform === 'linux' ? PIXEL_COMPARISON[platform] : PIXEL_COMPARISON.linux;
}

/** The pixels a comparison counts against its OS's budget. */
export function countedPixels(comparison: Pick<PixelComparison, 'differing' | 'isolated'>, rule: PixelComparisonRule): number {
  return comparison.differing + (rule.countsLonePixels ? comparison.isolated : 0);
}

/**
 * How far past a text's line box its glyphs may draw, in CSS px: a glyph's ink can overhang its
 * advance by a fraction of a pixel, and antialiasing bleeds one device pixel past that.
 */
export const TEXT_MASK_PADDING_PX = 1;

/** Every region of a measure whose pixels are glyphs: each text line box, each placeholder, each terminal. */
export function textMaskBoxes(measure: FrameMeasure): MeasuredBox[] {
  return [
    ...measure.textNodes.flatMap((node) => node.lines),
    ...(measure.unmeasuredText ?? []),
    ...measure.terminals.map((terminal) => terminal.rect),
  ];
}

/**
 * The line boxes of every clock or counter that moved on since the poster (differsOnlyInDigits),
 * from both measures, so its pixels can be left out while the rest of the frame is compared.
 */
export function clockMaskBoxes(reference: FrameMeasure, actual: FrameMeasure): MeasuredBox[] {
  return clockTextPairs(reference, actual).flatMap(({ expected, found }) => [...expected.lines, ...found.lines]);
}

/** Regions left out of a pixel comparison, in CSS px, and the device scale the images were shot at. */
export interface PixelMask {
  boxes: MeasuredBox[];
  scale: number;
  /** CSS px added on every side of every box. */
  padding: number;
}

/**
 * What a case leaves out of its pixels: a clock or counter that moved on since the poster on every
 * OS, and in `outside-text` mode every glyph, from the poster's measure and the shot's.
 */
export function pixelMaskFor(mode: PixelComparisonMode, reference: FrameMeasure, shot: FrameMeasure, scale: number): PixelMask {
  const boxes = [
    ...clockMaskBoxes(reference, shot),
    ...(mode === 'outside-text' ? [...textMaskBoxes(reference), ...textMaskBoxes(shot)] : []),
  ];
  return { boxes, scale, padding: TEXT_MASK_PADDING_PX };
}

export interface PixelComparison {
  /**
   * Pixels that differ, that pixelmatch does not read as antialiasing, and that touch another such
   * pixel. A lone one is an edge pixel of an icon that the OS's rasterizer shaded one step apart
   * (macOS in v0.62.0: about eight a frame, each on a lucide stroke's edge, the shape the same), and
   * is counted in `isolated` instead. A real change (a swapped icon, a moved border, another color)
   * changes neighbouring pixels together.
   */
  differing: number;
  /** Differing pixels with no differing neighbour, which `differing` leaves out. */
  isolated: number;
  total: number;
  /** Pixels the mask left out of the comparison. */
  masked: number;
  /** Set when the two images are not the same size, which no pixel count can describe. */
  sizeMismatch: string | null;
}

/**
 * Compare a frame's shot to its poster, writing a diff image to `diffPath` when any pixel differs.
 * A mask's pixels are painted out of both images first, so they cannot count, and the diff image
 * shows only the pixels that did.
 */
export function comparePixels(posterBytes: Buffer, frameBytes: Buffer, options: { diffPath?: string; mask?: PixelMask } = {}): PixelComparison {
  const poster = PNG.sync.read(posterBytes);
  const frame = PNG.sync.read(frameBytes);
  if (poster.width !== frame.width || poster.height !== frame.height) {
    return { differing: 0, isolated: 0, total: 0, masked: 0, sizeMismatch: `the frame is ${frame.width}x${frame.height}, the poster ${poster.width}x${poster.height}` };
  }
  const { width, height } = poster;
  let masked = 0;
  if (options.mask && options.mask.boxes.length > 0) {
    const { boxes, scale, padding } = options.mask;
    const covered = new Uint8Array(width * height);
    for (const box of boxes) {
      const left = Math.max(0, Math.floor((box.x - padding) * scale));
      const top = Math.max(0, Math.floor((box.y - padding) * scale));
      const right = Math.min(width, Math.ceil((box.x + box.width + padding) * scale));
      const bottom = Math.min(height, Math.ceil((box.y + box.height + padding) * scale));
      for (let row = top; row < bottom; row++) covered.fill(1, row * width + left, row * width + Math.max(left, right));
    }
    for (let pixel = 0; pixel < covered.length; pixel++) {
      if (covered[pixel] === 0) continue;
      masked += 1;
      poster.data.fill(0, pixel * 4, pixel * 4 + 4);
      frame.data.fill(0, pixel * 4, pixel * 4 + 4);
    }
  }
  const diff = new PNG({ width, height });
  const counted = pixelmatch(poster.data, frame.data, diff.data, width, height, { includeAA: false, diffMask: true, diffColor: DIFF_COLOR, aaColor: ANTIALIASING_COLOR });
  if (counted > 0 && options.diffPath) fs.writeFileSync(options.diffPath, PNG.sync.write(diff));
  const isolated = counted === 0 ? 0 : countIsolatedDiffPixels(diff.data, width, height);
  return { differing: counted - isolated, isolated, total: width * height, masked, sizeMismatch: null };
}

/** The colors pixelmatch paints a differing pixel and an antialiasing one in its diff mask. */
const DIFF_COLOR: [number, number, number] = [255, 0, 0];
const ANTIALIASING_COLOR: [number, number, number] = [255, 255, 0];

/** Differing pixels in a pixelmatch diff mask with no differing pixel among their eight neighbours. */
function countIsolatedDiffPixels(mask: Uint8Array, width: number, height: number): number {
  const isDiff = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const index = (y * width + x) * 4;
    return mask[index + 3] > 0 && mask[index] === DIFF_COLOR[0] && mask[index + 1] === DIFF_COLOR[1] && mask[index + 2] === DIFF_COLOR[2];
  };
  let isolated = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isDiff(x, y)) continue;
      let neighbour = false;
      for (let deltaY = -1; deltaY <= 1 && !neighbour; deltaY++) {
        for (let deltaX = -1; deltaX <= 1 && !neighbour; deltaX++) {
          if ((deltaX !== 0 || deltaY !== 0) && isDiff(x + deltaX, y + deltaY)) neighbour = true;
        }
      }
      if (!neighbour) isolated += 1;
    }
  }
  return isolated;
}

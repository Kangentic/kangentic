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
 *             frame against the poster, where only antialiasing may differ. A scene that shows a
 *             clock or a counter that moved on since the poster is held to its layout alone.
 *   the hero  also booted as the site's hero boots it, `loop=1`, whose layout at ready has to be
 *             the still's: the frame a host lifts its poster onto (demo/boot.js, onReady).
 */
import fs from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
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
 *   pixels            the drawing differs boot to boot; layout and terminals are still held.
 *   text              the text itself differs boot to boot; only terminals are held.
 *   held-terminals    a terminal held at a smaller type takes another grid at another display
 *                     scale; its terminals are held only at the poster's own scale.
 *   fractional-wraps  a long text breaks one word differently at 125 or 150 percent, where
 *                     Chromium lays text out with fractional advances; its text is held only at
 *                     whole scales.
 */
export type GateKnownDifference = 'pixels' | 'text' | 'held-terminals' | 'fractional-wraps';

const HELD_TERMINAL_REASON = 'its terminal is held at a smaller type, and xterm conforms it to the largest type the pane takes at each display\'s own cell, so the grid differs by scale (130 columns at 100 percent, 118 at 200); holding one grid instead left the pane an empty band at 125 and 200 percent, and the poster would have shown it';

export const GATE_KNOWN_DIFFERENCES: Record<string, { skips: GateKnownDifference; reason: string }> = {
  'knowledge-graph': { skips: 'text', reason: 'the overview labels a different set of conversation titles on each boot, so its poster names titles the live frame may not' },
  'knowledge-graph-contoso-web': { skips: 'pixels', reason: 'the map is a WebGL drawing whose camera comes to rest a little differently on each boot' },
  'knowledge-graph-spring-petclinic': { skips: 'pixels', reason: 'the map is a WebGL drawing whose camera comes to rest a little differently on each boot' },
  'knowledge-graph-online-boutique': { skips: 'pixels', reason: 'the map is a WebGL drawing whose camera comes to rest a little differently on each boot' },
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
};

/** What a case leaves out of its comparison. */
export interface GateSkips {
  text: boolean;
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
    text: known === 'text' || (known === 'fractional-wraps' && fractionalScale),
    terminals: known === 'held-terminals' && !gateCase.comparePositions,
    pixels: known === 'pixels' || known === 'text',
  };
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
 * How many pixels that are NOT antialiasing may differ between a frame and its poster, per OS
 * running the gate. The posters are shot on Linux, so Linux holds the bar at none. Windows and
 * macOS rasterize text through their own scalers (DirectWrite, CoreText), and the share of their
 * difference pixelmatch does not classify as antialiasing is measured by a dispatched run of
 * demo-poster-gate.yml (demo/README.md, The poster gate); raise a value here only from such a run,
 * with its number in the comment beside it. Every entry is 0 on purpose until then. A leg over
 * budget fails and prints its count, which is the measurement.
 */
export const NON_ANTIALIASING_PIXEL_BUDGET: Record<string, number> = {
  linux: 0,
  // Measured by a local Windows run of the whole gate (task 1079): every pixel comparison identical.
  win32: 0,
  // Not measured yet: the first macOS leg's failure prints the number to put here.
  darwin: 0,
};

export interface PixelComparison {
  /** Pixels that differ and pixelmatch does not read as antialiasing. */
  differing: number;
  total: number;
  /** Set when the two images are not the same size, which no pixel count can describe. */
  sizeMismatch: string | null;
}

/** Compare a frame's shot to its poster, writing a diff image to `diffPath` when any pixel differs. */
export function comparePixels(posterBytes: Buffer, frameBytes: Buffer, diffPath?: string): PixelComparison {
  const poster = PNG.sync.read(posterBytes);
  const frame = PNG.sync.read(frameBytes);
  if (poster.width !== frame.width || poster.height !== frame.height) {
    return { differing: 0, total: 0, sizeMismatch: `the frame is ${frame.width}x${frame.height}, the poster ${poster.width}x${poster.height}` };
  }
  const diff = new PNG({ width: poster.width, height: poster.height });
  const differing = pixelmatch(poster.data, frame.data, diff.data, poster.width, poster.height, { includeAA: false, diffMask: true });
  if (differing > 0 && diffPath) fs.writeFileSync(diffPath, PNG.sync.write(diff));
  return { differing, total: poster.width * poster.height, sizeMismatch: null };
}

/**
 * The poster gate: every poster's scene, booted from the built demo on this OS at the display
 * scales a visitor has, against the poster set the release shot (tests/captures/helpers/poster-gate.ts
 * says what each case checks). demo/poster-gate.mjs runs it; release.yml runs that on Windows, macOS
 * and Linux through .github/workflows/demo-poster-gate.yml, and a mismatch fails the job.
 *
 *   POSTER_GATE_SET=<dir>       the poster set's staging directory (dist/demo-posters): its scenes/
 *                               and hero/ directories, the stills and their .layout.json sidecars.
 *                               Without it the file declares no case, so `npm run capture`, which
 *                               runs every capture file, does not run the gate.
 *   POSTER_GATE_OUTPUT=<dir>    where a failing case writes its frame, its diff and its layout
 *
 * Each case launches the rig's own browser (launchCaptureBrowser: full Chromium, scrollbars on, the
 * scale forced) and opens the scene as the poster was opened. It measures the layout at ready, the
 * moment a host lifts its poster, and compares the pixels once the frame stops changing, as the
 * poster was shot.
 */
import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startDemoServer } from '../../../demo/static-server.mjs';
import { readBuildScenes } from '../../../scripts/lib/demo-posters.mjs';
import { SCENES } from '../scenes';
import { hideDevOnlyChrome, launchCaptureBrowser } from '../helpers/capture-page';
import { openScene, shootWhenStill, type SceneTheme } from '../helpers/scene-page';
import { compareFrameMeasures, countClockTexts, measureFrame, type FrameMeasure } from '../helpers/frame-measure';
import {
  GATE_KNOWN_DIFFERENCES, comparePixels, countedPixels, gateCases, knownDifferenceSkips, pixelComparisonFor, pixelMaskFor, posterGateSet, stripKnownDifference,
} from '../helpers/poster-gate';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist', 'demo');
const SET_DIR = process.env.POSTER_GATE_SET ? path.resolve(process.env.POSTER_GATE_SET) : null;
const OUTPUT_DIR = process.env.POSTER_GATE_OUTPUT ? path.resolve(process.env.POSTER_GATE_OUTPUT) : path.join(REPO_ROOT, 'dist', 'poster-gate');

// Read the build only when asked to gate: a stale or missing build throws here, naming the fix.
const scenesJson = SET_DIR === null ? null : readBuildScenes({ distDir: DIST_DIR, packageJsonPath: path.join(REPO_ROOT, 'package.json') });
const cases = scenesJson === null ? [] : gateCases(posterGateSet(scenesJson.scenes.map((scene: { name: string }) => scene.name), scenesJson.frame));
const pixelComparison = pixelComparisonFor(process.platform);

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;
let server: DemoServer;

test.describe('Poster gate', () => {
  // Each case is its own test group, so the workflow's --shard splits the cases between its legs.
  // In the default mode the whole file is one group, and a second shard would get no case at all
  // and still exit 0. The captures project keeps one worker, so the cases still run one at a time,
  // and each worker starts its own server in beforeAll.
  test.describe.configure({ mode: 'parallel' });

  test.beforeAll(async () => {
    server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  });

  test.afterAll(async () => {
    if (server) await server.close();
  });

  for (const gateCase of cases) {
    test(gateCase.title, async () => {
      const setDir = SET_DIR as string;
      const scene = SCENES[gateCase.scene];
      if (!scene) throw new Error(`The poster set names scene ${gateCase.scene}, which the registry does not have`);
      const layoutPath = path.join(setDir, gateCase.layoutFile);
      if (!fs.existsSync(layoutPath)) throw new Error(`${layoutPath} is missing: run "npm run demo:posters" first, or point POSTER_GATE_SET at the set`);
      let reference: FrameMeasure;
      try {
        reference = JSON.parse(fs.readFileSync(layoutPath, 'utf8')) as FrameMeasure;
      } catch (error) {
        throw new Error(`${layoutPath} is not a layout the rig wrote (${error instanceof Error ? error.message : String(error)}): shoot the set again with "npm run demo:posters"`);
      }
      const resolution = { name: `gate-${gateCase.scale}x`, viewport: gateCase.viewport, scale: gateCase.scale };
      const { browser, page } = await launchCaptureBrowser({ resolution });
      try {
        await hideDevOnlyChrome(page);
        const stem = gateCase.title.replace(/[^a-z0-9.-]+/gi, '_');
        await openScene(page, scene, { baseUrl: server.url, theme: gateCase.theme as SceneTheme, motion: gateCase.motion });
        // The layout at READY, which is the moment a host lifts its poster: a scene that paints
        // after ready (an editor still laying out) differs from its poster exactly then, and a
        // settled frame would hide it. The pixels are compared once the frame stops changing, as
        // the poster was shot, past the scrollbar thumb and cursor a terminal shows at ready.
        const measured = await measureFrame(page);
        // The shot is taken only when it is compared or a failure keeps it: a still settles first
        // (shootWhenStill), which costs every case at a scale with no poster for nothing. The frame
        // is measured again right after it, so the pixel mask (a clock that ticked since ready, the
        // text where it is drawn in the shot) describes the pixels that were shot.
        let captured: { bytes: Buffer; measure: FrameMeasure } | null = null;
        const takeShot = async (): Promise<{ bytes: Buffer; measure: FrameMeasure }> => {
          if (captured === null) {
            const bytes = gateCase.motion === 'still' ? await shootWhenStill(page) : await page.screenshot({ type: 'png' });
            captured = { bytes, measure: await measureFrame(page) };
          }
          return captured;
        };
        if (gateCase.motion === 'loop') await takeShot();
        // What a named difference leaves out of the comparison (GATE_KNOWN_DIFFERENCES), printed on
        // every run that leaves it out.
        const known = GATE_KNOWN_DIFFERENCES[gateCase.scene];
        const skips = knownDifferenceSkips(known?.skips, gateCase);
        if (skips.text || skips.graphLabels || skips.terminals || skips.pixels) console.log(`[poster-gate] ${gateCase.title}: a known difference, ${known?.skips} not held here: ${known?.reason}`);
        const problems = compareFrameMeasures(stripKnownDifference(reference, skips), stripKnownDifference(measured, skips), { comparePositions: gateCase.comparePositions });
        const clocksAtReady = countClockTexts(reference, measured);
        if (clocksAtReady > 0) console.log(`[poster-gate] ${gateCase.title}: ${clocksAtReady} clock or counter text(s) moved on since the poster; their line count is held, and their pixels are left out of the comparison`);
        if (gateCase.posterFile && !skips.pixels) {
          const shot = await takeShot();
          // A moved clock is left out on every OS; on Windows and macOS so is every glyph
          // (PIXEL_COMPARISON).
          const comparison = comparePixels(fs.readFileSync(path.join(setDir, gateCase.posterFile)), shot.bytes, {
            diffPath: path.join(OUTPUT_DIR, `${stem}.diff.png`),
            mask: pixelMaskFor(pixelComparison.mode, reference, shot.measure, gateCase.scale),
          });
          const counted = countedPixels(comparison, pixelComparison);
          if (comparison.sizeMismatch) problems.push(comparison.sizeMismatch);
          else if (counted > pixelComparison.budget) {
            problems.push(`${counted} of ${comparison.total - comparison.masked} compared pixels differ beyond antialiasing (${pixelComparison.mode} on ${process.platform}, budget ${pixelComparison.budget})`);
          }
          const share = comparison.total > 0 ? Math.round((comparison.masked / comparison.total) * 100) : 0;
          const lonePixels = `${comparison.isolated} lone edge pixels ${pixelComparison.countsLonePixels ? 'among them' : 'not counted'}`;
          console.log(`[poster-gate] ${gateCase.title}: ${counted} pixels beyond antialiasing (${lonePixels}), ${pixelComparison.mode} on ${process.platform}, ${share}% of the frame left out`);
        }
        if (problems.length > 0) {
          fs.writeFileSync(path.join(OUTPUT_DIR, `${stem}.png`), (await takeShot()).bytes);
          fs.writeFileSync(path.join(OUTPUT_DIR, `${stem}.layout.json`), `${JSON.stringify(measured)}\n`);
        }
        expect(problems, `${gateCase.title} on ${process.platform} differs from its poster`).toEqual([]);
      } finally {
        await browser.close();
      }
    });
  }
});

/**
 * One still per registry scene, shot from the BUILT web demo: the rig as the scene registry's
 * second consumer. `npm run capture` builds dist/demo first; running this file against a stale
 * or missing build is refused rather than silently shooting last release's frames.
 *
 * Every scene the site can embed is opened by URL, so a still here is a frame of what a docs
 * page shows. The three `driver` scenes are the rig's alone: their gesture (a card mid-drag, a
 * right-click menu, a window dragged to the edge) is played with Playwright after the frame
 * reports ready, which is what no page can do for itself.
 *
 * Output: captures/<timestamp>/scenes/<scene>.<theme>.<resolution>.png, in the same gitignored,
 * per-run directory the marketing captures use, and beside each still a
 * <scene>.<theme>.<resolution>.focus.json holding the rect of the scene's `focus` element as
 * measured on that still (demo/boot.js's own measure, the one the ready message reports), or
 * null for a scene that names none. demo/posters.mjs reads those into the poster manifest.
 * Axes are env-selectable for a quick single run,
 * and every axis refuses a name it does not know rather than shooting the page's error card:
 *   CAPTURE_SCENES=board,usage        only these scenes (default: all)
 *   CAPTURE_THEMES=clay,rust          default: night,sand (the poster set shoots the product pair)
 *   CAPTURE_RESOLUTIONS=frame,hero    default: frame (the site's 1600 by 1000, at 2x)
 *   CAPTURE_OUTPUT_ROOT=<dir>         replaces captures/<timestamp>; demo/posters.mjs points it at
 *                                     dist/demo-posters/ so the set it verifies and zips is in one
 *                                     known place (tests/captures/helpers/output-dir.ts)
 */
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startDemoServer } from '../../../demo/static-server.mjs';
import { SCENES } from '../scenes';
import { hideDevOnlyChrome, launchCaptureBrowser } from '../helpers/capture-page';
import { openScene, SCENE_THEMES, type SceneTheme } from '../helpers/scene-page';
import { frame, hero, inline, thumbnail, type Resolution } from '../helpers/resolutions';
import { getOutputDir } from '../helpers/output-dir';

const DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'dist', 'demo');
const OUTPUT_DIR = getOutputDir('scenes');

const RESOLUTIONS_BY_NAME: Record<string, Resolution> = { frame, hero, inline, thumbnail };

function envList(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (!value) return fallback;
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

const sceneNames = envList('CAPTURE_SCENES', Object.keys(SCENES));
const themes = envList('CAPTURE_THEMES', ['night', 'sand']).map((name) => {
  if (!(SCENE_THEMES as readonly string[]).includes(name)) {
    throw new Error(`CAPTURE_THEMES names "${name}"; known: ${SCENE_THEMES.join(', ')}`);
  }
  return name as SceneTheme;
});
const resolutions = envList('CAPTURE_RESOLUTIONS', ['frame']).map((name) => {
  const resolution = RESOLUTIONS_BY_NAME[name];
  if (!resolution) throw new Error(`CAPTURE_RESOLUTIONS names "${name}"; known: ${Object.keys(RESOLUTIONS_BY_NAME).join(', ')}`);
  return resolution;
});

for (const name of sceneNames) {
  if (!SCENES[name]) throw new Error(`CAPTURE_SCENES names "${name}", which the registry does not have. Scenes: ${Object.keys(SCENES).join(', ')}`);
}

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;
let server: DemoServer;

interface FocusRect { x: number; y: number; w: number; h: number }
interface DemoBootWindow { __demoBoot: { focusRectOf(selector: string): FocusRect | null } }

test.beforeAll(async () => {
  // Throws naming `npm run build:demo` when dist/demo is absent; nothing here shoots the dev server.
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.describe('Scene captures', () => {
  for (const name of sceneNames) {
    const scene = SCENES[name];
    for (const theme of themes) {
      for (const resolution of resolutions) {
        test(`${name} ${theme} ${resolution.name}`, async () => {
          const { browser, page } = await launchCaptureBrowser({ resolution });
          // The build is production, so there is no dev badge to hide; the call stays because
          // tests/unit/capture-dev-chrome-parity.test.ts requires it of every capture entry point,
          // and a future dev-server path through this file would need it.
          await hideDevOnlyChrome(page);
          try {
            await openScene(page, scene, { baseUrl: server.url, theme });
            await page.screenshot({
              path: path.join(OUTPUT_DIR, `${name}.${theme}.${resolution.name}.png`),
              fullPage: false,
            });
            // Measured on the frame just shot, after any gesture, so a crop fits this still. A
            // named focus that measures nothing throws rather than writing a null that reads as
            // "this scene has no focus".
            const focusSelector = scene.focus;
            const focus = focusSelector
              ? await page.evaluate((selector) => (window as unknown as DemoBootWindow).__demoBoot.focusRectOf(selector), focusSelector)
              : null;
            if (focusSelector && !focus) {
              throw new Error(`Scene ${name} names focus ${focusSelector}, which measured no on-screen element in ${theme}`);
            }
            fs.writeFileSync(
              path.join(OUTPUT_DIR, `${name}.${theme}.${resolution.name}.focus.json`),
              `${JSON.stringify(focus)}\n`,
            );
          } finally {
            await browser.close();
          }
        });
      }
    }
  }
});

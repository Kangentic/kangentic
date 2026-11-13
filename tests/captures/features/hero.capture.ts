/**
 * The landing page's hero still: the board in rust at the hero iframe's 1600 by 940, at 1x and 2x,
 * shot from the BUILT web demo the way scenes.capture.ts shoots every scene (the same launch, the
 * same wait for the frame to stop changing). demo/posters.mjs runs this beside the scene rig, and
 * scripts/lib/demo-posters.mjs packs both stills under the manifest's `hero` key (HERO_POSTER), so
 * kangentic.com's hero can show a poster that is the live frame it lifts onto.
 *
 * Output: <CAPTURE_OUTPUT_ROOT or captures/<timestamp>>/hero/hero.rust.<1|2>x.png, and beside each
 * a .layout.json the poster gate compares the live hero against.
 */
import { test } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { startDemoServer } from '../../../demo/static-server.mjs';
import { HERO_POSTER, HERO_SHOTS_DIR, heroFileName, heroLayoutFileName } from '../../../scripts/lib/demo-posters.mjs';
import { SCENES } from '../scenes';
import { hideDevOnlyChrome, launchCaptureBrowser } from '../helpers/capture-page';
import { openScene, shootWhenStill, type SceneTheme } from '../helpers/scene-page';
import { heroStill, heroStill2x, type Resolution } from '../helpers/resolutions';
import { getOutputDir } from '../helpers/output-dir';
import { measureFrame } from '../helpers/frame-measure';

const DIST_DIR = path.resolve(__dirname, '..', '..', '..', 'dist', 'demo');
const OUTPUT_DIR = getOutputDir(HERO_SHOTS_DIR);
const RESOLUTION_BY_SCALE: Record<number, Resolution> = { 1: heroStill, 2: heroStill2x };

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;
let server: DemoServer;

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

test.describe('Hero still', () => {
  for (const scale of HERO_POSTER.scales) {
    test(`hero ${HERO_POSTER.theme} ${scale}x`, async () => {
      const resolution = RESOLUTION_BY_SCALE[scale];
      if (!resolution) throw new Error(`HERO_POSTER names a ${scale}x hero, and resolutions.ts has no hero still at that scale`);
      const { browser, page } = await launchCaptureBrowser({ resolution });
      await hideDevOnlyChrome(page);
      try {
        await openScene(page, SCENES[HERO_POSTER.scene], { baseUrl: server.url, theme: HERO_POSTER.theme as SceneTheme });
        await shootWhenStill(page, { path: path.join(OUTPUT_DIR, heroFileName(scale)) });
        fs.writeFileSync(path.join(OUTPUT_DIR, heroLayoutFileName(scale)), `${JSON.stringify(await measureFrame(page))}\n`);
      } finally {
        await browser.close();
      }
    });
  }
});

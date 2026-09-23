/**
 * Shoot, verify, and pack the poster set for kangentic.com's docs figures.
 *
 *   npm run build:demo        first: the set is shot from dist/demo, and a stale build is refused
 *   npm run demo:posters      every scene in clay and rust at the frame's 2x, into
 *                             dist/demo-posters/scenes/, verified against dist/demo/scenes.json,
 *                             and zipped with manifest.json as dist/demo-posters-<version>.zip
 *
 * The rig is tests/captures/features/scenes.capture.ts, driven through its own env axes
 * (CAPTURE_THEMES, CAPTURE_RESOLUTIONS, CAPTURE_OUTPUT_ROOT) rather than a second capture file,
 * so the posters are the same stills `npm run capture` shoots, and the three driver scenes get
 * their gesture from the same Playwright code. release.yml's demo-posters job runs this after
 * publish-release and attaches the zip to the release. Every gate here exits non-zero naming its
 * cause: a missing or stale build, a rig failure, a poster missing or at the wrong size.
 * scripts/lib/demo-posters.mjs holds the pure half and tests/unit/demo-posters.test.ts covers it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  POSTER_RESOLUTION,
  POSTER_THEMES,
  expectedPosters,
  packPosterSet,
  posterPixelSize,
  posterZipName,
  readBuildScenes,
  readPosterFocus,
  resolvePlaywrightCli,
  verifyPosterSet,
} from '../scripts/lib/demo-posters.mjs';

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoDir, '..');
const distDir = path.join(repoRoot, 'dist', 'demo');
/** Beside dist/demo, never inside it: build:demo empties its own directory and nothing else. */
const stagingDir = path.join(repoRoot, 'dist', 'demo-posters');
/** getOutputDir('scenes') in tests/captures/helpers/output-dir.ts, under CAPTURE_OUTPUT_ROOT. */
const shotsDir = path.join(stagingDir, 'scenes');
/**
 * Forward slashes on purpose, not path.join: Playwright reads a file argument as a regular
 * expression against the full path, so a Windows `tests\captures` is the escape `\c` and matches
 * nothing ("No tests found"). A slash matches on every OS.
 */
const SCENE_RIG = 'tests/captures/features/scenes.capture.ts';

function log(message) {
  console.log(`[demo:posters] ${message}`);
}

function fail(message) {
  console.error(`[demo:posters] ${message}`);
  process.exit(1);
}

function main() {
  // Both preconditions before anything on disk moves, so a stale build or a missing install
  // fails in milliseconds rather than after the staging directory is gone.
  const scenesJson = readBuildScenes({ distDir, packageJsonPath: path.join(repoRoot, 'package.json') });
  const playwrightCli = resolvePlaywrightCli();
  const { width, height } = posterPixelSize(scenesJson);
  const posters = expectedPosters(scenesJson);
  log(`build ${distDir} is version ${scenesJson.version} with ${scenesJson.scenes.length} scenes.`);
  log(`Shooting ${posters.length} posters (${POSTER_THEMES.join(', ')}) at ${width}x${height} into ${shotsDir}`);

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(shotsDir, { recursive: true });

  // The rig's own axes, pinned. CAPTURE_SCENES is dropped on purpose: a value left in the shell
  // from a scoped run would shoot a subset, and the verify below would then refuse the set
  // without saying why.
  const env = {
    ...process.env,
    CAPTURE_THEMES: POSTER_THEMES.join(','),
    CAPTURE_RESOLUTIONS: POSTER_RESOLUTION,
    CAPTURE_OUTPUT_ROOT: stagingDir,
  };
  delete env.CAPTURE_SCENES;
  const rig = spawnSync(process.execPath, [playwrightCli, 'test', '--project=captures', SCENE_RIG], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  if (rig.status !== 0) {
    fail(`the scene rig exited with ${rig.status ?? rig.signal}; no set was packed.`);
  }

  const problems = verifyPosterSet(scenesJson, shotsDir);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[demo:posters] ${problem}`);
    fail(`${problems.length} problem(s) with the shots in ${shotsDir}; refusing to pack a partial set.`);
  }

  const zipPath = path.join(repoRoot, 'dist', posterZipName(scenesJson.version));
  const focus = readPosterFocus(scenesJson, shotsDir);
  fs.writeFileSync(zipPath, packPosterSet(scenesJson, shotsDir, focus));
  const megabytes = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  log(`${scenesJson.scenes.length} scenes x ${POSTER_THEMES.length} themes = ${posters.length} posters at ${width}x${height}, ${megabytes} MB, ${zipPath}`);
  const focusRects = Object.values(focus)
    .flatMap((byTheme) => Object.values(byTheme))
    .filter((rect) => rect !== null).length;
  log(`${focusRects} of ${posters.length} posters carry a focus rect in manifest.json; the rest name no focus element.`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

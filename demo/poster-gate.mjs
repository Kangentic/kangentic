/**
 * The poster gate: does the live frame show what its poster shows, on this OS?
 *
 *   npm run demo:posters        first, on Linux: the set the release attaches
 *   npm run demo:poster-gate    every poster's scene booted from dist/demo at 1, 1.25, 1.5 and 2x
 *                               and compared to dist/demo-posters (tests/captures/helpers/poster-gate.ts
 *                               says what is compared). Extra arguments go to Playwright, so
 *                               `-- --shard=1/2` runs half.
 *
 * .github/workflows/demo-poster-gate.yml runs it on Windows, macOS and Linux after release.yml's
 * demo-posters job has shot the set, on the very bytes that job shot from. Every refusal exits
 * non-zero naming its cause: a missing or stale build, a set with a missing still or sidecar, a
 * frame that differs from its poster. A failing case leaves its frame, its diff and its layout in
 * dist/poster-gate/ for the workflow to upload.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HERO_SHOTS_DIR, readBuildScenes, verifyHeroStills, verifyPosterSet } from '../scripts/lib/demo-posters.mjs';
import { resolvePlaywrightCli } from '../scripts/lib/playwright-cli.mjs';

const demoDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(demoDir, '..');
const distDir = path.join(repoRoot, 'dist', 'demo');
const setDir = path.resolve(process.env.POSTER_GATE_SET ?? path.join(repoRoot, 'dist', 'demo-posters'));
const outputDir = path.join(repoRoot, 'dist', 'poster-gate');
/** Forward slashes on purpose: Playwright reads a file argument as a regular expression (demo/posters.mjs). */
const GATE_RIG = 'tests/captures/features/poster-gate.capture.ts';

function log(message) {
  console.log(`[demo:poster-gate] ${message}`);
}

function fail(message) {
  console.error(`[demo:poster-gate] ${message}`);
  process.exit(1);
}

function main() {
  const scenesJson = readBuildScenes({ distDir, packageJsonPath: path.join(repoRoot, 'package.json') });
  const playwrightCli = resolvePlaywrightCli();
  const problems = [...verifyPosterSet(scenesJson, path.join(setDir, 'scenes')), ...verifyHeroStills(path.join(setDir, HERO_SHOTS_DIR))];
  if (problems.length > 0) {
    for (const problem of problems) console.error(`[demo:poster-gate] ${problem}`);
    fail(`${problems.length} problem(s) with the poster set in ${setDir}; run "npm run demo:posters" first, or point POSTER_GATE_SET at the set.`);
  }
  const extraArguments = process.argv.slice(2);
  log(`build ${scenesJson.version}, ${scenesJson.scenes.length} scenes, set ${setDir}, on ${process.platform}${extraArguments.length > 0 ? ` (${extraArguments.join(' ')})` : ''}`);
  const env = { ...process.env, POSTER_GATE_SET: setDir, POSTER_GATE_OUTPUT: outputDir };
  delete env.CAPTURE_SCENES;
  const rig = spawnSync(process.execPath, [playwrightCli, 'test', '--project=captures', GATE_RIG, ...extraArguments], {
    cwd: repoRoot,
    stdio: 'inherit',
    env,
  });
  if (rig.error) fail(`the gate could not start Playwright: ${rig.error.message}`);
  if (rig.status === null) fail(`the gate was stopped by ${rig.signal} before it finished on ${process.platform}.`);
  if (rig.status !== 0) {
    fail(`the gate exited with ${rig.status}: a frame differs from its poster on ${process.platform}. The frames, diffs and layouts are in ${outputDir}.`);
  }
  log(`every frame matches its poster on ${process.platform}.`);
}

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

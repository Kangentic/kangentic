/**
 * The poster set: one still per registry scene in each product theme, at the site's frame at
 * 2x, verified against the build's own scenes.json and zipped with a manifest. kangentic.com's
 * docs figures (AppFigure) render a poster before the demo frame boots, and instead of it in
 * print, under no JS, and on a phone; the three `driver` scenes have no other artifact at all.
 * demo/posters.mjs is the command, and release.yml's demo-posters job attaches its zip to every
 * release as demo-posters-<version>.zip. This module is the pure half, so
 * tests/unit/demo-posters.test.ts can run it over fixtures without a browser.
 *
 * The contract the site implements (kangentic.com, src/utils/figure-posters.ts):
 *
 *   demo-posters-<version>.zip
 *     manifest.json               { version, frame: { width, height }, scale, scenes }
 *     <scene>.<theme>.frame.png   frame.width * scale by frame.height * scale, title bar kept
 *
 * `scenes` maps a scene name to its file per theme. `version` is scenes.json's, the string the
 * site compares against the demo it deploys; a mismatch, a scene the manifest lacks, or a file
 * that is absent fails the site's build rather than shipping a stale or partial set quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { strToU8, zipSync } from 'fflate';

/** The product pair the site embeds with, in manifest key order; also the rig's CAPTURE_THEMES. */
export const POSTER_THEMES = ['clay', 'rust'];

/**
 * The rig resolution the set is shot at, which is the file suffix: `frame` in
 * tests/captures/helpers/resolutions.ts, the site's 1600 by 1000 at scale 2. This module cannot
 * import that TypeScript file, so tests/unit/demo-posters.test.ts pins both constants to it.
 */
export const POSTER_RESOLUTION = 'frame';
export const POSTER_SCALE = 2;

const SCENES_MANIFEST = 'scenes.json';
const POSTER_MANIFEST = 'manifest.json';

export function posterFileName(sceneName, theme) {
  return `${sceneName}.${theme}.${POSTER_RESOLUTION}.png`;
}

export function posterZipName(version) {
  return `demo-posters-${version}.zip`;
}

/** Every poster the set must carry, in scenes.json order, each scene's themes in POSTER_THEMES order. */
export function expectedPosters(scenesJson) {
  const posters = [];
  for (const scene of scenesJson.scenes) {
    for (const theme of POSTER_THEMES) {
      posters.push({ scene: scene.name, theme, file: posterFileName(scene.name, theme) });
    }
  }
  return posters;
}

/** The pixel size every poster must be: the frame at the poster scale. */
export function posterPixelSize(scenesJson) {
  return { width: scenesJson.frame.width * POSTER_SCALE, height: scenesJson.frame.height * POSTER_SCALE };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Signature (8), IHDR length (4), the `IHDR` tag (4), width (4), height (4). */
const PNG_HEADER_BYTES = 24;

/**
 * Width and height out of a PNG's first 24 bytes. IHDR is required to be the first chunk, so a
 * truncated or foreign file is reported as such rather than as a nonsense size.
 */
export function readPngDimensions(bytes, label) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < PNG_HEADER_BYTES) {
    throw new Error(`${label} is ${buffer.length} bytes, shorter than a PNG header`);
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${label} does not start with the PNG signature`);
  }
  if (buffer.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error(`${label} does not open with an IHDR chunk, so it is not a PNG this can size`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** The IEND chunk that closes every PNG: a zero length, the tag, and the tag's fixed CRC. */
const PNG_TRAILER = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * A file's dimensions, read from its first 24 bytes, after its last 12 are checked to be the
 * IEND chunk: a still cut short (a rig process killed mid-write, a disk that filled) keeps a
 * valid header and would otherwise pass. Two small reads, so verifying a hundred 3200 by 2000
 * stills costs no decode.
 */
export function inspectPngFile(filePath) {
  const { size } = fs.statSync(filePath);
  const head = Buffer.alloc(PNG_HEADER_BYTES);
  const tail = Buffer.alloc(PNG_TRAILER.length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const headBytes = fs.readSync(descriptor, head, 0, PNG_HEADER_BYTES, 0);
    const dimensions = readPngDimensions(head.subarray(0, headBytes), filePath);
    const tailBytes = size >= PNG_TRAILER.length
      ? fs.readSync(descriptor, tail, 0, PNG_TRAILER.length, size - PNG_TRAILER.length)
      : 0;
    if (tailBytes !== PNG_TRAILER.length || !tail.equals(PNG_TRAILER)) {
      throw new Error(`${filePath} does not end with the IEND chunk, so it is truncated (${size} bytes)`);
    }
    return dimensions;
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Every way the shots directory fails the contract, as one line each: a poster that is missing,
 * one that is not a PNG or is cut short, one at the wrong size, and a PNG the manifest would not
 * name (a stale directory, or a theme that is not a poster theme). Empty means the set is
 * complete. Reports every problem rather than the first, so one run of the rig answers all of
 * them, and never throws on a gap: an absent directory is every poster missing.
 */
export function verifyPosterSet(scenesJson, shotsDir) {
  const problems = [];
  const expected = expectedPosters(scenesJson);
  const { width, height } = posterPixelSize(scenesJson);
  for (const poster of expected) {
    const filePath = path.join(shotsDir, poster.file);
    if (!fs.existsSync(filePath)) {
      problems.push(`missing ${poster.file} (scene ${poster.scene}, theme ${poster.theme})`);
      continue;
    }
    let size;
    try {
      size = inspectPngFile(filePath);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    if (size.width !== width || size.height !== height) {
      problems.push(`${poster.file} is ${size.width}x${size.height}, not ${width}x${height} (the ${scenesJson.frame.width}x${scenesJson.frame.height} frame at ${POSTER_SCALE}x)`);
    }
  }
  const expectedFiles = new Set(expected.map((poster) => poster.file));
  const isDirectory = fs.statSync(shotsDir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  const present = isDirectory ? fs.readdirSync(shotsDir).filter((name) => name.endsWith('.png')).sort() : [];
  for (const name of present) {
    if (!expectedFiles.has(name)) problems.push(`unexpected ${name}: not a scenes.json scene at a poster theme`);
  }
  return problems;
}

/** The manifest the site reads: scenes keyed by name, in scenes.json order. */
export function buildPosterManifest(scenesJson) {
  const scenes = {};
  for (const scene of scenesJson.scenes) {
    const files = {};
    for (const theme of POSTER_THEMES) files[theme] = posterFileName(scene.name, theme);
    scenes[scene.name] = files;
  }
  return {
    version: scenesJson.version,
    frame: { width: scenesJson.frame.width, height: scenesJson.frame.height },
    scale: POSTER_SCALE,
    scenes,
  };
}

/**
 * The zip's bytes: manifest.json first, then every poster in manifest order. The posters are
 * stored rather than deflated (PNG is already deflate inside), which is also what keeps packing
 * a hundred 3200 by 2000 stills to a copy. Call verifyPosterSet first; this reads what is there.
 */
export function packPosterSet(scenesJson, shotsDir) {
  const manifest = buildPosterManifest(scenesJson);
  const entries = {
    [POSTER_MANIFEST]: [strToU8(`${JSON.stringify(manifest, null, 2)}\n`), { level: 6 }],
  };
  for (const poster of expectedPosters(scenesJson)) {
    entries[poster.file] = [fs.readFileSync(path.join(shotsDir, poster.file)), { level: 0 }];
  }
  return zipSync(entries);
}

/** A JSON file's value, naming the file when it does not parse: a build cut off mid-write leaves one. */
function readJsonFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${filePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The build's scenes.json, refused when the build is absent or STALE: its version has to be
 * package.json's, or the set would name one version in its zip and manifest while the demo the
 * site deploys for the tag reports another, and the site fails its build on exactly that.
 */
export function readBuildScenes({ distDir, packageJsonPath }) {
  const indexPath = path.join(distDir, 'index.html');
  const scenesPath = path.join(distDir, SCENES_MANIFEST);
  if (!fs.existsSync(indexPath) || !fs.existsSync(scenesPath)) {
    throw new Error(`No web build at ${distDir} (index.html and ${SCENES_MANIFEST}). Run "npm run build:demo" first.`);
  }
  const scenesJson = readJsonFile(scenesPath);
  if (typeof scenesJson.version !== 'string' || scenesJson.version === '') {
    throw new Error(`${scenesPath} carries no version string; is this a demo build?`);
  }
  if (!Number.isInteger(scenesJson.frame?.width) || !Number.isInteger(scenesJson.frame?.height)) {
    throw new Error(`${scenesPath} carries no frame size; is this a demo build?`);
  }
  if (!Array.isArray(scenesJson.scenes) || scenesJson.scenes.length === 0 || scenesJson.scenes.some((scene) => typeof scene?.name !== 'string')) {
    throw new Error(`${scenesPath} lists no named scenes; is this a demo build?`);
  }
  const packageJson = readJsonFile(packageJsonPath);
  if (scenesJson.version !== packageJson.version) {
    throw new Error(`${scenesPath} is version ${scenesJson.version} but package.json is ${packageJson.version}: the build is stale. Run "npm run build:demo" first.`);
  }
  return scenesJson;
}

/** The Playwright CLI entry, spawned with process.execPath so no shell is involved on any OS. */
export function resolvePlaywrightCli() {
  try {
    return createRequire(import.meta.url).resolve('@playwright/test/cli');
  } catch {
    throw new Error('@playwright/test is not installed (its cli entry did not resolve). Run "npm ci" first.');
  }
}

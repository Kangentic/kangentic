/**
 * scripts/lib/demo-posters.mjs is the pure half of `npm run demo:posters` (demo/posters.mjs),
 * which shoots every registry scene in the two product themes and zips the set with a manifest
 * for kangentic.com's docs figures; release.yml's demo-posters job attaches that zip to every
 * release. The site fails its build on a version that is not the deployed demo's, on a scene the
 * manifest lacks, and on a file that is absent, so the packer has to refuse each of those first,
 * and this pins that it does, over fixtures rather than a ten-minute rig run. It also pins the two
 * contracts the .mjs cannot import: the rig's resolution and file naming (tests/captures), and the
 * theme list the rig validates against.
 *
 * Tier: Unit.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  POSTER_RESOLUTION,
  POSTER_SCALE,
  POSTER_THEMES,
  buildPosterManifest,
  expectedPosters,
  inspectPngFile,
  packPosterSet,
  posterFileName,
  posterFocusFileName,
  posterPixelSize,
  posterZipName,
  readBuildScenes,
  readPngDimensions,
  readPosterFocus,
  resolvePlaywrightCli,
  verifyPosterSet,
} from '../../scripts/lib/demo-posters.mjs';
import { frame } from '../../tests/captures/helpers/resolutions';
import { SCENE_THEMES } from '../../tests/captures/helpers/scene-page';

// tests/captures/features/scenes.capture.ts validates CAPTURE_THEMES at module load, before it
// ever reaches a call that only makes sense inside the real Playwright test runner
// (test.beforeAll). Importing it here is the only way to run that validation for real, since
// tests/captures sits outside tsconfig's `include` and is never typechecked. The mock lets the
// import proceed past the runner-only calls on a valid theme, so a passing import is read as a
// clean pass through the guard rather than an artifact of loading outside the runner. This mock
// is file-wide (vi.mock is hoisted above every import in the file, including scene-page.ts's own
// `import { expect } from '@playwright/test'`), which is safe today because nothing this file
// imports calls that `expect`; a future named import from '@playwright/test' in the rig's
// dependency graph would silently receive this stub instead.
vi.mock('@playwright/test', () => {
  const testFn = vi.fn();
  Object.assign(testFn, { describe: vi.fn(), beforeAll: vi.fn(), afterAll: vi.fn() });
  return { test: testFn, expect: vi.fn() };
});

const REPO_ROOT = path.resolve(__dirname, '../..');

/** The shape demo/vite.config.mts emits as dist/demo/scenes.json, cut to three scenes, one of them rig-only. */
const FIXTURE_SCENES = {
  version: '0.43.0',
  frame: { width: 1600, height: 1000 },
  scenes: [
    { name: 'board', reach: 'boot', alt: 'The board.', description: 'The board.' },
    { name: 'card-drag', reach: 'driver', alt: 'A card mid-drag.', description: 'A held drag.' },
    { name: 'settings-general', reach: 'boot', alt: 'Settings.', description: 'The General tab.' },
  ],
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_TRAILER = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

/** Signature, an IHDR chunk of the given size, and nothing else: enough for a header read, not a decoder. */
function pngHeader(width: number, height: number, chunkTag = 'IHDR'): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from(PNG_SIGNATURE).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write(chunkTag, 12, 'latin1');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  // Bit depth 8, colour type 6 (RGBA), compression 0, filter 0, interlace 0; the CRC stays zero.
  buffer.set([8, 6, 0, 0, 0], 24);
  return buffer;
}

/** A whole file as far as the verifier looks: the header, some stand-in body, and the IEND trailer. */
function pngFile(width: number, height: number): Buffer {
  return Buffer.concat([pngHeader(width, height), Buffer.alloc(64, 0x5a), Buffer.from(PNG_TRAILER)]);
}

/** The one fixture scene with a focus element, and the rect the rig would measure for it. */
const FOCUS_SCENE = 'settings-general';
const FOCUS_RECT = { x: 0.2156, y: 0.08, w: 0.5688, h: 0.84 };

/** The focus map a complete fixture set packs: the one rect in both themes, null everywhere else. */
const FIXTURE_FOCUS = {
  board: { clay: null, rust: null },
  'card-drag': { clay: null, rust: null },
  'settings-general': { clay: FOCUS_RECT, rust: FOCUS_RECT },
};

/** Every poster and its focus sidecar, the way the rig leaves a finished run. */
function writeCompleteSet(shotsDir: string, size = { width: 3200, height: 2000 }): void {
  fs.mkdirSync(shotsDir, { recursive: true });
  for (const poster of expectedPosters(FIXTURE_SCENES)) {
    fs.writeFileSync(path.join(shotsDir, poster.file), pngFile(size.width, size.height));
    const focus = poster.scene === FOCUS_SCENE ? FOCUS_RECT : null;
    fs.writeFileSync(path.join(shotsDir, poster.focusFile), `${JSON.stringify(focus)}\n`);
  }
}

let tempRoot: string;

beforeAll(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-posters-'));
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function scratch(name: string): string {
  const dir = path.join(tempRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('the poster set names and sizes', () => {
  it('names a poster after the scene, the theme, and the rig resolution', () => {
    expect(posterFileName('board', 'clay')).toBe('board.clay.frame.png');
    expect(posterFocusFileName('board', 'clay')).toBe('board.clay.frame.focus.json');
    expect(posterZipName('0.43.0')).toBe('demo-posters-0.43.0.zip');
  });

  it('pairs every expected poster with its focus sidecar', () => {
    for (const poster of expectedPosters(FIXTURE_SCENES)) {
      expect(poster.focusFile).toBe(posterFocusFileName(poster.scene, poster.theme));
    }
  });

  it('expects one poster per scene per theme, scenes in scenes.json order, clay before rust', () => {
    expect(expectedPosters(FIXTURE_SCENES).map((poster) => poster.file)).toEqual([
      'board.clay.frame.png',
      'board.rust.frame.png',
      'card-drag.clay.frame.png',
      'card-drag.rust.frame.png',
      'settings-general.clay.frame.png',
      'settings-general.rust.frame.png',
    ]);
  });

  it('sizes a poster as the frame at the poster scale', () => {
    expect(posterPixelSize(FIXTURE_SCENES)).toEqual({ width: 3200, height: 2000 });
  });
});

describe('readPngDimensions', () => {
  it('reads width and height out of the IHDR chunk', () => {
    expect(readPngDimensions(pngHeader(3200, 2000), 'sample')).toEqual({ width: 3200, height: 2000 });
  });

  it('reads dimensions from a genuine Uint8Array, not only a Buffer', () => {
    const bytes = new Uint8Array(pngHeader(3200, 2000));
    expect(Buffer.isBuffer(bytes)).toBe(false);
    expect(readPngDimensions(bytes, 'view')).toEqual({ width: 3200, height: 2000 });
  });

  it('reads dimensions from a Uint8Array subarray view with a non-zero byteOffset', () => {
    const padded = new Uint8Array(Buffer.concat([Buffer.alloc(5), pngHeader(1600, 1000)]));
    const view = padded.subarray(5);
    expect(view.byteOffset).toBe(5);
    expect(readPngDimensions(view, 'offset-view')).toEqual({ width: 1600, height: 1000 });
  });

  it('refuses a file shorter than a PNG header', () => {
    expect(() => readPngDimensions(Buffer.alloc(10), 'short.png')).toThrow(/short\.png is 10 bytes, shorter than a PNG header/);
  });

  it('refuses a file without the PNG signature', () => {
    expect(() => readPngDimensions(Buffer.alloc(33), 'zeros.png')).toThrow(/zeros\.png does not start with the PNG signature/);
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    expect(() => readPngDimensions(pngHeader(1, 1, 'IDAT'), 'odd.png')).toThrow(/odd\.png does not open with an IHDR chunk/);
  });

  it('inspects a file by its two ends: the header for the size, the trailer for wholeness', () => {
    const filePath = path.join(scratch('inspect'), 'one.png');
    fs.writeFileSync(filePath, pngFile(1600, 1000));
    expect(inspectPngFile(filePath)).toEqual({ width: 1600, height: 1000 });
  });

  it('refuses a file cut short, since a valid header alone would pass', () => {
    const filePath = path.join(scratch('inspect-truncated'), 'cut.png');
    fs.writeFileSync(filePath, pngFile(1600, 1000).subarray(0, 60));
    expect(() => inspectPngFile(filePath)).toThrow(/cut\.png does not end with the IEND chunk, so it is truncated \(60 bytes\)/);
  });

  it('refuses a file on disk shorter than a PNG header, reading only the bytes actually there', () => {
    const filePath = path.join(scratch('inspect-too-short'), 'stub.png');
    fs.writeFileSync(filePath, Buffer.alloc(10));
    expect(() => inspectPngFile(filePath)).toThrow(/stub\.png is 10 bytes, shorter than a PNG header/);
  });
});

describe('buildPosterManifest', () => {
  it('is exactly the shape the site reads, scenes keyed by name in scenes.json order, then focus', () => {
    const manifest = buildPosterManifest(FIXTURE_SCENES, FIXTURE_FOCUS);
    expect(manifest).toEqual({
      version: '0.43.0',
      frame: { width: 1600, height: 1000 },
      scale: 2,
      scenes: {
        board: { clay: 'board.clay.frame.png', rust: 'board.rust.frame.png' },
        'card-drag': { clay: 'card-drag.clay.frame.png', rust: 'card-drag.rust.frame.png' },
        'settings-general': { clay: 'settings-general.clay.frame.png', rust: 'settings-general.rust.frame.png' },
      },
      focus: FIXTURE_FOCUS,
    });
    expect(Object.keys(manifest)).toEqual(['version', 'frame', 'scale', 'scenes', 'focus']);
    expect(Object.keys(manifest.scenes)).toEqual(['board', 'card-drag', 'settings-general']);
  });
});

describe('readPosterFocus', () => {
  it('reads every sidecar into a map keyed by scene then theme, in manifest order', () => {
    const shotsDir = scratch('focus-read');
    writeCompleteSet(shotsDir);
    const focus = readPosterFocus(FIXTURE_SCENES, shotsDir);
    expect(focus).toEqual(FIXTURE_FOCUS);
    expect(Object.keys(focus)).toEqual(['board', 'card-drag', 'settings-general']);
    expect(Object.keys(focus.board)).toEqual(['clay', 'rust']);
  });

  it('throws naming a missing sidecar rather than reading it as no focus', () => {
    const shotsDir = scratch('focus-read-missing');
    writeCompleteSet(shotsDir);
    fs.rmSync(path.join(shotsDir, 'board.rust.frame.focus.json'));
    expect(() => readPosterFocus(FIXTURE_SCENES, shotsDir)).toThrow(/missing board\.rust\.frame\.focus\.json \(scene board, theme rust\)/);
  });
});

describe('verifyPosterSet', () => {
  it('accepts a complete set at the right size', () => {
    const shotsDir = scratch('complete');
    writeCompleteSet(shotsDir);
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([]);
  });

  it('names every missing poster, not only the first', () => {
    const shotsDir = scratch('missing-two');
    writeCompleteSet(shotsDir);
    fs.rmSync(path.join(shotsDir, 'card-drag.rust.frame.png'));
    fs.rmSync(path.join(shotsDir, 'settings-general.clay.frame.png'));
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([
      'missing card-drag.rust.frame.png (scene card-drag, theme rust)',
      'missing settings-general.clay.frame.png (scene settings-general, theme clay)',
    ]);
  });

  it('reports every poster and every sidecar missing when the directory does not exist', () => {
    const problems = verifyPosterSet(FIXTURE_SCENES, path.join(tempRoot, 'never-written'));
    expect(problems).toHaveLength(12);
    expect(problems.every((problem) => problem.startsWith('missing '))).toBe(true);
  });

  it('names a missing focus sidecar even when its poster is present', () => {
    const shotsDir = scratch('focus-missing');
    writeCompleteSet(shotsDir);
    fs.rmSync(path.join(shotsDir, 'settings-general.clay.frame.focus.json'));
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([
      'missing settings-general.clay.frame.focus.json (scene settings-general, theme clay)',
    ]);
  });

  it('names a focus sidecar that is neither null nor a rect with a positive size', () => {
    const shotsDir = scratch('focus-malformed');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'board.clay.frame.focus.json'), JSON.stringify({ ...FOCUS_RECT, w: 0 }));
    fs.writeFileSync(path.join(shotsDir, 'board.rust.frame.focus.json'), JSON.stringify({ ...FOCUS_RECT, h: '0.84' }));
    fs.writeFileSync(path.join(shotsDir, 'card-drag.clay.frame.focus.json'), JSON.stringify({ x: 0, y: 0, width: 1, height: 1 }));
    const problems = verifyPosterSet(FIXTURE_SCENES, shotsDir);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/^board\.clay\.frame\.focus\.json is neither null nor a \{ x, y, w, h \} rect with a positive size/);
    expect(problems[1]).toMatch(/^board\.rust\.frame\.focus\.json is neither null nor/);
    expect(problems[2]).toMatch(/^card-drag\.clay\.frame\.focus\.json is neither null nor/);
  });

  it('names a focus sidecar that is not JSON, as a rig killed mid-write leaves one', () => {
    const shotsDir = scratch('focus-not-json');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'card-drag.rust.frame.focus.json'), '{ "x": 0.2,');
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([
      'card-drag.rust.frame.focus.json is not valid JSON: { "x": 0.2,',
    ]);
  });

  it('names a poster at the wrong size with the size it found', () => {
    const shotsDir = scratch('wrong-size');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'board.clay.frame.png'), pngFile(1600, 1000));
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([
      'board.clay.frame.png is 1600x1000, not 3200x2000 (the 1600x1000 frame at 2x)',
    ]);
  });

  it('names a poster that is not a PNG', () => {
    const shotsDir = scratch('not-png');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'board.rust.frame.png'), 'not a png at all, but long enough to read');
    const problems = verifyPosterSet(FIXTURE_SCENES, shotsDir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/board\.rust\.frame\.png does not start with the PNG signature/);
  });

  it('names a poster cut short after a valid header', () => {
    const shotsDir = scratch('truncated');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'card-drag.clay.frame.png'), pngFile(3200, 2000).subarray(0, 80));
    const problems = verifyPosterSet(FIXTURE_SCENES, shotsDir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/card-drag\.clay\.frame\.png does not end with the IEND chunk, so it is truncated \(80 bytes\)/);
  });

  it('names a PNG the manifest would not list, so a stale directory cannot pack', () => {
    const shotsDir = scratch('extra');
    writeCompleteSet(shotsDir);
    fs.writeFileSync(path.join(shotsDir, 'board.night.frame.png'), pngFile(3200, 2000));
    fs.writeFileSync(path.join(shotsDir, 'retired-scene.clay.frame.png'), pngFile(3200, 2000));
    expect(verifyPosterSet(FIXTURE_SCENES, shotsDir)).toEqual([
      'unexpected board.night.frame.png: not a scenes.json scene at a poster theme',
      'unexpected retired-scene.clay.frame.png: not a scenes.json scene at a poster theme',
    ]);
  });

  it('treats a file where the directory should be as every poster missing, without throwing', () => {
    const filePath = path.join(scratch('not-a-dir'), 'scenes');
    fs.writeFileSync(filePath, 'a file, not a directory');
    const problems = verifyPosterSet(FIXTURE_SCENES, filePath);
    expect(problems).toHaveLength(12);
    expect(problems.every((problem) => problem.startsWith('missing '))).toBe(true);
  });
});

describe('readBuildScenes', () => {
  function writeBuild(dir: string, scenesJson: unknown, packageVersion: string): { distDir: string; packageJsonPath: string } {
    const distDir = path.join(dir, 'demo');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(distDir, 'scenes.json'), JSON.stringify(scenesJson));
    const packageJsonPath = path.join(dir, 'package.json');
    fs.writeFileSync(packageJsonPath, JSON.stringify({ version: packageVersion }));
    return { distDir, packageJsonPath };
  }

  it('returns the build manifest when its version is package.json\'s', () => {
    const build = writeBuild(scratch('build-fresh'), FIXTURE_SCENES, '0.43.0');
    expect(readBuildScenes(build)).toEqual(FIXTURE_SCENES);
  });

  it('refuses a missing build, naming the build command', () => {
    const packageJsonPath = path.join(scratch('build-absent'), 'package.json');
    fs.writeFileSync(packageJsonPath, JSON.stringify({ version: '0.43.0' }));
    expect(() => readBuildScenes({ distDir: path.join(tempRoot, 'build-absent', 'demo'), packageJsonPath }))
      .toThrow(/No web build at .*Run "npm run build:demo" first/);
  });

  it('refuses a stale build, naming both versions', () => {
    const build = writeBuild(scratch('build-stale'), FIXTURE_SCENES, '0.44.0');
    expect(() => readBuildScenes(build)).toThrow(/is version 0\.43\.0 but package\.json is 0\.44\.0: the build is stale/);
  });

  it('refuses a scenes.json that is not a demo build manifest', () => {
    const build = writeBuild(scratch('build-foreign'), { version: '0.43.0', scenes: [] }, '0.43.0');
    expect(() => readBuildScenes(build)).toThrow(/carries no frame size/);
  });

  it('refuses a scenes.json carrying no version string', () => {
    const build = writeBuild(
      scratch('build-no-version'),
      { version: '', frame: { width: 1600, height: 1000 }, scenes: [{ name: 'board' }] },
      '0.43.0',
    );
    expect(() => readBuildScenes(build)).toThrow(/carries no version string/);
  });

  it('refuses a scenes.json listing no named scenes', () => {
    const build = writeBuild(
      scratch('build-no-scenes'),
      { version: '0.43.0', frame: { width: 1600, height: 1000 }, scenes: [] },
      '0.43.0',
    );
    expect(() => readBuildScenes(build)).toThrow(/lists no named scenes/);
  });

  it('refuses a scenes.json that is not valid JSON, naming the file', () => {
    const build = writeBuild(scratch('build-invalid-json'), FIXTURE_SCENES, '0.43.0');
    fs.writeFileSync(path.join(build.distDir, 'scenes.json'), '{ "version": "0.43.0",');
    expect(() => readBuildScenes(build)).toThrow(/scenes\.json is not valid JSON/);
  });
});

describe('packPosterSet', () => {
  it('zips the manifest first and every poster after it, in manifest order, byte for byte, with no sidecars', () => {
    const shotsDir = scratch('pack');
    writeCompleteSet(shotsDir);
    const unzipped = unzipSync(packPosterSet(FIXTURE_SCENES, shotsDir));
    expect(Object.keys(unzipped)).toEqual([
      'manifest.json',
      'board.clay.frame.png',
      'board.rust.frame.png',
      'card-drag.clay.frame.png',
      'card-drag.rust.frame.png',
      'settings-general.clay.frame.png',
      'settings-general.rust.frame.png',
    ]);
    const manifest = JSON.parse(strFromU8(unzipped['manifest.json']));
    expect(manifest).toEqual(buildPosterManifest(FIXTURE_SCENES, FIXTURE_FOCUS));
    expect(manifest.focus[FOCUS_SCENE].clay).toEqual(FOCUS_RECT);
    expect(manifest.focus.board.clay).toBeNull();
    expect(Buffer.from(unzipped['board.clay.frame.png'])).toEqual(pngFile(3200, 2000));
  });

  /**
   * unzipSync hides the compression method each entry actually used, so this walks the zip's own
   * local file headers to pin it: a poster is a still image already deflated inside its own PNG
   * stream, so packPosterSet stores it (method 0) rather than paying to deflate it again, while
   * manifest.json, a few hundred bytes of JSON, is worth deflating (method 8).
   */
  it('stores every poster uncompressed while deflating the manifest', () => {
    const shotsDir = scratch('pack-compression');
    writeCompleteSet(shotsDir);
    const zipBytes = packPosterSet(FIXTURE_SCENES, shotsDir);
    const zipBuffer = Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
    const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
    const methodByName: Record<string, number> = {};
    let offset = 0;
    while (offset < zipBuffer.length && zipBuffer.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIGNATURE) {
      const compressionMethod = zipBuffer.readUInt16LE(offset + 8);
      const compressedSize = zipBuffer.readUInt32LE(offset + 18);
      const nameLength = zipBuffer.readUInt16LE(offset + 26);
      const extraLength = zipBuffer.readUInt16LE(offset + 28);
      const name = zipBuffer.toString('utf8', offset + 30, offset + 30 + nameLength);
      methodByName[name] = compressionMethod;
      offset += 30 + nameLength + extraLength + compressedSize;
    }
    expect(Object.keys(methodByName)).toEqual(['manifest.json', ...expectedPosters(FIXTURE_SCENES).map((poster) => poster.file)]);
    expect(methodByName['manifest.json']).toBe(8);
    for (const poster of expectedPosters(FIXTURE_SCENES)) {
      expect(methodByName[poster.file]).toBe(0);
    }
  });
});

// The .mjs cannot import the rig's TypeScript, so the constants it mirrors are pinned here: the
// resolution name is the file suffix the rig writes, the scale is what makes the size check mean
// "the frame at 2x", and the theme pair has to be on the list the rig validates CAPTURE_THEMES
// against or every poster run fails at the rig's own guard.
describe('the packer agrees with the rig', () => {
  it('shoots at the rig resolution the site frame is authored at', () => {
    expect(POSTER_RESOLUTION).toBe(frame.name);
    expect(POSTER_SCALE).toBe(frame.scale);
    expect(posterPixelSize({ frame: frame.viewport })).toEqual({
      width: frame.viewport.width * frame.scale,
      height: frame.viewport.height * frame.scale,
    });
  });

  it('asks the rig only for themes it validates', () => {
    for (const theme of POSTER_THEMES) expect(SCENE_THEMES).toContain(theme);
  });

  it('names files the way the rig writes them, into the directory the rig chooses', () => {
    const rigSource = fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/features/scenes.capture.ts'), 'utf8');
    expect(rigSource).toContain('`${name}.${theme}.${resolution.name}.png`');
    expect(rigSource).toContain('`${name}.${theme}.${resolution.name}.focus.json`');
    expect(rigSource).toContain("getOutputDir('scenes')");
    // The rig measures through demo/boot.js's own function, so a poster's rect is the live frame's.
    expect(rigSource).toContain('__demoBoot.focusRectOf(');
    const bootSource = fs.readFileSync(path.join(REPO_ROOT, 'demo/boot.js'), 'utf8');
    expect(bootSource).toContain('focusRectOf: rectOf');
    const commandSource = fs.readFileSync(path.join(REPO_ROOT, 'demo/posters.mjs'), 'utf8');
    expect(commandSource).toContain('CAPTURE_OUTPUT_ROOT');
    // The shots directory is the output root plus the rig's feature name, whatever the root is called.
    expect(commandSource).toMatch(/path\.join\(\w+, 'scenes'\)/);
    // A literal with forward slashes, never path.join: Playwright reads the file argument as a
    // regex, and a Windows backslash path is the escape `\c`, which matched nothing.
    expect(commandSource).toContain("'tests/captures/features/scenes.capture.ts'");
  });

  it('refuses to write a null sidecar for a scene whose named focus measured nothing', () => {
    // verifyPosterSet accepts a null focus for any scene, since it cannot know which scenes
    // name one. The rig's throw here is the only thing that keeps a named-but-missing focus
    // out of the poster manifest instead of shipping as a silent null.
    const rigSource = fs.readFileSync(path.join(REPO_ROOT, 'tests/captures/features/scenes.capture.ts'), 'utf8');
    expect(rigSource).toContain('which measured no on-screen element');
  });

  it('is what npm run demo:posters runs', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(packageJson.scripts['demo:posters']).toBe('node demo/posters.mjs');
  });

  it('finds the Playwright CLI it spawns', () => {
    const cli = resolvePlaywrightCli();
    expect(path.basename(cli)).toBe('cli.js');
    expect(fs.existsSync(cli)).toBe(true);
  });

  // CAPTURES_ROOT is computed once at module load, so a test has to reset the module registry
  // between stubs to see it recomputed. Scoped afterEach keeps the stub from leaking into
  // sibling tests in this describe.
  describe('CAPTURES_ROOT resolution', () => {
    let scratchDir: string;

    beforeAll(() => {
      scratchDir = scratch('capture-output-root');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      delete process.env.CAPTURE_OUTPUT_ROOT;
      vi.resetModules();
    });

    it('resolves CAPTURES_ROOT from CAPTURE_OUTPUT_ROOT when it is set', async () => {
      vi.stubEnv('CAPTURE_OUTPUT_ROOT', scratchDir);
      vi.resetModules();
      const outputDir = await import('../../tests/captures/helpers/output-dir');
      expect(outputDir.CAPTURES_ROOT).toBe(path.resolve(scratchDir));
    });

    it('resolves a relative CAPTURE_OUTPUT_ROOT against process.cwd()', async () => {
      vi.stubEnv('CAPTURE_OUTPUT_ROOT', 'some/relative');
      vi.resetModules();
      const outputDir = await import('../../tests/captures/helpers/output-dir');
      expect(outputDir.CAPTURES_ROOT).toBe(path.resolve('some/relative'));
    });

    it('falls back to a timestamped captures directory when CAPTURE_OUTPUT_ROOT is unset', async () => {
      delete process.env.CAPTURE_OUTPUT_ROOT;
      vi.resetModules();
      const outputDir = await import('../../tests/captures/helpers/output-dir');
      expect(outputDir.CAPTURES_ROOT).toMatch(/captures[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/);
      expect(outputDir.CAPTURES_ROOT).not.toBe(path.resolve(scratchDir));
    });
  });

  // The rig refuses a CAPTURE_THEMES name SCENE_THEMES does not carry "rather than shooting the
  // page's error card" (the rig's own header comment). That guard runs at module load, so
  // importing the file with each env value set is what actually exercises it, rather than
  // re-stating the `.includes` check as a second copy of the same logic.
  describe('CAPTURE_THEMES validation (scenes.capture.ts)', () => {
    let scratchDir: string;

    beforeAll(() => {
      scratchDir = scratch('capture-themes-validation');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      delete process.env.CAPTURE_OUTPUT_ROOT;
      delete process.env.CAPTURE_THEMES;
      vi.resetModules();
    });

    it('refuses a CAPTURE_THEMES name the registry does not know, naming the known list', async () => {
      vi.stubEnv('CAPTURE_OUTPUT_ROOT', scratchDir);
      vi.stubEnv('CAPTURE_THEMES', 'not-a-real-theme');
      vi.resetModules();
      await expect(import('../../tests/captures/features/scenes.capture')).rejects.toThrow(
        `CAPTURE_THEMES names "not-a-real-theme"; known: ${SCENE_THEMES.join(', ')}`,
      );
    });

    it('does not refuse a theme the registry knows, the poster themes clay and rust included', async () => {
      for (const theme of SCENE_THEMES) {
        vi.stubEnv('CAPTURE_OUTPUT_ROOT', scratchDir);
        vi.stubEnv('CAPTURE_THEMES', theme);
        vi.resetModules();
        await expect(import('../../tests/captures/features/scenes.capture')).resolves.toBeDefined();
      }
    });
  });
});

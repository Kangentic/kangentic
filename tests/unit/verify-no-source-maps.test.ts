/**
 * The packaged source map gate (build/verify-no-source-maps.js), against real asars
 * written with `@electron/asar`, and the electron-builder.yml lines that keep it honest:
 * the `.map` exclusion, which nothing else pins, and the `afterPack` hook that runs the
 * gate at all. What is lost if these go: a release that ships its sources in every
 * installer with every job green, or a gate that quietly stopped running.
 *
 * Tier: Unit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPackageWithOptions } from '@electron/asar';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyNoSourceMaps } from '../../build/verify-no-source-maps.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDir(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-no-source-maps-'));
  temporaryDirs.push(directory);
  return directory;
}

/** Packs `files` (paths relative to the app root, `null` for a directory) into a real
 *  asar. `unpack` is an asar glob, the same mechanism behind electron-builder's `asarUnpack`. */
async function packAsar(files: Record<string, string | null>, unpack?: string): Promise<string> {
  const appDir = temporaryDir();
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(appDir, relativePath);
    if (contents === null) {
      fs.mkdirSync(filePath, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
    }
  }
  const asarPath = path.join(temporaryDir(), 'app.asar');
  await createPackageWithOptions(appDir, asarPath, unpack ? { unpack } : {});
  return asarPath;
}

const MAIN_BUNDLE = { '.vite/build/index.js': 'bundle' };

describe('verifyNoSourceMaps', () => {
  it('passes a clean package and says how much it checked', async () => {
    const asarPath = await packAsar({ ...MAIN_BUNDLE, 'package.json': '{}' });
    const log = vi.fn();

    verifyNoSourceMaps({ asarPath, log });

    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no source maps in the package \(\d+ asar entries checked\)/));
  });

  it('fails on a map packed in the asar, and names it', async () => {
    const asarPath = await packAsar({ ...MAIN_BUNDLE, '.vite/build/index.js.map': '{}' });

    // The count as well as the path: an asar lookup that failed would name the path too.
    expect(() => verifyNoSourceMaps({ asarPath, log: vi.fn() })).toThrow(/1 source map file\(s\) in the package[^]*\.vite\/build\/index\.js\.map/);
  });

  it('fails on a map that is unpacked, which the same listing covers', async () => {
    const asarPath = await packAsar({ ...MAIN_BUNDLE, 'node_modules/sharp/lib/index.js.map': '{}' }, '*.map');

    expect(fs.existsSync(`${asarPath}.unpacked`)).toBe(true);
    expect(() => verifyNoSourceMaps({ asarPath, log: vi.fn() })).toThrow(/1 source map file\(s\) in the package[^]*node_modules\/sharp\/lib\/index\.js\.map/);
  });

  it('caps the listing at 20 maps and counts the rest', async () => {
    const files: Record<string, string | null> = { ...MAIN_BUNDLE };
    const allMaps: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const mapPath = `node_modules/pkg/lib/file-${String(index).padStart(2, '0')}.js.map`;
      files[mapPath] = '{}';
      allMaps.push(mapPath);
    }
    const asarPath = await packAsar(files);

    let message = '';
    try {
      verifyNoSourceMaps({ asarPath, log: vi.fn() });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('21 source map file(s)');
    // The asar listing order is not the insertion order, so find the omitted one by what is listed.
    const listed = allMaps.filter((mapPath) => message.includes(mapPath));
    expect(listed).toHaveLength(20);
    expect(message).toContain('...and 1 more');
  });

  it('does not take a nested directory named like a map for a file', async () => {
    const asarPath = await packAsar({ ...MAIN_BUNDLE, 'node_modules/some-package/lib/some.map/index.js': 'module' });

    expect(() => verifyNoSourceMaps({ asarPath, log: vi.fn() })).not.toThrow();
  });

  it('refuses a missing asar rather than reading it as clean', () => {
    const asarPath = path.join(temporaryDir(), 'app.asar');

    expect(() => verifyNoSourceMaps({ asarPath, log: vi.fn() })).toThrow(/no app\.asar/);
  });

  it('refuses an asar that does not hold the main bundle, since that listing proves nothing', async () => {
    const asarPath = await packAsar({ 'package.json': '{}' });

    expect(() => verifyNoSourceMaps({ asarPath, log: vi.fn() })).toThrow(/does not list \.vite\/build\/index\.js/);
  });
});

/** The `- entry` strings of electron-builder.yml's top-level `files:` list, comments skipped. */
function readFilesList(yamlSource: string): string[] {
  const match = yamlSource.match(/^files:\n((?:[ \t].*\n|\n)*)/m);
  if (!match) throw new Error('electron-builder.yml: could not find the top-level "files:" list');
  return match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, '$1'));
}

/** The reason this config could ship a `.map`, or null. A later positive pattern can pull
 *  back in what a negation dropped, so the exclusion has to come after every positive one. */
function sourceMapExclusionProblem(yamlSource: string): string | null {
  const files = readFilesList(yamlSource);
  const exclusionIndex = files.lastIndexOf('!**/*.map');
  if (exclusionIndex === -1) return '`files` does not exclude **/*.map';
  const reincluded = files.slice(exclusionIndex + 1).filter((entry) => !entry.startsWith('!'));
  return reincluded.length > 0 ? `\`files\` re-includes ${reincluded.join(', ')} after excluding **/*.map` : null;
}

describe('electron-builder.yml', () => {
  const config = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8').replace(/\r\n/g, '\n');
  const exclusionLine = '  - "!**/*.map"\n';

  it('excludes every source map, after every positive pattern', () => {
    expect(sourceMapExclusionProblem(config)).toBeNull();
  });

  it('runs afterPack, which is the only thing that runs the package gate', () => {
    expect(config).toMatch(/^afterPack: build\/afterPack\.js$/m);
  });

  describe('the check itself reads a broken config as broken', () => {
    it('with the exclusion removed', () => {
      expect(config).toContain(exclusionLine);
      const removed = config.replace(exclusionLine, '');

      expect(sourceMapExclusionProblem(removed)).toMatch(/does not exclude/);
    });

    it('with the exclusion moved ahead of a positive pattern', () => {
      const firstEntry = '  - ".vite/build/**"\n';
      expect(config).toContain(firstEntry);
      const moved = config.replace(exclusionLine, '').replace(firstEntry, exclusionLine + firstEntry);

      expect(sourceMapExclusionProblem(moved)).toMatch(/re-includes/);
    });
  });
});

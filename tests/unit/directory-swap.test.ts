/**
 * swapDirectoryIn puts a freshly cut directory in place of the committed one
 * (scripts/cut-demo-fonts.mjs swaps its cut in for demo/fonts/). If a guard here goes, a refused
 * rename on Windows can delete the only on-disk copy of the committed demo faces.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { swapDirectoryIn } from '../../scripts/lib/directory-swap.mjs';

let rootDir: string;
let stagingDir: string;
let outputDir: string;
let retiredDir: string;

function writeFileIn(directory: string, name: string, content: string): void {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), content);
}

beforeEach(() => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-swap-'));
  stagingDir = path.join(rootDir, 'staging');
  outputDir = path.join(rootDir, 'fonts');
  retiredDir = path.join(rootDir, 'fonts-retired');
});

afterEach(() => {
  fs.rmSync(rootDir, { recursive: true, force: true });
});

describe('swapDirectoryIn', () => {
  it('replaces the output with the staging contents and leaves no retired directory', () => {
    writeFileIn(outputDir, 'old.woff2', 'old');
    writeFileIn(stagingDir, 'new.woff2', 'new');

    swapDirectoryIn({ stagingDir, outputDir, retiredDir });

    expect(fs.readdirSync(outputDir)).toEqual(['new.woff2']);
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(fs.existsSync(retiredDir)).toBe(false);
  });

  it('puts the old contents back when the staging rename is refused', () => {
    writeFileIn(outputDir, 'old.woff2', 'old');

    expect(() => swapDirectoryIn({ stagingDir, outputDir, retiredDir })).toThrow();

    expect(fs.readFileSync(path.join(outputDir, 'old.woff2'), 'utf8')).toBe('old');
    expect(fs.existsSync(retiredDir)).toBe(false);
  });

  it('keeps the old contents in retiredDir and names it when both renames are refused', () => {
    writeFileIn(outputDir, 'old.woff2', 'old');
    writeFileIn(stagingDir, 'new.woff2', 'new');
    let renameCalls = 0;
    const refusingFileSystem = {
      ...fs,
      renameSync(from: fs.PathLike, to: fs.PathLike): void {
        renameCalls += 1;
        if (renameCalls === 1) {
          fs.renameSync(from, to);
          return;
        }
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    };

    expect(() => swapDirectoryIn({ stagingDir, outputDir, retiredDir }, refusingFileSystem)).toThrow(
      new RegExp(retiredDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    expect(fs.readFileSync(path.join(retiredDir, 'old.woff2'), 'utf8')).toBe('old');
  });

  it('changes nothing and names outputDir when the old contents cannot be moved aside', () => {
    writeFileIn(outputDir, 'old.woff2', 'old');
    writeFileIn(stagingDir, 'new.woff2', 'new');
    const refusingFileSystem = {
      ...fs,
      renameSync(): void {
        throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' });
      },
    };

    let thrown: unknown = null;
    try {
      swapDirectoryIn({ stagingDir, outputDir, retiredDir }, refusingFileSystem);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(outputDir);
    expect((thrown as Error).message).toContain('nothing was changed');
    expect(((thrown as Error).cause as { code?: string }).code).toBe('EBUSY');
    expect(fs.readFileSync(path.join(outputDir, 'old.woff2'), 'utf8')).toBe('old');
    expect(fs.readFileSync(path.join(stagingDir, 'new.woff2'), 'utf8')).toBe('new');
  });

  it('keeps the swap and leaves retiredDir for the next run when its removal is refused', () => {
    writeFileIn(outputDir, 'old.woff2', 'old');
    writeFileIn(stagingDir, 'new.woff2', 'new');
    let removeCalls = 0;
    const refusingFileSystem = {
      ...fs,
      rmSync(target: fs.PathLike, options?: fs.RmOptions): void {
        removeCalls += 1;
        if (removeCalls === 1) {
          fs.rmSync(target, options);
          return;
        }
        throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
      },
    };
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message: string) => { warnings.push(message); };
    try {
      expect(() => swapDirectoryIn({ stagingDir, outputDir, retiredDir }, refusingFileSystem)).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }

    expect(fs.readdirSync(outputDir)).toEqual(['new.woff2']);
    expect(fs.readFileSync(path.join(retiredDir, 'old.woff2'), 'utf8')).toBe('old');
    expect(warnings.join('\n')).toContain(retiredDir);

    // The next run clears what this one left.
    writeFileIn(stagingDir, 'newer.woff2', 'newer');
    swapDirectoryIn({ stagingDir, outputDir, retiredDir });
    expect(fs.readdirSync(outputDir)).toEqual(['newer.woff2']);
    expect(fs.existsSync(retiredDir)).toBe(false);
  });

  it('refuses to start when a previous swap left outputDir missing and retiredDir present', () => {
    writeFileIn(retiredDir, 'old.woff2', 'old');
    writeFileIn(stagingDir, 'new.woff2', 'new');

    expect(() => swapDirectoryIn({ stagingDir, outputDir, retiredDir })).toThrow(/previous swap/);

    expect(fs.readFileSync(path.join(retiredDir, 'old.woff2'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(stagingDir, 'new.woff2'))).toBe(true);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it('makes stagingDir the output when there is no outputDir and no retiredDir', () => {
    writeFileIn(stagingDir, 'new.woff2', 'new');

    swapDirectoryIn({ stagingDir, outputDir, retiredDir });

    expect(fs.readdirSync(outputDir)).toEqual(['new.woff2']);
    expect(fs.existsSync(stagingDir)).toBe(false);
    expect(fs.existsSync(retiredDir)).toBe(false);
  });
});

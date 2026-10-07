/**
 * Pins scripts/lib/is-entrypoint.mjs, the guard every review script uses to run its CLI only when
 * node was asked to run that file:
 *
 * 1. The module's own path is the entrypoint, and a different file is not.
 * 2. The comparison is by real path, so a path that reaches the file through a link still matches
 *    (a URL comparison would not, which is the bug the helper exists to fix).
 * 3. When a path cannot be resolved it falls back to comparing URLs, so importing a script from a
 *    test or an odd launcher never throws, and a missing path is simply not the entrypoint.
 * 4. With no process.argv[1] at all (an embedded `node -e` style launch) nothing is an entrypoint.
 *
 * Every test sets process.argv[1] itself and afterEach restores the whole array.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntrypoint } from '../../scripts/lib/is-entrypoint.mjs';

const MODULE_PATH = path.resolve(__dirname, '../../scripts/lib/is-entrypoint.mjs');
const MODULE_URL = pathToFileURL(MODULE_PATH).href;
const originalArgv = [...process.argv];

let tempDirectory: string | null = null;

function makeTempDirectory(): string {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'is-entrypoint-'));
  return tempDirectory;
}

/** Sets process.argv[1] to the value, or removes it when undefined. */
function setEntryArgument(entryArgument: string | undefined): void {
  process.argv.splice(1, process.argv.length - 1);
  if (entryArgument !== undefined) process.argv.push(entryArgument);
}

afterEach(() => {
  process.argv.splice(0, process.argv.length, ...originalArgv);
  if (tempDirectory !== null) {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
    tempDirectory = null;
  }
});

describe('isEntrypoint', () => {
  it('is true when process.argv[1] is the module itself', () => {
    setEntryArgument(MODULE_PATH);

    expect(isEntrypoint(MODULE_URL)).toBe(true);
  });

  it('is true for a relative process.argv[1] that resolves to the module', () => {
    setEntryArgument(path.relative(process.cwd(), MODULE_PATH));

    expect(isEntrypoint(MODULE_URL)).toBe(true);
  });

  it('is false when process.argv[1] is a different existing file', () => {
    const otherFile = path.join(makeTempDirectory(), 'other-script.mjs');
    fs.writeFileSync(otherFile, '// not the module under test\n');
    setEntryArgument(otherFile);

    expect(isEntrypoint(MODULE_URL)).toBe(false);
  });

  it('is true when process.argv[1] reaches the module through a link', (context) => {
    const root = makeTempDirectory();
    const realDirectory = path.join(root, 'real');
    const linkedDirectory = path.join(root, 'linked');
    fs.mkdirSync(realDirectory);
    const realFile = path.join(realDirectory, 'entry.mjs');
    fs.writeFileSync(realFile, '// entry\n');
    try {
      // A junction needs no privilege on Windows, where a plain symlink can be refused.
      fs.symlinkSync(realDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      context.skip();
    }
    setEntryArgument(path.join(linkedDirectory, 'entry.mjs'));

    // The URL a module loaded from the real location reports differs from the linked argument, so
    // only the real-path comparison can call this the entrypoint.
    expect(pathToFileURL(path.join(linkedDirectory, 'entry.mjs')).href).not.toBe(pathToFileURL(realFile).href);
    expect(isEntrypoint(pathToFileURL(realFile).href)).toBe(true);
  });

  it('is false, without throwing, when process.argv[1] does not exist', () => {
    setEntryArgument(path.join(makeTempDirectory(), 'missing-script.mjs'));

    expect(() => isEntrypoint(MODULE_URL)).not.toThrow();
    expect(isEntrypoint(MODULE_URL)).toBe(false);
  });

  it('falls back to a URL comparison when neither path exists', () => {
    const missingFile = path.join(makeTempDirectory(), 'missing-script.mjs');
    setEntryArgument(missingFile);

    expect(isEntrypoint(pathToFileURL(missingFile).href)).toBe(true);
    expect(isEntrypoint(pathToFileURL(path.join(path.dirname(missingFile), 'another-missing.mjs')).href)).toBe(false);
  });

  it('is false when process.argv[1] is undefined', () => {
    setEntryArgument(undefined);

    expect(process.argv[1]).toBeUndefined();
    expect(isEntrypoint(MODULE_URL)).toBe(false);
  });

  it('is false when process.argv[1] is an empty string', () => {
    setEntryArgument('');

    expect(isEntrypoint(MODULE_URL)).toBe(false);
  });
});

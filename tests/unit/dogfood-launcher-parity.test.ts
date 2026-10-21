import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// scripts/dogfood-launcher.ps1 writes a shortcut into the checkout root. The shortcut carries
// that machine's absolute path, so it must never be committable, and the only thing keeping it
// out of git is a hand-written `.gitignore` line that repeats the script's default file name.
// Nothing links the two at compile time, so renaming one silently makes the shortcut stageable
// by `git add -A` (which `/pull-request` runs), and a machine path lands in a public repo.
//
// The script is also read by Windows PowerShell 5.1, which decodes a BOM-less UTF-8 file as the
// ANSI code page. A single non-ASCII character in it is mangled on the machines it exists for.

const REPO_ROOT = path.resolve(__dirname, '../..');
const LAUNCHER_SCRIPT = path.join(REPO_ROOT, 'scripts/dogfood-launcher.ps1');
const GITIGNORE = path.join(REPO_ROOT, '.gitignore');

function read(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

describe('dogfood launcher parity', () => {
  it('the default shortcut name the script writes is ignored by .gitignore, anchored to the root', () => {
    const declared = /Join-Path \$repoRoot '([^']+\.lnk)'/.exec(read(LAUNCHER_SCRIPT));
    expect(declared, 'dogfood-launcher.ps1 no longer builds its default shortcut path from $repoRoot').not.toBeNull();

    const ignoredLines = read(GITIGNORE)
      .split('\n')
      .map((line) => line.trim());
    expect(ignoredLines).toContain(`/${declared?.[1]}`);
  });

  it('the script is plain ASCII, so Windows PowerShell 5.1 reads it intact', () => {
    // eslint-disable-next-line no-control-regex -- the point is to match everything outside 0x00-0x7F
    const nonAscii = [...read(LAUNCHER_SCRIPT)].filter((character) => /[^\x00-\x7F]/.test(character));
    expect(nonAscii).toEqual([]);
  });
});

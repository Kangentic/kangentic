/**
 * Dogfood launcher shortcut / .gitignore parity guard.
 *
 * `scripts/dogfood-launcher.ps1 -CreateShortcut` writes a Windows shortcut to the repo root. The
 * shortcut carries this checkout's absolute path (its WorkingDirectory and its -File argument),
 * so it is machine-specific and must never be committed to this public repo. The only thing that
 * keeps git from picking it up is a root-anchored line in the root .gitignore that names the
 * script's default shortcut file. Nothing else ties the two together. Rename the file in the
 * script, or delete the .gitignore line, and the shortcut becomes an untracked file that a
 * routine `git add` commits.
 *
 * This test derives the default name from the `Join-Path $repoRoot '<name>.lnk'` literal in the
 * script and asserts the root .gitignore has the exact line `/<name>.lnk`. It throws when it
 * cannot find that literal, so a refactor of that line fails loudly instead of passing without
 * checking anything.
 *
 * Tier: Unit. It only reads two text files, so it runs unchanged on the Linux CI runner.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAUNCHER_SCRIPT_RELATIVE_PATH = 'scripts/dogfood-launcher.ps1';

/**
 * Pulls the default shortcut file name out of `$ShortcutPath = Join-Path $repoRoot '<name>.lnk'`.
 * The name is a single-quoted PowerShell literal, so it may contain spaces and parentheses but
 * never a single quote.
 */
function readDefaultShortcutName(): string {
  const scriptSource = fs.readFileSync(path.join(REPO_ROOT, LAUNCHER_SCRIPT_RELATIVE_PATH), 'utf8');
  const match = scriptSource.match(/Join-Path\s+\$repoRoot\s+'([^'\r\n]+\.lnk)'/);
  if (match === null) {
    throw new Error(
      `${LAUNCHER_SCRIPT_RELATIVE_PATH}: could not find the default shortcut literal ` +
        "`Join-Path $repoRoot '<name>.lnk'`. This test derives the name from that line so the " +
        'root .gitignore can be checked against it. If the line was refactored, update the regex ' +
        'in tests/unit/dogfood-launcher-gitignore-parity.test.ts to match the new shape.',
    );
  }
  return match[1];
}

/** Root .gitignore lines. Split on CRLF too, because a Windows checkout may use it. */
function readRootGitignoreLines(): string[] {
  const gitignoreSource = fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8');
  return gitignoreSource.split(/\r?\n/);
}

describe('dogfood launcher shortcut is gitignored', () => {
  it('names a plain file in the repo root, not a path', () => {
    const shortcutName = readDefaultShortcutName();
    expect(shortcutName).not.toMatch(/[\\/]/);
  });

  it('has a root-anchored .gitignore line for the default shortcut name', () => {
    const shortcutName = readDefaultShortcutName();
    const expectedIgnoreLine = `/${shortcutName}`;

    expect(
      readRootGitignoreLines(),
      `.gitignore must contain the exact line "${expectedIgnoreLine}". ` +
        `${LAUNCHER_SCRIPT_RELATIVE_PATH} writes that file to the repo root with this ` +
        "checkout's absolute path inside it, and an unignored copy could be committed to a public repo.",
    ).toContain(expectedIgnoreLine);
  });
});

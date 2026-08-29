/**
 * Unit coverage for scripts/build-review-pack.mjs, the /code-review shared-pack builder.
 *
 * Nothing exercised this script before: no test anywhere ran it end to end, yet other
 * agents in the review fan-out literally size their `Read` offset/limit calls off the
 * "Total lines: N" header it writes at the top of .kangentic/REVIEW_PACK.tmp.md. An
 * undercounted header truncates a downstream agent's last read silently.
 *
 * The script has no exports (it is a standalone node ESM CLI), so this drives it end to
 * end against a throwaway git repository created under os.tmpdir() and inspects the pack
 * file it writes. Never point it at this checkout's own repo root: doing so would
 * overwrite .kangentic/REVIEW_PREEXISTING_DIRTY.tmp, which an in-flight review pass may
 * depend on.
 *
 * Two behaviors are pinned:
 *
 * 1. The "Total lines: N" header always matches the pack file's actual line count,
 *    including the trailing "## Not included (read on demand)" section that appears
 *    whenever a changed file is omitted (oversized, binary, or over the pack byte cap).
 *    Before the fix, N was derived from the table-of-contents cursor arithmetic, which
 *    stopped advancing once the packed sections ended and never accounted for the
 *    omitted-files block - undercounting by 1 + omittedCount whenever anything was
 *    omitted.
 *
 * 2. parseNumstat resolves git's rename notation ("old => new") to the new path via
 *    resolveNumstatPath, so a renamed-and-modified committed file is ranked by its true
 *    churn instead of silently scoring 0 (its raw numstat key never matches a real path,
 *    so an unresolved lookup always misses).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/build-review-pack.mjs');
const SINGLE_FILE_CAP_BYTES = 1024 * 1024;

let repoDirectory: string;

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commitAll(cwd: string, message: string): void {
  runGit(['add', '-A'], cwd);
  runGit(
    ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-q', '-m', message],
    cwd,
  );
}

function runBuildScript(cwd: string, args: string[] = []): string {
  try {
    return execFileSync('node', [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message: string };
    throw new Error(
      `build-review-pack.mjs failed.\nstdout: ${execError.stdout ?? ''}\nstderr: ${execError.stderr ?? ''}\n${execError.message}`,
    );
  }
}

beforeEach(() => {
  repoDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-review-pack-'));
  runGit(['init', '-q'], repoDirectory);
  // Faithful to a real project's .kangentic/: gitignored, so it never shows up as an
  // "untracked" changed file that the script would try to pack.
  fs.writeFileSync(path.join(repoDirectory, '.gitignore'), '.kangentic/\n');
});

afterEach(() => {
  fs.rmSync(repoDirectory, { recursive: true, force: true });
});

describe('build-review-pack.mjs', () => {
  it(
    '"Total lines" header matches the actual pack length, including an omitted-files section',
    () => {
      fs.writeFileSync(path.join(repoDirectory, 'tracked.txt'), 'line one\nline two\n');
      commitAll(repoDirectory, 'base commit');

      // An uncommitted edit so the union diff and a packed body section are non-empty -
      // otherwise this fixture would only exercise a near-empty pack and barely traverse
      // the table-of-contents cursor arithmetic the fix replaced.
      fs.writeFileSync(
        path.join(repoDirectory, 'tracked.txt'),
        'line one\nline two\nline three (uncommitted)\n',
      );

      // An untracked file over SINGLE_FILE_CAP_BYTES lands in "Not included" with reason
      // 'binary, missing, or >1MB' - the section whose lines the buggy cursor arithmetic
      // never counted.
      fs.writeFileSync(
        path.join(repoDirectory, 'oversized.txt'),
        'x'.repeat(SINGLE_FILE_CAP_BYTES + 1024),
      );

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      // Non-vacuity guards: if either of these two sections failed to appear, the header
      // check below would trivially pass no matter what the header derivation did.
      expect(packContent).toContain('## Full file: tracked.txt');
      expect(packContent).toContain('## Not included (read on demand)');
      expect(packContent).toContain('oversized.txt');

      const headerMatch = packContent.match(/^Total lines: (\d+)\./);
      expect(headerMatch).not.toBeNull();
      const headerTotal = Number(headerMatch![1]);
      const actualTotal = packContent.split('\n').length;

      expect(headerTotal).toBe(actualTotal);
    },
    20000,
  );

  it(
    'resolves a renamed-and-modified committed file to its true churn, ranking it above a barely-touched file',
    () => {
      // Rename detection is similarity-based and off below git's default 50% threshold;
      // pin it explicitly rather than depend on the fixture's ambient config.
      runGit(['config', 'diff.renames', 'true'], repoDirectory);

      const baseLines = Array.from({ length: 100 }, (_, index) => `heavy line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'aaa-original.txt'), baseLines.join('\n') + '\n');
      fs.writeFileSync(path.join(repoDirectory, 'zzz-trivial.txt'), 'kept one\nkept two\n');
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      runGit(['mv', 'aaa-original.txt', 'mmm-renamed.txt'], repoDirectory);
      const appendedLines = baseLines.concat(
        Array.from({ length: 12 }, (_, index) => `appended line ${index}`),
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'mmm-renamed.txt'),
        appendedLines.join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'zzz-trivial.txt'),
        'kept one\nkept two\nappended trivial line\n',
      );
      commitAll(repoDirectory, 'rename and heavily edit one file, trivially edit another');

      // Precondition guard: confirms git actually emitted rename notation for this
      // fixture, so a pass below reflects resolveNumstatPath and not an unrelated
      // ranking coincidence (e.g. rename detection silently not firing on some machine).
      const numstatOutput = runGit(['diff', `${baseRef}...HEAD`, '--numstat'], repoDirectory);
      expect(numstatOutput).toContain(' => ');

      runBuildScript(repoDirectory, [baseRef]);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');
      const contentsBlock = packContent
        .split('## Contents (start line)')[1]
        .split('## Union diff')[0];

      const renamedIndex = contentsBlock.indexOf('mmm-renamed.txt');
      const trivialIndex = contentsBlock.indexOf('zzz-trivial.txt');
      expect(renamedIndex).toBeGreaterThan(-1);
      expect(trivialIndex).toBeGreaterThan(-1);

      // Largest churn first: the renamed file's 12 appended lines must outrank the
      // trivial file's 1-line edit, which only holds once its churn resolves under its
      // new path rather than the unresolved "old => new" numstat key.
      expect(renamedIndex).toBeLessThan(trivialIndex);
    },
    20000,
  );
});

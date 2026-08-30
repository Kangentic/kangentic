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
 * Four behaviors are pinned:
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
 *
 * 3. Every "- line N: <label>" table-of-contents entry points at the exact line where its
 *    own section heading ("## Union diff" or "## Full file: <path>") starts. This bit
 *    during development: the diff heading's own line was uncounted in the cursor
 *    arithmetic, sending every TOC entry to a blank line instead of its heading, and the
 *    only reason it was caught was manual verification, not a test.
 *
 * 4. A file that pushes the packed bodies over PACK_BODY_CAP_BYTES (200KB) is omitted from
 *    "## Full file" bodies with reason "over pack cap", but its diff hunk stays in the
 *    union diff (the byte cap only trims full-body packing, never the diff itself) - and
 *    the TOC/header-total contract from (1) and (3) still holds for a pack shaped this way
 *    (an omitted file contributes no TOC entry and does not perturb the header block).
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

interface TocEntry {
  lineNumber: number;
  label: string;
}

function extractTocEntries(packContent: string): TocEntry[] {
  const contentsBlock = packContent
    .split('## Contents (start line)')[1]
    .split('## Union diff')[0];
  const entryPattern = /^- line (\d+): (.+)$/gm;
  const entries: TocEntry[] = [];
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(contentsBlock)) !== null) {
    entries.push({ lineNumber: Number(match[1]), label: match[2].trim() });
  }
  return entries;
}

// Shared by the TOC-accuracy test and the pack-cap test: both need to confirm every TOC
// entry's claimed line number is exactly where its section heading starts, and that the
// "Total lines" header matches the pack's real length. Running it against two differently
// shaped packs (committed+uncommitted vs. uncommitted-only-with-an-omission) is deliberate,
// not duplication - see behavior 4's comment above.
function assertTocLineAccuracyAndHeaderTotal(packContent: string): TocEntry[] {
  const packLines = packContent.split('\n');
  const entries = extractTocEntries(packContent);
  // Guards the helper itself, not just today's two callers: with zero entries the loop
  // below is vacuously true and the header check alone passes on any pack, so a future
  // caller that forgets its own non-vacuity assertion would still get real coverage here.
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const expectedPrefix =
      entry.label === 'Union diff' ? '## Union diff' : `## Full file: ${entry.label}`;
    // Compare the actual line's leading text against the expected prefix (rather than a
    // boolean startsWith assertion) so a failure prints the real line - for the historical
    // off-by-one bug that line is the empty string, which is immediately diagnostic.
    const actualPrefix = packLines[entry.lineNumber - 1].slice(0, expectedPrefix.length);
    expect(actualPrefix).toBe(expectedPrefix);
  }

  const headerMatch = packContent.match(/^Total lines: (\d+)\./);
  expect(headerMatch).not.toBeNull();
  expect(Number(headerMatch![1])).toBe(packLines.length);

  return entries;
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

  it(
    'every TOC entry line number points at the exact line where its own section heading starts',
    () => {
      // Two changed tracked files are load-bearing, not incidental: the TOC cursor advances
      // by two independent formulas - "1 + diffLines.length + 1" for the union-diff entry,
      // and "1 + section.lines + 1" for each packed-file entry. A single changed file would
      // only ever exercise the first formula (there would be nothing after it to mis-cursor
      // into); beta.txt's entry is the only assertion below that can catch a regression to
      // the per-section increment, so do not simplify this fixture to one file.
      fs.writeFileSync(path.join(repoDirectory, 'alpha.txt'), 'alpha one\nalpha two\nalpha three\n');
      fs.writeFileSync(path.join(repoDirectory, 'beta.txt'), 'beta one\nbeta two\n');
      commitAll(repoDirectory, 'base commit');

      fs.writeFileSync(
        path.join(repoDirectory, 'alpha.txt'),
        'alpha one\nalpha two\nalpha three\nalpha four (uncommitted)\n',
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'beta.txt'),
        'beta one\nbeta two\nbeta three (uncommitted)\n',
      );

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      const entries = assertTocLineAccuracyAndHeaderTotal(packContent);

      // Non-vacuity guard: if fewer than 3 entries parsed (union diff + two file sections),
      // the loop inside the helper would have exercised too little of the cursor arithmetic
      // to catch the historical bug (every entry landing on a blank line).
      expect(entries.map((entry) => entry.label).sort()).toEqual(
        ['Union diff', 'alpha.txt', 'beta.txt'].sort(),
      );
    },
    20000,
  );

  it(
    'a file over the 200KB pack-body cap is omitted from Full file bodies but keeps its diff hunk in the union diff',
    () => {
      fs.writeFileSync(path.join(repoDirectory, 'small.txt'), 'small one\n');
      // 7000 fixed-length lines land the numbered body around 356KB: comfortably over
      // PACK_BODY_CAP_BYTES (200KB) on its own, so the omission cannot depend on
      // churn-ranking order, and comfortably under SINGLE_FILE_CAP_BYTES (1MB) so
      // readFileSafe still returns a body instead of tripping the OTHER cap the first test
      // in this file already covers.
      const bigLines = Array.from({ length: 7000 }, () => 'x'.repeat(45));
      fs.writeFileSync(path.join(repoDirectory, 'big.txt'), bigLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      fs.writeFileSync(
        path.join(repoDirectory, 'small.txt'),
        'small one\nsmall two (uncommitted)\n',
      );
      fs.appendFileSync(path.join(repoDirectory, 'big.txt'), 'appended heavy line (uncommitted)\n');

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      expect(packContent).toContain('## Full file: small.txt');
      expect(packContent).not.toContain('## Full file: big.txt');
      expect(packContent).toContain('## Not included (read on demand)');
      expect(packContent).toMatch(/- big\.txt \(churn \d+; over pack cap\)/);

      // The pack-body cap only trims the full-file-bodies section; the union diff is built
      // straight from git diff output and is unaffected, so the omitted file's hunk must
      // still be readable.
      expect(packContent).toContain('diff --git a/big.txt b/big.txt');
      expect(packContent).toContain('+appended heavy line (uncommitted)');

      // Same line-accuracy + header-total check as the previous test, run against a pack
      // shaped differently (one packed section, an omitted-files block, no committed-diff
      // layer) to pin that an omitted file contributes no TOC entry and does not perturb
      // the header block that precedes "## Union diff".
      const entries = assertTocLineAccuracyAndHeaderTotal(packContent);
      expect(entries.map((entry) => entry.label)).toEqual(['Union diff', 'small.txt']);
    },
    20000,
  );
});

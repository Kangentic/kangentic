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
 *    own section heading ("## Union diff", or a "## Full file: <path>" / "## Partial file:
 *    <path>" body heading) starts. A windowed section is the harder case: its rendered
 *    length is the shown lines plus one line per elision marker, not the file's line
 *    count, so the cursor must advance by what was written. This bit
 *    during development: the diff heading's own line was uncounted in the cursor
 *    arithmetic, sending every TOC entry to a blank line instead of its heading, and the
 *    only reason it was caught was manual verification, not a test.
 *
 * 4. A file that pushes the packed bodies over PACK_BODY_CAP_BYTES (200KB) is omitted from
 *    the packed bodies with reason "full body over pack cap", but its diff hunk stays in the
 *    union diff (the byte cap only trims full-body packing, never the diff itself) - and
 *    the TOC/header-total contract from (1) and (3) still holds for a pack shaped this way
 *    (an omitted file contributes no TOC entry and does not perturb the header block).
 *
 * 5. The stdout "  paths: " line carries every changed file across all three layers
 *    (committed-vs-base, uncommitted, untracked), INCLUDING one trimmed by the 200KB cap,
 *    and is distinct from the "  changed files: " count line above it. This is the line
 *    /code-review's SKILL.md tells the driver to read for `changedFiles`, and the reason it
 *    exists at all: the pack's TOC lists only files whose body was packed, so deriving the
 *    list from the TOC silently drops a cap-trimmed file and un-gates a domain auditor whose
 *    glob it matched.
 *
 * 6. The script exits 0 on both the empty-diff and non-empty-diff paths, so only the
 *    literal "NO CHANGES:" stdout prefix (never the exit status) tells a caller which case
 *    it hit - and on that path neither REVIEW_PACK.tmp.md nor REVIEW_PREEXISTING_DIRTY.tmp
 *    is written at all.
 *
 * 7. Two context-expanded windows within WINDOW_MERGE_GAP_LINES (5) of each other merge into
 *    one contiguous window with no elision marker between them, rather than staying separate
 *    and paying an extra marker line for a gap that small.
 *
 * 8. A pure-deletion hunk ("@@ -a,b +N,0 @@", nothing on the new side) anchors its window at
 *    the collapse point N rather than the general start/end formula, which would invert to
 *    [N, N - 1] for a zero-length hunk - a silent one-line-short window (the trailing context
 *    stops at N + WINDOW_CONTEXT_LINES - 1 instead of N + WINDOW_CONTEXT_LINES) rather than a
 *    loud failure, because the context expansion on both sides rescues the inverted range from
 *    the later end >= start filter for any realistically sized file.
 *
 * 9. Window context is clamped at both file boundaries: an edit within WINDOW_CONTEXT_LINES
 *    (20) of line 1 or of the file's last line never reads past either end of the lines array.
 *
 * 10. Every elision marker's own arithmetic, not just its textual shape, is correct: the
 *     reported skip count equals its range's line span, and the range itself abuts the shown
 *     line numbers immediately surrounding it (or the file's first/last line at a boundary).
 *
 * Investigated and confirmed unreachable: a defensive try/catch in the script wraps
 * `git merge-base` and the `--unified=0` diff it feeds windowing from, intending to fall back
 * to packing every body in full if either fails (e.g. baseRef and HEAD share no history).
 * There is no such baseRef, however, that does not ALSO crash the script's earlier, unguarded
 * `gitDiff(baseRef + '...HEAD')` calls first (confirmed against unrelated histories, an orphan
 * branch, and a shallow clone missing the common ancestor - all fail identically before
 * windowing code ever runs). Those earlier calls predate this diff and are out of scope here;
 * left as a follow-up rather than a test that would need to assert against the crash.
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
  // Identity AND signing are overridden for the same reason: the fixture repo must not inherit
  // the developer's or the runner's ambient git config. A global commit.gpgsign=true would make
  // every commit here try to sign, which fails outright in a non-interactive test run with no
  // key or no GPG_TTY - green on one machine, red on another.
  runGit(
    [
      '-c',
      'user.email=dev@example.com',
      '-c',
      'user.name=Dev',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      message,
    ],
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

// Parses the one stdout line SKILL.md tells the review driver to read for `changedFiles`.
// Deliberately strict about the "  paths: " prefix rather than searching for a bare "paths":
// the summary block prints a "  changed files: " count line directly above, and the whole point
// of the separate label is that a driver can tell the two apart without ambiguity. Returns
// undefined when the line is absent so a caller can assert on its presence rather than silently
// reconstructing an empty list.
const PATHS_LINE_PREFIX = '  paths: ';
function parsePathsLine(buildOutput: string): string[] | undefined {
  const pathsLine = buildOutput
    .split('\n')
    .find((line) => line.startsWith(PATHS_LINE_PREFIX));
  if (pathsLine === undefined) return undefined;
  return pathsLine.slice(PATHS_LINE_PREFIX.length).trim().split(', ');
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
    // A body is packed either in full or as windows around its changed hunks, so a section
    // heading is "## Full file:" or "## Partial file:". Both are accepted here; which one a
    // given file gets is pinned by the windowing tests, not by the cursor arithmetic. The
    // cursor bug this helper guards is identical either way, and a windowed section is the
    // harder case for it: its rendered length is the shown lines PLUS one line per elision
    // marker, not the file's line count.
    const expectedPrefix =
      entry.label === 'Union diff'
        ? '## Union diff'
        : packLines[entry.lineNumber - 1].startsWith('## Partial file: ')
          ? `## Partial file: ${entry.label}`
          : `## Full file: ${entry.label}`;
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

interface WindowedSectionToken {
  kind: 'line' | 'marker';
  lineNumber?: number;
  skippedCount?: number;
  rangeStart?: number;
  rangeEnd?: number;
}

// Walks a windowed section's rendered text (heading remainder plus body) into an ordered list
// of its two possible line shapes: a numbered content line, or an elision marker. Order is
// preserved because assertElisionMarkerArithmetic needs each marker's nearest neighboring
// content lines on both sides, not just the marker text in isolation.
function tokenizeWindowedSection(sectionText: string): WindowedSectionToken[] {
  const tokens: WindowedSectionToken[] = [];
  for (const renderedLine of sectionText.split('\n')) {
    const numberedLineMatch = renderedLine.match(/^\s*(\d+)\t/);
    if (numberedLineMatch) {
      tokens.push({ kind: 'line', lineNumber: Number(numberedLineMatch[1]) });
      continue;
    }
    const markerMatch = renderedLine.match(
      /^ {6}\.{5} (\d+) unchanged lines omitted \((\d+)-(\d+)\) \.{5}$/,
    );
    if (markerMatch) {
      tokens.push({
        kind: 'marker',
        skippedCount: Number(markerMatch[1]),
        rangeStart: Number(markerMatch[2]),
        rangeEnd: Number(markerMatch[3]),
      });
    }
  }
  return tokens;
}

// Cross-checks every elision marker's arithmetic against its neighbors, not just its textual
// shape. An off-by-one in `skipped = start - previousEnd - 1` (e.g. dropping the "- 1") would
// still produce a well-formed "..... N unchanged lines omitted (a-b) ....." line that every
// shape-only regex in this file would accept, so this checks the numbers themselves:
//   - N (the reported skip count) always equals b - a + 1.
//   - a is exactly one more than the nearest shown line number BEFORE the marker, or 1 if the
//     marker is the section's first rendered line (nothing shown before it).
//   - b is exactly one less than the nearest shown line number AFTER the marker, or the file's
//     total line count if the marker is the section's last rendered line (nothing shown after
//     it).
function assertElisionMarkerArithmetic(sectionText: string): void {
  const totalLinesMatch = sectionText.match(/\((\d+) lines total/);
  expect(totalLinesMatch).not.toBeNull();
  const totalLines = Number(totalLinesMatch![1]);

  const tokens = tokenizeWindowedSection(sectionText);
  const markerTokens = tokens.filter((token) => token.kind === 'marker');
  // Non-vacuity guard: a section with no markers would make every assertion below vacuously
  // true, so a caller that forgot to fixture an omission would still show green here.
  expect(markerTokens.length).toBeGreaterThan(0);

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.kind !== 'marker') continue;

    expect(token.skippedCount).toBe(token.rangeEnd! - token.rangeStart! + 1);

    const previousLineToken = tokens
      .slice(0, tokenIndex)
      .reverse()
      .find((candidate) => candidate.kind === 'line');
    const nextLineToken = tokens
      .slice(tokenIndex + 1)
      .find((candidate) => candidate.kind === 'line');

    expect(token.rangeStart).toBe(
      previousLineToken === undefined ? 1 : previousLineToken.lineNumber! + 1,
    );
    expect(token.rangeEnd).toBe(
      nextLineToken === undefined ? totalLines : nextLineToken.lineNumber! - 1,
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
      // "full body over pack cap", not a bare "over pack cap": admission is decided on the FULL
      // body's cost even though a windowed body may be what gets written, so a pack can report a
      // written total well under the cap while still omitting files. The reason has to name which
      // number was tested or it reads as a broken packer.
      expect(packContent).toMatch(/- big\.txt \(churn \d+; full body over pack cap\)/);

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

  it(
    'the stdout "paths:" line lists every changed file across all three layers, including a cap-trimmed one the TOC omits',
    () => {
      // 7000 fixed-length lines, same sizing as the cap test above: the numbered body lands
      // around 356KB, comfortably over PACK_BODY_CAP_BYTES (200KB) on its own. That
      // independence matters here specifically because this fixture also carries a
      // committed-vs-base layer, which folds into churnOf's ranking (committed + uncommitted
      // churn) - without an independently-oversized file, the cap could land on whichever
      // file the ranking happens to favor, and the test would pass for the wrong reason.
      const heavyLines = Array.from({ length: 7000 }, () => 'x'.repeat(45));
      fs.writeFileSync(path.join(repoDirectory, 'committed-vs-base.txt'), 'line one\n');
      fs.writeFileSync(path.join(repoDirectory, 'tracked-uncommitted.txt'), 'line one\n');
      fs.writeFileSync(path.join(repoDirectory, 'big.txt'), heavyLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      // Committed-vs-base layer: both files land in the base...HEAD diff.
      fs.writeFileSync(
        path.join(repoDirectory, 'committed-vs-base.txt'),
        'line one\nline two (committed after base)\n',
      );
      fs.appendFileSync(path.join(repoDirectory, 'big.txt'), 'appended heavy line (committed)\n');
      commitAll(repoDirectory, 'committed-vs-base change');

      // Uncommitted layer: a working-tree edit to a file already tracked at HEAD.
      fs.writeFileSync(
        path.join(repoDirectory, 'tracked-uncommitted.txt'),
        'line one\nline two (uncommitted)\n',
      );

      // Untracked layer: a brand-new file never added to git.
      fs.writeFileSync(path.join(repoDirectory, 'untracked.txt'), 'new file\n');

      const buildOutput = runBuildScript(repoDirectory, [baseRef]);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      // Non-vacuity guard: big.txt must actually be the trimmed one, not silently packed -
      // otherwise every path would reach the TOC anyway and the test could not tell a
      // "paths:"-derived list apart from a TOC-derived one, which is the whole distinction.
      expect(packContent).not.toContain('## Full file: big.txt');
      // "full body over pack cap", not a bare "over pack cap": admission is decided on the FULL
      // body's cost even though a windowed body may be what gets written, so a pack can report a
      // written total well under the cap while still omitting files. The reason has to name which
      // number was tested or it reads as a broken packer.
      expect(packContent).toMatch(/- big\.txt \(churn \d+; full body over pack cap\)/);
      expect(packContent).toContain('## Full file: committed-vs-base.txt');
      expect(packContent).toContain('## Full file: tracked-uncommitted.txt');
      expect(packContent).toContain('## Full file: untracked.txt');

      // The gap the "paths:" line closes: the TOC really is missing the trimmed file, so a
      // driver reading the TOC would under-gate its domain auditors by exactly this path.
      const tocLabels = extractTocEntries(packContent).map((entry) => entry.label);
      expect(tocLabels).not.toContain('big.txt');

      const changedFiles = parsePathsLine(buildOutput);
      expect(changedFiles).toBeDefined();
      expect([...changedFiles!].sort()).toEqual(
        ['committed-vs-base.txt', 'tracked-uncommitted.txt', 'untracked.txt', 'big.txt'].sort(),
      );

      // The count line is a separate, distinctly labelled line: a driver keying off "paths: "
      // must not be able to match the count line by accident.
      expect(buildOutput).toMatch(/^ {2}changed files: 4 \(/m);
      expect(buildOutput.match(/^ {2}paths: /gm)).toHaveLength(1);
    },
    20000,
  );

  it(
    'packs a sparsely-changed body as windows around its hunks, keeps a densely-changed one whole, and never windows an untracked file',
    () => {
      // sparse.txt: 400 lines, one 2-line edit. Windows cover ~42 lines, so the body is
      // overwhelmingly untouched code - the case windowing exists for.
      const sparseLines = Array.from({ length: 400 }, (_, index) => `sparse line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'sparse.txt'), sparseLines.join('\n') + '\n');
      // dense.txt: 40 lines, and every line changes. Its windows would cover the whole file,
      // so windowing it would ADD an elision marker for no saving; it must stay whole.
      const denseLines = Array.from({ length: 40 }, (_, index) => `dense line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'dense.txt'), denseLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      sparseLines[200] = 'sparse line 200 (edited)';
      sparseLines[201] = 'sparse line 201 (edited)';
      fs.writeFileSync(path.join(repoDirectory, 'sparse.txt'), sparseLines.join('\n') + '\n');
      fs.writeFileSync(
        path.join(repoDirectory, 'dense.txt'),
        denseLines.map((line) => `${line} (rewritten)`).join('\n') + '\n',
      );
      // An untracked file has no hunks to window against - every line of it is new - so it
      // must be packed whole no matter how large it is.
      fs.writeFileSync(
        path.join(repoDirectory, 'brand-new.txt'),
        Array.from({ length: 300 }, (_, index) => `new line ${index}`).join('\n') + '\n',
      );

      const buildOutput = runBuildScript(repoDirectory);
      const packContent = fs.readFileSync(
        path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md'),
        'utf8',
      );

      expect(packContent).toContain('## Partial file: sparse.txt (401 lines total;');
      expect(packContent).toContain('## Full file: dense.txt');
      expect(packContent).toContain('## Full file: brand-new.txt');
      expect(packContent).not.toContain('## Partial file: dense.txt');
      expect(packContent).not.toContain('## Partial file: brand-new.txt');

      // The elision marker names the exact run it stands in for, so a finder can tell what it
      // is not being shown rather than inferring it from a gap in the line numbers.
      expect(packContent).toMatch(/^ {6}\.{5} \d+ unchanged lines omitted \(\d+-\d+\) \.{5}$/m);

      // The saving is real, not just a relabel: sparse.txt's section must be a small fraction
      // of the 400 lines it stands for.
      const sparseSection = packContent.split('## Partial file: sparse.txt')[1].split('\n## ')[0];
      const shownLineNumbers = [...sparseSection.matchAll(/^\s*(\d+)\t/gm)].map((match) =>
        Number(match[1]),
      );
      expect(shownLineNumbers.length).toBeGreaterThan(20);
      expect(shownLineNumbers.length).toBeLessThan(120);

      // The summary reports what was windowed, so a review driver (and this test) can tell
      // windowing engaged at all rather than inferring it from pack size.
      expect(buildOutput).toMatch(/bodies packed 3 \(1 windowed, \d+KB written of \d+KB budgeted\), omitted 0/);

      // Beyond the marker's textual SHAPE (asserted above), its arithmetic must also be
      // correct: the reported skip count and the shown range must agree with the line numbers
      // actually surrounding it.
      assertElisionMarkerArithmetic(sparseSection);

      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'windows are placed against the WORKING TREE, so a file that is both committed-vs-base and dirty still shows every changed line',
    () => {
      // The misalignment this pins is invisible to a clean-tree fixture. The committed layer is
      // a three-dot diff (`base...HEAD`), so its hunk line numbers are HEAD-relative, while the
      // body the packer writes is read from the working tree. Prepending lines shifts the two
      // apart. Deriving windows from that diff puts them at the wrong offset - and the failure
      // is silent, because the prefixed line numbers come from the body and stay correct; what
      // breaks is WHICH region is shown. Changed code is dropped, unchanged code is shown, and
      // the section still looks perfectly well-formed. Measured on a real diff, the naive
      // derivation dropped 18 of 80 changed lines.
      const originalLines = Array.from({ length: 300 }, (_, index) => `line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'mixed.txt'), originalLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      // Committed layer: an edit deep in the file, far from where the dirty layer will hit.
      originalLines[200] = 'line 200 (committed after base)';
      fs.writeFileSync(path.join(repoDirectory, 'mixed.txt'), originalLines.join('\n') + '\n');
      commitAll(repoDirectory, 'committed edit deep in the file');

      // Dirty layer: 40 prepended lines shift every committed hunk down by 40 in the tree.
      const PREPENDED = 40;
      const preamble = Array.from(
        { length: PREPENDED },
        (_, index) => `uncommitted preamble ${index}`,
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'mixed.txt'),
        preamble.join('\n') + '\n' + originalLines.join('\n') + '\n',
      );

      runBuildScript(repoDirectory, [baseRef]);
      const packContent = fs.readFileSync(
        path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md'),
        'utf8',
      );

      // Non-vacuity guard: if the file were packed whole this test could not fail.
      expect(packContent).toContain('## Partial file: mixed.txt');
      const section = packContent.split('## Partial file: mixed.txt')[1].split('\n## ')[0];
      const shown = new Set(
        [...section.matchAll(/^\s*(\d+)\t/gm)].map((match) => Number(match[1])),
      );

      // The authoritative changed-line set, derived here independently of the packer.
      const mergeBase = runGit(['merge-base', baseRef, 'HEAD'], repoDirectory).trim();
      const authoritative = runGit(
        ['diff', '--unified=0', mergeBase, '--', 'mixed.txt'],
        repoDirectory,
      );
      const changedLines: number[] = [];
      for (const line of authoritative.split('\n')) {
        const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!hunk) continue;
        const start = Number(hunk[1]);
        const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let offset = 0; offset < Math.max(1, length); offset++) {
          changedLines.push(start + offset);
        }
      }
      // Guards the guard: both layers must be represented, or "every changed line is shown"
      // could hold vacuously against the dirty layer alone.
      expect(changedLines.length).toBeGreaterThan(PREPENDED);
      expect(Math.max(...changedLines)).toBeGreaterThan(PREPENDED + 100);

      expect(changedLines.filter((lineNumber) => !shown.has(lineNumber))).toEqual([]);

      // And the committed edit is shown at its WORKING-TREE line number, not its HEAD one.
      expect(section).toContain(
        `${String(201 + PREPENDED).padStart(5)}\tline 200 (committed after base)`,
      );
    },
    20000,
  );

  it(
    'produces a byte-identical pack under hostile local git config, so the review surface does not differ per developer',
    () => {
      // This repo is public and /code-review runs against whatever git config a user has.
      // Every setting below changes the pack SILENTLY - a valid-looking pack, just a different
      // one than a teammate or CI gets for the same commits:
      //   mnemonicPrefix renames the diff prefixes per source (`c/` commit, `w/` working tree)
      //     and noprefix drops them. The windowing pass keys off `+++ b/<path>` from a
      //     commit-vs-working-tree diff - exactly the case mnemonic prefixes apply to - so
      //     either one switches windowing off entirely and inflates the pack.
      //   context resizes the union diff, the pack's largest single section.
      //   renames off makes a renamed-and-modified file score zero churn and rank last.
      //   external replaces the diff body with a program's arbitrary output; unlike the rest it
      //     cannot be pinned via `-c` (an empty value makes git spawn the empty string and die),
      //     so it is neutralized with --no-ext-diff on every diff call.
      // The script pins all of them to git's own defaults; this is the red-green for that.
      const sparseLines = Array.from({ length: 400 }, (_, index) => `sparse line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'sparse.txt'), sparseLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      sparseLines[200] = 'sparse line 200 (edited)';
      fs.writeFileSync(path.join(repoDirectory, 'sparse.txt'), sparseLines.join('\n') + '\n');

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      runBuildScript(repoDirectory);
      const defaultConfigPack = fs.readFileSync(packPath, 'utf8');
      // Non-vacuity guard: without windowing under the default config there is nothing for
      // the hostile configs to differ FROM, and both halves below would pass trivially.
      expect(defaultConfigPack).toContain('## Partial file: sparse.txt');

      for (const [key, value] of [
        ['diff.mnemonicPrefix', 'true'],
        ['diff.noprefix', 'true'],
        ['diff.context', '25'],
        ['diff.renames', 'false'],
        // A real external differ, not a bogus one: `echo` exists on every platform's PATH
        // (Windows resolves it through the Git-for-Windows shell git uses to spawn diff
        // drivers), so this exercises the "diff replaced by arbitrary output" path rather
        // than the "spawn failed" path. Without --no-ext-diff the union diff becomes echo's
        // output and the pack is unrecognisable.
        ['diff.external', 'echo'],
      ]) {
        runGit(['config', key, value], repoDirectory);
        runBuildScript(repoDirectory);
        expect(fs.readFileSync(packPath, 'utf8')).toBe(defaultConfigPack);
        runGit(['config', '--unset', key], repoDirectory);
      }
    },
    20000,
  );

  it(
    'the "NO CHANGES:" stdout prefix, not the exit status, discriminates an empty diff from a non-empty one, and the empty path writes neither output file',
    () => {
      // execFileSync throws on a non-zero exit, so runBuildScript returning at all already
      // means exit 0 - on BOTH the empty and non-empty paths. Only the literal stdout prefix
      // can tell a caller which case it hit; SKILL.md now says so explicitly, and this test
      // pins the reason why by checking the prefix on both sides of the same repo.
      //
      // The existsSync assertions below are the second half of the same contract and are named
      // in the test title too: a driver that trusted the exit status alone would go on to read
      // two files the empty path never created, so "exits 0" and "writes nothing" have to fail
      // separately and legibly rather than under a title that mentions only the prefix.
      commitAll(repoDirectory, 'commit the fixture .gitignore');

      const emptyRunOutput = runBuildScript(repoDirectory);
      expect(emptyRunOutput.startsWith('NO CHANGES:')).toBe(true);
      expect(
        fs.existsSync(path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md')),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(repoDirectory, '.kangentic', 'REVIEW_PREEXISTING_DIRTY.tmp')),
      ).toBe(false);

      fs.writeFileSync(path.join(repoDirectory, 'changed.txt'), 'a change\n');
      const nonEmptyRunOutput = runBuildScript(repoDirectory);
      expect(nonEmptyRunOutput.startsWith('NO CHANGES:')).toBe(false);
      expect(
        fs.existsSync(path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md')),
      ).toBe(true);
    },
    20000,
  );

  it(
    'merges two windows into one contiguous span, with no elision marker between them, when their context-expanded ranges are within WINDOW_MERGE_GAP_LINES of each other',
    () => {
      // Two single-line edits whose raw hunk ranges never overlap, but whose
      // CONTEXT-EXPANDED ranges do land close together: the edit at line 100 expands to
      // [80, 120], and the edit at line 143 expands to [123, 163]. The 3-line gap between 120
      // and 123 sits comfortably inside WINDOW_MERGE_GAP_LINES (5) without landing exactly on
      // the boundary, so this pins the merge branch itself rather than an off-by-one at the
      // edge.
      const gapMergeLines = Array.from({ length: 200 }, (_, index) => `gap merge line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'gap-merge.txt'), gapMergeLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      gapMergeLines[99] = 'gap merge line 99 (edited)';
      gapMergeLines[142] = 'gap merge line 142 (edited)';
      fs.writeFileSync(path.join(repoDirectory, 'gap-merge.txt'), gapMergeLines.join('\n') + '\n');

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      expect(packContent).toContain('## Partial file: gap-merge.txt');
      // A single merged window, not two: reverting the merge to "always emit a separate window
      // per hunk" would report 2 windows here even though the shown/omitted line assertions
      // below could still coincidentally look plausible.
      expect(packContent).toContain('in 1 window;');

      const section = packContent.split('## Partial file: gap-merge.txt')[1].split('\n## ')[0];

      // Both edited lines are shown.
      expect(section).toContain(`${String(100).padStart(5)}\tgap merge line 99 (edited)`);
      expect(section).toContain(`${String(143).padStart(5)}\tgap merge line 142 (edited)`);
      // The "gap" between the two raw hunks (working-tree lines 121-122, untouched) belongs to
      // the SAME merged window, so it is shown rather than elided.
      expect(section).toContain(`${String(121).padStart(5)}\tgap merge line 120`);
      expect(section).toContain(`${String(122).padStart(5)}\tgap merge line 121`);

      // Exactly two markers (one leading, one trailing): a regression back to "always separate
      // windows" would insert a third marker for the omitted 121-122 gap.
      const markerMatches = [
        ...section.matchAll(/^ {6}\.{5} \d+ unchanged lines omitted \((\d+)-(\d+)\) \.{5}$/gm),
      ];
      expect(markerMatches).toHaveLength(2);
      expect(section).not.toMatch(/unchanged lines omitted \(121-122\)/);

      assertElisionMarkerArithmetic(section);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'anchors a pure-deletion hunk at its collapse point and shows context on both sides of the removed lines',
    () => {
      // `git diff --unified=0` reports a pure deletion as "@@ -a,b +N,0 @@": nothing on the
      // new side, so the parser special-cases it to a point range at N rather than the general
      // `[start, start + length - 1]` formula, which would invert to `[N, N - 1]` for a
      // zero-length hunk. That inverted range is not dropped by the later `end >= start`
      // filter for a realistically sized file - the +/- WINDOW_CONTEXT_LINES expansion rescues
      // it - so the bug is silent and precise rather than loud: the trailing edge of the
      // window lands one line short (at N + WINDOW_CONTEXT_LINES - 1 instead of N +
      // WINDOW_CONTEXT_LINES), quietly hiding the last line of context on the far side of the
      // deletion.
      const deletionLines = Array.from({ length: 200 }, (_, index) => `deletion line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'deletion.txt'), deletionLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      // Remove five contiguous lines from the middle (indices 100-104), leaving everything
      // else untouched.
      const afterDeletion = deletionLines.slice(0, 100).concat(deletionLines.slice(105));
      fs.writeFileSync(path.join(repoDirectory, 'deletion.txt'), afterDeletion.join('\n') + '\n');

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      // Non-vacuity guard: windowing must actually engage for the line-120 assertion below to
      // mean anything.
      expect(packContent).toContain('## Partial file: deletion.txt');
      expect(packContent).not.toContain('## Full file: deletion.txt');

      const section = packContent.split('## Partial file: deletion.txt')[1].split('\n## ')[0];

      // The last surviving line before the gap (working-tree line 100) and the first
      // surviving line after it (working-tree line 101) are adjacent in the rendered window,
      // showing the code the removed lines used to sit between.
      expect(section).toContain(`${String(100).padStart(5)}\tdeletion line 99`);
      expect(section).toContain(`${String(101).padStart(5)}\tdeletion line 105`);

      // Context extends WINDOW_CONTEXT_LINES (20) on each side of the anchor at working-tree
      // line 100: line 120 is the last line inside the window, line 121 the first excluded one.
      expect(section).toContain(`${String(120).padStart(5)}\tdeletion line 124`);
      expect(section).not.toContain('deletion line 125');
      // And symmetrically on the near side: line 80 is the first line inside the window, line
      // 79 the first excluded one going backward.
      expect(section).toContain(`${String(80).padStart(5)}\tdeletion line 79`);
      expect(section).not.toContain('deletion line 78');

      assertElisionMarkerArithmetic(section);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'clamps window context at both file boundaries instead of reading past line 1 or past the last line',
    () => {
      // Edits near the very start and very end of the file: WINDOW_CONTEXT_LINES (20) would
      // push the raw expansion below line 1 on one side and past the file's last line on the
      // other, so Math.max(1, ...) and Math.min(totalLines, ...) must clamp both. Dropping
      // either clamp reads past the lines array, and a JS out-of-bounds array access is
      // `undefined`, not an exception - so a dropped clamp renders the literal text
      // "undefined" at a bogus line number rather than throwing or omitting anything.
      const boundaryLines = Array.from({ length: 300 }, (_, index) => `boundary line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'boundary.txt'), boundaryLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      boundaryLines[4] = 'boundary line 4 (edited)';
      boundaryLines[294] = 'boundary line 294 (edited)';
      fs.writeFileSync(path.join(repoDirectory, 'boundary.txt'), boundaryLines.join('\n') + '\n');

      runBuildScript(repoDirectory);

      const packPath = path.join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md');
      const packContent = fs.readFileSync(packPath, 'utf8');

      expect(packContent).toContain('## Partial file: boundary.txt');
      const section = packContent.split('## Partial file: boundary.txt')[1].split('\n## ')[0];

      const totalLinesMatch = section.match(/\((\d+) lines total/);
      expect(totalLinesMatch).not.toBeNull();
      const totalLines = Number(totalLinesMatch![1]);

      const shownLineNumbers = [...section.matchAll(/^\s*(\d+)\t/gm)].map((match) =>
        Number(match[1]),
      );
      expect(shownLineNumbers.length).toBeGreaterThan(0);

      // The lower clamp: the window around line 5 must start at exactly line 1, never below.
      expect(Math.min(...shownLineNumbers)).toBe(1);
      // The upper clamp: the window around line 295 must end at exactly the file's last line,
      // never past it.
      expect(Math.max(...shownLineNumbers)).toBe(totalLines);

      expect(section).not.toContain('undefined');

      // The two windows stay separate (a 250-line gap between them, far past
      // WINDOW_MERGE_GAP_LINES), so there is exactly one interior elision marker and none at
      // either boundary - the boundary itself already IS the first/last shown line.
      const markerMatches = [
        ...section.matchAll(/^ {6}\.{5} \d+ unchanged lines omitted \((\d+)-(\d+)\) \.{5}$/gm),
      ];
      expect(markerMatches).toHaveLength(1);

      expect(section).toContain(`${String(5).padStart(5)}\tboundary line 4 (edited)`);
      expect(section).toContain(`${String(295).padStart(5)}\tboundary line 294 (edited)`);

      assertElisionMarkerArithmetic(section);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );
});

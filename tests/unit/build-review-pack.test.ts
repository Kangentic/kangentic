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
 * The pack has one format: every changed file is exactly one section, and every body line is
 * `<marker><line number, 5 wide><tab><text>` with "+" added, " " unchanged, and "-" removed
 * (no number, shown in place before the line that follows it). A file admitted under the body
 * cap is "## Full file:" or "## Partial file:" (hunks with 20 lines of context); every other
 * readable file is "## Changed hunks:" (3 lines of context). There is no separate union diff.
 * The behaviors pinned:
 *
 * 1. The "Total lines: N" header always matches the pack file's actual line count,
 *    including the trailing "## Not included (read on demand)" section that appears
 *    whenever a changed file's content is absent (oversized, binary, or a stubbed hunk
 *    section). Before the fix, N was derived from the table-of-contents cursor arithmetic,
 *    which stopped advancing once the packed sections ended and never accounted for the
 *    omitted-files block - undercounting by 1 + omittedCount whenever anything was omitted.
 *
 * 2. parseNumstat resolves git's rename notation ("old => new") to the new path via
 *    resolveNumstatPath, so a renamed-and-modified committed file is ranked by its true
 *    churn instead of silently scoring 0 (its raw numstat key never matches a real path,
 *    so an unresolved lookup always misses).
 *
 * 3. Every "- line N: <label>" table-of-contents entry points at the exact line where its
 *    own section heading starts, and every changed file has exactly one heading. A windowed
 *    section is the harder case: its rendered length is the shown lines plus one line per
 *    elision marker plus one line per removed line, not the file's line count, so the cursor
 *    must advance by what was written. This bit during development: the first section's own
 *    heading line was uncounted in the cursor arithmetic, sending every TOC entry to a blank
 *    line instead of its heading, and the only reason it was caught was manual verification,
 *    not a test. The second header line (the format legend) is part of that arithmetic too.
 *
 * 4. A file that pushes the packed bodies over PACK_BODY_CAP_BYTES (200KB) is not given a
 *    body; it is packed at the hunk tier ("## Changed hunks:", every changed line with 3 lines
 *    of context and exact numbers), and it is NOT listed under "## Not included", because it
 *    carries every changed line. A hunk-tier section that alone exceeds
 *    PACK_HUNK_SECTION_CAP_BYTES (100KB) becomes a one-line "## Changed hunks omitted:" stub
 *    and IS listed there. The cap is a fact about the file alone, never about what else
 *    changed: a smaller hunk-tier file beside a stubbed one keeps its hunks.
 *
 * 5. The stdout "  paths: " line carries every changed file across all three layers
 *    (committed-vs-base, uncommitted, untracked), and is distinct from the "  changed files: "
 *    count line above it. This is the line /code-review's SKILL.md tells the driver to read
 *    for `changedFiles`: it is the script's own array, so it cannot disagree with the pack.
 *    The TOC now lists every changed file too, and the two are asserted to match one-to-one.
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
 *    the later end >= start filter for any realistically sized file. The removed lines render
 *    in place, between the two surviving neighbours.
 *
 * 9. Window context is clamped at both file boundaries: an edit within WINDOW_CONTEXT_LINES
 *    (20) of line 1 or of the file's last line never reads past either end of the lines array.
 *
 * 10. Every elision marker's own arithmetic, not just its textual shape, is correct: the
 *     reported skip count equals its range's line span, and the range itself abuts the shown
 *     line numbers immediately surrounding it (or the file's first/last line at a boundary),
 *     looking through removed lines, which carry no number.
 *
 * 11. WINDOW_MAX_SHARE_OF_FULL (0.85) is enforced at its actual boundary, not merely at the
 *     extremes: a windowed body whose byte share lands fractionally ABOVE 0.85 still renders
 *     as "## Full file:", and one whose share lands fractionally BELOW renders as
 *     "## Partial file:".
 *
 * 12. WINDOW_MERGE_GAP_LINES (5) is a "less-than-or-equal" comparison against the
 *     CONTEXT-EXPANDED gap between two windows, not the raw hunk-to-hunk distance: two windows
 *     exactly 5 lines apart (post-expansion) merge, while two windows 6 lines apart stay
 *     separate with a marker reporting exactly 5 omitted lines.
 *
 * 13. Every rendered line carries the right marker: "+" on an added line, " " on an unchanged
 *     one, "-" with a blank number field on a removed line, rendered in place - before the
 *     first line of the hunk that replaced it, after the collapse point of a pure deletion,
 *     before line 1 for a deletion at the top of the file, and before the phantom empty last
 *     line for a deletion at the end of a newline-terminated file. A file changed in a commit
 *     and reverted in the working tree, a deleted file, a pure rename, and a binary each get
 *     their own one-line (or hunks-only) section, so the pack never claims a body it cannot
 *     show. The same file rendered with `--body-cap 0` (the light shape) is a
 *     "## Changed hunks:" section at 3 lines of context with the same markers.
 *
 * 14. The pack is byte-identical under hostile local git config: the seven `-c` pins plus
 *     `--no-ext-diff`. Every rendered byte now derives from the one `--unified=0` merge-base
 *     parse, so a lost prefix pin would switch the WHOLE parse off, not just windowing.
 *
 * 15. A missing or non-numeric --body-cap value exits 2 with a stderr message, from the
 *     argv-parsing loop, before the script ever calls git.
 *
 * 16. A mode-only change (the executable bit flips, content unchanged) is a one-line
 *     "## Not shown:" section naming the transition, e.g. "mode 100644 -> 100755".
 *
 * 17. A tracked file that stays over SINGLE_FILE_CAP_BYTES (1MB) even after its edit, with a
 *     small parsed hunk, is packed at the hunk tier under the OTHER arm of hunkSectionFor's
 *     "kind === 'hunks-only'" split: "## Changed hunks: <path> (over 1MB, body not read; ...)",
 *     rendered with renderHunksOnly's 0 lines of context - not the "## Deleted file:" heading,
 *     and not the per-file-hunk-cap stub, as long as the small edit's own rendered section
 *     stays under that cap.
 *
 * 18. The stub heading's own over-cap ternary has two arms: a stub for a DELETED file whose
 *     hunk-tier section alone exceeds PACK_HUNK_SECTION_CAP_BYTES (100KB) says "deleted file",
 *     not "read on demand" - the heading built earlier in hunkSectionFor is fully overwritten,
 *     never merged with the stub text.
 *
 * 19. A genuinely empty file gets its own two reasons under "## Not shown:": adding one is
 *     "new file, empty" and deleting an already-empty one is "deleted, was empty". Both must be
 *     driven as two SEPARATE diffs: git's rename detector treats any two empty (or otherwise
 *     byte-identical) files as 100% similar, so an add and a delete of empty files in the SAME
 *     diff pair into a rename instead ("renamed from ..., content unchanged"), never exercising
 *     either reason - confirmed empirically against a scratch repo before this fixture was written.
 *
 * Not covered, and why: a C-quoted path (a quote, backslash, or control character in a file
 * name) lands its raw block under "## Union diff (unparsed)". NTFS forbids those characters,
 * so the fixture cannot be created on the Windows machines this suite also runs on.
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

// Identity AND signing are overridden for the same reason: the fixture repo must not inherit
// the developer's or the runner's ambient git config. A global commit.gpgsign=true would make
// every commit here try to sign, which fails outright in a non-interactive test run with no
// key or no GPG_TTY - green on one machine, red on another.
function commitStaged(cwd: string, message: string): void {
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

function commitAll(cwd: string, message: string): void {
  runGit(['add', '-A'], cwd);
  commitStaged(cwd, message);
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

// For the one path that is SUPPOSED to exit non-zero (a rejected --body-cap value):
// execFileSync throws on any non-zero exit, so runBuildScript's happy-path helper cannot be
// reused here - it would rethrow the exit-2 failure as an unrelated "failed" error and lose the
// exit code and stderr text this checks. Throws itself, with a distinct message, if the script
// exits 0 when the test expected it to reject the arguments.
function runBuildScriptExpectingFailure(
  cwd: string,
  args: string[],
): { exitCode: number | null; stderr: string } {
  try {
    execFileSync('node', [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const execError = error as { status?: number | null; stderr?: string };
    return { exitCode: execError.status ?? null, stderr: execError.stderr ?? '' };
  }
  throw new Error('build-review-pack.mjs was expected to exit non-zero but exited 0');
}

function readPack(cwd: string): string {
  return fs.readFileSync(path.join(cwd, '.kangentic', 'REVIEW_PACK.tmp.md'), 'utf8');
}

// The one line format every section uses. Assertions build expected lines through this helper
// rather than hand-padding, so the marker column cannot silently drift out of the assertions.
function markedLine(marker: '+' | '-' | ' ', lineNumber: number | null, text: string): string {
  return `${marker}${lineNumber === null ? '     ' : String(lineNumber).padStart(5)}\t${text}`;
}

// A section heading names its file between "## <Kind>: " and the LAST " (", so a path that
// itself contains " (" still resolves. Returns null for the non-file headings ("## Contents
// (start line)", "## Not included (read on demand)", "## Union diff (unparsed)").
function headingPathOf(headingLine: string): string | null {
  const match = headingLine.match(/^## [A-Za-z ]+: (.+)$/);
  if (!match) return null;
  const remainder = match[1];
  const parenIndex = remainder.lastIndexOf(' (');
  return parenIndex === -1 ? remainder : remainder.slice(0, parenIndex);
}

interface TocEntry {
  lineNumber: number;
  label: string;
}

function extractTocEntries(packContent: string): TocEntry[] {
  // The TOC runs from the "## Contents" heading to the first blank line; the section that
  // follows it varies (there is no fixed "## Union diff" any more), so the blank line is the
  // only stable terminator.
  const contentsBlock = packContent.split('## Contents (start line)\n')[1].split('\n\n')[0];
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

// Shared by most tests: every TOC entry's claimed line number is exactly where its section
// heading starts, every label has exactly one heading anywhere in the pack (a duplicated
// section would be the diff/body redundancy this format exists to remove), and the "Total
// lines" header matches the pack's real length.
function assertTocLineAccuracyAndHeaderTotal(packContent: string): TocEntry[] {
  const packLines = packContent.split('\n');
  const entries = extractTocEntries(packContent);
  // Guards the helper itself, not just today's callers: with zero entries the loop below is
  // vacuously true and the header check alone passes on any pack, so a future caller that
  // forgets its own non-vacuity assertion would still get real coverage here.
  expect(entries.length).toBeGreaterThan(0);
  // The second header line is the format legend, and the cursor arithmetic counts it.
  expect(packLines[1]).toMatch(/^(Full|Light) pack \(.*\)\. Line format: /);
  const labels = entries.map((entry) => entry.label);
  expect(new Set(labels).size).toBe(labels.length);
  for (const entry of entries) {
    const actualLine = packLines[entry.lineNumber - 1];
    // Compare the heading's own label against the entry (rather than a boolean assertion) so a
    // failure prints the real line - for the historical off-by-one bug that line is the empty
    // string, which is immediately diagnostic.
    const actualLabel =
      entry.label === 'Union diff (unparsed)'
        ? actualLine === '## Union diff (unparsed)'
          ? entry.label
          : actualLine
        : (headingPathOf(actualLine) ?? actualLine);
    expect(actualLabel).toBe(entry.label);
    const headingCount = packLines.filter(
      (line) => line.startsWith('## ') && headingPathOf(line) === entry.label,
    ).length;
    if (entry.label !== 'Union diff (unparsed)') expect(headingCount).toBe(1);
  }

  const headerMatch = packContent.match(/^Total lines: (\d+)\./);
  expect(headerMatch).not.toBeNull();
  expect(Number(headerMatch![1])).toBe(packLines.length);

  return entries;
}

// The TOC lists exactly the script's own changed-file list, and each of those files has exactly
// one section heading: the "one record per changed file" contract.
function assertOneSectionPerChangedFile(packContent: string, changedFiles: string[]): void {
  const tocLabels = extractTocEntries(packContent)
    .map((entry) => entry.label)
    .filter((label) => label !== 'Union diff (unparsed)');
  expect([...tocLabels].sort()).toEqual([...changedFiles].sort());
  const packLines = packContent.split('\n');
  for (const relPath of changedFiles) {
    const headings = packLines.filter(
      (line) => line.startsWith('## ') && headingPathOf(line) === relPath,
    );
    expect(headings).toHaveLength(1);
  }
}

interface WindowedSectionToken {
  kind: 'line' | 'marker';
  lineNumber?: number;
  skippedCount?: number;
  rangeStart?: number;
  rangeEnd?: number;
}

// Walks a windowed section's rendered text (heading remainder plus body) into an ordered list
// of its numbered content lines and elision markers. A removed line ("-" marker, blank number)
// is deliberately NOT a token: markers' nearest-neighbour arithmetic must look through it to
// the numbered line it precedes. Order is preserved because assertElisionMarkerArithmetic
// needs each marker's nearest numbered neighbours on both sides.
function tokenizeWindowedSection(sectionText: string): WindowedSectionToken[] {
  const tokens: WindowedSectionToken[] = [];
  for (const renderedLine of sectionText.split('\n')) {
    const numberedLineMatch = renderedLine.match(/^[ +] *(\d+)\t/);
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

// The body of one section: everything after its heading up to the next heading.
function sectionBodyOf(packContent: string, headingPrefix: string): string {
  const parts = packContent.split(headingPrefix);
  expect(parts.length).toBe(2);
  return parts[1].split('\n## ')[0];
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

      // An uncommitted edit so a packed body section is non-empty - otherwise this fixture
      // would only exercise a near-empty pack and barely traverse the table-of-contents
      // cursor arithmetic the fix replaced.
      fs.writeFileSync(
        path.join(repoDirectory, 'tracked.txt'),
        'line one\nline two\nline three (uncommitted)\n',
      );

      // An untracked file over SINGLE_FILE_CAP_BYTES lands in "Not included" with reason
      // 'binary, missing, or >1MB' - the section whose lines the buggy cursor arithmetic
      // never counted - and gets a one-line "## Not shown:" section of its own.
      fs.writeFileSync(
        path.join(repoDirectory, 'oversized.txt'),
        'x'.repeat(SINGLE_FILE_CAP_BYTES + 1024),
      );

      runBuildScript(repoDirectory);

      const packContent = readPack(repoDirectory);

      // Non-vacuity guards: if either of these two sections failed to appear, the header
      // check below would trivially pass no matter what the header derivation did.
      expect(packContent).toContain('## Full file: tracked.txt');
      expect(packContent).toContain(
        '## Not shown: oversized.txt (binary, missing, or >1MB; new, untracked; read on demand)',
      );
      expect(packContent).toContain('## Not included (read on demand)');
      expect(packContent).toMatch(/^- oversized\.txt \(churn \d+; binary, missing, or >1MB\)$/m);

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

      const packContent = readPack(repoDirectory);
      const tocLabels = extractTocEntries(packContent).map((entry) => entry.label);

      const renamedIndex = tocLabels.indexOf('mmm-renamed.txt');
      const trivialIndex = tocLabels.indexOf('zzz-trivial.txt');
      expect(renamedIndex).toBeGreaterThan(-1);
      expect(trivialIndex).toBeGreaterThan(-1);

      // Largest churn first: the renamed file's 12 appended lines must outrank the
      // trivial file's 1-line edit, which only holds once its churn resolves under its
      // new path rather than the unresolved "old => new" numstat key.
      expect(renamedIndex).toBeLessThan(trivialIndex);

      // The rename survives into the section heading, and the appended lines are marked added
      // at their working-tree numbers: 100 kept lines, so the first appended one is line 101.
      expect(packContent).toContain('## Partial file: mmm-renamed.txt (113 lines total;');
      expect(packContent).toMatch(/^## Partial file: mmm-renamed\.txt \(.*; renamed from aaa-original\.txt\)$/m);
      expect(packContent).toContain(markedLine('+', 101, 'appended line 0'));
      expect(packContent).toContain(markedLine(' ', 100, 'heavy line 99'));
    },
    20000,
  );

  it(
    'every TOC entry line number points at the exact line where its own section heading starts',
    () => {
      // Two changed tracked files are load-bearing, not incidental: with one file the TOC
      // cursor advances exactly once, so a regression to the per-section increment ("1 +
      // section lines + 1") could only mis-cursor a second entry. beta.txt's entry is the only
      // assertion below that can catch that, so do not simplify this fixture to one file.
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

      const packContent = readPack(repoDirectory);

      const entries = assertTocLineAccuracyAndHeaderTotal(packContent);

      // Non-vacuity guard: if fewer than 2 entries parsed, the loop inside the helper would
      // have exercised too little of the cursor arithmetic to catch the historical bug (every
      // entry landing on a blank line).
      expect(entries.map((entry) => entry.label).sort()).toEqual(['alpha.txt', 'beta.txt']);
    },
    20000,
  );

  it(
    'a file over the body cap is packed at the hunk tier with its changed lines; a hunk section over the per-file cap becomes a stub and a Not-included entry while a smaller hunk-tier file keeps its hunks',
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
      // An untracked file is one hunk covering every content line, so its hunk-tier section is
      // its whole body: 8000 lines of 52 bytes each is ~416KB, over PACK_HUNK_SECTION_CAP_BYTES
      // (100KB) on its own. That is the per-file ceiling firing on a fact about this file, not
      // on the pack's total: big.txt's tiny hunk section beside it is untouched.
      const hugeLines = Array.from({ length: 8000 }, () => 'y'.repeat(45));
      fs.writeFileSync(path.join(repoDirectory, 'huge-new.txt'), hugeLines.join('\n') + '\n');

      const buildOutput = runBuildScript(repoDirectory);

      const packContent = readPack(repoDirectory);

      expect(packContent).toContain('## Full file: small.txt');
      expect(packContent).not.toContain('## Full file: big.txt');
      expect(packContent).not.toContain('## Partial file: big.txt');

      // Over the body cap means the hunk tier, not omission: every changed line is still in the
      // pack with its exact working-tree number, with 3 lines of context, behind a leading
      // elision marker for the 6997 untouched lines before the window.
      expect(packContent).toContain(
        '## Changed hunks: big.txt (7002 lines total; 1 hunk with 3 lines of context;',
      );
      const bigSection = sectionBodyOf(packContent, '## Changed hunks: big.txt');
      expect(bigSection).toContain(markedLine('+', 7001, 'appended heavy line (uncommitted)'));
      expect(bigSection).toMatch(/^ {6}\.{5} 6997 unchanged lines omitted \(1-6997\) \.{5}$/m);
      assertElisionMarkerArithmetic(bigSection);

      // The per-file hunk cap: a one-line stub naming what it stands for, and a Not-included
      // entry, while big.txt (which carries its hunks) is NOT listed there.
      expect(packContent).toMatch(
        /^## Changed hunks omitted: huge-new\.txt \(\+8000\/-0 lines in 1 hunk; section \d+KB, over the per-file hunk cap; read on demand; new, untracked; every line is added\)$/m,
      );
      expect(packContent).toContain('## Not included (read on demand)');
      expect(packContent).toMatch(/^- huge-new\.txt \(churn \d+; changed hunks over the per-file hunk cap\)$/m);
      expect(packContent).not.toMatch(/^- big\.txt \(/m);
      expect(packContent).not.toContain('yyyyy');

      expect(buildOutput).toMatch(/omitted 1; hunk sections 2 \(1 over per-file hunk cap\)/);
      expect(buildOutput).toMatch(/^ {2}omitted: huge-new\.txt$/m);

      // Same line-accuracy + header-total check as the previous test, run against a pack shaped
      // differently (one body, one hunk section, one stub, a Not-included block) to pin that a
      // stub contributes a heading-only section and its own TOC entry.
      const entries = assertTocLineAccuracyAndHeaderTotal(packContent);
      expect(entries.map((entry) => entry.label).sort()).toEqual(
        ['big.txt', 'huge-new.txt', 'small.txt'].sort(),
      );
    },
    20000,
  );

  it(
    'the stdout "paths:" line lists every changed file across all three layers, including a cap-trimmed one, and matches the TOC one-to-one',
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

      const packContent = readPack(repoDirectory);

      // Non-vacuity guard: big.txt must actually be the trimmed one, not silently packed -
      // otherwise the "paths:" list and the TOC could agree for the wrong reason.
      expect(packContent).not.toContain('## Full file: big.txt');
      expect(packContent).toContain('## Changed hunks: big.txt (');
      expect(packContent).toContain('## Full file: committed-vs-base.txt');
      expect(packContent).toContain('## Full file: tracked-uncommitted.txt');
      expect(packContent).toContain(
        '## Full file: untracked.txt (2 lines; line numbers prefixed; new, untracked; every line is added)',
      );
      expect(packContent).toContain(markedLine('+', 1, 'new file'));

      const changedFiles = parsePathsLine(buildOutput);
      expect(changedFiles).toBeDefined();
      expect([...changedFiles!].sort()).toEqual(
        ['committed-vs-base.txt', 'tracked-uncommitted.txt', 'untracked.txt', 'big.txt'].sort(),
      );

      // One record per changed file: the TOC and the paths line name the same set, and each
      // path has exactly one heading, trimmed or not.
      assertOneSectionPerChangedFile(packContent, changedFiles!);

      // The count line is a separate, distinctly labelled line: a driver keying off "paths: "
      // must not be able to match the count line by accident.
      expect(buildOutput).toMatch(/^ {2}changed files: 4 \(/m);
      expect(buildOutput.match(/^ {2}paths: /gm)).toHaveLength(1);
    },
    20000,
  );

  it(
    'packs a sparsely-changed body as windows around its hunks, keeps a densely-changed one whole, never windows an untracked file, and writes each changed line exactly once',
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
      // An untracked file is one hunk covering every content line, so windowing it would save
      // nothing; it must be packed whole no matter how large it is.
      fs.writeFileSync(
        path.join(repoDirectory, 'brand-new.txt'),
        Array.from({ length: 300 }, (_, index) => `new line ${index}`).join('\n') + '\n',
      );

      const buildOutput = runBuildScript(repoDirectory);
      const packContent = readPack(repoDirectory);

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
      const sparseSection = sectionBodyOf(packContent, '## Partial file: sparse.txt');
      const shownLineNumbers = [...sparseSection.matchAll(/^[ +] *(\d+)\t/gm)].map((match) =>
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

      // Markers: every content line of the untracked file is added (its phantom empty last line
      // is the one unchanged line); the rewritten file shows its 40 old lines removed in place
      // and its 40 new lines added.
      const brandNewSection = sectionBodyOf(packContent, '## Full file: brand-new.txt');
      const brandNewMarkers = [...brandNewSection.matchAll(/^([ +]) *\d+\t/gm)].map((match) => match[1]);
      expect(brandNewMarkers.filter((marker) => marker === '+')).toHaveLength(300);
      expect(brandNewMarkers.filter((marker) => marker === ' ')).toHaveLength(1);
      // Git reports a block rewrite as ONE hunk (40 removed, then 40 added), and the section
      // renders it as the diff says it: the removed block in place before the first new line.
      const denseSection = sectionBodyOf(packContent, '## Full file: dense.txt');
      expect([...denseSection.matchAll(/^- {5}\t/gm)]).toHaveLength(40);
      expect([...denseSection.matchAll(/^\+ *\d+\t/gm)]).toHaveLength(40);
      expect(denseSection).toContain(
        markedLine('-', null, 'dense line 39') + '\n' + markedLine('+', 1, 'dense line 0 (rewritten)'),
      );

      // Each changed line is written exactly once. The pack used to carry it twice: once in the
      // union diff and once in the body. This is the redundancy the one-section format removes.
      expect(packContent.split('sparse line 200 (edited)')).toHaveLength(2);
      expect(packContent.split('dense line 7 (rewritten)')).toHaveLength(2);
      expect(packContent.split('new line 123')).toHaveLength(2);

      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'pins the WINDOW_MAX_SHARE_OF_FULL boundary itself: a windowed share just above 0.85 stays Full, just below stays Partial',
    () => {
      // The sparse-vs-dense test above only exercises the extremes (a windowed share near 0.1,
      // and near 1.0), which would still pass for almost any threshold value. These two
      // fixtures are tuned - by replaying the exact windowing and rendering arithmetic offline
      // against candidate edit spacings - to land within a couple of percentage points on
      // either side of the real 0.85 cutoff, without depending on anything OS- or
      // locale-specific: both are pure fixed-width ASCII text and plain '\n' line endings, so
      // the byte counts are identical on every platform.
      //   boundary-above.txt: 20 single-line edits spaced 48 lines apart across 1000 lines,
      //     none close enough to merge (each window is an isolated +/-20-line span). Windowed
      //     share ~0.86 -> stays "## Full file:".
      //   boundary-below.txt: 19 single-line edits spaced 50 lines apart, same shape. Windowed
      //     share ~0.82 -> stays "## Partial file:".
      const totalLines = 1000;
      const aboveEditLines: number[] = [];
      for (let line = 30; line < totalLines - 30; line += 48) aboveEditLines.push(line);
      const belowEditLines: number[] = [];
      for (let line = 30; line < totalLines - 30; line += 50) belowEditLines.push(line);

      const baseAboveLines = Array.from(
        { length: totalLines },
        (_, index) => `above share line ${String(index).padStart(4, '0')}`,
      );
      const baseBelowLines = Array.from(
        { length: totalLines },
        (_, index) => `below share line ${String(index).padStart(4, '0')}`,
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'boundary-above.txt'),
        baseAboveLines.join('\n') + '\n',
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'boundary-below.txt'),
        baseBelowLines.join('\n') + '\n',
      );
      commitAll(repoDirectory, 'base commit');

      const editedAboveLines = [...baseAboveLines];
      for (const line of aboveEditLines) editedAboveLines[line - 1] += ' (edited)';
      fs.writeFileSync(
        path.join(repoDirectory, 'boundary-above.txt'),
        editedAboveLines.join('\n') + '\n',
      );

      const editedBelowLines = [...baseBelowLines];
      for (const line of belowEditLines) editedBelowLines[line - 1] += ' (edited)';
      fs.writeFileSync(
        path.join(repoDirectory, 'boundary-below.txt'),
        editedBelowLines.join('\n') + '\n',
      );

      runBuildScript(repoDirectory);

      const packContent = readPack(repoDirectory);

      expect(packContent).toContain('## Full file: boundary-above.txt');
      expect(packContent).not.toContain('## Partial file: boundary-above.txt');
      expect(packContent).toContain('## Partial file: boundary-below.txt');
      expect(packContent).not.toContain('## Full file: boundary-below.txt');

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
      // apart. Deriving the change record from that diff puts every hunk at the wrong offset -
      // and the failure is silent, because the prefixed line numbers come from the body and
      // stay correct; what breaks is WHICH region is shown and marked. Changed code is dropped,
      // unchanged code is shown, and the section still looks perfectly well-formed. Measured on
      // a real diff, the naive derivation dropped 18 of 80 changed lines. Every rendered byte
      // now derives from the one merge-base parse, so this pins the whole pack, not just windows.
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
      const packContent = readPack(repoDirectory);

      // Non-vacuity guard: if the file were packed whole this test could not fail.
      expect(packContent).toContain('## Partial file: mixed.txt');
      const section = sectionBodyOf(packContent, '## Partial file: mixed.txt');
      const shown = new Set(
        [...section.matchAll(/^[ +] *(\d+)\t/gm)].map((match) => Number(match[1])),
      );
      const markedAdded = new Set(
        [...section.matchAll(/^\+ *(\d+)\t/gm)].map((match) => Number(match[1])),
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
      // And every changed line is MARKED added, not merely shown: an unmarked changed line
      // reads as context, which is the same misalignment in a quieter form.
      expect(changedLines.filter((lineNumber) => !markedAdded.has(lineNumber))).toEqual([]);

      // The committed edit is shown at its WORKING-TREE line number, not its HEAD one, with
      // the line it replaced rendered in place before it.
      expect(section).toContain(
        markedLine('-', null, 'line 200') + '\n' + markedLine('+', 201 + PREPENDED, 'line 200 (committed after base)'),
      );
      expect(section).toContain(markedLine('+', 1, 'uncommitted preamble 0'));
      expect(section).toContain(markedLine(' ', PREPENDED + 1, 'line 0'));
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
      //     and noprefix drops them. The parser keys every file off `+++ b/<path>` from a
      //     commit-vs-working-tree diff - exactly the case mnemonic prefixes apply to - so
      //     either one switches the whole parse off: no markers, every file in the unparsed
      //     residual.
      //   context no longer reaches a rendered byte (every rendered diff is --unified=0) but
      //     stays in this loop so the pin stays honest about what it guards.
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

      runBuildScript(repoDirectory);
      const defaultConfigPack = readPack(repoDirectory);
      // Non-vacuity guard: without windowing and a marked edit under the default config there
      // is nothing for the hostile configs to differ FROM, and the loop below would pass
      // trivially.
      expect(defaultConfigPack).toContain('## Partial file: sparse.txt');
      expect(defaultConfigPack).toContain(markedLine('+', 201, 'sparse line 200 (edited)'));

      for (const [key, value] of [
        ['diff.mnemonicPrefix', 'true'],
        ['diff.noprefix', 'true'],
        ['diff.context', '25'],
        ['diff.renames', 'false'],
        // A real external differ, not a bogus one: `echo` exists on every platform's PATH
        // (Windows resolves it through the Git-for-Windows shell git uses to spawn diff
        // drivers), so this exercises the "diff replaced by arbitrary output" path rather
        // than the "spawn failed" path. Without --no-ext-diff the parse sees echo's output
        // and the pack is unrecognisable.
        ['diff.external', 'echo'],
      ]) {
        runGit(['config', key, value], repoDirectory);
        runBuildScript(repoDirectory);
        expect(readPack(repoDirectory)).toBe(defaultConfigPack);
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

      const packContent = readPack(repoDirectory);

      expect(packContent).toContain('## Partial file: gap-merge.txt');
      // A single merged window, not two: reverting the merge to "always emit a separate window
      // per hunk" would report 2 windows here even though the shown/omitted line assertions
      // below could still coincidentally look plausible.
      expect(packContent).toContain('in 1 window;');

      const section = sectionBodyOf(packContent, '## Partial file: gap-merge.txt');

      // Both edited lines are shown and marked, each preceded in place by the line it replaced.
      expect(section).toContain(
        markedLine('-', null, 'gap merge line 99') + '\n' + markedLine('+', 100, 'gap merge line 99 (edited)'),
      );
      expect(section).toContain(
        markedLine('-', null, 'gap merge line 142') + '\n' + markedLine('+', 143, 'gap merge line 142 (edited)'),
      );
      // The "gap" between the two raw hunks (working-tree lines 121-122, untouched) belongs to
      // the SAME merged window, so it is shown rather than elided, marked unchanged.
      expect(section).toContain(markedLine(' ', 121, 'gap merge line 120'));
      expect(section).toContain(markedLine(' ', 122, 'gap merge line 121'));

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
    'pins the WINDOW_MERGE_GAP_LINES boundary itself: a 5-line context-expanded gap merges, a 6-line gap does not',
    () => {
      // The merge test above uses a 3-line context-expanded gap - comfortably inside the
      // WINDOW_MERGE_GAP_LINES (5) boundary, not pinning it. Two window ranges are
      // [edit - 20, edit + 20], so for edits at p1 and p2 the post-expansion gap is
      // p2 - p1 - 40. Setting p2 - p1 = 45 lands the gap at exactly 5 (merge condition is
      // `start <= previousEnd + 5`, so 5 is the last value that still merges); setting
      // p2 - p1 = 46 lands the gap at exactly 6, one past the boundary, which must NOT merge.
      // Both pairs live in one file, far enough apart from each other (200 lines) that they
      // cannot interact.
      const boundaryLines = Array.from(
        { length: 500 },
        (_, index) => `merge boundary line ${index}`,
      );
      fs.writeFileSync(
        path.join(repoDirectory, 'merge-gap-boundary.txt'),
        boundaryLines.join('\n') + '\n',
      );
      commitAll(repoDirectory, 'base commit');

      // Pair A: p1=100, p2=145 (delta 45, gap exactly 5) -> must merge into one window.
      boundaryLines[99] = 'merge boundary line 99 (pair A edit one)';
      boundaryLines[144] = 'merge boundary line 144 (pair A edit two)';
      // Pair B: p1=300, p2=346 (delta 46, gap exactly 6) -> must stay two separate windows.
      boundaryLines[299] = 'merge boundary line 299 (pair B edit one)';
      boundaryLines[345] = 'merge boundary line 345 (pair B edit two)';
      fs.writeFileSync(
        path.join(repoDirectory, 'merge-gap-boundary.txt'),
        boundaryLines.join('\n') + '\n',
      );

      runBuildScript(repoDirectory);

      const packContent = readPack(repoDirectory);

      expect(packContent).toContain('## Partial file: merge-gap-boundary.txt');
      // Three windows total: pair A's merge collapses two raw ranges into one, pair B's two
      // ranges stay separate. A regression to "always merge" would report 2; a regression to
      // "never merge" would report 4.
      expect(packContent).toContain('in 3 windows;');

      const section = sectionBodyOf(packContent, '## Partial file: merge-gap-boundary.txt');

      // Pair A: both edits shown, AND everything between them (lines 101-144) shown too, since
      // they now live inside one merged window with no marker in between.
      expect(section).toContain(markedLine('+', 100, 'merge boundary line 99 (pair A edit one)'));
      expect(section).toContain(markedLine('+', 145, 'merge boundary line 144 (pair A edit two)'));
      expect(section).toContain(markedLine(' ', 122, 'merge boundary line 121'));
      expect(section).not.toMatch(/unchanged lines omitted \(1(0[1-9]|[1-3]\d|4[0-4])-/);

      // Pair B: both edits shown, but the exact 5-line gap between their expanded windows
      // (working-tree lines 321-325) is elided rather than merged away.
      expect(section).toContain(markedLine('+', 300, 'merge boundary line 299 (pair B edit one)'));
      expect(section).toContain(markedLine('+', 346, 'merge boundary line 345 (pair B edit two)'));
      expect(section).toContain('      ..... 5 unchanged lines omitted (321-325) .....');

      assertElisionMarkerArithmetic(section);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'anchors a pure-deletion hunk at its collapse point, renders the removed lines in place, and shows context on both sides',
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

      const packContent = readPack(repoDirectory);

      // Non-vacuity guard: windowing must actually engage for the line-120 assertion below to
      // mean anything.
      expect(packContent).toContain('## Partial file: deletion.txt');
      expect(packContent).not.toContain('## Full file: deletion.txt');

      const section = sectionBodyOf(packContent, '## Partial file: deletion.txt');

      // The last surviving line before the gap (working-tree line 100), the five removed lines
      // in place with no line number, and the first surviving line after it (working-tree line
      // 101): the finder sees exactly what was removed and between which lines.
      expect(section).toContain(
        [
          markedLine(' ', 100, 'deletion line 99'),
          ...deletionLines.slice(100, 105).map((text) => markedLine('-', null, text)),
          markedLine(' ', 101, 'deletion line 105'),
        ].join('\n'),
      );

      // Context extends WINDOW_CONTEXT_LINES (20) on each side of the anchor at working-tree
      // line 100: line 120 is the last line inside the window, line 121 the first excluded one.
      expect(section).toContain(markedLine(' ', 120, 'deletion line 124'));
      expect(section).not.toContain('deletion line 125');
      // And symmetrically on the near side: line 80 is the first line inside the window, line
      // 79 the first excluded one going backward.
      expect(section).toContain(markedLine(' ', 80, 'deletion line 79'));
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

      const packContent = readPack(repoDirectory);

      expect(packContent).toContain('## Partial file: boundary.txt');
      const section = sectionBodyOf(packContent, '## Partial file: boundary.txt');

      const totalLinesMatch = section.match(/\((\d+) lines total/);
      expect(totalLinesMatch).not.toBeNull();
      const totalLines = Number(totalLinesMatch![1]);

      const shownLineNumbers = [...section.matchAll(/^[ +] *(\d+)\t/gm)].map((match) =>
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

      expect(section).toContain(markedLine('+', 5, 'boundary line 4 (edited)'));
      expect(section).toContain(markedLine('+', 295, 'boundary line 294 (edited)'));

      assertElisionMarkerArithmetic(section);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'marks every line (+ added, space unchanged, - removed in place with no number) including deletions at line 0 and at EOF, and renders the same file at the hunk tier under --body-cap 0',
    () => {
      // markers.txt: 60 committed lines. The working tree drops the first two, edits one in
      // the middle, inserts one, and drops the last three, so one file exercises all four
      // removed-line placements: before line 1, before a replaced line, nowhere (a pure
      // insertion has nothing removed), and after the last content line - where the removed
      // lines anchor before the phantom empty last line that a newline-terminated file's
      // split leaves behind.
      const originalLines = Array.from({ length: 60 }, (_, index) => `marker line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'markers.txt'), originalLines.join('\n') + '\n');
      // no-newline.txt: the `\ No newline at end of file` annotation is not content and must
      // not leak into a rendered line.
      fs.writeFileSync(path.join(repoDirectory, 'no-newline.txt'), 'a\nb');
      commitAll(repoDirectory, 'base commit');

      const editedLines = originalLines.slice(2, 57);
      editedLines[28] = 'marker line 30 (edited)';
      editedLines.splice(39, 0, 'inserted line');
      fs.writeFileSync(path.join(repoDirectory, 'markers.txt'), editedLines.join('\n') + '\n');
      fs.writeFileSync(path.join(repoDirectory, 'no-newline.txt'), 'a\nb\nc');

      runBuildScript(repoDirectory);
      const fullPack = readPack(repoDirectory);

      // At 20 lines of context the four windows merge into one span over the whole 57-line
      // file, so the body tier renders it whole.
      expect(fullPack).toContain('## Full file: markers.txt (57 lines; line numbers prefixed)');
      const fullSection = sectionBodyOf(fullPack, '## Full file: markers.txt (57 lines; line numbers prefixed)\n');

      // Deletion at the top of the file: the removed lines come first, before line 1.
      expect(fullSection.startsWith(
        [
          markedLine('-', null, 'marker line 0'),
          markedLine('-', null, 'marker line 1'),
          markedLine(' ', 1, 'marker line 2'),
        ].join('\n'),
      )).toBe(true);
      // A replaced line: removed in place, then its replacement at the working-tree number.
      expect(fullSection).toContain(
        markedLine('-', null, 'marker line 30') + '\n' + markedLine('+', 29, 'marker line 30 (edited)'),
      );
      // A pure insertion: nothing removed, the new line between its unchanged neighbours.
      expect(fullSection).toContain(
        [
          markedLine(' ', 39, 'marker line 40'),
          markedLine('+', 40, 'inserted line'),
          markedLine(' ', 41, 'marker line 41'),
        ].join('\n'),
      );
      // Deletion at EOF: after the last content line, before the phantom empty line 57.
      expect(fullSection).toContain(
        [
          markedLine(' ', 56, 'marker line 56'),
          markedLine('-', null, 'marker line 57'),
          markedLine('-', null, 'marker line 58'),
          markedLine('-', null, 'marker line 59'),
          markedLine(' ', 57, ''),
        ].join('\n'),
      );
      // Exactly the diff's counts, and no unmarked line.
      expect([...fullSection.matchAll(/^- {5}\t/gm)]).toHaveLength(6);
      expect([...fullSection.matchAll(/^\+ *\d+\t/gm)]).toHaveLength(2);
      const bodyLines = fullSection.split('\n').filter((line) => line.length > 0);
      expect(bodyLines.every((line) => /^[ +-]/.test(line))).toBe(true);
      expect(fullPack).not.toMatch(/^\\ No newline/m);

      // The annotation line is skipped; the last line's newline change renders as the diff
      // says it: the old "b" removed, the new "b" and "c" added.
      expect(fullPack).toContain(
        [markedLine(' ', 1, 'a'), markedLine('-', null, 'b'), markedLine('+', 2, 'b'), markedLine('+', 3, 'c')].join('\n'),
      );

      assertTocLineAccuracyAndHeaderTotal(fullPack);

      // The light shape: the same file at 3 lines of context is a "## Changed hunks:" section
      // whose windows are [1,3], [26,43] (the edit at 29 and the insertion at 40 merge across
      // their 5-line gap), and [53,57], with the same markers in the same places.
      runBuildScript(repoDirectory, ['--body-cap', '0']);
      const lightPack = readPack(repoDirectory);
      expect(lightPack.split('\n')[1].startsWith('Light pack (every file at 3 lines of context).')).toBe(true);
      expect(lightPack).not.toMatch(/^## (Full|Partial) file: /m);
      expect(lightPack).toContain(
        '## Changed hunks: markers.txt (57 lines total; 4 hunks with 3 lines of context;',
      );
      const lightSection = sectionBodyOf(lightPack, '## Changed hunks: markers.txt');
      expect(lightSection).toContain('      ..... 22 unchanged lines omitted (4-25) .....');
      expect(lightSection).toContain('      ..... 9 unchanged lines omitted (44-52) .....');
      expect([...lightSection.matchAll(/^ {6}\.{5} /gm)]).toHaveLength(2);
      expect(lightSection).toContain(
        markedLine('-', null, 'marker line 30') + '\n' + markedLine('+', 29, 'marker line 30 (edited)'),
      );
      expect(lightSection).toContain(
        [
          markedLine(' ', 56, 'marker line 56'),
          markedLine('-', null, 'marker line 57'),
          markedLine('-', null, 'marker line 58'),
          markedLine('-', null, 'marker line 59'),
          markedLine(' ', 57, ''),
        ].join('\n'),
      );
      // The marker arithmetic must look through removed lines (which carry no number).
      assertElisionMarkerArithmetic(lightSection);
      assertTocLineAccuracyAndHeaderTotal(lightPack);
      expect(fs.readFileSync(path.join(repoDirectory, '.kangentic', 'REVIEW_PREEXISTING_DIRTY.tmp'), 'utf8')).toBe(
        'markers.txt\nno-newline.txt\n',
      );
    },
    20000,
  );

  it(
    'renders every non-body kind as one section: a deleted file with its removed lines, a pure rename, a no-net-change file, and a binary, each with exactly one TOC entry',
    () => {
      fs.writeFileSync(path.join(repoDirectory, 'deleted.txt'), 'gone one\ngone two\ngone three\n');
      fs.writeFileSync(
        path.join(repoDirectory, 'renamed-src.txt'),
        Array.from({ length: 60 }, (_, index) => `renamed line ${index}`).join('\n') + '\n',
      );
      fs.writeFileSync(path.join(repoDirectory, 'reverted.txt'), 'v1\n');
      fs.writeFileSync(path.join(repoDirectory, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x0d, 0x0a]));
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      runGit(['rm', '-q', 'deleted.txt'], repoDirectory);
      runGit(['mv', 'renamed-src.txt', 'renamed-dst.txt'], repoDirectory);
      fs.writeFileSync(path.join(repoDirectory, 'reverted.txt'), 'v2\n');
      commitAll(repoDirectory, 'delete, rename, and edit');

      // Working tree: the edit is reverted (so the file is in changedFiles through both the
      // committed and the uncommitted layer, yet has no net change against the merge base),
      // and the binary is rewritten.
      fs.writeFileSync(path.join(repoDirectory, 'reverted.txt'), 'v1\n');
      fs.writeFileSync(path.join(repoDirectory, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x48, 0x0d, 0x0a, 0x1a]));

      const buildOutput = runBuildScript(repoDirectory, [baseRef]);
      const packContent = readPack(repoDirectory);

      // A deleted file has no body to read, so it renders from the parse alone: its removed
      // lines, no numbers, under a heading that says how many.
      expect(packContent).toContain(
        [
          '## Deleted file: deleted.txt (3 lines removed)',
          markedLine('-', null, 'gone one'),
          markedLine('-', null, 'gone two'),
          markedLine('-', null, 'gone three'),
        ].join('\n'),
      );
      expect(packContent).toContain(
        '## Not shown: renamed-dst.txt (renamed from renamed-src.txt, content unchanged)',
      );
      expect(packContent).not.toContain('renamed line 7');
      expect(packContent).toContain(
        '## Not shown: reverted.txt (no net change against the merge base; changed in a commit and reverted in the working tree)',
      );
      expect(packContent).toContain('## Not shown: image.bin (binary)');
      expect(packContent).toMatch(/^- image\.bin \(churn \d+; binary\)$/m);
      expect(packContent).not.toContain('## Union diff');

      const changedFiles = parsePathsLine(buildOutput);
      expect(changedFiles).toBeDefined();
      expect([...changedFiles!].sort()).toEqual(
        ['deleted.txt', 'renamed-dst.txt', 'reverted.txt', 'image.bin'].sort(),
      );
      assertOneSectionPerChangedFile(packContent, changedFiles!);
      assertTocLineAccuracyAndHeaderTotal(packContent);

      expect(buildOutput).toMatch(
        /bodies packed 0 \(0 windowed, 0KB written of 0KB budgeted\), omitted 1; hunk sections 1 \(0 over per-file hunk cap\)/,
      );
    },
    20000,
  );

  it(
    'lists and renders the old path of a committed rename whose working-tree edits fell below the similarity threshold, so its deletion cannot fall between the two gathers',
    () => {
      // The changed-file list comes from the three-dot layer, which sees the rename as it stands
      // at HEAD (100% similar, so it lists only the new path). The change record is parsed from
      // the merge-base-to-working-tree diff, where the rewritten file no longer pairs with the old
      // one, so that diff reports the old path deleted and the new one added. Before the union in
      // the script, the deletion belonged to no listed file: it was in neither the pack nor the
      // `paths:` line, and the new path rendered as a new file with no trace of where it came from.
      const originalLines = Array.from({ length: 60 }, (_, index) => `rename line ${index}`);
      fs.writeFileSync(path.join(repoDirectory, 'src.txt'), originalLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      runGit(['mv', 'src.txt', 'dst.txt'], repoDirectory);
      commitAll(repoDirectory, 'rename, content unchanged');

      // Keep 15 of 60 lines: 25% similarity, below git's 50% rename threshold.
      const rewrittenLines = originalLines.map((line, index) => (index < 15 ? line : `rewritten line ${index}`));
      fs.writeFileSync(path.join(repoDirectory, 'dst.txt'), rewrittenLines.join('\n') + '\n');

      // Precondition guards: the three-dot layer still pairs the rename, and the two-dot diff
      // does not. Both must hold or the test passes for the wrong reason.
      expect(runGit(['-c', 'diff.renames=true', 'diff', `${baseRef}...HEAD`, '--name-status'], repoDirectory)).toMatch(/^R100\tsrc\.txt\tdst\.txt$/m);
      const mergeBase = runGit(['merge-base', baseRef, 'HEAD'], repoDirectory).trim();
      expect(runGit(['-c', 'diff.renames=true', 'diff', mergeBase, '--name-status'], repoDirectory)).toMatch(/^D\tsrc\.txt$/m);

      const buildOutput = runBuildScript(repoDirectory, [baseRef]);
      const packContent = readPack(repoDirectory);

      const changedFiles = parsePathsLine(buildOutput);
      expect(changedFiles).toBeDefined();
      expect([...changedFiles!].sort()).toEqual(['dst.txt', 'src.txt']);
      expect(buildOutput).toMatch(/^ {2}changed files: 2 \(committed 1, uncommitted 1, untracked 0, change record only 1\)$/m);

      expect(packContent).toContain(
        [
          '## Deleted file: src.txt (60 lines removed)',
          markedLine('-', null, 'rename line 0'),
        ].join('\n'),
      );
      expect(packContent).toContain(markedLine('-', null, 'rename line 59'));
      expect(packContent).toContain(
        '## Full file: dst.txt (61 lines; line numbers prefixed; new file; every line is added)',
      );
      expect(packContent).toContain(markedLine('+', 16, 'rewritten line 15'));
      assertOneSectionPerChangedFile(packContent, changedFiles!);
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'rejects a missing or non-numeric --body-cap value with exit code 2 and the usage message, before touching the repo at all',
    () => {
      // The fixture carries a real committed-plus-uncommitted change (same shape as this
      // file's first test) rather than an empty repo. An empty repo would make this test pass
      // for the wrong reason: with the validation removed, an empty repo hits the "NO CHANGES"
      // branch and exits 0 before `bodyCapBytes` is ever used, so the exit code would separate
      // 2-from-0 (or from a git crash on a HEAD-less repo) without the mutation actually being
      // exercised. With real changes present, removing the validation lets
      // `bodyCapBytes = Number('-1')` (or `Number(undefined)`, both non-positive/NaN) flow
      // straight into buildPack, which still writes a pack and exits 0 - so the red this test
      // depends on is "the script rejected nothing", not an unrelated crash.
      fs.writeFileSync(path.join(repoDirectory, 'tracked.txt'), 'line one\n');
      commitAll(repoDirectory, 'base commit');
      fs.appendFileSync(path.join(repoDirectory, 'tracked.txt'), 'line two (uncommitted)\n');

      const negativeValueResult = runBuildScriptExpectingFailure(repoDirectory, [
        '--body-cap',
        '-1',
      ]);
      expect(negativeValueResult.exitCode).toBe(2);
      expect(negativeValueResult.stderr).toContain(
        '--body-cap needs a non-negative integer byte count',
      );

      const missingValueResult = runBuildScriptExpectingFailure(repoDirectory, ['--body-cap']);
      expect(missingValueResult.exitCode).toBe(2);
      expect(missingValueResult.stderr).toContain(
        '--body-cap needs a non-negative integer byte count',
      );

      // Neither rejected run got far enough to create the output directory, let alone write
      // into it - meaningful here specifically because the fixture has real changes that WOULD
      // reach `mkdirSync` if the rejection did not fire first.
      expect(fs.existsSync(path.join(repoDirectory, '.kangentic'))).toBe(false);
    },
    20000,
  );

  it(
    'renders a mode-only change (the executable bit flipped, content unchanged) as a one-line "## Not shown:" section naming the mode transition',
    () => {
      fs.writeFileSync(path.join(repoDirectory, 'mode-only.txt'), 'unchanged content\n');
      commitAll(repoDirectory, 'base commit');
      const baseRef = runGit(['rev-parse', 'HEAD'], repoDirectory).trim();

      // Both writes are needed, for two different reasons. `git update-index --chmod` stages
      // 100755 into the index/tree directly, which is what HEAD ends up recording; committing
      // through commitStaged (not commitAll) matters here too, since `git add -A` would re-stat
      // the file from disk and clobber the staged mode bit back to 644 on a core.fileMode=true
      // checkout before the commit happens. But the script renders from a base-vs-WORKING-TREE
      // diff (`git diff <mergeBase>`, no --cached), and on a core.fileMode=true checkout (Linux,
      // macOS) that diff reads the mode from the actual file on disk, not from HEAD's tree - so
      // without also flipping the real permission bit, that diff would see 644 on both sides and
      // report no mode change at all. fs.chmodSync is the one that reaches that comparison;
      // Windows has no such bit and core.fileMode defaults false there, so the index write above
      // is what carries the change on that platform. Both are required for one assertion to hold
      // on every OS this suite runs on.
      runGit(['update-index', '--chmod=+x', 'mode-only.txt'], repoDirectory);
      fs.chmodSync(path.join(repoDirectory, 'mode-only.txt'), 0o755);
      commitStaged(repoDirectory, 'flip the executable bit only');

      runBuildScript(repoDirectory, [baseRef]);
      const packContent = readPack(repoDirectory);

      expect(packContent).toContain(
        '## Not shown: mode-only.txt (mode 100644 -> 100755, content unchanged)',
      );
      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'a tracked file over the single-file cap with parsed hunks is packed at the hunk tier with the "over 1MB, body not read" heading and zero lines of context, not a stub',
    () => {
      // Every existing oversized fixture in this file is either untracked (kind 'note', no
      // hunks) or stays under SINGLE_FILE_CAP_BYTES, so this heading - the OTHER branch of
      // hunkSectionFor's "kind === 'hunks-only'" split - has never been produced. The file must
      // stay well over 1MB even after the edit (readFileSafe re-checks size against the CURRENT
      // working-tree file), and the edit itself must be small enough that its rendered hunk
      // section stays under PACK_HUNK_SECTION_CAP_BYTES (100KB) - otherwise the stub branch
      // (covered by a sibling test below) would fire instead and this heading would never render.
      const HUGE_TRACKED_LINE_COUNT = 20000;
      const hugeLines = Array.from(
        { length: HUGE_TRACKED_LINE_COUNT },
        (_, index) => `huge tracked line ${index} ${'z'.repeat(40)}`,
      );
      fs.writeFileSync(path.join(repoDirectory, 'huge-tracked.txt'), hugeLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      // Non-vacuity guard for the ">1MB" half of this test's name: confirm the fixture is
      // actually over the cap before relying on that to route it away from the body tier.
      expect(
        fs.statSync(path.join(repoDirectory, 'huge-tracked.txt')).size,
      ).toBeGreaterThan(SINGLE_FILE_CAP_BYTES);

      const editedLines = [...hugeLines];
      editedLines[100] = `${hugeLines[100]} (edited)`;
      fs.writeFileSync(path.join(repoDirectory, 'huge-tracked.txt'), editedLines.join('\n') + '\n');

      expect(
        fs.statSync(path.join(repoDirectory, 'huge-tracked.txt')).size,
      ).toBeGreaterThan(SINGLE_FILE_CAP_BYTES);

      runBuildScript(repoDirectory);
      const packContent = readPack(repoDirectory);

      expect(packContent).toContain(
        '## Changed hunks: huge-tracked.txt (over 1MB, body not read; 1 hunk ' +
          'with 0 lines of context; line numbers prefixed and exact)',
      );
      expect(packContent).not.toContain('## Changed hunks omitted: huge-tracked.txt');

      const section = sectionBodyOf(packContent, '## Changed hunks: huge-tracked.txt');
      // The lines this heading claims come from renderHunksOnly, not the windowed body
      // renderer: the changed line itself, at its exact number, with NEITHER neighbouring line
      // shown - 0 lines of context, unlike the 3 or 20 the other renderers carry.
      expect(section).toContain(markedLine('-', null, hugeLines[100]));
      expect(section).toContain(markedLine('+', 101, editedLines[100]));
      expect(section).not.toContain(hugeLines[99]);
      expect(section).not.toContain(hugeLines[101]);

      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'a deleted file whose hunk-tier section alone is over the per-file hunk cap becomes a stub naming "deleted file", not "read on demand"',
    () => {
      // renderHunksOnly's stub heading is built once and then the byte check at the end of
      // hunkSectionFor can still overwrite it: this pins the "deleted file" arm of that
      // ternary. Every existing hunk-cap fixture in this file caps an untracked ADD, so only
      // "read on demand" has ever been produced. The committed file's raw content must exceed
      // PACK_HUNK_SECTION_CAP_BYTES (100KB) on its own - deleting all of it is what makes the
      // rendered stub-candidate section (every removed line, unabridged) exceed the same cap.
      const DELETED_LINE_COUNT = 3000;
      const deletedLines = Array.from(
        { length: DELETED_LINE_COUNT },
        (_, index) => `deleted content line ${index} ${'w'.repeat(30)}`,
      );
      fs.writeFileSync(path.join(repoDirectory, 'big-deleted.txt'), deletedLines.join('\n') + '\n');
      commitAll(repoDirectory, 'base commit');

      // Non-vacuity guard: the committed file itself, not just its rendered stand-in, is over
      // the cap this test claims to exercise.
      expect(
        fs.statSync(path.join(repoDirectory, 'big-deleted.txt')).size,
      ).toBeGreaterThan(100 * 1024);

      runGit(['rm', '-q', 'big-deleted.txt'], repoDirectory);

      const buildOutput = runBuildScript(repoDirectory);
      const packContent = readPack(repoDirectory);

      expect(packContent).not.toMatch(/^## Deleted file: big-deleted\.txt/m);
      expect(packContent).toMatch(
        /^## Changed hunks omitted: big-deleted\.txt \(\+0\/-3000 lines in 1 hunk; section \d+KB, over the per-file hunk cap; deleted file\)$/m,
      );
      expect(packContent).toContain('## Not included (read on demand)');
      expect(packContent).toMatch(
        /^- big-deleted\.txt \(churn \d+; changed hunks over the per-file hunk cap\)$/m,
      );
      expect(buildOutput).toMatch(/^ {2}omitted: big-deleted\.txt$/m);

      assertTocLineAccuracyAndHeaderTotal(packContent);
    },
    20000,
  );

  it(
    'notes the addition of a genuinely empty file as "new file, empty" and the deletion of an already-empty file as "deleted, was empty"',
    () => {
      // Both events must be driven as two SEPARATE diffs. Two empty files (or one empty file
      // added and another deleted in the same diff) are byte-identical, and git's rename
      // detector treats any two identical files as a 100% similarity match: an add and a delete
      // of empty files together get paired into "renamed from ..., content unchanged" instead of
      // either reason this test targets - confirmed empirically against a scratch repo before
      // writing this fixture.
      fs.writeFileSync(path.join(repoDirectory, 'other.txt'), 'line one\n');
      fs.writeFileSync(path.join(repoDirectory, 'empty-existing.txt'), '');
      commitAll(repoDirectory, 'base commit');

      // Diff 1: only an addition. The new file must be STAGED, not merely present untracked -
      // an untracked empty file never enters the parsed diff at all and takes the unrelated
      // "new, untracked, empty" reason instead.
      fs.writeFileSync(path.join(repoDirectory, 'empty-add.txt'), '');
      runGit(['add', 'empty-add.txt'], repoDirectory);

      runBuildScript(repoDirectory);
      const additionPack = readPack(repoDirectory);
      expect(additionPack).toContain('## Not shown: empty-add.txt (new file, empty)');
      assertTocLineAccuracyAndHeaderTotal(additionPack);

      // Commit the addition so the second diff below carries exactly one changed empty file
      // (the deletion), never both at once.
      commitAll(repoDirectory, 'commit the empty addition');

      // Diff 2: only a deletion, of a file that was already empty at the base commit.
      runGit(['rm', '-q', 'empty-existing.txt'], repoDirectory);

      runBuildScript(repoDirectory);
      const deletionPack = readPack(repoDirectory);
      expect(deletionPack).toContain('## Not shown: empty-existing.txt (deleted, was empty)');
      assertTocLineAccuracyAndHeaderTotal(deletionPack);
    },
    20000,
  );
});

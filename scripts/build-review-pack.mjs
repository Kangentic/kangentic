#!/usr/bin/env node
/**
 * Builds the /code-review shared review pack (.kangentic/REVIEW_PACK.tmp.md) and the
 * pre-existing-dirty list (.kangentic/REVIEW_PREEXISTING_DIRTY.tmp) in one invocation,
 * so the review driver pays one Bash call instead of generating a ~200KB pack through
 * the Write tool (tool input is billed as model output; a 200KB pack costs roughly
 * 100k output tokens if the driver writes it itself - see docs/code-review-fanout-audit.md).
 *
 * Usage: node scripts/build-review-pack.mjs [<baseRef>]
 *   baseRef  optional, e.g. "origin/main" or "main". Omitted or empty: working-tree
 *            changes only (uncommitted + untracked), matching the skill's no-base fallback.
 *
 * Output files (both under .kangentic/, which is gitignored):
 *   REVIEW_PACK.tmp.md          "Total lines: N", a table of contents with start lines,
 *                               the union diff, then line-numbered bodies of changed files
 *                               (largest churn first) up to the byte cap. A body whose changed
 *                               hunks cover only part of it is packed as windows around those
 *                               hunks ("## Partial file:") rather than in full; the admitted SET
 *                               is unchanged either way, so windowing only shrinks the pack.
 *   REVIEW_PREEXISTING_DIRTY.tmp  one path per line: tracked-dirty + untracked, captured
 *                               BEFORE the review pass edits anything (Step 8's set math).
 *
 * Prints a compact summary to stdout; never prints the pack itself. One line of that summary is
 * a contract rather than a nicety: `  paths: <a>, <b>, ...` is the authoritative changed-file
 * list the review driver gates its domain auditors on. It covers files the pack TRIMMED as well
 * as files it packed, which is why the driver must read it instead of the pack's table of
 * contents. Keep it labelled distinctly from the `changed files:` count line above it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACK_BODY_CAP_BYTES = 200 * 1024;
const SINGLE_FILE_CAP_BYTES = 1024 * 1024;

// A body is packed as windows around its changed hunks instead of in full when that saves a
// worthwhile share of its bytes. Most of a large file's body is unchanged code that no finder's
// criteria reach, and every pack byte is re-read by up to 11 finders while a file left out is
// read only by the finders that actually want it - so bytes spent on untouched code are the
// pack's worst-value bytes. Measured across eight merged PRs: identical file coverage, packs
// 2% to 71% smaller (docs/code-review-fanout-audit.md, the windowed-bodies section).
const WINDOW_CONTEXT_LINES = 20;
const WINDOW_MERGE_GAP_LINES = 5; // two windows closer than this merge; an elision marker costs a line
const WINDOW_MAX_SHARE_OF_FULL = 0.85; // skip windowing unless it saves at least 15% of the body

// The pack must be a function of the diff alone, not of whoever's git config happens to be in
// scope. This repo is public and `/code-review` runs on other people's machines and in CI, so a
// pack that differs per developer means a different review surface for the same commits - and
// every one of these fails SILENTLY, producing a valid-looking pack rather than an error.
//   quotepath        git octal-escapes non-ASCII path bytes, and the mangled path then fails
//                    every later existsSync lookup.
//   mnemonicPrefix   renames the diff prefixes per source (`c/` commit, `w/` working tree).
//   noprefix,        drop or replace `a/` and `b/`. The windowing pass keys file paths off the
//   src/dstPrefix    `+++ b/<path>` header of a COMMIT-vs-WORKING-TREE diff, which is exactly
//                    the case mnemonic prefixes apply to, so any of these three silently
//                    switches windowing off: no error, just a bigger pack on that machine.
//   context          changes how much context the union diff carries, so the pack's largest
//                    section grows or shrinks with a personal preference.
//   renames          off, a renamed-and-modified file scores zero churn (its numstat key never
//                    matches a real path) and ranks last instead of first.
// These are the values the pack is DEFINED against, not a claim about any git version's
// defaults (rename detection, for one, only defaults on from git 2.9). For anyone on stock
// config they change nothing; for someone who deliberately set a non-default `diff.context`
// they do change the union diff, and that is accepted - one reproducible pack everywhere beats
// honouring a personal preference in a shared review artifact.
const GIT_CONFIG_OVERRIDES = [
  'core.quotepath=false',
  'diff.mnemonicPrefix=false',
  'diff.noprefix=false',
  'diff.srcPrefix=a/',
  'diff.dstPrefix=b/',
  'diff.context=3',
  'diff.renames=true',
];

function git(...args) {
  // CRLF is normalized so line counts and pack content are identical across checkout configs.
  return execFileSync('git', [...GIT_CONFIG_OVERRIDES.flatMap((setting) => ['-c', setting]), ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');
}

// Every diff goes through here, so a future call site cannot forget the flag.
// --no-ext-diff neutralizes the last config that would rewrite the pack: a `diff.external`
// program, or a `diff=<driver>` gitattribute, replaces the diff body with arbitrary text.
// It is the one setting in this family that cannot be pinned via `-c` - an empty
// `diff.external=` makes git try to spawn the empty string and abort with
// "cannot spawn : No such file or directory", killing the whole pack build.
function gitDiff(...args) {
  return git('diff', '--no-ext-diff', ...args);
}

// Declared after git() but before any call to it: GIT_CONFIG_OVERRIDES is a const, so a call
// hoisted above its initializer would hit the temporal dead zone.
const baseRef = (process.argv[2] || '').trim();
const repoRoot = git('rev-parse', '--show-toplevel').trim();

function nameOnly(text) {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function resolveNumstatPath(rawPath) {
  // Rename detection prints "old => new" or "prefix{old => new}suffix"; churn must key on
  // the resolved new path or it never matches the plain paths `--name-only` reports.
  const braceForm = rawPath.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceForm) {
    return (braceForm[1] + braceForm[3] + braceForm[4]).replace('//', '/').replace(/^\//, '');
  }
  const arrowForm = rawPath.match(/^(.+) => (.+)$/);
  if (arrowForm) return arrowForm[2];
  return rawPath;
}

function parseNumstat(text) {
  const churn = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (match) {
      const added = match[1] === '-' ? 0 : Number(match[1]);
      const deleted = match[2] === '-' ? 0 : Number(match[2]);
      const relPath = resolveNumstatPath(match[3].trim());
      churn.set(relPath, (churn.get(relPath) || 0) + added + deleted);
    }
  }
  return churn;
}

// 1. Gather the three disjoint layers (mirrors SKILL.md Step 4).
const committedDiff = baseRef ? gitDiff(baseRef + '...HEAD') : '';
const committedNames = baseRef ? nameOnly(gitDiff(baseRef + '...HEAD', '--name-only')) : [];
const committedChurn = baseRef ? parseNumstat(gitDiff(baseRef + '...HEAD', '--numstat')) : new Map();
const uncommittedDiff = gitDiff('HEAD');
const uncommittedNames = nameOnly(gitDiff('HEAD', '--name-only'));
const uncommittedChurn = parseNumstat(gitDiff('HEAD', '--numstat'));
const untrackedNames = nameOnly(git('ls-files', '--others', '--exclude-standard'));

const changedFiles = [...new Set([...committedNames, ...uncommittedNames, ...untrackedNames])];
if (changedFiles.length === 0) {
  console.log('NO CHANGES: committed diff, uncommitted diff, and untracked list are all empty.');
  process.exit(0);
}

// 2. Pre-existing dirty list: tracked-dirty + untracked, NOT the committed-vs-base paths.
const preexistingDirty = [...new Set([...uncommittedNames, ...untrackedNames])];
const kangenticDir = join(repoRoot, '.kangentic');
mkdirSync(kangenticDir, { recursive: true });
writeFileSync(join(kangenticDir, 'REVIEW_PREEXISTING_DIRTY.tmp'), preexistingDirty.join('\n') + '\n');

// 3. Untracked files enter the diff as synthetic added-file blocks.
const fileContentCache = new Map();
function readFileSafe(relPath) {
  // Memoized: an untracked file is needed by the synthetic diff, the churn ranking, and the
  // packing loop; only the first call pays the read and binary scan.
  if (fileContentCache.has(relPath)) return fileContentCache.get(relPath);
  let body = null; // stays null for missing, oversized, or binary files
  const absolute = join(repoRoot, relPath);
  if (existsSync(absolute) && statSync(absolute).size <= SINGLE_FILE_CAP_BYTES) {
    const content = readFileSync(absolute);
    if (!content.includes(0)) {
      body = content.toString('utf8').replace(/\r\n/g, '\n');
    }
  }
  fileContentCache.set(relPath, body);
  return body;
}

const fileLinesCache = new Map();
function readFileLines(relPath) {
  // Every consumer of a body wants it split, and the same file is split by the synthetic-diff
  // loop, the churn ranking, and the packing loop. Memoize the array itself so a large file is
  // split once rather than three or four times. Null propagates for missing/oversized/binary.
  if (fileLinesCache.has(relPath)) return fileLinesCache.get(relPath);
  const body = readFileSafe(relPath);
  const lines = body === null ? null : body.split('\n');
  fileLinesCache.set(relPath, lines);
  return lines;
}

// 3b. Changed line ranges per file, in WORKING-TREE coordinates.
// This must not be parsed out of the union diff. That diff's committed layer is three-dot
// (`base...HEAD`), so its new-side line numbers are HEAD-relative, while the body we window is
// read from the working tree - for any file that is both committed-vs-base AND dirty the two
// disagree, and a window placed at the wrong offset is worse than no window at all, because the
// finder gets confidently-labelled line numbers pointing at the wrong code. One two-dot diff from
// the merge base to the working tree gives every layer's changes in one coordinate system.
const hunkRangesByPath = (() => {
  const ranges = new Map();
  // Both calls are defensive: this repo is public and the script runs against whatever git
  // config a user has. If either fails, fall back to packing every body in full rather than
  // failing the whole review. An empty map means "window nothing".
  // Note what this does NOT cover. A base ref with no common ancestor never reaches here: the
  // layer-1 gather above calls `gitDiff(baseRef + '...HEAD')` unguarded, and three-dot notation
  // needs the same merge base, so it throws first and takes the whole build with it (measured
  // on an orphan branch: `fatal: <sha>...HEAD: no merge base`, packer exit 1, raised at the
  // layer-1 call). That is pre-existing behaviour and guarding it is a separate fix. This catch
  // covers only a failure isolated to these two calls.
  let text;
  try {
    const mergeBase = baseRef ? git('merge-base', baseRef, 'HEAD').trim() : 'HEAD';
    // `a/` and `b/` are guaranteed by GIT_CONFIG_OVERRIDES, which is why the parser below can
    // require the `b/` prefix rather than treating it as optional. Git still C-quotes a path
    // containing a quote, a backslash, or a control character (`+++ "b/od\"d.ts"`) whatever
    // quotepath says; such a header simply does not match, the file gets no windows, and it is
    // packed in full. That is the safe direction to fail - a larger pack, never a misplaced
    // window - so it is left as graceful degradation rather than a second parser.
    text = gitDiff('--unified=0', mergeBase);
  } catch {
    return ranges;
  }
  let currentPath = null;
  for (const line of text.split('\n')) {
    // Reset per file, so a format with no `+++` line (a binary or mode-only change) cannot
    // leave the previous file's path in scope for whatever parses next.
    if (line.startsWith('diff --git ')) { currentPath = null; continue; }
    // `+++ b/<path>` rather than the `diff --git` line: the latter concatenates both paths, so a
    // path containing a space cannot be split back out of it unambiguously. The `b/` is required
    // because the prefix is forced above; a repo with a real top-level `b/` directory therefore
    // still resolves to `b/<path>` rather than losing its first segment.
    // A deleted file needs no check here: git writes its new side as a bare `+++ /dev/null`,
    // never under the `b/` prefix, so the match simply fails and the `diff --git` reset above
    // has already cleared currentPath. Such a file gets no windows and is packed in full.
    const targetHeader = line.match(/^\+\+\+ b\/(.*)$/);
    if (targetHeader) {
      currentPath = targetHeader[1];
      continue;
    }
    if (!currentPath) continue;
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // `+N,0` is a pure deletion: nothing exists on the new side, so anchor a point at N and let
    // the context expansion show the code the removed lines used to sit between.
    const list = ranges.get(currentPath) || [];
    list.push(length === 0 ? [start, start] : [start, start + length - 1]);
    ranges.set(currentPath, list);
  }
  return ranges;
})();

function windowsFor(relPath, totalLines) {
  const raw = hunkRangesByPath.get(relPath);
  if (!raw || raw.length === 0) return null;
  const expanded = raw
    .map(([start, end]) => [
      Math.max(1, start - WINDOW_CONTEXT_LINES),
      Math.min(totalLines, end + WINDOW_CONTEXT_LINES),
    ])
    .filter(([start, end]) => end >= start)
    .sort((a, b) => a[0] - b[0]);
  if (expanded.length === 0) return null;
  const merged = [];
  for (const [start, end] of expanded) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1] + WINDOW_MERGE_GAP_LINES) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

// Takes the text and its 1-based number rather than the array and an index, so neither caller
// has to re-derive one from the other: the full-body render already has the text in hand, and
// the windowed render already counts in 1-based line numbers.
function numberLine(lineText, lineNumber) {
  return String(lineNumber).padStart(5) + '\t' + lineText;
}

function renderFullBody(lines) {
  return lines.map((lineText, index) => numberLine(lineText, index + 1)).join('\n');
}

function renderWindowedBody(lines, windows) {
  const parts = [];
  let previousEnd = 0;
  for (const [start, end] of windows) {
    const skipped = start - previousEnd - 1;
    if (skipped > 0) {
      parts.push(`      ..... ${skipped} unchanged lines omitted (${previousEnd + 1}-${start - 1}) .....`);
    }
    for (let lineNumber = start; lineNumber <= end; lineNumber++) parts.push(numberLine(lines[lineNumber - 1], lineNumber));
    previousEnd = end;
  }
  const trailing = lines.length - previousEnd;
  if (trailing > 0) {
    parts.push(`      ..... ${trailing} unchanged lines omitted (${previousEnd + 1}-${lines.length}) .....`);
  }
  return parts.join('\n');
}

let syntheticBlocks = '';
for (const relPath of untrackedNames) {
  const lines = readFileLines(relPath);
  if (lines === null) continue;
  syntheticBlocks += `\ndiff --git a/${relPath} b/${relPath}\nnew file\n--- /dev/null\n+++ b/${relPath}\n`;
  syntheticBlocks += lines.map((line) => '+' + line).join('\n') + '\n';
}
const unionDiff = [committedDiff, uncommittedDiff, syntheticBlocks].filter((part) => part.trim()).join('\n');

// 4. Bodies, largest churn first, capped. Admission is decided on FULL-body cost even when a
// windowed body is what gets written, so the packed SET is exactly what it was before windowing.
// Set, not the array: churnOf runs once per changed file, so an array `includes` here is
// O(changedFiles x untrackedNames) on a diff that is mostly new files.
const untrackedNameSet = new Set(untrackedNames);
const churnOf = (relPath) => {
  if (untrackedNameSet.has(relPath)) {
    const lines = readFileLines(relPath);
    return lines ? lines.length : 0;
  }
  return (committedChurn.get(relPath) || 0) + (uncommittedChurn.get(relPath) || 0);
};
const ranked = changedFiles
  .map((relPath) => ({ relPath, churn: churnOf(relPath) }))
  .sort((a, b) => b.churn - a.churn);

const packedSections = [];
const omitted = [];
let bodyBytes = 0;
for (const { relPath, churn } of ranked) {
  const lines = readFileLines(relPath);
  if (lines === null) { omitted.push({ relPath, churn, reason: 'binary, missing, or >1MB' }); continue; }
  const full = renderFullBody(lines);
  const fullBytes = Buffer.byteLength(full);
  // Windowed only when it saves a worthwhile share; an untracked file has no hunks and a
  // densely-changed one windows to nearly its whole body, so both keep their full text.
  const windows = windowsFor(relPath, lines.length);
  const windowed = windows ? renderWindowedBody(lines, windows) : null;
  const windowedBytes = windowed === null ? Infinity : Buffer.byteLength(windowed);
  const useWindow = windowedBytes <= fullBytes * WINDOW_MAX_SHARE_OF_FULL;
  const numbered = useWindow ? windowed : full;
  const sectionBytes = useWindow ? windowedBytes : fullBytes;
  // The admitted SET is decided on full-body cost, exactly as before windowing existed, so a
  // file that ships today can never be displaced by a newly-affordable larger one (a greedy
  // knapsack reorders badly: measured, spending the freed budget cost PR337 three files).
  // Windowing then only shrinks what that set costs.
  // The reason names the FULL body, because that is what the budget was tested against. Saying
  // plain "over pack cap" beside a pack that wrote well under the cap reads as a broken packer.
  if (bodyBytes + fullBytes > PACK_BODY_CAP_BYTES) { omitted.push({ relPath, churn, reason: 'full body over pack cap' }); continue; }
  bodyBytes += fullBytes;
  packedSections.push({
    relPath,
    churn,
    numbered,
    lines: lines.length,
    shownLines: useWindow ? windowed.split('\n').length : lines.length,
    windowed: useWindow,
    windowCount: useWindow ? windows.length : 0,
    sectionBytes,
  });
}
const packedBodyBytes = packedSections.reduce((sum, section) => sum + section.sectionBytes, 0);
const windowedCount = packedSections.filter((section) => section.windowed).length;

// 5. Assemble with a line-accurate table of contents.
const diffLines = unionDiff.split('\n');
const tocEntries = [];
const bodyParts = [];
// Layout below the header block: TOC lines, blank, then sections. Compute in two passes.
function sectionHeader(section) {
  if (!section.windowed) {
    return `## Full file: ${section.relPath} (${section.lines} lines; line numbers prefixed)`;
  }
  // Name the omission in the heading, not only at the elision markers. A finder that cannot tell
  // what a section guarantees re-reads the whole file, which costs the pack bytes AND keeps the
  // duplicate read - the one way this change loses.
  return (
    `## Partial file: ${section.relPath} (${section.lines} lines total; ` +
    `every changed hunk shown with ${WINDOW_CONTEXT_LINES} lines of context, in ${section.windowCount} ` +
    `window${section.windowCount === 1 ? '' : 's'}; unchanged runs between them are marked and omitted; ` +
    `line numbers prefixed and exact)`
  );
}
const headerLineCountFor = (tocCount) => 1 + 1 + tocCount + 1; // Total-lines line + "## Contents" + entries + blank
let cursor = headerLineCountFor(1 + packedSections.length) + 1; // first line after the header block
tocEntries.push({ label: 'Union diff', startLine: cursor });
cursor += 1 + diffLines.length + 1; // heading + diff body + trailing blank
for (const section of packedSections) {
  tocEntries.push({ label: section.relPath, startLine: cursor });
  // shownLines, not lines: a windowed section renders fewer lines than the file has, plus one
  // line per elision marker. Finders navigate by these offsets, so they must count what is
  // actually written, not what the file contains.
  cursor += 1 + section.shownLines + 1; // heading + body + blank
}
bodyParts.push('## Contents (start line)');
for (const entry of tocEntries) bodyParts.push(`- line ${entry.startLine}: ${entry.label}`);
bodyParts.push('');
bodyParts.push('## Union diff');
bodyParts.push(unionDiff);
bodyParts.push('');
for (const section of packedSections) {
  bodyParts.push(sectionHeader(section));
  bodyParts.push(section.numbered);
  bodyParts.push('');
}
if (omitted.length) {
  bodyParts.push('## Not included (read on demand)');
  for (const entry of omitted) bodyParts.push(`- ${entry.relPath} (churn ${entry.churn}; ${entry.reason})`);
}
// The header's total is derived from the assembled text, never from the cursor arithmetic
// (which only feeds the TOC start lines): finders size their reads off this number, so every
// trailing section - including the omitted-files list - must be counted.
const tailText = bodyParts.join('\n');
const totalLines = 1 + tailText.split('\n').length;
const packText = `Total lines: ${totalLines}. Read sequentially with offset/limit; at most 2000 lines return per Read call.\n` + tailText;
const packPath = join(kangenticDir, 'REVIEW_PACK.tmp.md');
writeFileSync(packPath, packText);

// 6. Summary only - never print the pack.
console.log(`Review pack written: ${packPath}`);
console.log(`  changed files: ${changedFiles.length} (committed ${committedNames.length}, uncommitted ${uncommittedNames.length}, untracked ${untrackedNames.length})`);
// Labelled distinctly from the count line above: the driver reads THIS line to decide
// which gated finders to spawn.
console.log(`  paths: ${changedFiles.join(', ')}`);
// totalLines, not a re-split of packText: they are equal by construction (packText is the
// one header line plus tailText) and the pack can be hundreds of KB.
console.log(`  pack: ${(Buffer.byteLength(packText) / 1024).toFixed(0)}KB, ${totalLines} lines; diff ${(Buffer.byteLength(unionDiff) / 1024).toFixed(0)}KB; bodies packed ${packedSections.length} (${windowedCount} windowed, ${(packedBodyBytes / 1024).toFixed(0)}KB written of ${(bodyBytes / 1024).toFixed(0)}KB budgeted), omitted ${omitted.length}`);
console.log(`  preexisting dirty: ${preexistingDirty.length} paths -> REVIEW_PREEXISTING_DIRTY.tmp`);
if (omitted.length) console.log('  omitted: ' + omitted.map((entry) => entry.relPath).join(', '));

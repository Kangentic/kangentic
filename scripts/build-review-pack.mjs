#!/usr/bin/env node
/**
 * Builds the /code-review shared review pack (.kangentic/REVIEW_PACK.tmp.md) and the
 * pre-existing-dirty list (.kangentic/REVIEW_PREEXISTING_DIRTY.tmp) in one invocation,
 * so the review driver pays one Bash call instead of generating a ~200KB pack through
 * the Write tool (tool input is billed as model output; a 200KB pack costs roughly
 * 100k output tokens if the driver writes it itself - see docs/code-review-fanout-audit.md).
 *
 * Usage: node scripts/build-review-pack.mjs [<baseRef>] [--body-cap <bytes>]
 *   baseRef     optional, e.g. "origin/main" or "main". Omitted or empty: working-tree
 *               changes only (uncommitted + untracked), matching the skill's no-base fallback.
 *   --body-cap  optional byte budget for the body tier (default PACK_BODY_CAP_BYTES). `0`
 *               renders every readable file at the hunk tier, the "light pack" shape that
 *               scripts/replay-review-pack-corpus.mjs measures; the review skill never passes it.
 *
 * Output files (both under .kangentic/, which is gitignored):
 *   REVIEW_PACK.tmp.md          "Total lines: N", a one-line format legend, a table of contents
 *                               with a start line for EVERY changed file, then one section per
 *                               changed file, largest churn first. There is no separate diff:
 *                               each changed line appears exactly once, in its file's section,
 *                               as `<marker><line number, 5 wide><tab><text>` with "+" added,
 *                               " " unchanged, and "-" removed (no number; shown in place before
 *                               the line that follows it). A file admitted under the body cap is
 *                               "## Full file:" or "## Partial file:" (every changed hunk with 20
 *                               lines of context); every other readable file is "## Changed
 *                               hunks:" (the same renderer at 3 lines of context), unless that
 *                               section alone exceeds the per-file hunk cap, in which case it is
 *                               a one-line "## Changed hunks omitted:" stub. Deleted, binary,
 *                               rename-only, and mode-only files get a one-line section too.
 *   REVIEW_PREEXISTING_DIRTY.tmp  one path per line: tracked-dirty + untracked, captured
 *                               BEFORE the review pass edits anything (Step 8's set math).
 *
 * Prints a compact summary to stdout; never prints the pack itself. One line of that summary is
 * a contract rather than a nicety: `  paths: <a>, <b>, ...` is the authoritative changed-file
 * list the review driver gates its domain auditors on. It is the script's own changedFiles
 * array, so it cannot disagree with what the pack was built from. Keep it labelled distinctly
 * from the `changed files:` count line above it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACK_BODY_CAP_BYTES = 200 * 1024;
const SINGLE_FILE_CAP_BYTES = 1024 * 1024;

// A hunk-tier section over this many bytes is replaced by a one-line stub. This is a fact about
// the file alone (like SINGLE_FILE_CAP_BYTES for bodies), never a knapsack over its neighbours: a
// global cap would make a file's presence depend on what else changed, the reorder hazard the
// admission comment below records. Half the body cap: a single file whose changed lines alone
// would take half the pack's body budget is a lockfile, a generated bundle, or a snapshot dump,
// which no finder reads linearly. The pack is therefore bounded by the review's own changed
// lines plus the body cap, not by a constant; docs/code-review-fanout-audit.md section 14
// records how often the corpus hits this ceiling.
const PACK_HUNK_SECTION_CAP_BYTES = 100 * 1024;

// A body is packed as windows around its changed hunks instead of in full when that saves a
// worthwhile share of its bytes. Most of a large file's body is unchanged code that no finder's
// criteria reach, and every pack byte is re-read by up to 11 finders while a file left out is
// read only by the finders that actually want it - so bytes spent on untouched code are the
// pack's worst-value bytes. Measured across eight merged PRs: identical file coverage, packs
// 2% to 71% smaller (docs/code-review-fanout-audit.md, the windowed-bodies section).
const WINDOW_CONTEXT_LINES = 20; // body tier: a file admitted under the body cap
const HUNK_CONTEXT_LINES = 3; // hunk tier: every other readable file, what the union diff used to carry
const WINDOW_MERGE_GAP_LINES = 5; // two windows closer than this merge; an elision marker costs a line
const WINDOW_MAX_SHARE_OF_FULL = 0.85; // skip windowing unless it saves at least 15% of the body

// The pack must be a function of the diff alone, not of whoever's git config happens to be in
// scope. This repo is public and `/code-review` runs on other people's machines and in CI, so a
// pack that differs per developer means a different review surface for the same commits - and
// every one of these fails SILENTLY, producing a valid-looking pack rather than an error.
//   quotepath        git octal-escapes non-ASCII path bytes, and the mangled path then fails
//                    every later existsSync lookup.
//   mnemonicPrefix   renames the diff prefixes per source (`c/` commit, `w/` working tree).
//   noprefix,        drop or replace `a/` and `b/`. The parser keys every file off the
//   src/dstPrefix    `+++ b/<path>` header of a COMMIT-vs-WORKING-TREE diff, which is exactly
//                    the case mnemonic prefixes apply to, so any of these three switches the
//                    WHOLE parse off: every file would land in the unparsed residual and no
//                    section would carry a marker. Since the whole pack now renders from that
//                    parse, these pins are more load-bearing than when they only guarded windows.
//   context          no longer reaches any rendered byte (every diff the pack renders is
//                    `--unified=0`, and `--name-only` / `--numstat` ignore it); pinned anyway so
//                    a future call site cannot inherit a personal value.
//   renames          off, a renamed-and-modified file scores zero churn (its numstat key never
//                    matches a real path) and ranks last instead of first.
// These are the values the pack is DEFINED against, not a claim about any git version's
// defaults (rename detection, for one, only defaults on from git 2.9). For anyone on stock
// config they change nothing.
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
const cliArguments = process.argv.slice(2);
let baseRef = '';
let bodyCapBytes = PACK_BODY_CAP_BYTES;
for (let argumentIndex = 0; argumentIndex < cliArguments.length; argumentIndex++) {
  const argument = cliArguments[argumentIndex];
  if (argument === '--body-cap') {
    const value = cliArguments[argumentIndex + 1];
    if (value === undefined || !/^\d+$/.test(value)) {
      console.error('--body-cap needs a non-negative integer byte count');
      process.exit(2);
    }
    bodyCapBytes = Number(value);
    argumentIndex++;
  } else if (!baseRef) {
    baseRef = argument.trim();
  }
}
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

// 1. Gather the three disjoint layers (mirrors SKILL.md Step 4): names and churn only. The diff
// TEXT the pack renders comes from one two-dot merge-base diff below, never from these layers.
// One `--numstat` per layer yields both: a numstat line carries its path (rename notation
// resolved by parseNumstat), so a separate `--name-only` spawn would list the same set in the
// same order. Every git process costs tens of milliseconds on Windows; this build spawns six.
const committedChurn = baseRef ? parseNumstat(gitDiff(baseRef + '...HEAD', '--numstat')) : new Map();
const committedNames = [...committedChurn.keys()];
const uncommittedChurn = parseNumstat(gitDiff('HEAD', '--numstat'));
const uncommittedNames = [...uncommittedChurn.keys()];
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

// 3. Working-tree bodies, memoized: a body is wanted by the churn ranking (untracked files rank
// by line count), the admission key, and up to two renders, so it is read and split once.
const fileContentCache = new Map();
function readFileSafe(relPath) {
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
  if (fileLinesCache.has(relPath)) return fileLinesCache.get(relPath);
  const body = readFileSafe(relPath);
  const lines = body === null ? null : body.split('\n');
  fileLinesCache.set(relPath, lines);
  return lines;
}

// 3b. The change record, per file, in WORKING-TREE coordinates.
// Every rendered byte derives from this one parse. It must be a two-dot diff from the merge
// base to the working tree, never the three-dot committed layer: that layer's new-side line
// numbers are HEAD-relative, while the body we render is read from the working tree, and for any
// file that is both committed-vs-base AND dirty the two disagree. A window placed at the wrong
// offset is worse than no window at all, because the finder gets confidently-labelled line
// numbers pointing at the wrong code (measured on a real mixed-layer file: 18 of 80 changed lines
// dropped). There is no fallback when this parse fails: a pack with no markers would claim nothing
// changed, so a failure here is loud rather than a quietly wrong review surface.
//
// `a/` and `b/` are guaranteed by GIT_CONFIG_OVERRIDES, which is why the parser can require the
// `b/` prefix rather than treating it as optional. Git still C-quotes a path containing a quote, a
// backslash, or a control character (`+++ "b/od\"d.ts"`) whatever quotepath says; such a block
// keys to nothing and lands verbatim in the unparsed residual section, so it is never lost.
function symmetricPathFromDiffLine(diffLine) {
  // `diff --git a/P b/P`: a block with no `---`/`+++` lines (binary, mode-only, an empty file
  // added or deleted) names its path only here. Both halves are the same path, so the split is
  // unambiguous even when the path contains a space: the remainder is `a/` + P + ` b/` + P.
  const remainder = diffLine.slice('diff --git '.length);
  if ((remainder.length - 5) % 2 !== 0) return null;
  const pathLength = (remainder.length - 5) / 2;
  if (pathLength <= 0 || !remainder.startsWith('a/')) return null;
  const candidate = remainder.slice(2, 2 + pathLength);
  return remainder.slice(2 + pathLength) === ' b/' + candidate ? candidate : null;
}

function parseUnifiedZeroDiff(text) {
  const filesByPath = new Map();
  const unparsedBlocks = [];
  for (const block of text.split(/^(?=diff --git )/m)) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const parsed = { newFile: false, deleted: false, binary: false, renamedFrom: null, modeChange: null, hunks: [] };
    let oldPath = null;
    let newPath = null;
    let renamedTo = null;
    let oldMode = null;
    let newMode = null;
    let hunkStartIndex = lines.length;
    for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.startsWith('@@ ')) { hunkStartIndex = lineIndex; break; }
      if (line.startsWith('new file mode ')) parsed.newFile = true;
      else if (line.startsWith('deleted file mode ')) parsed.deleted = true;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) parsed.binary = true;
      else if (line.startsWith('rename from ')) parsed.renamedFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) renamedTo = line.slice('rename to '.length);
      else if (line.startsWith('old mode ')) oldMode = line.slice('old mode '.length);
      else if (line.startsWith('new mode ')) newMode = line.slice('new mode '.length);
      else if (line.startsWith('--- a/')) oldPath = line.slice('--- a/'.length);
      else if (line.startsWith('+++ b/')) newPath = line.slice('+++ b/'.length);
      else if (line === '--- /dev/null') parsed.newFile = true;
      else if (line === '+++ /dev/null') parsed.deleted = true;
    }
    if (oldMode !== null && newMode !== null) parsed.modeChange = [oldMode, newMode];
    // Keyed by the new-side path: the `diff --git` line concatenates both paths, so a path with a
    // space cannot be split out of it unless the two halves are identical (the fallback below).
    // A deleted file has a bare `+++ /dev/null`, so it keys off its old side instead.
    let relPath = newPath;
    if (relPath === null && parsed.deleted) relPath = oldPath;
    if (relPath === null) relPath = renamedTo;
    if (relPath === null) relPath = symmetricPathFromDiffLine(lines[0]);
    if (relPath === null) { unparsedBlocks.push(block); continue; }
    for (let lineIndex = hunkStartIndex; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const hunkHeader = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (hunkHeader) {
        parsed.hunks.push({
          newStart: Number(hunkHeader[1]),
          newLength: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
          removed: [],
          added: [],
        });
        continue;
      }
      const currentHunk = parsed.hunks[parsed.hunks.length - 1];
      if (!currentHunk) continue;
      // `\ No newline at end of file` annotates the line above it and is not content.
      if (line.startsWith('-')) currentHunk.removed.push(line.slice(1));
      else if (line.startsWith('+')) currentHunk.added.push(line.slice(1));
    }
    filesByPath.set(relPath, parsed);
  }
  return { filesByPath, unparsedBlocks };
}

const mergeBase = baseRef ? git('merge-base', baseRef, 'HEAD').trim() : 'HEAD';
const { filesByPath: parsedByPath, unparsedBlocks } = parseUnifiedZeroDiff(gitDiff('--unified=0', mergeBase));

// 3c. Rendering. One line format for every section: marker, line number 5 wide, tab, text.
function markLine(marker, lineNumber, lineText) {
  return marker + (lineNumber === null ? '     ' : String(lineNumber).padStart(5)) + '\t' + lineText;
}

function elisionMarker(skipped, fromLine, toLine) {
  return `      ..... ${skipped} unchanged lines omitted (${fromLine}-${toLine}) .....`;
}

// The admission key: what a plain numbered full body (no markers, no removed lines) costs. This
// reproduces the byte count the pack charged before markers existed, without building the
// string, so the admitted SET is byte-identical to what it was.
function plainNumberedBytes(lines) {
  let bytes = Math.max(0, lines.length - 1);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    bytes += Math.max(5, String(lineIndex + 1).length) + 1 + Buffer.byteLength(lines[lineIndex]);
  }
  return bytes;
}

function windowsFor(hunks, totalLines, contextLines) {
  // `+N,0` is a pure deletion: nothing exists on the new side, so anchor a point at N and let
  // the context expansion show the code the removed lines used to sit between.
  const expanded = hunks
    .map(({ newStart, newLength }) => (newLength === 0 ? [newStart, newStart] : [newStart, newStart + newLength - 1]))
    .map(([start, end]) => [Math.max(1, start - contextLines), Math.min(totalLines, end + contextLines)])
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

// Renders a readable body, whole (windows = [[1, total]]) or as windows, with every line marked.
// Removed lines render in place: before the new-side line the hunk starts at, or, for a pure
// deletion, after the line git reports as the collapse point. Every context width in use (3 and
// 20) is at least 1, so the window around a hunk always contains its anchor.
function renderMarkedBody(lines, hunks, windows) {
  const addedLines = new Set();
  const removedBefore = new Map();
  for (const { newStart, newLength, removed } of hunks) {
    for (let lineNumber = newStart; lineNumber < newStart + newLength; lineNumber++) addedLines.add(lineNumber);
    if (removed.length === 0) continue;
    const anchor = newLength > 0 ? newStart : newStart + 1;
    const existing = removedBefore.get(anchor);
    if (existing) existing.push(...removed);
    else removedBefore.set(anchor, [...removed]);
  }
  const parts = [];
  const pushRemovedBefore = (lineNumber) => {
    const removed = removedBefore.get(lineNumber);
    if (removed) for (const oldText of removed) parts.push(markLine('-', null, oldText));
  };
  let previousEnd = 0;
  for (const [start, end] of windows) {
    const skipped = start - previousEnd - 1;
    if (skipped > 0) parts.push(elisionMarker(skipped, previousEnd + 1, start - 1));
    for (let lineNumber = start; lineNumber <= end; lineNumber++) {
      pushRemovedBefore(lineNumber);
      parts.push(markLine(addedLines.has(lineNumber) ? '+' : ' ', lineNumber, lines[lineNumber - 1]));
    }
    previousEnd = end;
  }
  // A deletion after the file's last line anchors at total + 1. Unreachable when the file ends in
  // a newline (the split leaves a phantom empty last line that the deletion anchors before), kept
  // so a file without one cannot silently lose its removed lines.
  if (previousEnd === lines.length) pushRemovedBefore(lines.length + 1);
  const trailing = lines.length - previousEnd;
  if (trailing > 0) parts.push(elisionMarker(trailing, previousEnd + 1, lines.length));
  return renderedSection(parts);
}

// Line count comes from the parts array rather than a second pass over the joined text; finders
// navigate by these counts, so they must equal what is written (removed lines and markers too).
function renderedSection(parts) {
  const text = parts.join('\n');
  return { text, lineCount: parts.length, bytes: Buffer.byteLength(text) };
}

// Renders from the parser alone, for a body that cannot be read (deleted, or over the single-file
// cap): the changed lines with exact numbers and no context.
function renderHunksOnly(hunks) {
  const parts = [];
  let previousEnd = 0;
  for (const { newStart, newLength, removed, added } of hunks) {
    const gapEnd = newLength > 0 ? newStart - 1 : newStart;
    const skipped = gapEnd - previousEnd;
    if (skipped > 0) parts.push(elisionMarker(skipped, previousEnd + 1, gapEnd));
    for (const oldText of removed) parts.push(markLine('-', null, oldText));
    added.forEach((newText, offset) => parts.push(markLine('+', newStart + offset, newText)));
    previousEnd = newLength > 0 ? newStart + newLength - 1 : newStart;
  }
  return renderedSection(parts);
}

// 4. One description per changed file, independent of any cap, shared by every pack built.
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

function noteReasonFor(entry) {
  const { parsed, hunks, lines, untracked, renamedFrom } = entry;
  if (parsed) {
    if (parsed.binary) return renamedFrom ? `binary; renamed from ${renamedFrom}` : 'binary';
    if (renamedFrom && hunks.length === 0) return `renamed from ${renamedFrom}, content unchanged`;
    if (parsed.modeChange && hunks.length === 0) return `mode ${parsed.modeChange[0]} -> ${parsed.modeChange[1]}, content unchanged`;
    if (parsed.newFile && hunks.length === 0) return 'new file, empty';
    if (parsed.deleted && hunks.length === 0) return 'deleted, was empty';
    return 'binary, missing, or >1MB; read on demand';
  }
  if (lines === null) return untracked ? 'binary, missing, or >1MB; new, untracked; read on demand' : 'binary, missing, or >1MB; read on demand';
  if (untracked) return 'new, untracked, empty';
  // No reason may contain " (": a heading names its file up to the last " (", and a nested
  // parenthesis would move that boundary into the reason.
  if (unparsedBlocks.length > 0) return 'no parsed hunks; its raw diff block is at the end of the pack';
  return 'no net change against the merge base; changed in a commit and reverted in the working tree';
}

function describeChangedFile(relPath, churn) {
  const lines = readFileLines(relPath);
  const untracked = untrackedNameSet.has(relPath);
  // An untracked file is not in any diff; every content line is new. The synthetic hunk covers
  // the content lines only, matching git's own `@@ -0,0 +1,N @@` for a committed add, so the
  // phantom empty last line of a newline-terminated file renders unchanged either way.
  const parsed = untracked ? null : parsedByPath.get(relPath) || null;
  let hunks = parsed ? parsed.hunks : [];
  if (untracked && lines !== null) {
    const contentLineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    hunks = contentLineCount > 0 ? [{ newStart: 1, newLength: contentLineCount, removed: [], added: [] }] : [];
  }
  const renamedFrom = parsed ? parsed.renamedFrom : null;
  const suffixParts = [];
  if (untracked) suffixParts.push('new, untracked; every line is added');
  else if (parsed && parsed.newFile) suffixParts.push('new file; every line is added');
  if (renamedFrom) suffixParts.push(`renamed from ${renamedFrom}`);
  const entry = {
    relPath,
    churn,
    lines,
    parsed,
    hunks,
    untracked,
    renamedFrom,
    headingSuffix: suffixParts.length ? '; ' + suffixParts.join('; ') : '',
    plainFullBytes: lines === null ? 0 : plainNumberedBytes(lines),
    // What the removed lines add to a marked full body: marker, five spaces, tab, text, newline.
    removedBytes: hunks.reduce(
      (sum, hunk) => sum + hunk.removed.reduce((inner, oldText) => inner + 8 + Buffer.byteLength(oldText), 0),
      0,
    ),
    kind: 'note',
    noteReason: '',
    hunkSectionCache: null,
  };
  if (lines !== null && hunks.length > 0) entry.kind = 'body-candidate';
  else if (lines === null && parsed && !parsed.binary && hunks.length > 0) entry.kind = 'hunks-only';
  else entry.noteReason = noteReasonFor(entry);
  return entry;
}

const entries = ranked.map(({ relPath, churn }) => describeChangedFile(relPath, churn));

// The hunk-tier rendering of a file is a cap-independent fact about it, so it is computed once
// and shared by every pack built from these entries (the full pack never renders it for a file it
// admits to the body tier).
function hunkSectionFor(entry) {
  if (entry.hunkSectionCache) return entry.hunkSectionCache;
  const hunkCount = entry.hunks.length;
  const hunkWord = hunkCount === 1 ? 'hunk' : 'hunks';
  let heading;
  let rendered;
  if (entry.kind === 'hunks-only') {
    rendered = renderHunksOnly(entry.hunks);
    if (entry.parsed.deleted) {
      const removedCount = entry.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
      heading = `## Deleted file: ${entry.relPath} (${removedCount} lines removed${entry.headingSuffix})`;
    } else {
      heading =
        `## Changed hunks: ${entry.relPath} (over 1MB, body not read; ${hunkCount} ${hunkWord} ` +
        `with 0 lines of context; line numbers prefixed and exact${entry.headingSuffix})`;
    }
  } else {
    const windows = windowsFor(entry.hunks, entry.lines.length, HUNK_CONTEXT_LINES);
    rendered = renderMarkedBody(entry.lines, entry.hunks, windows);
    heading =
      `## Changed hunks: ${entry.relPath} (${entry.lines.length} lines total; ${hunkCount} ${hunkWord} ` +
      `with ${HUNK_CONTEXT_LINES} lines of context; unchanged runs between them are marked and omitted; ` +
      `line numbers prefixed and exact${entry.headingSuffix})`;
  }
  const { bytes } = rendered;
  const section = { heading, body: rendered.text, bytes, lineCount: rendered.lineCount, stubbed: false };
  if (bytes > PACK_HUNK_SECTION_CAP_BYTES) {
    const addedCount = entry.hunks.reduce((sum, hunk) => sum + hunk.newLength, 0);
    const removedCount = entry.hunks.reduce((sum, hunk) => sum + hunk.removed.length, 0);
    const deleted = entry.parsed !== null && entry.parsed.deleted;
    section.heading =
      `## Changed hunks omitted: ${entry.relPath} (+${addedCount}/-${removedCount} lines in ${hunkCount} ${hunkWord}; ` +
      `section ${(bytes / 1024).toFixed(0)}KB, over the per-file hunk cap; ${deleted ? 'deleted file' : 'read on demand'}${entry.headingSuffix})`;
    section.body = null;
    section.lineCount = 0;
    section.stubbed = true;
  }
  entry.hunkSectionCache = section;
  return section;
}

// 5. Build a pack: admit bodies largest churn first under the cap, render every other file at the
// hunk tier, then assemble with a line-accurate table of contents.
function buildPack(packEntries, capBytes) {
  const sections = [];
  let bodyBudgetUsed = 0;
  let packedBodyBytes = 0;
  let bodiesPacked = 0;
  let windowedCount = 0;
  for (const entry of packEntries) {
    // The admitted SET is decided on the PLAIN full-body cost, exactly as before windowing or
    // markers existed, so a file that ships today can never be displaced by a newly-affordable
    // larger one (a greedy knapsack reorders badly: measured, spending the freed budget cost
    // PR337 three files). Windowing and the dedupe then only shrink what that set costs. The
    // written bytes can exceed the charged budget slightly (one marker byte per line plus the
    // removed lines); the summary prints both numbers for that reason.
    if (entry.kind === 'body-candidate' && bodyBudgetUsed + entry.plainFullBytes <= capBytes) {
      bodyBudgetUsed += entry.plainFullBytes;
      // The marked full body's size follows from the plain cost without rendering it: one marker
      // byte per line plus the removed lines. So a file that windows never pays a full render.
      const fullBytes = entry.plainFullBytes + entry.lines.length + entry.removedBytes;
      // Windowed only when it saves a worthwhile share; a new file's one hunk covers its whole
      // body and a densely-changed one windows to nearly all of it, so both keep their full text.
      const windows = windowsFor(entry.hunks, entry.lines.length, WINDOW_CONTEXT_LINES);
      const windowed = windows ? renderMarkedBody(entry.lines, entry.hunks, windows) : null;
      const useWindow = windowed !== null && windowed.bytes <= fullBytes * WINDOW_MAX_SHARE_OF_FULL;
      const rendered = useWindow ? windowed : renderMarkedBody(entry.lines, entry.hunks, [[1, entry.lines.length]]);
      // Name the omission in the heading, not only at the elision markers. A finder that cannot
      // tell what a section guarantees re-reads the whole file, which costs the pack bytes AND
      // keeps the duplicate read - the one way this design loses.
      const heading = useWindow
        ? `## Partial file: ${entry.relPath} (${entry.lines.length} lines total; ` +
          `every changed hunk shown with ${WINDOW_CONTEXT_LINES} lines of context, in ${windows.length} ` +
          `window${windows.length === 1 ? '' : 's'}; unchanged runs between them are marked and omitted; ` +
          `line numbers prefixed and exact${entry.headingSuffix})`
        : `## Full file: ${entry.relPath} (${entry.lines.length} lines; line numbers prefixed${entry.headingSuffix})`;
      sections.push({ entry, heading, body: rendered.text, lineCount: rendered.lineCount, tier: 'body' });
      bodiesPacked++;
      if (useWindow) windowedCount++;
      packedBodyBytes += rendered.bytes;
      continue;
    }
    if (entry.kind === 'body-candidate' || entry.kind === 'hunks-only') {
      const hunkSection = hunkSectionFor(entry);
      sections.push({
        entry,
        heading: hunkSection.heading,
        body: hunkSection.body,
        lineCount: hunkSection.lineCount,
        tier: hunkSection.stubbed ? 'stub' : 'hunk',
      });
      continue;
    }
    sections.push({ entry, heading: `## Not shown: ${entry.relPath} (${entry.noteReason})`, body: null, lineCount: 0, tier: 'note' });
  }

  // "Not included" is the one list of what a finder must fetch itself: content the pack does not
  // carry. A hunk-tier file is never listed here; it carries every changed line, and listing it
  // would prompt the re-read the windowing A/B measured for.
  const notIncluded = [];
  for (const { entry, tier } of sections) {
    if (tier === 'stub') notIncluded.push({ relPath: entry.relPath, churn: entry.churn, reason: 'changed hunks over the per-file hunk cap' });
    else if (tier === 'note' && entry.parsed && entry.parsed.binary) notIncluded.push({ relPath: entry.relPath, churn: entry.churn, reason: 'binary' });
    else if (tier === 'note' && !entry.parsed && entry.lines === null) notIncluded.push({ relPath: entry.relPath, churn: entry.churn, reason: 'binary, missing, or >1MB' });
  }

  // Layout below the two header lines: "## Contents", one TOC line per section, a blank line, then
  // the sections. lineCount is what was actually written (removed lines and elision markers
  // included), because finders navigate by these offsets.
  const tocEntries = [];
  const tocCount = sections.length + (unparsedBlocks.length > 0 ? 1 : 0);
  let cursor = 2 + 1 + tocCount + 1 + 1; // first line after the header block
  for (const section of sections) {
    tocEntries.push({ label: section.entry.relPath, startLine: cursor });
    cursor += 1 + section.lineCount + 1; // heading + body + blank
  }
  if (unparsedBlocks.length > 0) tocEntries.push({ label: 'Union diff (unparsed)', startLine: cursor });
  const bodyParts = ['## Contents (start line)'];
  for (const tocEntry of tocEntries) bodyParts.push(`- line ${tocEntry.startLine}: ${tocEntry.label}`);
  bodyParts.push('');
  for (const section of sections) {
    bodyParts.push(section.heading);
    if (section.body !== null) bodyParts.push(section.body);
    bodyParts.push('');
  }
  if (unparsedBlocks.length > 0) {
    bodyParts.push('## Union diff (unparsed)');
    bodyParts.push(unparsedBlocks.join('').replace(/\n$/, ''));
    bodyParts.push('');
  }
  if (notIncluded.length > 0) {
    bodyParts.push('## Not included (read on demand)');
    for (const item of notIncluded) bodyParts.push(`- ${item.relPath} (churn ${item.churn}; ${item.reason})`);
  }
  // The header's total is derived from the assembled text, never from the cursor arithmetic
  // (which only feeds the TOC start lines): finders size their reads off this number, so every
  // trailing section - including the omitted-files list - must be counted.
  const tailText = bodyParts.join('\n');
  const totalLines = 2 + tailText.split('\n').length;
  const kindSentence = capBytes > 0
    ? `Full pack (bodies at ${WINDOW_CONTEXT_LINES} lines of context, other files at ${HUNK_CONTEXT_LINES}).`
    : `Light pack (every file at ${HUNK_CONTEXT_LINES} lines of context).`;
  const legend =
    `${kindSentence} Line format: <marker><line number, 5 wide><tab><text>; marker "+" added, ` +
    `"-" removed (no line number, shown in place before the line that follows), " " unchanged.`;
  const text =
    `Total lines: ${totalLines}. Read sequentially with offset/limit; at most 2000 lines return per Read call.\n` +
    `${legend}\n${tailText}`;
  return {
    text,
    totalLines,
    bodiesPacked,
    windowedCount,
    packedBodyBytes,
    bodyBudgetUsed,
    hunkSections: sections.filter((section) => section.tier === 'hunk' || section.tier === 'stub').length,
    stubbed: sections.filter((section) => section.tier === 'stub').length,
    notIncluded,
  };
}

const pack = buildPack(entries, bodyCapBytes);
const packPath = join(kangenticDir, 'REVIEW_PACK.tmp.md');
writeFileSync(packPath, pack.text);

// 6. Summary only - never print the pack.
const kilobytes = (bytes) => (bytes / 1024).toFixed(0) + 'KB';
console.log(`Review pack written: ${packPath}`);
console.log(`  changed files: ${changedFiles.length} (committed ${committedNames.length}, uncommitted ${uncommittedNames.length}, untracked ${untrackedNames.length})`);
// Labelled distinctly from the count line above: the driver reads THIS line to decide
// which gated finders to spawn.
console.log(`  paths: ${changedFiles.join(', ')}`);
console.log(
  `  pack: ${kilobytes(Buffer.byteLength(pack.text))}, ${pack.totalLines} lines; ` +
  `bodies packed ${pack.bodiesPacked} (${pack.windowedCount} windowed, ${kilobytes(pack.packedBodyBytes)} written of ${kilobytes(pack.bodyBudgetUsed)} budgeted), ` +
  `omitted ${pack.notIncluded.length}; hunk sections ${pack.hunkSections} (${pack.stubbed} over per-file hunk cap)`,
);
console.log(`  preexisting dirty: ${preexistingDirty.length} paths -> REVIEW_PREEXISTING_DIRTY.tmp`);
if (pack.notIncluded.length > 0) console.log('  omitted: ' + pack.notIncluded.map((item) => item.relPath).join(', '));

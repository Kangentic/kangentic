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
 *                               the union diff, then full line-numbered bodies of changed
 *                               files (largest churn first) up to the byte cap.
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

const baseRef = (process.argv[2] || '').trim();
const repoRoot = git('rev-parse', '--show-toplevel').trim();

function git(...args) {
  // core.quotepath=false: git otherwise octal-escapes non-ASCII path bytes in --name-only /
  // ls-files output, and the mangled path silently fails every later existsSync lookup.
  // CRLF is normalized so line counts and pack content are identical across checkout configs.
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');
}

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
const committedDiff = baseRef ? git('diff', baseRef + '...HEAD') : '';
const committedNames = baseRef ? nameOnly(git('diff', baseRef + '...HEAD', '--name-only')) : [];
const committedChurn = baseRef ? parseNumstat(git('diff', baseRef + '...HEAD', '--numstat')) : new Map();
const uncommittedDiff = git('diff', 'HEAD');
const uncommittedNames = nameOnly(git('diff', 'HEAD', '--name-only'));
const uncommittedChurn = parseNumstat(git('diff', 'HEAD', '--numstat'));
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

let syntheticBlocks = '';
for (const relPath of untrackedNames) {
  const lines = readFileLines(relPath);
  if (lines === null) continue;
  syntheticBlocks += `\ndiff --git a/${relPath} b/${relPath}\nnew file\n--- /dev/null\n+++ b/${relPath}\n`;
  syntheticBlocks += lines.map((line) => '+' + line).join('\n') + '\n';
}
const unionDiff = [committedDiff, uncommittedDiff, syntheticBlocks].filter((part) => part.trim()).join('\n');

// 4. Full bodies, largest churn first, capped.
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
  const numbered = lines.map((line, index) => String(index + 1).padStart(5) + '\t' + line).join('\n');
  const sectionBytes = Buffer.byteLength(numbered);
  if (bodyBytes + sectionBytes > PACK_BODY_CAP_BYTES) { omitted.push({ relPath, churn, reason: 'over pack cap' }); continue; }
  bodyBytes += sectionBytes;
  packedSections.push({ relPath, churn, numbered, lines: lines.length });
}

// 5. Assemble with a line-accurate table of contents.
const diffLines = unionDiff.split('\n');
const tocEntries = [];
const bodyParts = [];
// Layout below the header block: TOC lines, blank, then sections. Compute in two passes.
function sectionHeader(section) {
  return `## Full file: ${section.relPath} (${section.lines} lines; line numbers prefixed)`;
}
const headerLineCountFor = (tocCount) => 1 + 1 + tocCount + 1; // Total-lines line + "## Contents" + entries + blank
let cursor = headerLineCountFor(1 + packedSections.length) + 1; // first line after the header block
tocEntries.push({ label: 'Union diff', startLine: cursor });
cursor += 1 + diffLines.length + 1; // heading + diff body + trailing blank
for (const section of packedSections) {
  tocEntries.push({ label: section.relPath, startLine: cursor });
  cursor += 1 + section.lines + 1; // heading + body + blank
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
console.log(`  pack: ${(Buffer.byteLength(packText) / 1024).toFixed(0)}KB, ${totalLines} lines; diff ${(Buffer.byteLength(unionDiff) / 1024).toFixed(0)}KB; bodies packed ${packedSections.length}, omitted ${omitted.length}`);
console.log(`  preexisting dirty: ${preexistingDirty.length} paths -> REVIEW_PREEXISTING_DIRTY.tmp`);
if (omitted.length) console.log('  omitted: ' + omitted.map((entry) => entry.relPath).join(', '));

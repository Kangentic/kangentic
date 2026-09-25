#!/usr/bin/env node
/**
 * Replays the review-pack corpus: builds the pack for each merged PR with a control script and
 * with the working-copy scripts/build-review-pack.mjs, and prints the comparison table that
 * docs/code-review-fanout-audit.md sections 13.3 and 14.2 carry. A pack is a pure function of a
 * ref pair, so the numbers reproduce on any machine with network access and an authenticated gh.
 *
 * Usage: node scripts/replay-review-pack-corpus.mjs [--control <ref-or-path>] [--keep] [<pr>...]
 *   <pr>...     PR numbers; default is the eight-PR corpus of section 13.3.
 *   --control   a git ref whose scripts/build-review-pack.mjs is the control (default: main), or
 *               a path to a script file.
 *   --keep      leave the temp clone in place (its path is printed) instead of deleting it.
 *
 * Per PR it runs three arms: control, treatment (the working-copy script), and treatment with
 * `--body-cap 0` (the light shape). Everything is measured from the pack files, never from the
 * summary lines, so both formats are read the same way. Per arm it checks the contract the audit
 * checks: the `Total lines:` header matches the file, every TOC entry points at a heading, every
 * numbered body line matches the working tree, and the `paths:` line is identical across arms.
 *
 * Two caveats carried over from the audit (13.6): a landed PR head is a proxy for the tree the
 * real review saw, which may have carried uncommitted work; and this repo rebase-merges, so the
 * reviewed head survives only as `refs/pull/<n>/head`, which is what gets fetched.
 *
 * Writes only under a fresh directory beneath os.tmpdir(). It never runs a builder with the
 * source checkout as cwd: that would overwrite .kangentic/REVIEW_PREEXISTING_DIRTY.tmp under an
 * in-flight review. Not wired into package.json: it needs the network and gh, and it is run once
 * per pack-format change, not as part of any gate.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULT_CORPUS = ['341', '329', '316', '337', '302', '338', '328', '306'];

const cliArguments = process.argv.slice(2);
let controlSpec = 'main';
let keepTemp = false;
const pullRequestNumbers = [];
for (let argumentIndex = 0; argumentIndex < cliArguments.length; argumentIndex++) {
  const argument = cliArguments[argumentIndex];
  if (argument === '--control') {
    controlSpec = cliArguments[argumentIndex + 1] ?? '';
    argumentIndex++;
  } else if (argument === '--keep') {
    keepTemp = true;
  } else if (/^\d+$/.test(argument)) {
    pullRequestNumbers.push(argument);
  } else {
    console.error(`unrecognised argument: ${argument}`);
    process.exit(2);
  }
}
if (pullRequestNumbers.length === 0) pullRequestNumbers.push(...DEFAULT_CORPUS);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function git(cwd, ...args) {
  return run('git', args, { cwd });
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const treatmentScript = join(scriptDirectory, 'build-review-pack.mjs');
const sourceRoot = git(scriptDirectory, 'rev-parse', '--show-toplevel').trim();
const originUrl = git(sourceRoot, 'remote', 'get-url', 'origin').trim();

const temporaryRoot = mkdtempSync(join(tmpdir(), 'review-pack-replay-'));

function resolveControlScript() {
  if (existsSync(controlSpec) && statSync(controlSpec).isFile()) return resolve(controlSpec);
  const controlText = git(sourceRoot, 'show', `${controlSpec}:scripts/build-review-pack.mjs`);
  const controlPath = join(temporaryRoot, 'control', 'build-review-pack.mjs');
  mkdirSync(dirname(controlPath), { recursive: true });
  writeFileSync(controlPath, controlText);
  return controlPath;
}

function commitExists(repoDirectory, sha) {
  try {
    git(repoDirectory, 'cat-file', '-e', `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function ensureCommit(repoDirectory, sha, description) {
  if (commitExists(repoDirectory, sha)) return;
  git(repoDirectory, 'fetch', '--quiet', 'origin', sha);
  if (!commitExists(repoDirectory, sha)) throw new Error(`${description} ${sha} is not fetchable from origin`);
}

// A section heading names its file up to the LAST " (": the builder guarantees no heading text
// after the path contains " (" (see noteReasonFor in build-review-pack.mjs).
function headingPathOf(headingLine) {
  const match = headingLine.match(/^## [A-Za-z ]+: (.+)$/);
  if (!match) return null;
  const parenIndex = match[1].lastIndexOf(' (');
  return parenIndex === -1 ? match[1] : match[1].slice(0, parenIndex);
}

const BODY_HEADING_PREFIXES = ['## Full file: ', '## Partial file: ', '## Changed hunks: '];

// Reads a pack file and checks the contract, format-agnostically: the control pack's lines have
// no marker column and the treatment's do, so the numbered-line regex accepts both.
function measurePack(repoDirectory, packText, summary, elapsedMs) {
  const packLines = packText.split('\n');
  const problems = [];
  const headerMatch = packText.match(/^Total lines: (\d+)\./);
  if (!headerMatch || Number(headerMatch[1]) !== packLines.length) problems.push('header total');

  const tocPattern = /^- line (\d+): (.+)$/gm;
  let tocMatch;
  let tocEntries = 0;
  while ((tocMatch = tocPattern.exec(packText)) !== null) {
    tocEntries++;
    if (!(packLines[Number(tocMatch[1]) - 1] ?? '').startsWith('## ')) problems.push(`toc ${tocMatch[2]}`);
  }

  let checkedLines = 0;
  let mismatchedLines = 0;
  const fileLinesCache = new Map();
  let currentFileLines = null;
  for (const line of packLines) {
    if (line.startsWith('## ')) {
      currentFileLines = null;
      if (BODY_HEADING_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        const relPath = headingPathOf(line);
        if (relPath !== null && !fileLinesCache.has(relPath)) {
          const absolute = join(repoDirectory, relPath);
          fileLinesCache.set(
            relPath,
            existsSync(absolute) ? readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n').split('\n') : null,
          );
        }
        currentFileLines = relPath === null ? null : fileLinesCache.get(relPath);
      }
      continue;
    }
    if (currentFileLines === null) continue;
    const numbered = line.match(/^[ +]? *(\d+)\t(.*)$/);
    if (!numbered) continue;
    checkedLines++;
    if (currentFileLines[Number(numbered[1]) - 1] !== numbered[2]) mismatchedLines++;
  }
  if (mismatchedLines > 0) problems.push(`${mismatchedLines} line mismatches`);

  const countHeadings = (prefix) => packLines.filter((line) => line.startsWith(prefix)).length;
  const pathsLine = summary.split('\n').find((line) => line.startsWith('  paths: ')) ?? '';
  return {
    bytes: Buffer.byteLength(packText),
    lines: packLines.length,
    bodies: countHeadings('## Full file: ') + countHeadings('## Partial file: '),
    windowed: countHeadings('## Partial file: '),
    hunkSections: countHeadings('## Changed hunks: '),
    stubs: countHeadings('## Changed hunks omitted: '),
    notShown: countHeadings('## Not shown: ') + countHeadings('## Deleted file: '),
    tocEntries,
    checkedLines,
    paths: pathsLine,
    problems,
    elapsedMs,
  };
}

function buildArm(repoDirectory, scriptPath, extraArguments, baseSha) {
  rmSync(join(repoDirectory, '.kangentic'), { recursive: true, force: true });
  const started = performance.now();
  const summary = run('node', [scriptPath, baseSha, ...extraArguments], { cwd: repoDirectory });
  const elapsedMs = performance.now() - started;
  const packText = readFileSync(join(repoDirectory, '.kangentic', 'REVIEW_PACK.tmp.md'), 'utf8');
  return measurePack(repoDirectory, packText, summary, elapsedMs);
}

function formatNumber(value) {
  return value.toLocaleString('en-US');
}

function formatDelta(from, to) {
  if (from === 0) return 'n/a';
  return `${(((to - from) / from) * 100).toFixed(1)}%`;
}

const rows = [];
let failures = 0;
try {
  const controlScript = resolveControlScript();
  const repoDirectory = join(temporaryRoot, 'repo');
  git(temporaryRoot, 'clone', '--quiet', '--no-checkout', originUrl, repoDirectory);

  for (const pullRequestNumber of pullRequestNumbers) {
    try {
      const info = JSON.parse(
        run('gh', ['pr', 'view', pullRequestNumber, '--json', 'number,title,state,baseRefOid,headRefOid,additions,deletions,changedFiles'], {
          cwd: sourceRoot,
        }),
      );
      try {
        git(repoDirectory, 'fetch', '--quiet', 'origin', `refs/pull/${pullRequestNumber}/head:refs/replay/${pullRequestNumber}`);
      } catch {
        // The pull ref can be gone; the head SHA may still be fetchable directly.
      }
      ensureCommit(repoDirectory, info.headRefOid, `PR ${pullRequestNumber} head`);
      ensureCommit(repoDirectory, info.baseRefOid, `PR ${pullRequestNumber} base`);
      git(repoDirectory, 'checkout', '--quiet', '--detach', info.headRefOid);

      const control = buildArm(repoDirectory, controlScript, [], info.baseRefOid);
      const full = buildArm(repoDirectory, treatmentScript, [], info.baseRefOid);
      const light = buildArm(repoDirectory, treatmentScript, ['--body-cap', '0'], info.baseRefOid);
      const notes = [];
      if (control.paths !== full.paths) notes.push('paths differ (control vs full)');
      if (full.paths !== light.paths) notes.push('paths differ (full vs light)');
      if (full.bytes > control.bytes) notes.push('full larger than control');
      if (light.bytes > full.bytes) notes.push('light larger than full');
      if (control.bodies !== full.bodies) notes.push(`bodies changed ${control.bodies} -> ${full.bodies}`);
      for (const [armName, arm] of [['control', control], ['full', full], ['light', light]]) {
        for (const problem of arm.problems) notes.push(`${armName}: ${problem}`);
      }
      rows.push({ pullRequestNumber, info, control, full, light, notes });
    } catch (error) {
      failures++;
      const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
      rows.push({ pullRequestNumber, error: message });
    }
  }
} finally {
  if (keepTemp) console.log(`temp clone kept at ${temporaryRoot}`);
  // A failed cleanup must not swallow the run: the table below this block is the whole point of
  // a replay that just cloned and fetched the corpus, and on Windows a freshly written tree can
  // still be held for a moment by a scanner or a background git process. No retry ladder here on
  // purpose. fs.rm's own maxRetries compounds per path through the recursion, measured at 668s
  // on a locked two-directory tree, so the script names the leftover instead of grinding on it.
  else {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      const reason =
        cleanupError instanceof Error ? cleanupError.message.split('\n')[0] : String(cleanupError);
      console.log(`temp clone left at ${temporaryRoot} (cleanup failed: ${reason})`);
    }
  }
}

console.log('');
console.log('| PR | shape | control pack | full pack | delta | light pack | light vs full | bodies packed | hunk sections (full / light) | stubbed (full / light) | lines checked | ms (control / full / light) | notes |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const totals = { control: 0, full: 0, light: 0, checked: 0 };
for (const row of rows) {
  if (row.error) {
    console.log(`| PR${row.pullRequestNumber} | head unavailable (${row.error}) | | | | | | | | | | | |`);
    continue;
  }
  const { info, control, full, light } = row;
  totals.control += control.bytes;
  totals.full += full.bytes;
  totals.light += light.bytes;
  totals.checked += control.checkedLines + full.checkedLines + light.checkedLines;
  console.log(
    `| PR${row.pullRequestNumber} | ${info.changedFiles}f +${info.additions}/-${info.deletions} | ${formatNumber(control.bytes)} | ${formatNumber(full.bytes)} | ${formatDelta(control.bytes, full.bytes)} | ${formatNumber(light.bytes)} | ${formatDelta(full.bytes, light.bytes)} | ${control.bodies} -> ${full.bodies} | ${full.hunkSections} / ${light.hunkSections} | ${full.stubs} / ${light.stubs} | ${formatNumber(control.checkedLines + full.checkedLines + light.checkedLines)} | ${control.elapsedMs.toFixed(0)} / ${full.elapsedMs.toFixed(0)} / ${light.elapsedMs.toFixed(0)} | ${row.notes.join('; ')} |`,
  );
}
console.log(
  `| Total | | ${formatNumber(totals.control)} | ${formatNumber(totals.full)} | ${formatDelta(totals.control, totals.full)} | ${formatNumber(totals.light)} | ${formatDelta(totals.full, totals.light)} | | | | ${formatNumber(totals.checked)} | | |`,
);
if (failures > 0) {
  console.error(`${failures} of ${rows.length} PRs could not be replayed; the table above is partial.`);
  process.exit(1);
}

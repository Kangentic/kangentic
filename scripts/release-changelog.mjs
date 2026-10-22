#!/usr/bin/env node
/**
 * Builds the CHANGELOG.md entry for a desktop release from the commits since the previous tag, and
 * writes it after the `<!-- releases -->` marker. /release Step 3 runs it.
 *
 * Why a script: v0.48.0's range held 136 commits, and grouping them, stripping each prefix and
 * typing the result into CHANGELOG.md by hand took a separate line-by-line check to trust. About a
 * fifth of them were also /code-review bookkeeping that tells a reader nothing about the release:
 * a pass's row in the fan-out audit doc, and the empty commit that carries a pass's Refuted and
 * Decisions ledger. Recognizing those means reading every commit's file list, which a script does
 * reliably and an eye does not.
 *
 * Usage: node scripts/release-changelog.mjs <previousTag> <version> [--write] [--date YYYY-MM-DD]
 *   <previousTag>  the tag /release Step 0 captured (`git describe --tags --abbrev=0 --match "v*"`).
 *                  Never re-derived here: after Step 5 tags the release, the same command returns
 *                  the NEW tag and the range comes back empty.
 *   <version>      the version being released, without the v (0.48.0).
 *   --write        insert the entry into this checkout's CHANGELOG.md. Without it the entry is only
 *                  printed, which is the dry run.
 *   --date         the entry's date. Defaults to today's local date.
 *
 * The commits are read from the checkout this script lives in, never from the current directory,
 * so `node <main>/scripts/release-changelog.mjs` reads main even from a release worktree.
 *
 * Prints the entry, then one summary line that names how many commits it skipped, zero included,
 * then each skipped commit's hash and subject.
 * Exit 0 on success. Exit 2 for a usage error, a range with nothing to release, a CHANGELOG.md with
 * no marker, or one that already holds an entry for <version>.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

export const RELEASES_MARKER = '<!-- releases -->';
export const REVIEW_AUDIT_DOC = 'docs/code-review-fanout-audit.md';

const RECORD_SEPARATOR = '\x1e';
const FIELD_SEPARATOR = '\x1f';
const CONVENTIONAL_SUBJECT = /^(feat|fix|chore|docs|refactor|test|style|perf|ci|build)(\([^)]*\))?(!)?:\s*(.*)$/;

/**
 * Parse `git log --format=%x1e%h%x1f%p%x1f%s --name-only` into one record per commit. A merge has
 * several parents and lists no files under --name-only, so `parents` is kept to tell it apart from
 * an empty commit.
 */
export function parseGitLog(raw) {
  return raw
    .split(RECORD_SEPARATOR)
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const [header, ...rest] = record.replace(/\r\n/g, '\n').split('\n');
      const [hash, parents, subject] = header.split(FIELD_SEPARATOR);
      return {
        hash,
        parents: parents.split(' ').filter(Boolean),
        subject,
        files: rest.map((line) => line.trim()).filter(Boolean),
      };
    });
}

/**
 * /code-review bookkeeping: a commit whose only change is the fan-out audit doc, or a single-parent
 * commit that changes nothing (a pass's ledger rides an empty commit). A merge is never one.
 */
export function isReviewRecord(commit) {
  if (commit.parents.length > 1) return false;
  if (commit.files.length === 0) return true;
  return commit.files.length === 1 && commit.files[0] === REVIEW_AUDIT_DOC;
}

/** Which section a subject belongs in, and its text with the conventional prefix stripped. */
export function classifySubject(subject) {
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  let section;
  let text;
  if (match) {
    const [, type, , bang, rest] = match;
    text = rest;
    if (bang || subject.includes('BREAKING CHANGE')) section = 'breaking';
    else if (type === 'feat') section = 'features';
    else if (type === 'fix') section = 'fixes';
    else section = 'other';
  } else {
    text = subject;
    if (subject.includes('BREAKING CHANGE')) section = 'breaking';
    else if (/^(Add|Implement|Create)\b/.test(subject) || /feature/i.test(subject)) section = 'features';
    else if (/^Fix\b/.test(subject) || /bug|resolve/i.test(subject)) section = 'fixes';
    else section = 'other';
  }
  return { section, text: text.charAt(0).toUpperCase() + text.slice(1) };
}

const SECTION_TITLES = [
  ['breaking', 'Breaking Changes'],
  ['features', 'Features'],
  ['fixes', 'Fixes'],
  ['other', 'Other'],
];

/**
 * The entry text and what went into it. Commits keep git log's order, newest first. The skipped
 * commits come back by name, because a wrong skip removes a line from a public changelog and a bare
 * count cannot show which one.
 */
export function buildEntry({ version, date, commits }) {
  const sections = { breaking: [], features: [], fixes: [], other: [] };
  const skippedCommits = [];
  for (const commit of commits) {
    if (isReviewRecord(commit)) {
      skippedCommits.push(commit);
      continue;
    }
    const { section, text } = classifySubject(commit.subject);
    sections[section].push(`- ${text} (${commit.hash})`);
  }
  let entry = `## [v${version}] - ${date}\n`;
  for (const [key, title] of SECTION_TITLES) {
    if (sections[key].length === 0) continue;
    entry += `\n### ${title}\n${sections[key].join('\n')}\n`;
  }
  const counts = Object.fromEntries(SECTION_TITLES.map(([key]) => [key, sections[key].length]));
  const skipped = skippedCommits.length;
  return { entry, included: commits.length - skipped, skipped, skippedCommits, counts };
}

/**
 * CHANGELOG.md with the entry inserted after the marker, in the file's own line endings. Throws
 * when the marker is missing, or when an entry for the version is already there, since running
 * --write twice would otherwise list the release twice.
 */
export function insertEntry(changelog, entry, version) {
  const lineEnding = changelog.includes('\r\n') ? '\r\n' : '\n';
  const normalized = changelog.replace(/\r\n/g, '\n');
  const markerIndex = normalized.indexOf(RELEASES_MARKER);
  if (markerIndex === -1) throw new Error(`CHANGELOG.md has no ${RELEASES_MARKER} marker, so there is nowhere to put the entry.`);
  if (normalized.includes(`## [v${version}]`)) throw new Error(`CHANGELOG.md already has an entry for v${version}.`);
  const afterMarker = normalized.indexOf('\n', markerIndex);
  const head = afterMarker === -1 ? `${normalized}\n` : normalized.slice(0, afterMarker + 1);
  const tail = afterMarker === -1 ? '' : normalized.slice(afterMarker + 1).replace(/^\n+/, '');
  const updated = `${head}\n${entry}\n${tail}`;
  return lineEnding === '\n' ? updated : updated.replace(/\n/g, '\r\n');
}

export function formatSummary({ version, included, skipped, counts }) {
  const sections = `${counts.breaking} breaking, ${counts.features} features, ${counts.fixes} fixes, ${counts.other} other`;
  return `release-changelog: v${version} lists ${included} commit${included === 1 ? '' : 's'} (${sections}), skipped ${skipped} review-record commit${skipped === 1 ? '' : 's'}`;
}

/** One line per skipped commit, so a dry run shows exactly what the entry leaves out. */
export function formatSkippedCommits(skippedCommits) {
  return skippedCommits.map((commit) => `  skipped ${commit.hash} ${commit.subject}`).join('\n');
}

/** The entry's date when --date is not given: `now` as a local YYYY-MM-DD. */
export function localDate(now = new Date()) {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function main(argv) {
  const usage = 'usage: node scripts/release-changelog.mjs <previousTag> <version> [--write] [--date YYYY-MM-DD]';
  const write = argv.includes('--write');
  const dateIndex = argv.indexOf('--date');
  const date = dateIndex === -1 ? localDate() : argv[dateIndex + 1];
  const dateArgumentIndexes = dateIndex === -1 ? [] : [dateIndex, dateIndex + 1];
  const positional = argv.filter((argument, index) => argument !== '--write' && !dateArgumentIndexes.includes(index));
  if (positional.length !== 2 || (dateIndex !== -1 && !/^\d{4}-\d{2}-\d{2}$/.test(date ?? ''))) {
    console.error(usage);
    return 2;
  }
  const [previousTag, version] = positional;
  if (previousTag.startsWith('-')) {
    console.error(`the previous tag is ${JSON.stringify(previousTag)}; git log would read it as an option, not a revision.\n${usage}`);
    return 2;
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`the version is ${JSON.stringify(version)}; pass it as X.Y.Z, without the v.\n${usage}`);
    return 2;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let raw;
  try {
    raw = execFileSync(
      'git',
      ['-C', repoRoot, 'log', `${previousTag}..HEAD`, '--no-decorate', '--abbrev=8', `--format=${RECORD_SEPARATOR}%h${FIELD_SEPARATOR}%p${FIELD_SEPARATOR}%s`, '--name-only'],
      // --name-only lists every file of every commit, so a large range passes the 1 MiB default.
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (error) {
    const stderr = /** @type {{ stderr?: string }} */ (error).stderr ?? '';
    console.error(`git log ${previousTag}..HEAD failed in ${repoRoot}: ${stderr.trim() || String(error)}`);
    return 2;
  }
  const commits = parseGitLog(raw);
  if (commits.length === 0) {
    console.error(`${previousTag}..HEAD holds no commits. If Step 5 already tagged this release, pass the tag Step 0 captured, not a fresh git describe.`);
    return 2;
  }

  const result = buildEntry({ version, date, commits });
  if (write) {
    const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
    try {
      fs.writeFileSync(changelogPath, insertEntry(fs.readFileSync(changelogPath, 'utf8'), result.entry, version));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  console.log(result.entry);
  console.log(`${formatSummary({ version, ...result })}${write ? ', written to CHANGELOG.md' : ', dry run (nothing written)'}`);
  if (result.skipped > 0) console.log(formatSkippedCommits(result.skippedCommits));
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

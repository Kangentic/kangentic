#!/usr/bin/env node
/**
 * Release step: build the ONE latest-mac.yml both macOS arches update from,
 * from the binaries actually attached to the release.
 *
 * Each macOS release leg runs its own electron-builder, and electron-builder
 * merges per-arch feeds only within a single run. So the arm64 leg publishes a
 * latest-mac.yml listing only the arm64 files, the Intel leg publishes one
 * listing only the x64 files, and the second upload deletes and replaces the
 * first (electron-publish's gitHubPublisher overwrites an existing asset).
 * Whichever leg finished last would decide every Mac's updates: an x64-only feed
 * moves Apple silicon Macs onto the Intel build under Rosetta, and an arm64-only
 * feed leaves Intel Macs with no zip at all.
 *
 * electron-updater's MacUpdater.filterFilesForArch keeps the files whose URL names
 * arm64 on Apple silicon (and under Rosetta) and the rest on Intel, so one feed
 * listing both arches is right for both. publish-release runs this before
 * patch-mac-update-info.js and the asset gate.
 *
 * The `files:` entries are computed here, from the zips and dmgs on the release
 * (sha512 in base64 and size, the fields electron-builder writes), rather than
 * carried over from the legs. That keeps the feed true to what a Mac downloads in
 * every case a run can be in: a re-run of only some jobs (workflow artifacts do
 * not reliably carry across run attempts, release assets do), and a re-run over a
 * release that is already published, where electron-builder skips every upload
 * but the legs still rebuild. There the binaries on the release are the published
 * ones, the computed feed equals the published feed, and nothing is uploaded.
 *
 * Everything else in the feed (version, release notes, release date, and a
 * minimumSystemVersion already written) is kept from the latest-mac.yml on the
 * release, edited as text like patch-mac-update-info.js does, so publish-release
 * needs no `npm ci` and no YAML dependency. The top-level `path` / `sha512` that
 * older clients read name the arm64 zip, as they did before Intel builds existed.
 *
 * Usage: node scripts/merge-mac-update-feeds.js <tag> [--repo owner/name] [--dry-run]
 */

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MAC_ARCHES } = require('./release-assets');

const CHANNEL_FILE = 'latest-mac.yml';

function parseArgs(argv) {
  const positional = [];
  let repo = process.env.GITHUB_REPOSITORY || 'Kangentic/kangentic';
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repo') {
      repo = argv[index + 1];
      index += 1;
    } else if (argv[index] === '--dry-run') {
      dryRun = true;
    } else {
      positional.push(argv[index]);
    }
  }
  return { tag: positional[0], repo, dryRun };
}

/**
 * The files the feed lists, in electron-builder's order within an arch (the zip,
 * then the dmg) and arm64 first, so a client that reads the first file gets the
 * arm64 zip as before.
 *
 * @param {string} version Version without a leading "v".
 * @returns {string[]}
 */
function macFeedFileNames(version) {
  return MAC_ARCHES.flatMap((arch) => [`Kangentic-${version}-${arch}-mac.zip`, `Kangentic-${version}-${arch}.dmg`]);
}

/**
 * Split a feed into the text before its `files:` block, the block's items (each a
 * list of lines), and the text after it. The block runs from the column-0
 * `files:` key to the next column-0 line, so a release note line that looks like
 * a list item is never part of it.
 *
 * @param {string} ymlText
 * @returns {{ head: string[], items: string[][], tail: string[] }}
 */
function splitFeed(ymlText) {
  const lines = ymlText.replace(/\r\n/g, '\n').split('\n');
  const filesIndex = lines.findIndex((line) => /^files:\s*$/.test(line));
  if (filesIndex === -1) {
    throw new Error(`The feed has no top-level "files:" list.`);
  }
  let endIndex = filesIndex + 1;
  while (endIndex < lines.length && (lines[endIndex] === '' || /^\s/.test(lines[endIndex]))) {
    endIndex += 1;
  }
  // A trailing blank line belongs to whatever follows, not to the last item.
  while (endIndex > filesIndex + 1 && lines[endIndex - 1] === '') {
    endIndex -= 1;
  }

  const items = [];
  for (const line of lines.slice(filesIndex + 1, endIndex)) {
    if (/^\s*- /.test(line)) {
      items.push([line]);
    } else if (items.length > 0) {
      items[items.length - 1].push(line);
    } else {
      throw new Error(`The feed's "files:" list starts with a line that is not a list item: "${line}".`);
    }
  }
  return { head: lines.slice(0, filesIndex + 1), items, tail: lines.slice(endIndex) };
}

/**
 * The `url` of one `files:` item.
 *
 * @param {string[]} item
 * @returns {string | null}
 */
function itemUrl(item) {
  for (const line of item) {
    const match = line.match(/^\s*(?:- )?url:\s*["']?([^"'\s]+)["']?\s*$/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Every url the feed's `files:` list names, in order.
 *
 * @param {string} ymlText
 * @returns {string[]}
 */
function feedFileUrls(ymlText) {
  return splitFeed(ymlText).items.map(itemUrl).filter((url) => url !== null);
}

/**
 * The feed's top-level `version`, or null.
 *
 * @param {string} ymlText
 * @returns {string | null}
 */
function readFeedVersion(ymlText) {
  const match = ymlText.match(/^version:\s*["']?([^"'\s]+)["']?\s*$/m);
  return match ? match[1] : null;
}

/**
 * A feed entry for one file, as electron-builder writes it: the sha512 digest in
 * base64 and the size in bytes.
 *
 * @param {string} filePath
 * @param {string} url The file's name on the release.
 * @returns {Promise<{ url: string, sha512: string, size: number }>}
 */
function fileEntry(filePath, url) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(filePath)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve({ url, sha512: hash.digest('base64'), size: fs.statSync(filePath).size }));
  });
}

/**
 * The base feed with its `files:` list replaced by `entries` and its top-level
 * `path` / `sha512` pointed at the first entry. Everything else is kept as it
 * was. Idempotent: building from a feed already built from the same entries
 * returns it unchanged.
 *
 * @param {string} baseText
 * @param {{ url: string, sha512: string, size: number }[]} entries
 * @returns {string}
 */
function buildMacFeed(baseText, entries) {
  if (entries.length === 0) throw new Error('No files to list in the feed.');
  const base = splitFeed(baseText);
  const items = entries.flatMap((entry) => [`  - url: ${entry.url}`, `    sha512: ${entry.sha512}`, `    size: ${entry.size}`]);
  let tail = base.tail;
  let head = base.head;
  const [first] = entries;
  for (const [key, value] of [['path', first.url], ['sha512', first.sha512]]) {
    const pattern = new RegExp(`^${key}:.*$`);
    const inHead = head.findIndex((line) => pattern.test(line));
    const inTail = tail.findIndex((line) => pattern.test(line));
    if (inTail !== -1) {
      tail = tail.map((line, index) => (index === inTail ? `${key}: ${value}` : line));
    } else if (inHead !== -1) {
      head = head.map((line, index) => (index === inHead ? `${key}: ${value}` : line));
    } else {
      throw new Error(`The feed has no top-level "${key}:" for older clients to read.`);
    }
  }
  return [...head, ...items, ...tail].join('\n');
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Download the feed and the macOS binaries from the release, hash the binaries,
 * and replace the release's feed when the computed one differs.
 *
 * @param {{ tag: string, repo: string, dryRun: boolean }} options
 * @param {{ execFile?: typeof execFileSync }} [dependencies] `execFile` runs both
 *   `gh` calls. It is a parameter because `execFileSync` is bound when this file
 *   loads, so a test cannot replace it afterwards.
 * @returns {Promise<void>}
 */
async function mergeReleaseFeed({ tag, repo, dryRun }, { execFile = execFileSync } = {}) {
  const version = tag.replace(/^v/, '');
  const fileNames = macFeedFileNames(version);
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mac-feed-'));
  try {
    const patterns = [CHANNEL_FILE, ...fileNames].flatMap((name) => ['--pattern', name]);
    try {
      execFile('gh', ['release', 'download', tag, '--repo', repo, ...patterns, '--dir', workDirectory, '--clobber'], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (error) {
      throw new Error(`Could not download ${CHANNEL_FILE} and the macOS binaries from ${tag}: ${describeError(error)}`);
    }

    const missing = [CHANNEL_FILE, ...fileNames].filter((name) => !fs.existsSync(path.join(workDirectory, name)));
    if (missing.length > 0) {
      throw new Error(
        `${tag} is missing ${missing.join(', ')}. The macOS leg that builds it did not upload it; ` +
          're-run that leg (verify-release-assets.js would refuse this release too).',
      );
    }

    const baseText = fs.readFileSync(path.join(workDirectory, CHANNEL_FILE), 'utf8');
    const baseVersion = readFeedVersion(baseText);
    if (baseVersion !== version) {
      throw new Error(`${CHANNEL_FILE} on ${tag} is for version ${baseVersion ?? '(none)'}, expected ${version}.`);
    }

    const entries = [];
    for (const name of fileNames) {
      entries.push(await fileEntry(path.join(workDirectory, name), name));
    }
    const merged = buildMacFeed(baseText, entries);
    const listing = entries.map((entry) => `${entry.url} (${entry.size} bytes)`).join(', ');

    if (dryRun) {
      process.stdout.write(merged);
      console.log(`\nDry run: ${CHANNEL_FILE} on ${tag} would list ${listing}. Nothing uploaded.`);
      return;
    }
    if (merged === baseText.replace(/\r\n/g, '\n')) {
      console.log(`${CHANNEL_FILE} on ${tag} already lists ${listing} with matching hashes. Not re-uploading.`);
      return;
    }

    const mergedPath = path.join(workDirectory, 'merged', CHANNEL_FILE);
    fs.mkdirSync(path.dirname(mergedPath), { recursive: true });
    fs.writeFileSync(mergedPath, merged);
    try {
      execFile('gh', ['release', 'upload', tag, mergedPath, '--clobber', '--repo', repo], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (error) {
      throw new Error(`Could not replace ${CHANNEL_FILE} on ${tag}: ${describeError(error)}`);
    }
    console.log(
      `${CHANNEL_FILE} on ${tag}: was listing ${feedFileUrls(baseText).join(', ') || 'nothing'}; ` +
        `now lists ${listing}, hashed from the files on the release.`,
    );
  } finally {
    // Retried: on Windows a scanner can hold a just-written dmg for a moment,
    // and a throw here would hide the result above.
    fs.rmSync(workDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.tag) {
    console.error('Usage: node scripts/merge-mac-update-feeds.js <tag> [--repo owner/name] [--dry-run]');
    process.exit(1);
  }
  try {
    await mergeReleaseFeed(options);
  } catch (error) {
    console.error(`::error::${describeError(error)}`);
    console.error('The release stays a draft. Fix the cause and re-run publish-release.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  macFeedFileNames,
  splitFeed,
  feedFileUrls,
  readFeedVersion,
  fileEntry,
  buildMacFeed,
  mergeReleaseFeed,
  main,
};

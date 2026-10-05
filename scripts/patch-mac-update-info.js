#!/usr/bin/env node
/**
 * Release step: stop Macs older than `mac.minimumSystemVersion` from
 * auto-updating into a build that will not open on them.
 *
 * electron-updater skips an update only when the feed carries
 * `minimumSystemVersion` (AppUpdater.checkIfUpdateSupported). electron-builder
 * writes `mac.minimumSystemVersion` into Info.plist and the pkg requirements,
 * never into latest-mac.yml, and cannot be made to: `releaseInfo` rejects extra
 * keys, and the mac zip's update info carries a `sha512`, so anything passed
 * through `updateInfo` lands under `files[0]` instead of at the top level. So
 * without this step a Mac on a dropped macOS downloads the update, installs it,
 * and macOS refuses to open the result.
 *
 * The value is the DARWIN version, not the macOS one: the updater compares it
 * against `os.release()` with `semver.lt`, and fails open on anything that is
 * not full semver. macOS 13 is Darwin 22, so a macOS 12 Mac (Darwin 21.x) is
 * refused and macOS 13.0 (Darwin 22.1.0) is not.
 *
 * electron-builder uploads latest-mac.yml from memory during `npm run publish`,
 * so editing the file on disk afterwards changes nothing. This replaces the
 * asset on the draft release instead, then downloads it again to prove the
 * field landed. It runs in publish-release, after every platform leg, so a
 * re-run of the mac leg alone cannot put the unpatched file back before the
 * release goes live.
 *
 * Usage: node scripts/patch-mac-update-info.js <tag> [--repo owner/name] [--dry-run]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CHANNEL_FILE = 'latest-mac.yml';
const BUILDER_CONFIG_PATH = path.join(__dirname, '..', 'electron-builder.yml');

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
 * `minimumSystemVersion` from the top-level `mac:` block of electron-builder.yml.
 * Read from the config at release time, so the feed can never disagree with
 * the LSMinimumSystemVersion baked into the app itself.
 *
 * @param {string} builderYmlText
 * @returns {string} e.g. "13.0"
 */
function readMacMinimumSystemVersion(builderYmlText) {
  const block = builderYmlText.replace(/\r\n/g, '\n').match(/\nmac:\n((?:[ \t].*\n?)*)/);
  if (!block) {
    throw new Error('electron-builder.yml has no top-level "mac:" block.');
  }
  const value = block[1].match(/^ {2}minimumSystemVersion:\s*["']?([0-9.]+)["']?\s*$/m);
  if (!value) {
    throw new Error(
      'electron-builder.yml "mac:" has no minimumSystemVersion. Without it there is nothing to ' +
        'block older Macs with, and they would auto-update into a build they cannot open.'
    );
  }
  return value[1];
}

/**
 * The Darwin kernel version a macOS release reports from `os.release()`, as the
 * full semver electron-updater needs. macOS 11 and later: Darwin = major + 9.
 * Mac OS X 10.x: Darwin = minor + 4.
 *
 * @param {string} macosVersion e.g. "13.0"
 * @returns {string} e.g. "22.0.0"
 */
function darwinVersionForMacos(macosVersion) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.\d+)?$/.exec(String(macosVersion).trim());
  if (!match) {
    throw new Error(`Not a macOS version: "${macosVersion}".`);
  }
  const major = Number(match[1]);
  const minor = match[2] === undefined ? 0 : Number(match[2]);
  if (major >= 11) return `${major + 9}.0.0`;
  if (major === 10) return `${minor + 4}.0.0`;
  throw new Error(`No Darwin mapping for macOS ${macosVersion}.`);
}

const MINIMUM_SYSTEM_VERSION_LINE = /^minimumSystemVersion:.*$/m;

/**
 * Set the top-level `minimumSystemVersion` of an update feed. Replaces a
 * column-0 key or appends one at column 0. A column-0 key always ends the
 * `releaseNotes: |` block scalar above it, whose own lines are indented, so
 * neither branch can land inside the release notes. Quoted so YAML reads a
 * string. Idempotent.
 *
 * @param {string} ymlText
 * @param {string} darwinVersion
 * @returns {{ text: string, action: 'added' | 'replaced' | 'unchanged' }}
 */
function withMinimumSystemVersion(ymlText, darwinVersion) {
  const line = `minimumSystemVersion: '${darwinVersion}'`;
  const existing = ymlText.match(MINIMUM_SYSTEM_VERSION_LINE);
  if (existing) {
    if (existing[0].trimEnd() === line) return { text: ymlText, action: 'unchanged' };
    return { text: ymlText.replace(MINIMUM_SYSTEM_VERSION_LINE, line), action: 'replaced' };
  }
  const base = ymlText.endsWith('\n') ? ymlText : `${ymlText}\n`;
  return { text: `${base}${line}\n`, action: 'added' };
}

/**
 * The feed's top-level `minimumSystemVersion`, or null.
 *
 * @param {string} ymlText
 * @returns {string | null}
 */
function readFeedMinimumSystemVersion(ymlText) {
  const match = ymlText.match(/^minimumSystemVersion:\s*["']?([^"'\s]+)["']?\s*$/m);
  return match ? match[1] : null;
}

function downloadChannelFile(tag, repo, directory) {
  execFileSync(
    'gh',
    ['release', 'download', tag, '--repo', repo, '--pattern', CHANNEL_FILE, '--dir', directory, '--clobber'],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  const filePath = path.join(directory, CHANNEL_FILE);
  if (!fs.existsSync(filePath)) {
    throw new Error(`${CHANNEL_FILE} is not attached to release ${tag}.`);
  }
  return filePath;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Patch the release's feed and prove the result. Throws on every failure; main
 * turns that into the `::error::` and nonzero exit that keep the release a draft.
 */
function patchReleaseFeed({ tag, repo, dryRun }) {
  const macosVersion = readMacMinimumSystemVersion(fs.readFileSync(BUILDER_CONFIG_PATH, 'utf8'));
  const darwinVersion = darwinVersionForMacos(macosVersion);

  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-mac-feed-'));
  try {
    let original;
    try {
      original = fs.readFileSync(downloadChannelFile(tag, repo, workDirectory), 'utf8');
    } catch (error) {
      throw new Error(`Could not download ${CHANNEL_FILE} from ${tag}: ${describeError(error)}`);
    }

    const { text, action } = withMinimumSystemVersion(original, darwinVersion);
    if (dryRun) {
      process.stdout.write(text);
      console.log(
        `\nDry run: would have ${action === 'unchanged' ? 'left unchanged' : action} ` +
          `minimumSystemVersion '${darwinVersion}' (macOS ${macosVersion}) in ${CHANNEL_FILE} on ${tag}. Nothing uploaded.`
      );
      return;
    }

    if (action === 'unchanged') {
      console.log(
        `${CHANNEL_FILE} on ${tag} already carries minimumSystemVersion '${darwinVersion}' (macOS ${macosVersion}). Not re-uploading.`
      );
    } else {
      const patchedPath = path.join(workDirectory, 'patched', CHANNEL_FILE);
      fs.mkdirSync(path.dirname(patchedPath), { recursive: true });
      fs.writeFileSync(patchedPath, text);
      try {
        execFileSync('gh', ['release', 'upload', tag, patchedPath, '--clobber', '--repo', repo], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
      } catch (error) {
        throw new Error(`Could not replace ${CHANNEL_FILE} on ${tag}: ${describeError(error)}`);
      }
    }

    // Prove it from the release itself, not from what was sent.
    const verifyDirectory = path.join(workDirectory, 'verify');
    fs.mkdirSync(verifyDirectory, { recursive: true });
    let published;
    try {
      published = readFeedMinimumSystemVersion(fs.readFileSync(downloadChannelFile(tag, repo, verifyDirectory), 'utf8'));
    } catch (error) {
      throw new Error(`Could not re-download ${CHANNEL_FILE} from ${tag} to verify it: ${describeError(error)}`);
    }
    if (published !== darwinVersion) {
      throw new Error(
        `${CHANNEL_FILE} on ${tag} carries minimumSystemVersion ${published === null ? '(none)' : `'${published}'`} ` +
          `after the upload, expected '${darwinVersion}'. Macs below macOS ${macosVersion} would auto-update into a build they cannot open.`
      );
    }
    console.log(
      `${CHANNEL_FILE} on ${tag}: ${action === 'unchanged' ? 'already had' : action} minimumSystemVersion ` +
        `'${darwinVersion}' (macOS ${macosVersion}), verified on the release. Older Macs will not be offered this update.`
    );
  } finally {
    fs.rmSync(workDirectory, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.tag) {
    console.error('Usage: node scripts/patch-mac-update-info.js <tag> [--repo owner/name] [--dry-run]');
    process.exit(1);
  }
  try {
    patchReleaseFeed(options);
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
  readMacMinimumSystemVersion,
  darwinVersionForMacos,
  withMinimumSystemVersion,
  readFeedMinimumSystemVersion,
};

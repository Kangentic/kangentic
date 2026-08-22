#!/usr/bin/env node
/**
 * Release gate: prove a tag resolves to exactly ONE release carrying every
 * expected asset, before that release is published.
 *
 * v0.35.0 shipped Windows-only while every platform job reported success. The
 * artifacts had landed on three separate release objects for one tag, and the
 * publish step resolved the tag to one of them. Build success says nothing about
 * what is attached to the release being published, so this is the check that
 * actually prevents a partial release. A failure here leaves the release a draft.
 *
 * Usage: node scripts/verify-release-assets.js <tag> [--repo owner/name]
 */

const { execFileSync } = require('node:child_process');
const { expectedReleaseAssets, CHANNEL_FILES } = require('./release-assets');

function parseArgs(argv) {
  const positional = [];
  let repo = process.env.GITHUB_REPOSITORY || 'Kangentic/kangentic';
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--repo') {
      repo = argv[index + 1];
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  return { tag: positional[0], repo };
}

/**
 * Every release object carrying this tag.
 *
 * Deliberately lists /releases and filters, rather than calling
 * /releases/tags/<tag>: that endpoint resolves only PUBLISHED releases, and this
 * gate runs while the release is still a draft. It is also the only way to see a
 * duplicate draft, which is the failure this exists to catch.
 *
 * Pages explicitly rather than using `gh api --paginate`, which concatenates raw
 * JSON arrays: stitching those back together means splicing on `][`, and release
 * bodies contain markdown reference links that produce exactly that sequence.
 */
function releasesForTag(repo, tag) {
  const matching = [];
  for (let page = 1; page <= 20; page += 1) {
    const raw = execFileSync(
      'gh',
      ['api', `repos/${repo}/releases?per_page=100&page=${page}`],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
    );
    const releases = JSON.parse(raw);
    if (releases.length === 0) break;
    matching.push(...releases.filter((release) => release.tag_name === tag));
    if (releases.length < 100) break;
  }
  return matching;
}

/**
 * The pure decision. Split out from the I/O above so every failure branch is
 * unit-testable without a network round trip.
 *
 * @param {Array} releases Release objects already filtered to one tag.
 * @param {string} tag
 * @returns {{ ok: boolean, problems: string[], release: object | null }}
 */
function verifyReleaseAssets(releases, tag) {
  const version = tag.replace(/^v/, '');
  const expected = expectedReleaseAssets(version);
  const problems = [];

  if (releases.length === 0) {
    return { ok: false, problems: [`No release found for tag ${tag}.`], release: null };
  }

  // The split itself. Naming the ids matters: drafts are invisible to
  // `gh release view <tag>`, so without them the extras are hard to even find.
  if (releases.length > 1) {
    const described = releases
      .map((release) => `      id=${release.id} draft=${release.draft} assets=${release.assets.length}`)
      .join('\n');
    problems.push(
      `Tag ${tag} resolves to ${releases.length} release objects; expected exactly 1.\n${described}\n` +
        '      Consolidate the assets onto one release and delete the extras before publishing.'
    );
  }

  const release = releases.find((candidate) => candidate.draft) || releases[0];
  const assetsByName = new Map(release.assets.map((asset) => [asset.name, asset]));

  const missing = expected.filter((name) => !assetsByName.has(name));
  if (missing.length > 0) {
    const missingChannels = missing.filter((name) => CHANNEL_FILES.includes(name));
    problems.push(
      `Release id=${release.id} is missing ${missing.length} of ${expected.length} expected assets:\n` +
        missing.map((name) => `      ${name}`).join('\n') +
        (missingChannels.length > 0
          ? `\n      ${missingChannels.length} of these are updater channel files, so auto-update ` +
            'would be broken for those platforms.'
          : '')
    );
  }

  // An asset still uploading is listed but not yet fetchable.
  const incomplete = expected
    .map((name) => assetsByName.get(name))
    .filter((asset) => asset && asset.state !== 'uploaded');
  if (incomplete.length > 0) {
    problems.push(
      'Some assets are not in the "uploaded" state:\n' +
        incomplete.map((asset) => `      ${asset.name} (state=${asset.state})`).join('\n')
    );
  }

  return { ok: problems.length === 0, problems, release };
}

function main() {
  const { tag, repo } = parseArgs(process.argv.slice(2));
  if (!tag) {
    console.error('Usage: node scripts/verify-release-assets.js <tag> [--repo owner/name]');
    process.exit(1);
  }

  const { ok, problems, release } = verifyReleaseAssets(releasesForTag(repo, tag), tag);

  if (!ok) {
    console.error(`\nRelease verification FAILED for ${tag}.\n`);
    for (const problem of problems) console.error(`  - ${problem}\n`);
    console.error('Refusing to publish. The release stays a draft.');
    console.error(
      'If this is an intentional rename, a new platform, or a dropped one, update the expected\n' +
        'list in scripts/release-assets.js (and tests/unit/release-asset-manifest.test.ts) first.'
    );
    process.exit(1);
  }

  const expectedCount = expectedReleaseAssets(tag.replace(/^v/, '')).length;
  console.log(
    `Release verification passed for ${tag}: release id=${release.id} carries all ${expectedCount} expected assets.`
  );
}

if (require.main === module) {
  main();
}

// parseArgs and main are exported for tests: main is what turns an `ok: false`
// decision into the nonzero exit that actually blocks the publish step, so it is
// load-bearing rather than glue.
module.exports = { verifyReleaseAssets, releasesForTag, parseArgs, main };

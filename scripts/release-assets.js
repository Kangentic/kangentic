/**
 * The complete set of assets a release must carry, for one version.
 *
 * The release gate (scripts/verify-release-assets.js) reads this file directly.
 * The launcher does NOT: packages/launcher/bin/kangentic.js is deliberately
 * zero-dependency and hardcodes its own copies of these filenames. So the two are
 * cross-CHECKED, not shared, and changing a name here does not update the
 * launcher. tests/unit/release-asset-manifest.test.ts is what pins them together,
 * along with electron-builder.yml's artifactName templates.
 *
 * It is a plain explicit list rather than something derived from
 * electron-builder.yml at runtime: the gate runs at the moment of publishing,
 * where a YAML-parsing bug would be expensive and hard to diagnose. Drift is
 * caught in CI instead.
 *
 * The three channel files are what electron-updater actually fetches, so a
 * release missing one of them is broken for that platform even though every
 * platform build succeeded. That is exactly how v0.35.0 shipped Windows-only.
 */

/**
 * The macOS arch built today. Intel macs and linux arm64 have no artifacts.
 *
 * Adding a second macOS arch is NOT a matter of reassigning this constant: that
 * would rename the existing four mac entries and silently drop arm64 coverage.
 * Duplicate the four mac lines below for the new arch instead, and bump the asset
 * count the test and the docs hardcode (tests/unit/release-asset-manifest.test.ts,
 * docs/deployment.md, .claude/skills/release/SKILL.md all say 11).
 */
const MAC_ARCH = 'arm64';

/**
 * @param {string} version Version without a leading "v" (e.g. "0.35.0").
 * @returns {string[]} Every filename the release must carry.
 */
function expectedReleaseAssets(version) {
  return [
    // Windows (nsis)
    `Kangentic-Setup-${version}.exe`,
    `Kangentic-Setup-${version}.exe.blockmap`,
    'latest.yml',

    // macOS (dmg + zip)
    `Kangentic-${version}-${MAC_ARCH}.dmg`,
    `Kangentic-${version}-${MAC_ARCH}.dmg.blockmap`,
    `Kangentic-${version}-${MAC_ARCH}-mac.zip`,
    `Kangentic-${version}-${MAC_ARCH}-mac.zip.blockmap`,
    'latest-mac.yml',

    // Linux (deb + rpm)
    `kangentic_${version}_amd64.deb`,
    `kangentic-${version}-1.x86_64.rpm`,
    'latest-linux.yml',
  ];
}

/** The updater manifests, called out separately because a release missing one is
 *  broken for that platform even when every binary is present. */
const CHANNEL_FILES = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml'];

module.exports = { expectedReleaseAssets, CHANNEL_FILES, MAC_ARCH };

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
 * The channel files are what electron-updater actually fetches, so a release
 * missing one of them is broken for that platform even though every platform
 * build succeeded. That is exactly how v0.35.0 shipped Windows-only.
 */

/**
 * The macOS arches built, one release leg each. Both legs feed ONE latest-mac.yml:
 * electron-updater's MacUpdater picks the zip whose URL names arm64 on Apple
 * silicon and the other one on Intel, so the feed must list both zips. The legs
 * cannot write that file themselves, since each would replace the other's, so
 * release.yml's publish-release job rebuilds it from the binaries on the release
 * (scripts/merge-mac-update-feeds.js).
 *
 * Adding or dropping an arch changes the asset count the test and the docs
 * hardcode (tests/unit/release-asset-manifest.test.ts, docs/deployment.md,
 * .claude/skills/release/SKILL.md). Those say 18 BUILD assets, and the docs also
 * say a finished release carries 19: release.yml's demo-posters job attaches the
 * docs poster set after publishing, deliberately outside this list, since this
 * manifest is verified before that job runs.
 */
const MAC_ARCHES = ['arm64', 'x64'];

/**
 * The Linux arches built, one release leg each, under electron-builder's per-format
 * arch names (builder-util's getArtifactArchName: x64 is amd64 for deb and x86_64
 * for rpm, arm64 is arm64 and aarch64). Unlike macOS, every Linux arch gets its own
 * update feed: electron-updater reads latest-linux.yml on x64 and
 * latest-linux-<arch>.yml everywhere else.
 */
const LINUX_TARGETS = [
  { arch: 'x64', debArch: 'amd64', rpmArch: 'x86_64', channelFile: 'latest-linux.yml' },
  { arch: 'arm64', debArch: 'arm64', rpmArch: 'aarch64', channelFile: 'latest-linux-arm64.yml' },
];

/**
 * @param {string} version Version without a leading "v" (e.g. "0.35.0").
 * @returns {string[]} The mac zips the merged latest-mac.yml must list, one per arch.
 */
function expectedMacZips(version) {
  return MAC_ARCHES.map((arch) => `Kangentic-${version}-${arch}-mac.zip`);
}

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

    // macOS (dmg + zip per arch, one shared feed)
    ...MAC_ARCHES.flatMap((arch) => [
      `Kangentic-${version}-${arch}.dmg`,
      `Kangentic-${version}-${arch}.dmg.blockmap`,
      `Kangentic-${version}-${arch}-mac.zip`,
      `Kangentic-${version}-${arch}-mac.zip.blockmap`,
    ]),
    'latest-mac.yml',

    // Linux (deb + rpm + feed per arch)
    ...LINUX_TARGETS.flatMap((target) => [
      `kangentic_${version}_${target.debArch}.deb`,
      `kangentic-${version}-1.${target.rpmArch}.rpm`,
      target.channelFile,
    ]),
  ];
}

/** The updater manifests, called out separately because a release missing one is
 *  broken for that platform even when every binary is present. */
const CHANNEL_FILES = ['latest.yml', 'latest-mac.yml', ...LINUX_TARGETS.map((target) => target.channelFile)];

module.exports = { expectedReleaseAssets, expectedMacZips, CHANNEL_FILES, MAC_ARCHES, LINUX_TARGETS };

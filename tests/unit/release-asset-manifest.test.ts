import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// v0.35.0 shipped Windows-only: three matrix legs each created their own draft release for one
// tag, and the publish step resolved the tag to one of them. scripts/verify-release-assets.js is
// the gate that now blocks that, and scripts/release-assets.js is the manifest it checks against.
//
// A manifest is only as good as its agreement with what actually gets built and downloaded, and
// there are two independent ways for it to drift:
//
//   1. electron-builder.yml renames an artifact  -> the gate fails the release (loud, recoverable)
//   2. the launcher expects a different name     -> `npx kangentic` 404s (silent, user-facing)
//
// Nothing cross-checked those before. This test pins all three to each other, so a rename in any
// one of them fails CI instead of a release. Two of the four platform filenames were inherited
// electron-builder defaults until this task pinned them; see the comments in electron-builder.yml.
//
// Follows linux-package-deps.test.ts in regex-extracting YAML rather than adding a parser
// (js-yaml is only transitively present, not a declared dependency).
//
// The launcher side is checked by CALLING its getArtifactFilename for every arch the manifest
// ships, rather than by matching its source text, so a launcher that names an arch differently
// from the manifest (amd64 against x86_64, aarch64 against arm64) fails here.
//
// What this does NOT catch: the arch names electron-builder itself produces. The manifest and the
// expansions below both take the deb/rpm names from LINUX_TARGETS, so if builder-util's
// getArtifactArchName ever mapped an arch to a different string, both sides would move together
// and this stayed green while the real filename changed. It is a cross-reference check between
// three files, not a check against electron-builder's actual output. The release gate catching a
// missing asset is the backstop for that class.

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

interface LinuxTarget {
  arch: string;
  debArch: string;
  rpmArch: string;
  channelFile: string;
}

const { expectedReleaseAssets, expectedMacZips, CHANNEL_FILES, MAC_ARCHES, LINUX_TARGETS } = requireFromRepo(
  './scripts/release-assets.js'
) as {
  expectedReleaseAssets: (version: string) => string[];
  expectedMacZips: (version: string) => string[];
  CHANNEL_FILES: string[];
  MAC_ARCHES: string[];
  LINUX_TARGETS: LinuxTarget[];
};

const { verifyReleaseAssets } = requireFromRepo('./scripts/verify-release-assets.js') as {
  verifyReleaseAssets: (
    releases: ReleaseFixture[],
    tag: string,
    readAssetText: (asset: ReleaseAsset) => string
  ) => { ok: boolean; problems: string[]; release: ReleaseFixture | null };
};

interface ReleaseAsset {
  name: string;
  state: string;
}

interface ReleaseFixture {
  id: number;
  draft: boolean;
  assets: ReleaseAsset[];
}

const VERSION = '9.9.9';
const PRODUCT_NAME = 'Kangentic';
const PACKAGE_NAME = 'kangentic';

/** Extract the full indented body of a top-level YAML key. Mirrors linux-package-deps.test.ts. */
function extractTopLevelBlock(yamlSource: string, topLevelKey: string): string {
  const match = yamlSource.match(new RegExp(`\\n${topLevelKey}:\\n((?:[ \\t].*\\n?)*)`));
  if (!match) {
    throw new Error(`electron-builder.yml: could not find top-level key "${topLevelKey}:"`);
  }
  return match[1];
}

/** Read `artifactName: "<template>"` out of an already-extracted block. */
function extractArtifactName(block: string, blockName: string): string {
  const match = block.match(/^\s*artifactName:\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(
      `electron-builder.yml: "${blockName}" has no artifactName. All four platform artifact ` +
        'names must stay pinned, or the release manifest is guessing at electron-builder defaults.'
    );
  }
  return match[1];
}

/**
 * Expand an electron-builder artifactName template. Only the macros the four pinned templates
 * actually use are supported: an unknown macro throws rather than silently expanding to "".
 */
function expandTemplate(
  template: string,
  values: { version: string; arch: string; ext: string; os: string }
): string {
  return template.replace(/\$\{(\w+)\}/g, (_match, macro: string) => {
    switch (macro) {
      case 'productName':
        return PRODUCT_NAME;
      case 'name':
        return PACKAGE_NAME;
      case 'version':
        return values.version;
      case 'arch':
        return values.arch;
      case 'ext':
        return values.ext;
      case 'os':
        return values.os;
      default:
        throw new Error(`Unsupported macro \${${macro}} in artifactName template "${template}"`);
    }
  });
}

const electronBuilderYaml = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
const launcherSource = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/launcher/bin/kangentic.js'),
  'utf8'
);

describe('release asset manifest', () => {
  it('lists exactly 18 assets, including every updater channel file', () => {
    // Windows 3; macOS 4 per arch plus one shared latest-mac.yml; Linux 3 per arch. The docs and
    // the release skill hardcode this count (18 build assets, 19 with the poster zip).
    const assets = expectedReleaseAssets(VERSION);
    expect(assets).toHaveLength(18);
    expect(new Set(assets).size).toBe(18);
    expect(CHANNEL_FILES).toEqual(['latest.yml', 'latest-mac.yml', 'latest-linux.yml', 'latest-linux-arm64.yml']);
    for (const channelFile of CHANNEL_FILES) {
      expect(assets).toContain(channelFile);
    }
  });

  it('ships both macOS arches and both Linux arches', () => {
    expect(MAC_ARCHES).toEqual(['arm64', 'x64']);
    expect(LINUX_TARGETS.map((target) => target.arch)).toEqual(['x64', 'arm64']);
    expect(expectedMacZips(VERSION)).toEqual([
      `${PRODUCT_NAME}-${VERSION}-arm64-mac.zip`,
      `${PRODUCT_NAME}-${VERSION}-x64-mac.zip`,
    ]);
  });

  // electron-updater reads latest-linux.yml on x64 and latest-linux-<arch>.yml on every other arch
  // (electron-updater's Provider.getChannelFilePrefix), and electron-builder writes the same names.
  it('names each Linux feed the way electron-updater asks for it', () => {
    for (const target of LINUX_TARGETS) {
      expect(target.channelFile).toBe(target.arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${target.arch}.yml`);
    }
  });

  it('matches the artifactName pinned in electron-builder.yml for every platform', () => {
    const assets = expectedReleaseAssets(VERSION);

    // Windows: nsis.artifactName
    const nsisTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'nsis'), 'nsis');
    const exeName = expandTemplate(nsisTemplate, {
      version: VERSION,
      arch: 'x64',
      ext: 'exe',
      os: 'win',
    });
    expect(assets).toContain(exeName);
    expect(assets).toContain(`${exeName}.blockmap`);

    // macOS zip and dmg, per arch: mac.artifactName (the dmg overrides it with dmg.artifactName)
    const macTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'mac'), 'mac');
    const dmgTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'dmg'), 'dmg');
    for (const arch of MAC_ARCHES) {
      const zipName = expandTemplate(macTemplate, { version: VERSION, arch, ext: 'zip', os: 'mac' });
      expect(assets).toContain(zipName);
      expect(assets).toContain(`${zipName}.blockmap`);
      const dmgName = expandTemplate(dmgTemplate, { version: VERSION, arch, ext: 'dmg', os: 'mac' });
      expect(assets).toContain(dmgName);
      expect(assets).toContain(`${dmgName}.blockmap`);
    }

    // Linux deb + rpm, per arch, under electron-builder's per-format arch names
    const debTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'deb'), 'deb');
    const rpmTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'rpm'), 'rpm');
    for (const target of LINUX_TARGETS) {
      expect(assets).toContain(
        expandTemplate(debTemplate, { version: VERSION, arch: target.debArch, ext: 'deb', os: 'linux' })
      );
      expect(assets).toContain(
        expandTemplate(rpmTemplate, { version: VERSION, arch: target.rpmArch, ext: 'rpm', os: 'linux' })
      );
    }
  });

  // The silent half of the drift: a renamed asset makes the gate fail loudly, but a launcher that
  // expects the old name just 404s for every new user on that platform. Every filename the launcher
  // can produce, for every arch it accepts, must be one the release carries, and every package the
  // release carries must be one the launcher can ask for.
  it('matches the filenames the launcher builds its download URLs from', () => {
    const assets = expectedReleaseAssets(VERSION);
    const launcherVersion = (requireFromRepo('./packages/launcher/package.json') as { version: string }).version;
    const launcher = launcherWithCommands();
    const asked = new Set<string>();

    // Restored even when an assertion here fails, or the stubbed execFileSync
    // and the cached launcher leak into every later test in this worker.
    try {
      const exeName = launcher.module.getArtifactFilename({ platform: 'win32', arch: 'x64' });
      expect(exeName).toBe(`${PRODUCT_NAME}-Setup-${launcherVersion}.exe`);
      asked.add(exeName ?? '');

      expect(launcher.module.MAC_ARCHES).toEqual(MAC_ARCHES);
      for (const arch of launcher.module.MAC_ARCHES) {
        asked.add(launcher.module.getArtifactFilename({ platform: 'darwin', arch }) ?? '');
      }

      expect(Object.keys(launcher.module.LINUX_PACKAGE_ARCHES)).toEqual(LINUX_TARGETS.map((target) => target.arch));
      for (const target of LINUX_TARGETS) {
        // rpm when rpm exists and apt does not, else deb
        launcher.setCommands(['rpm']);
        asked.add(launcher.module.getArtifactFilename({ platform: 'linux', arch: target.arch }) ?? '');
        launcher.setCommands(['apt']);
        asked.add(launcher.module.getArtifactFilename({ platform: 'linux', arch: target.arch }) ?? '');
      }
    } finally {
      launcher.restore();
    }

    const askedForThisVersion = [...asked].map((name) => name.replace(launcherVersion, VERSION));
    for (const name of askedForThisVersion) {
      expect(assets, `the launcher asks for ${name}, which no release carries`).toContain(name);
    }
    const installers = assets.filter((name) => /\.(exe|deb|rpm)$|-mac\.zip$/.test(name));
    expect([...askedForThisVersion].sort()).toEqual([...installers].sort());

    // The version in the URL is the launcher's own, which publish-npm releases with the app.
    expect(launcherSource).toContain('/releases/download/v${VERSION}/${filename}');
  });
});

/**
 * The launcher, required with child_process.execFileSync stubbed so its `which` probe (rpm vs
 * apt) answers from a list instead of the host. Same approach as
 * launcher-linux-artifact-selection.test.ts: the launcher destructures execFileSync at require
 * time, so the stub reads a variable rather than being re-installed per case.
 */
function launcherWithCommands(): {
  module: {
    getArtifactFilename: (platformInfo: { platform: string; arch?: string }) => string | null;
    LINUX_PACKAGE_ARCHES: Record<string, { deb: string; rpm: string }>;
    MAC_ARCHES: string[];
  };
  setCommands: (commands: string[]) => void;
  restore: () => void;
} {
  const childProcessModule = requireFromRepo('node:child_process') as { execFileSync: (...args: unknown[]) => unknown };
  const realExecFileSync = childProcessModule.execFileSync;
  let available: string[] = [];
  childProcessModule.execFileSync = (command: unknown, args: unknown) => {
    if (command === 'which' && Array.isArray(args) && !available.includes(String(args[0]))) {
      throw new Error(`command not found: ${String(args[0])}`);
    }
    return '';
  };
  const launcherPath = path.join(REPO_ROOT, 'packages/launcher/bin/kangentic.js');
  delete requireFromRepo.cache[requireFromRepo.resolve(launcherPath)];
  const module = requireFromRepo(launcherPath) as ReturnType<typeof launcherWithCommands>['module'];
  return {
    module,
    setCommands: (commands) => { available = commands; },
    restore: () => {
      childProcessModule.execFileSync = realExecFileSync;
      delete requireFromRepo.cache[requireFromRepo.resolve(launcherPath)];
    },
  };
}

/** A latest-mac.yml as the publish-release merge leaves it: every arch's zip and dmg. */
function macFeedListing(zips: string[]): string {
  const items = zips.flatMap((zip) => [
    `  - url: ${zip}`,
    '    sha512: c2hhNTEy',
    '    size: 100',
    `  - url: ${zip.replace('-mac.zip', '.dmg')}`,
    '    sha512: c2hhNTEy',
    '    size: 100',
  ]);
  return [`version: ${VERSION}`, 'files:', ...items, `path: ${zips[0]}`, 'sha512: c2hhNTEy', "releaseDate: '2026-10-13T00:00:00.000Z'", ''].join('\n');
}

const MERGED_FEED = macFeedListing(expectedMacZips(VERSION));
const readMergedFeed = (): string => MERGED_FEED;

function releaseWithAllAssets(id: number, draft: boolean): ReleaseFixture {
  return {
    id,
    draft,
    assets: expectedReleaseAssets(VERSION).map((name) => ({ name, state: 'uploaded' })),
  };
}

describe('verifyReleaseAssets', () => {
  it('passes for a single release carrying every expected asset', () => {
    const result = verifyReleaseAssets([releaseWithAllAssets(1, true)], `v${VERSION}`, readMergedFeed);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  // Both mac legs upload a latest-mac.yml naming only their own zip, and the second replaces the
  // first. Without the publish-release merge the release carries every NAME and still strands
  // every Mac of the arch that lost, which a name check alone cannot see.
  it('fails when latest-mac.yml lists only one arch, naming the zip it lacks', () => {
    const armOnly = macFeedListing([`${PRODUCT_NAME}-${VERSION}-arm64-mac.zip`]);
    const result = verifyReleaseAssets([releaseWithAllAssets(1, true)], `v${VERSION}`, () => armOnly);
    expect(result.ok).toBe(false);
    const joined = result.problems.join('\n');
    expect(joined).toContain(`latest-mac.yml does not list ${PRODUCT_NAME}-${VERSION}-x64-mac.zip`);
    expect(joined).toContain('merge-mac-update-feeds.js');
  });

  it('fails, saying so, when latest-mac.yml cannot be read', () => {
    const result = verifyReleaseAssets([releaseWithAllAssets(1, true)], `v${VERSION}`, () => {
      throw new Error('HTTP 404');
    });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('Could not read latest-mac.yml');
  });

  it('reads latest-mac.yml from the chosen release, not from another one', () => {
    const readAsset = vi.fn(readMergedFeed);
    const release = releaseWithAllAssets(7, true);
    verifyReleaseAssets([release], `v${VERSION}`, readAsset);
    expect(readAsset).toHaveBeenCalledTimes(1);
    expect(readAsset.mock.calls[0][0]).toBe(release.assets.find((asset) => asset.name === 'latest-mac.yml'));
  });

  // An asset still uploading is listed but not fetchable, so reading it would throw and stack an
  // "unreadable feed" complaint on top of the real one. The state problem alone is the useful
  // message, and the reader throws here (as the asset API does) so reading it at all shows up.
  it('does not read latest-mac.yml while it is still uploading, and reports only its state', () => {
    const release = releaseWithAllAssets(1, true);
    const feed = release.assets.find((asset) => asset.name === 'latest-mac.yml');
    if (!feed) throw new Error('fixture is missing latest-mac.yml');
    feed.state = 'starting';
    const readAsset = vi.fn((): string => {
      throw new Error('HTTP 404');
    });

    const result = verifyReleaseAssets([release], `v${VERSION}`, readAsset);

    expect(readAsset).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('latest-mac.yml (state=starting)');
    expect(result.problems.join('\n')).not.toContain('Could not read latest-mac.yml');
  });

  it('fails when the tag has no release at all', () => {
    const result = verifyReleaseAssets([], `v${VERSION}`, readMergedFeed);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain('No release found');
  });

  // The exact v0.35.0 shape: one published Windows release plus two orphaned drafts.
  it('fails when a tag resolves to more than one release object', () => {
    const windowsOnly: ReleaseFixture = {
      id: 371785632,
      draft: false,
      assets: [
        { name: `Kangentic-Setup-${VERSION}.exe`, state: 'uploaded' },
        { name: `Kangentic-Setup-${VERSION}.exe.blockmap`, state: 'uploaded' },
        { name: 'latest.yml', state: 'uploaded' },
      ],
    };
    const macDraft: ReleaseFixture = {
      id: 371785746,
      draft: true,
      assets: [{ name: 'latest-mac.yml', state: 'uploaded' }],
    };
    const linuxDraft: ReleaseFixture = {
      id: 371785726,
      draft: true,
      assets: [{ name: 'latest-linux.yml', state: 'uploaded' }],
    };

    const result = verifyReleaseAssets([windowsOnly, macDraft, linuxDraft], `v${VERSION}`, readMergedFeed);
    expect(result.ok).toBe(false);
    const joined = result.problems.join('\n');
    expect(joined).toContain('resolves to 3 release objects');
    expect(joined).toContain('371785746');
    expect(joined).toContain('371785726');
  });

  it('fails, and says so, when an updater channel file is missing', () => {
    const release = releaseWithAllAssets(1, true);
    release.assets = release.assets.filter((asset) => asset.name !== 'latest-mac.yml');

    const result = verifyReleaseAssets([release], `v${VERSION}`, readMergedFeed);
    expect(result.ok).toBe(false);
    const joined = result.problems.join('\n');
    expect(joined).toContain('latest-mac.yml');
    expect(joined).toContain('updater channel files');
  });

  it('fails when an expected asset is listed but still uploading', () => {
    const release = releaseWithAllAssets(1, true);
    const zip = release.assets.find((asset) => asset.name.endsWith('-mac.zip'));
    if (!zip) throw new Error('fixture is missing the mac zip');
    zip.state = 'starting';

    const result = verifyReleaseAssets([release], `v${VERSION}`, readMergedFeed);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('state=starting');
  });

  it('accepts a tag with or without the leading v', () => {
    expect(verifyReleaseAssets([releaseWithAllAssets(1, true)], VERSION, readMergedFeed).ok).toBe(true);
  });
});

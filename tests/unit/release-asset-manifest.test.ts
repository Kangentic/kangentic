import { describe, it, expect } from 'vitest';
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
// What this does NOT catch: the arch NAMES. Both the manifest and the expectations below
// hardcode the same values ("amd64" for deb, "x86_64" for rpm, MAC_ARCH for the mac pair), so if
// electron-builder's getArtifactArchName ever mapped x64 to a different string for one of these
// targets, both sides would move together and this stayed green while the real filename changed.
// It is a cross-reference check between three files, not a check against electron-builder's
// actual output. The release gate catching a missing asset is the backstop for that class.

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

const { expectedReleaseAssets, CHANNEL_FILES, MAC_ARCH } = requireFromRepo(
  './scripts/release-assets.js'
) as {
  expectedReleaseAssets: (version: string) => string[];
  CHANNEL_FILES: string[];
  MAC_ARCH: string;
};

const { verifyReleaseAssets } = requireFromRepo('./scripts/verify-release-assets.js') as {
  verifyReleaseAssets: (
    releases: ReleaseFixture[],
    tag: string
  ) => { ok: boolean; problems: string[]; release: ReleaseFixture | null };
};

interface ReleaseFixture {
  id: number;
  draft: boolean;
  assets: { name: string; state: string }[];
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
  it('lists exactly 11 assets, including all three updater channel files', () => {
    const assets = expectedReleaseAssets(VERSION);
    expect(assets).toHaveLength(11);
    expect(new Set(assets).size).toBe(11);
    for (const channelFile of CHANNEL_FILES) {
      expect(assets).toContain(channelFile);
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

    // macOS zip: mac.artifactName (the dmg overrides it below)
    const macTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'mac'), 'mac');
    const zipName = expandTemplate(macTemplate, {
      version: VERSION,
      arch: MAC_ARCH,
      ext: 'zip',
      os: 'mac',
    });
    expect(assets).toContain(zipName);
    expect(assets).toContain(`${zipName}.blockmap`);

    // macOS dmg: dmg.artifactName
    const dmgTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'dmg'), 'dmg');
    const dmgName = expandTemplate(dmgTemplate, {
      version: VERSION,
      arch: MAC_ARCH,
      ext: 'dmg',
      os: 'mac',
    });
    expect(assets).toContain(dmgName);
    expect(assets).toContain(`${dmgName}.blockmap`);

    // Linux deb + rpm
    const debTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'deb'), 'deb');
    expect(assets).toContain(
      expandTemplate(debTemplate, { version: VERSION, arch: 'amd64', ext: 'deb', os: 'linux' })
    );

    const rpmTemplate = extractArtifactName(extractTopLevelBlock(electronBuilderYaml, 'rpm'), 'rpm');
    expect(assets).toContain(
      expandTemplate(rpmTemplate, { version: VERSION, arch: 'x86_64', ext: 'rpm', os: 'linux' })
    );
  });

  // The silent half of the drift: a renamed asset makes the gate fail loudly, but a launcher that
  // expects the old name just 404s for every new user on that platform.
  it('matches the filenames the launcher builds its download URLs from', () => {
    const assets = expectedReleaseAssets(VERSION);

    // win32: `Kangentic-Setup-${version}.exe`
    expect(launcherSource).toContain(`${PRODUCT_NAME}-Setup-\${version}.exe`);
    expect(assets).toContain(`${PRODUCT_NAME}-Setup-${VERSION}.exe`);

    // darwin: `Kangentic-${version}-${platformInfo.arch}-mac.zip`
    expect(launcherSource).toMatch(
      /`Kangentic-\$\{version\}-\$\{[\w.]*arch\}-mac\.zip`/
    );
    expect(assets).toContain(`${PRODUCT_NAME}-${VERSION}-${MAC_ARCH}-mac.zip`);

    // linux: rpm when rpm exists and apt does not, else deb
    expect(launcherSource).toMatch(/`kangentic-\$\{version\}-1\.x86_64\.rpm`/);
    expect(launcherSource).toMatch(/`kangentic_\$\{version\}_amd64\.deb`/);
    expect(assets).toContain(`${PACKAGE_NAME}-${VERSION}-1.x86_64.rpm`);
    expect(assets).toContain(`${PACKAGE_NAME}_${VERSION}_amd64.deb`);
  });
});

function releaseWithAllAssets(id: number, draft: boolean): ReleaseFixture {
  return {
    id,
    draft,
    assets: expectedReleaseAssets(VERSION).map((name) => ({ name, state: 'uploaded' })),
  };
}

describe('verifyReleaseAssets', () => {
  it('passes for a single release carrying every expected asset', () => {
    const result = verifyReleaseAssets([releaseWithAllAssets(1, true)], `v${VERSION}`);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  it('fails when the tag has no release at all', () => {
    const result = verifyReleaseAssets([], `v${VERSION}`);
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

    const result = verifyReleaseAssets([windowsOnly, macDraft, linuxDraft], `v${VERSION}`);
    expect(result.ok).toBe(false);
    const joined = result.problems.join('\n');
    expect(joined).toContain('resolves to 3 release objects');
    expect(joined).toContain('371785746');
    expect(joined).toContain('371785726');
  });

  it('fails, and says so, when an updater channel file is missing', () => {
    const release = releaseWithAllAssets(1, true);
    release.assets = release.assets.filter((asset) => asset.name !== 'latest-mac.yml');

    const result = verifyReleaseAssets([release], `v${VERSION}`);
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

    const result = verifyReleaseAssets([release], `v${VERSION}`);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toContain('state=starting');
  });

  it('accepts a tag with or without the leading v', () => {
    expect(verifyReleaseAssets([releaseWithAllAssets(1, true)], VERSION).ok).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Desktop icons are consumed directly from node_modules/@kangentic/branding (see
// electron-builder.yml and src/main/window-utils.ts resolveIconPath) instead of a hand-placed
// resources/ folder. This guard pins the subpath layout the app depends on, so a package
// restructure or a bad `npm update @kangentic/branding` fails CI loudly instead of shipping a
// missing/broken app icon.

const REPO_ROOT = path.resolve(__dirname, '../..');
const BRANDING_ROOT = path.join(REPO_ROOT, 'node_modules', '@kangentic', 'branding');
const DESKTOP_ASSETS_DIR = path.join(BRANDING_ROOT, 'resources', 'desktop');
const REQUIRED_DESKTOP_ICONS = ['icon.ico', 'icon.icns', 'icon.png'];
const FAVICON_ASSET = path.join(BRANDING_ROOT, 'assets', 'brandmark-small.svg');
const THEMED_MARK_ASSETS = [
  path.join(BRANDING_ROOT, 'assets', 'brandmark-mono.svg'),
  path.join(BRANDING_ROOT, 'assets', 'brandmark-mono-amber.svg'),
];
const BRAND_MARK_COMPONENT = 'src/renderer/components/BrandMark.tsx';
// The theme-tinted mark is for app chrome that sits on a themed surface. The
// welcome screen deliberately uses the FULL-COLOR mark instead (see below), so
// it is not in this list.
const BRAND_MARK_IMPORTERS = [
  'src/renderer/components/layout/TitleBar.tsx',
];
const COLOR_MARK_CONSUMER = 'src/renderer/components/layout/WelcomeScreen.tsx';

// The Overseer mascot: consumed via the shipped animation contract
// (assets/mascot/animations.css + animations.json), never hand-authored
// timings (pixel-art-conventions.md). OverseerMascot.tsx supports a subset of
// the package's sequences; this pins that subset's frames against the
// installed package so a branding upgrade that renames/drops a frame file
// fails here instead of shipping a broken <img>.
const MASCOT_DIR = path.join(BRANDING_ROOT, 'assets', 'mascot');
const MASCOT_CSS = path.join(MASCOT_DIR, 'animations.css');
const MASCOT_JSON = path.join(MASCOT_DIR, 'animations.json');
const MASCOT_COMPONENT = 'src/renderer/components/onboarding/OverseerMascot.tsx';
const MASCOT_IMPORTERS = [
  'src/renderer/components/layout/WelcomeScreen.tsx',
  'src/renderer/components/onboarding/WelcomeChecklistDialog.tsx',
];
const SUPPORTED_SEQUENCES = ['wave-once', 'blink-loop'];

interface MascotAnimationsJson {
  frames: Record<string, { file: string }>;
  sequences: Record<string, {
    idle?: { frame: string };
    clip: Array<{ frame: string }>;
  }>;
}

/** Every frame key a sequence actually renders: clip poses plus its idle rest frame, if any. */
function framesUsedBySequence(animations: MascotAnimationsJson, sequenceKey: string): string[] {
  const sequence = animations.sequences[sequenceKey];
  if (!sequence) throw new Error(`animations.json has no sequence "${sequenceKey}"`);
  const frameKeys = new Set(sequence.clip.map((pose) => pose.frame));
  if (sequence.idle) frameKeys.add(sequence.idle.frame);
  return [...frameKeys];
}

// electron-builder.yml has five distinct icon sites that were repointed at the
// @kangentic/branding desktop assets (extraResources' two `from:` entries, win.icon,
// mac.icon, linux.icon). A whole-file substring check (see below) only proves the phrase
// appears SOMEWHERE, so reverting any single site to a local resources/ path would still
// pass it. These per-site checks parse each site independently via a targeted regex (no
// added yaml dependency - js-yaml is only a transitive electron-builder dependency, not a
// declared package.json dependency of this project) so a single-site regression fails only
// that site's test.
const BRANDING_DESKTOP_PREFIX = 'node_modules/@kangentic/branding/resources/desktop/';

/** Extract the full indented body of a top-level YAML key (e.g. "win", "mac", "linux") --
 *  every line following "<key>:\n" up to (not including) the next unindented line. */
function extractTopLevelBlock(yamlSource: string, topLevelKey: string): string {
  const match = yamlSource.match(new RegExp(`\\n${topLevelKey}:\\n((?:[ \\t].*\\n?)*)`));
  if (!match) {
    throw new Error(`electron-builder.yml: could not find top-level key "${topLevelKey}:"`);
  }
  return match[1];
}

/** Extract the value of the first "icon:" line within an already-extracted top-level block. */
function extractIconFromBlock(block: string, siteName: string): string {
  const match = block.match(/icon:\s*(\S+)/);
  if (!match) {
    throw new Error(`electron-builder.yml: could not find "icon:" within the ${siteName} block`);
  }
  return match[1];
}

/** Extract every `- from: ...` / `to: ...` pair inside the extraResources list. */
function extractExtraResourcesEntries(yamlSource: string): Array<{ from: string; to: string }> {
  const block = extractTopLevelBlock(yamlSource, 'extraResources');
  const entries: Array<{ from: string; to: string }> = [];
  const entryPattern = /-\s*from:\s*(\S+)\s*\n\s*to:\s*(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(block)) !== null) {
    entries.push({ from: match[1], to: match[2] });
  }
  return entries;
}

describe('electron-builder.yml icon sites (per-site)', () => {
  const electronBuilderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf-8');

  it('extraResources[0].from (icon.png) resolves under the branding desktop assets', () => {
    const entries = extractExtraResourcesEntries(electronBuilderConfig);
    const pngEntry = entries.find((entry) => entry.to === 'icon.png');
    expect(pngEntry, 'extraResources has no entry with to: icon.png').toBeDefined();
    expect(pngEntry?.from.startsWith(BRANDING_DESKTOP_PREFIX)).toBe(true);
  });

  it('extraResources[1].from (icon.ico) resolves under the branding desktop assets', () => {
    const entries = extractExtraResourcesEntries(electronBuilderConfig);
    const icoEntry = entries.find((entry) => entry.to === 'icon.ico');
    expect(icoEntry, 'extraResources has no entry with to: icon.ico').toBeDefined();
    expect(icoEntry?.from.startsWith(BRANDING_DESKTOP_PREFIX)).toBe(true);
  });

  it('win.icon resolves under the branding desktop assets', () => {
    const winBlock = extractTopLevelBlock(electronBuilderConfig, 'win');
    const icon = extractIconFromBlock(winBlock, 'win');
    expect(icon.startsWith(BRANDING_DESKTOP_PREFIX)).toBe(true);
  });

  it('mac.icon resolves under the branding desktop assets', () => {
    const macBlock = extractTopLevelBlock(electronBuilderConfig, 'mac');
    const icon = extractIconFromBlock(macBlock, 'mac');
    expect(icon.startsWith(BRANDING_DESKTOP_PREFIX)).toBe(true);
  });

  it('linux.icon resolves under the branding desktop assets', () => {
    const linuxBlock = extractTopLevelBlock(electronBuilderConfig, 'linux');
    const icon = extractIconFromBlock(linuxBlock, 'linux');
    expect(icon.startsWith(BRANDING_DESKTOP_PREFIX)).toBe(true);
  });
});

describe('@kangentic/branding desktop assets', () => {
  it('is installed', () => {
    const packageJsonPath = path.join(BRANDING_ROOT, 'package.json');
    expect(fs.existsSync(packageJsonPath), '@kangentic/branding is not installed; run npm install').toBe(true);
  });

  it('ships every desktop icon the app references', () => {
    const missing = REQUIRED_DESKTOP_ICONS.filter(
      (iconFilename) => !fs.existsSync(path.join(DESKTOP_ASSETS_DIR, iconFilename)),
    );
    expect(
      missing,
      `@kangentic/branding is missing expected resources/desktop/ assets:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('electron-builder.yml and window-utils.ts reference @kangentic/branding', () => {
    const electronBuilderConfig = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf-8');
    const windowUtilsSource = fs.readFileSync(path.join(REPO_ROOT, 'src/main/window-utils.ts'), 'utf-8');
    expect(electronBuilderConfig.includes('@kangentic/branding')).toBe(true);
    // window-utils.ts builds the path with segmented path.join() args (cross-platform-parity),
    // so '@kangentic' and 'branding' appear as separate string literals, not one joined literal.
    expect(windowUtilsSource.includes("'@kangentic'") && windowUtilsSource.includes("'branding'")).toBe(true);
  });

  it('ships the dev-server favicon asset and index.tsx references it', () => {
    expect(
      fs.existsSync(FAVICON_ASSET),
      '@kangentic/branding is missing assets/brandmark-small.svg (the documented dev-server favicon source)',
    ).toBe(true);
    const indexSource = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/index.tsx'), 'utf-8');
    expect(
      indexSource.includes('@kangentic/branding/assets/brandmark-small.svg'),
      'src/renderer/index.tsx should import the favicon from @kangentic/branding, not a local asset',
    ).toBe(true);
  });

  it('ships the themed in-app mark and BrandMark and its importers reference it', () => {
    const missing = THEMED_MARK_ASSETS.filter((assetPath) => !fs.existsSync(assetPath));
    expect(
      missing,
      `@kangentic/branding is missing themed brandmark assets:\n${missing.join('\n')}`,
    ).toEqual([]);

    const brandMarkSource = fs.readFileSync(path.join(REPO_ROOT, BRAND_MARK_COMPONENT), 'utf-8');
    expect(
      brandMarkSource.includes('@kangentic/branding/assets/brandmark-mono-amber.svg'),
      `${BRAND_MARK_COMPONENT} should import the theme-tinting brandmark from @kangentic/branding`,
    ).toBe(true);

    const notReferencing = BRAND_MARK_IMPORTERS.filter((relativePath) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
      return !source.includes('BrandMark');
    });
    expect(
      notReferencing,
      `These renderer files should render the shared BrandMark component:\n${notReferencing.join('\n')}`,
    ).toEqual([]);
  });

  it('the welcome screen consumes the full-color mark from the package', () => {
    // The welcome screen is the app's identity moment and first launch defaults
    // to the dark theme, so it uses the fixed-palette colored mark rather than
    // the theme-tinted BrandMark. brandmark-small.svg (the F4k board glyph) is
    // the right tier for a mark displayed this small - the card-K master fails
    // structurally below ~128px (see the icon-drafting skill).
    expect(
      fs.existsSync(FAVICON_ASSET),
      '@kangentic/branding is missing assets/brandmark-small.svg',
    ).toBe(true);
    const welcomeSource = fs.readFileSync(path.join(REPO_ROOT, COLOR_MARK_CONSUMER), 'utf-8');
    expect(
      welcomeSource.includes('@kangentic/branding/assets/brandmark-small.svg'),
      `${COLOR_MARK_CONSUMER} should import the full-color mark from @kangentic/branding`,
    ).toBe(true);
  });
});

describe('Overseer mascot', () => {
  it('ships the animation contract (animations.css + animations.json)', () => {
    expect(fs.existsSync(MASCOT_CSS), '@kangentic/branding is missing assets/mascot/animations.css').toBe(true);
    expect(fs.existsSync(MASCOT_JSON), '@kangentic/branding is missing assets/mascot/animations.json').toBe(true);
  });

  it('every frame animations.json names exists as a file in assets/mascot/', () => {
    const animations: MascotAnimationsJson = JSON.parse(fs.readFileSync(MASCOT_JSON, 'utf-8'));
    const missing = Object.entries(animations.frames)
      .filter(([, frame]) => !fs.existsSync(path.join(MASCOT_DIR, frame.file)))
      .map(([key, frame]) => `${key} -> ${frame.file}`);
    expect(missing, `animations.json names frame files that do not exist:\n${missing.join('\n')}`).toEqual([]);
  });

  it('animations.json still declares every sequence OverseerMascot.tsx supports', () => {
    const animations: MascotAnimationsJson = JSON.parse(fs.readFileSync(MASCOT_JSON, 'utf-8'));
    const missing = SUPPORTED_SEQUENCES.filter((key) => !animations.sequences[key]);
    expect(
      missing,
      `@kangentic/branding dropped sequence(s) OverseerMascot.tsx still supports:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('OverseerMascot.tsx imports every frame its supported sequences use', () => {
    const animations: MascotAnimationsJson = JSON.parse(fs.readFileSync(MASCOT_JSON, 'utf-8'));
    const mascotSource = fs.readFileSync(path.join(REPO_ROOT, MASCOT_COMPONENT), 'utf-8');

    const requiredFrameFiles = new Set<string>();
    for (const sequenceKey of SUPPORTED_SEQUENCES) {
      for (const frameKey of framesUsedBySequence(animations, sequenceKey)) {
        requiredFrameFiles.add(animations.frames[frameKey].file);
      }
    }

    const missingImports = [...requiredFrameFiles].filter(
      (file) => !mascotSource.includes(`@kangentic/branding/assets/mascot/${file}`),
    );
    expect(
      missingImports,
      `${MASCOT_COMPONENT} is missing an import for frame(s) its supported sequences use:\n${missingImports.join('\n')}`,
    ).toEqual([]);
  });

  it('OverseerMascot.tsx imports the shared animation stylesheet', () => {
    const mascotSource = fs.readFileSync(path.join(REPO_ROOT, MASCOT_COMPONENT), 'utf-8');
    expect(
      mascotSource.includes('@kangentic/branding/assets/mascot/animations.css'),
      `${MASCOT_COMPONENT} should import the shipped animations.css rather than hand-writing keyframes`,
    ).toBe(true);
  });

  it('the welcome screen and Get started panel render the shared OverseerMascot component', () => {
    const notReferencing = MASCOT_IMPORTERS.filter((relativePath) => {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8');
      return !source.includes('OverseerMascot');
    });
    expect(
      notReferencing,
      `These renderer files should render the shared OverseerMascot component:\n${notReferencing.join('\n')}`,
    ).toEqual([]);
  });
});

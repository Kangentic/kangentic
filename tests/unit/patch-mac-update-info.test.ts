import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// scripts/patch-mac-update-info.js writes `minimumSystemVersion` into the release's
// latest-mac.yml, so electron-updater on a Mac below mac.minimumSystemVersion skips the update
// instead of installing a build macOS will not open. Without it, every Mac on a dropped macOS
// auto-updates straight into a dead app (Electron 44 dropped macOS 12).
//
// Two ways this silently stops working, both pinned here against the real thing rather than a
// re-typed copy: the value must be the DARWIN version as full semver (electron-updater fails
// OPEN on anything else, so "13.0" or "13.0.0" would let macOS 12 through), and the patch must
// not land inside the multi-line `releaseNotes: |` block the real feed carries.

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

const {
  readMacMinimumSystemVersion,
  darwinVersionForMacos,
  withMinimumSystemVersion,
  readFeedMinimumSystemVersion,
  parseArgs,
} = requireFromRepo('./scripts/patch-mac-update-info.js') as {
  readMacMinimumSystemVersion: (builderYmlText: string) => string;
  darwinVersionForMacos: (macosVersion: string) => string;
  withMinimumSystemVersion: (
    ymlText: string,
    darwinVersion: string
  ) => { text: string; action: 'added' | 'replaced' | 'unchanged' };
  readFeedMinimumSystemVersion: (ymlText: string) => string | null;
  parseArgs: (argv: string[]) => { tag: string | undefined; repo: string; dryRun: boolean };
};

// The parser and comparison electron-updater itself runs, resolved from ITS dependency tree, so
// a different js-yaml or semver elsewhere in node_modules cannot make this pass.
const updaterPackageJson = requireFromRepo.resolve('electron-updater/package.json');
const requireFromUpdater = createRequire(updaterPackageJson);
const jsYaml = requireFromUpdater('js-yaml') as { load: (text: string) => Record<string, unknown> };
const { AppUpdater } = requireFromUpdater('./out/AppUpdater.js') as {
  AppUpdater: { prototype: { checkIfUpdateSupported: (this: unknown, info: unknown) => boolean } };
};

const builderYml = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
const realFeed = fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/release/latest-mac-0.43.2.yml'), 'utf8');

function updaterAllows(osRelease: string, feedText: string): boolean {
  vi.spyOn(os, 'release').mockReturnValue(osRelease);
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  return AppUpdater.prototype.checkIfUpdateSupported.call({ _logger: logger }, jsYaml.load(feedText));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readMacMinimumSystemVersion', () => {
  it('reads the real electron-builder.yml mac floor', () => {
    expect(readMacMinimumSystemVersion(builderYml)).toBe('13.0');
  });

  it('throws when the mac block has no minimumSystemVersion, rather than patching nothing', () => {
    const withoutFloor = builderYml.replace(/^ {2}minimumSystemVersion:.*\n/m, '');
    expect(() => readMacMinimumSystemVersion(withoutFloor)).toThrow(/no minimumSystemVersion/);
  });

  it('ignores a minimumSystemVersion outside the mac block', () => {
    const elsewhere = 'appId: x\nlinux:\n  minimumSystemVersion: "99.0"\n\nmac:\n  minimumSystemVersion: "14.0"\n';
    expect(readMacMinimumSystemVersion(elsewhere)).toBe('14.0');
  });
});

describe('darwinVersionForMacos', () => {
  it.each([
    ['10.15', '19.0.0'],
    ['11.0', '20.0.0'],
    ['12', '21.0.0'],
    ['13.0', '22.0.0'],
    ['14.0', '23.0.0'],
    ['15.1', '24.0.0'],
  ])('maps macOS %s to Darwin %s', (macosVersion, darwinVersion) => {
    expect(darwinVersionForMacos(macosVersion)).toBe(darwinVersion);
  });

  it('throws on a value that is not a macOS version', () => {
    expect(() => darwinVersionForMacos('Ventura')).toThrow();
    expect(() => darwinVersionForMacos('9.2')).toThrow();
  });
});

describe('withMinimumSystemVersion against the real v0.43.2 feed', () => {
  const darwinFloor = darwinVersionForMacos(readMacMinimumSystemVersion(builderYml));

  it('adds the field as a top-level STRING and leaves the release notes byte-identical', () => {
    const { text, action } = withMinimumSystemVersion(realFeed, darwinFloor);
    expect(action).toBe('added');
    const parsed = jsYaml.load(text);
    const original = jsYaml.load(realFeed);
    expect(parsed.minimumSystemVersion).toBe('22.0.0');
    expect(typeof parsed.minimumSystemVersion).toBe('string');
    expect(parsed.releaseNotes).toBe(original.releaseNotes);
    expect(parsed.files).toEqual(original.files);
    expect(parsed.version).toBe(original.version);
  });

  it('is a no-op the second time, so a re-run of publish-release does not re-upload', () => {
    const once = withMinimumSystemVersion(realFeed, darwinFloor).text;
    const twice = withMinimumSystemVersion(once, darwinFloor);
    expect(twice.action).toBe('unchanged');
    expect(twice.text).toBe(once);
  });

  it('replaces a stale value instead of adding a second key', () => {
    const stale = withMinimumSystemVersion(realFeed, '19.0.0').text;
    const { text, action } = withMinimumSystemVersion(stale, darwinFloor);
    expect(action).toBe('replaced');
    expect(text.match(/^minimumSystemVersion:/gm)).toHaveLength(1);
    expect(readFeedMinimumSystemVersion(text)).toBe('22.0.0');
  });

  it('appends after a feed with no trailing newline without gluing lines together', () => {
    const { text } = withMinimumSystemVersion(realFeed.trimEnd(), darwinFloor);
    expect(jsYaml.load(text).minimumSystemVersion).toBe('22.0.0');
  });
});

describe('electron-updater decides with the patched feed', () => {
  const patched = withMinimumSystemVersion(realFeed, darwinVersionForMacos('13.0')).text;

  it('refuses the update on macOS 12 (Darwin 21.x)', () => {
    expect(updaterAllows('21.6.0', patched)).toBe(false);
  });

  it('allows it on macOS 13.0 and later (Darwin 22.x+)', () => {
    expect(updaterAllows('22.0.0', patched)).toBe(true);
    expect(updaterAllows('22.1.0', patched)).toBe(true);
    expect(updaterAllows('24.6.0', patched)).toBe(true);
  });

  it('would let macOS 12 through on the unpatched feed, which is the bug this step exists for', () => {
    expect(updaterAllows('21.6.0', realFeed)).toBe(true);
  });

  it('would let macOS 12 through if the macOS version were written instead of the Darwin one', () => {
    expect(updaterAllows('21.6.0', withMinimumSystemVersion(realFeed, '13.0.0').text)).toBe(true);
  });
});

describe('parseArgs', () => {
  it('reads the tag, --repo and --dry-run', () => {
    expect(parseArgs(['v1.2.3', '--repo', 'owner/name', '--dry-run'])).toEqual({
      tag: 'v1.2.3',
      repo: 'owner/name',
      dryRun: true,
    });
  });
});

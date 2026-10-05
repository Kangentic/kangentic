import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// `npx kangentic` on a Mac older than the app supports would download the app, install it, and
// launch something macOS refuses to open, with nothing on screen to say why. The launcher refuses
// before downloading instead. Its floor is a Darwin major, which must stay in step with
// electron-builder.yml's mac.minimumSystemVersion: a floor below it lets a dead install through,
// one above it locks out a supported Mac.

const REPO_ROOT = path.resolve(__dirname, '../..');
const requireFromRepo = createRequire(path.join(REPO_ROOT, 'package.json'));

const { isUnsupportedMacOS, MINIMUM_DARWIN_MAJOR } = requireFromRepo('./packages/launcher/bin/kangentic.js') as {
  isUnsupportedMacOS: (platform: string, osRelease: string) => boolean;
  MINIMUM_DARWIN_MAJOR: number;
};

// The same reading and Darwin mapping the release step uses to write the update feed's floor.
const { readMacMinimumSystemVersion, darwinVersionForMacos } = requireFromRepo('./scripts/patch-mac-update-info.js') as {
  readMacMinimumSystemVersion: (builderYmlText: string) => string;
  darwinVersionForMacos: (macosVersion: string) => string;
};

describe('the launcher macOS floor', () => {
  it('matches electron-builder.yml mac.minimumSystemVersion', () => {
    const builderYml = fs.readFileSync(path.join(REPO_ROOT, 'electron-builder.yml'), 'utf8');
    const darwinFloor = darwinVersionForMacos(readMacMinimumSystemVersion(builderYml));
    expect(MINIMUM_DARWIN_MAJOR).toBe(Number.parseInt(darwinFloor.split('.')[0], 10));
  });

  it('refuses macOS 12 (Darwin 21)', () => {
    expect(isUnsupportedMacOS('darwin', '21.6.0')).toBe(true);
    expect(isUnsupportedMacOS('darwin', '21.0.1')).toBe(true);
  });

  it('allows macOS 13 and later (Darwin 22 and up)', () => {
    expect(isUnsupportedMacOS('darwin', '22.0.0')).toBe(false);
    expect(isUnsupportedMacOS('darwin', '22.1.0')).toBe(false);
    expect(isUnsupportedMacOS('darwin', '23.6.0')).toBe(false);
    expect(isUnsupportedMacOS('darwin', '25.0.0')).toBe(false);
  });

  it('never refuses another platform, whatever its release string', () => {
    expect(isUnsupportedMacOS('win32', '10.0.19045')).toBe(false);
    expect(isUnsupportedMacOS('linux', '5.15.0-91-generic')).toBe(false);
    expect(isUnsupportedMacOS('linux', '6.8.0')).toBe(false);
  });

  it('does not refuse a Mac whose release string it cannot parse', () => {
    expect(isUnsupportedMacOS('darwin', '')).toBe(false);
    expect(isUnsupportedMacOS('darwin', 'unknown')).toBe(false);
  });
});

/**
 * Unit tests for the launcher's version marker logic.
 *
 * Tests isInstalled(), writeVersionMarker(), and getVersionMarkerPath()
 * using a temp directory to isolate filesystem state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tempDirectory: string;
let launcherModule: {
  isInstalled: (platformInfo: { platform: string }) => boolean;
  getVersionMarkerPath: () => string;
  writeVersionMarker: () => void;
  getInstallPath: (platformInfo: { platform: string }) => string;
  getTempDir: () => string;
};

const launcherPackageJsonPath = path.resolve(__dirname, '../../packages/launcher/package.json');
const launcherVersion = JSON.parse(fs.readFileSync(launcherPackageJsonPath, 'utf-8')).version;

// Save original env vars once
const savedEnv: Record<string, string | undefined> = {};
const envKeys = ['APPDATA', 'XDG_CONFIG_HOME', 'LOCALAPPDATA'];

beforeEach(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-launcher-test-'));

  // Save and redirect all path-resolving env vars to temp directory
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    process.env[key] = tempDirectory;
  }
  vi.spyOn(os, 'homedir').mockReturnValue(tempDirectory);

  vi.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  launcherModule = require('../../packages/launcher/bin/kangentic.js');
});

afterEach(() => {
  // Restore env vars
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

describe('Launcher version marker', () => {
  describe('getVersionMarkerPath', () => {
    it('returns a path ending with installed-version', () => {
      const markerPath = launcherModule.getVersionMarkerPath();
      expect(path.basename(markerPath)).toBe('installed-version');
    });

    it('returns a path inside the kangentic/launcher directory', () => {
      const markerPath = launcherModule.getVersionMarkerPath();
      expect(markerPath).toContain(path.join('kangentic', 'launcher'));
    });
  });

  describe('writeVersionMarker', () => {
    it('creates a marker file with the current version', () => {
      launcherModule.writeVersionMarker();

      const markerPath = launcherModule.getVersionMarkerPath();
      expect(fs.existsSync(markerPath)).toBe(true);

      const content = fs.readFileSync(markerPath, 'utf-8').trim();
      expect(content).toBe(launcherVersion);
    });

    it('overwrites existing marker file', () => {
      const markerPath = launcherModule.getVersionMarkerPath();

      // Write an old version first
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '0.0.1\n', 'utf-8');

      launcherModule.writeVersionMarker();

      const content = fs.readFileSync(markerPath, 'utf-8').trim();
      expect(content).toBe(launcherVersion);
    });

    it('does not throw on failure', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => launcherModule.writeVersionMarker()).not.toThrow();
      warnSpy.mockRestore();
    });
  });

  describe('isInstalled', () => {
    it('returns false when binary does not exist', () => {
      const platformInfo = { platform: 'win32' };
      expect(launcherModule.isInstalled(platformInfo)).toBe(false);
    });

    it('returns false when marker file does not exist but binary does', () => {
      const platformInfo = { platform: 'win32' };

      const installPath = launcherModule.getInstallPath(platformInfo);
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, 'fake-binary', 'utf-8');

      expect(launcherModule.isInstalled(platformInfo)).toBe(false);
    });

    it('returns false when marker has wrong version', () => {
      const platformInfo = { platform: 'win32' };

      const installPath = launcherModule.getInstallPath(platformInfo);
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, 'fake-binary', 'utf-8');

      const markerPath = launcherModule.getVersionMarkerPath();
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, '0.0.1\n', 'utf-8');

      expect(launcherModule.isInstalled(platformInfo)).toBe(false);
    });

    it('returns true when binary exists and marker matches version', () => {
      const platformInfo = { platform: 'win32' };

      const installPath = launcherModule.getInstallPath(platformInfo);
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, 'fake-binary', 'utf-8');

      launcherModule.writeVersionMarker();

      expect(launcherModule.isInstalled(platformInfo)).toBe(true);
    });

    it('returns true even with trailing whitespace in marker', () => {
      const platformInfo = { platform: 'win32' };

      const installPath = launcherModule.getInstallPath(platformInfo);
      fs.mkdirSync(path.dirname(installPath), { recursive: true });
      fs.writeFileSync(installPath, 'fake-binary', 'utf-8');

      const markerPath = launcherModule.getVersionMarkerPath();
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, `  ${launcherVersion}  \n`, 'utf-8');

      expect(launcherModule.isInstalled(platformInfo)).toBe(true);
    });
  });
});

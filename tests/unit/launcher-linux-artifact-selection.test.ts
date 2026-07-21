/**
 * Unit tests for the launcher's Linux rpm-vs-deb artifact selection.
 *
 * getArtifactFilename() was previously unexported and untested - the deb/rpm branch that
 * shipped the broken libXShmfence dependency (see
 * .claude/rules/linux-package-dependencies.md) had zero coverage. kangentic.js destructures
 * execFileSync from child_process once at require time, so the spy's behavior is driven by a
 * mutable variable read on every call, not by re-spying per test (a fresh vi.spyOn().mockImplementation()
 * per test does not take effect here because the module is only required once). Spies on
 * execFileSync so this runs identically regardless of whether `which`/`rpm`/`apt` exist on the
 * host (see .claude/rules/cross-platform-parity.md) - Git Bash on Windows ships a real
 * which.exe, so an unmocked run would silently pass through to it.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- must be require(), not import: the spy has to be installed on the live module object before kangentic.js destructures execFileSync off it.
const childProcess: typeof import('node:child_process') = require('child_process');

let launcherModule: {
  getPlatformInfo: () => { platform: string; arch?: string } | null;
  getArtifactFilename: (platformInfo: { platform: string; arch?: string }) => string | null;
  installLinux: (artifactPath: string) => void;
};

const launcherPackageJsonPath = path.resolve(__dirname, '../../packages/launcher/package.json');
const launcherVersion = JSON.parse(fs.readFileSync(launcherPackageJsonPath, 'utf-8')).version;

let mockAvailableCommands: string[] = [];

// Records every `sudo` invocation so tests can assert the exact argv installLinux() chose,
// without a second competing spy - the same execFileSync mock below both answers `which`
// lookups and records `sudo` calls.
let sudoInvocations: string[][] = [];

beforeAll(() => {
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: readonly string[]) => {
    if (command === 'which' && !mockAvailableCommands.includes(args[0])) {
      throw new Error(`command not found: ${args[0]}`);
    }
    if (command === 'sudo') {
      sudoInvocations.push([...args]);
    }
    return '';
  }) as typeof childProcess.execFileSync);
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the launcher is plain CommonJS with no type declarations; it must also be required AFTER the spy above is installed.
  launcherModule = require('../../packages/launcher/bin/kangentic.js');
});

// child_process is a shared Node singleton, so the spy mutates global state that outlives this
// file. Without this restore, any later test in the same worker calling the real execFileSync
// would silently get the mock (every `which` throwing, every other command returning '').
afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  mockAvailableCommands = [];
  sudoInvocations = [];
});

describe('Launcher Linux artifact selection', () => {
  describe('getPlatformInfo', () => {
    it('linux platform info has no extension field (rpm vs deb is decided later)', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        const platformInfo = launcherModule.getPlatformInfo();
        expect(platformInfo).toEqual({ platform: 'linux', arch: 'x64' });
        expect(platformInfo).not.toHaveProperty('extension');
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('getArtifactFilename on linux', () => {
    it('selects the rpm artifact when rpm is present and apt is absent (Fedora/RHEL)', () => {
      mockAvailableCommands = ['rpm'];
      const filename = launcherModule.getArtifactFilename({ platform: 'linux', arch: 'x64' });
      expect(filename).toBe(`kangentic-${launcherVersion}-1.x86_64.rpm`);
    });

    it('selects the deb artifact when both rpm and apt are present', () => {
      mockAvailableCommands = ['rpm', 'apt'];
      const filename = launcherModule.getArtifactFilename({ platform: 'linux', arch: 'x64' });
      expect(filename).toBe(`kangentic_${launcherVersion}_amd64.deb`);
    });

    it('selects the deb artifact when rpm is absent (Debian/Ubuntu)', () => {
      mockAvailableCommands = ['apt'];
      const filename = launcherModule.getArtifactFilename({ platform: 'linux', arch: 'x64' });
      expect(filename).toBe(`kangentic_${launcherVersion}_amd64.deb`);
    });
  });

  describe('getArtifactFilename on other platforms', () => {
    it('returns the NSIS installer filename on win32', () => {
      const filename = launcherModule.getArtifactFilename({ platform: 'win32' });
      expect(filename).toBe(`Kangentic-Setup-${launcherVersion}.exe`);
    });

    it('returns the mac zip filename on darwin', () => {
      const filename = launcherModule.getArtifactFilename({ platform: 'darwin', arch: 'arm64' });
      expect(filename).toBe(`Kangentic-${launcherVersion}-arm64-mac.zip`);
    });
  });

  describe('installLinux command selection', () => {
    const debArtifactPath = '/tmp/kangentic.deb';
    const rpmArtifactPath = '/tmp/kangentic.rpm';

    it('runs sudo apt install when apt is present (.deb)', () => {
      mockAvailableCommands = ['apt'];
      launcherModule.installLinux(debArtifactPath);
      expect(sudoInvocations).toEqual([['apt', 'install', '-y', debArtifactPath]]);
    });

    it('falls back to sudo dpkg -i when apt is absent (.deb)', () => {
      mockAvailableCommands = [];
      launcherModule.installLinux(debArtifactPath);
      expect(sudoInvocations).toEqual([['dpkg', '-i', debArtifactPath]]);
    });

    it('runs sudo dnf install when dnf is present (.rpm)', () => {
      mockAvailableCommands = ['dnf'];
      launcherModule.installLinux(rpmArtifactPath);
      expect(sudoInvocations).toEqual([['dnf', 'install', '-y', rpmArtifactPath]]);
    });

    it('runs sudo zypper install when dnf is absent and zypper is present (.rpm, openSUSE)', () => {
      // The most important branch: before it existed, openSUSE fell through to `rpm -i`, which
      // enforces Requires without resolving them - the exact install failure this change fixes.
      mockAvailableCommands = ['zypper'];
      launcherModule.installLinux(rpmArtifactPath);
      expect(sudoInvocations).toEqual([['zypper', '--non-interactive', 'install', rpmArtifactPath]]);
    });

    it('falls back to sudo rpm -i when neither dnf nor zypper is present (.rpm)', () => {
      mockAvailableCommands = [];
      launcherModule.installLinux(rpmArtifactPath);
      expect(sudoInvocations).toEqual([['rpm', '-i', rpmArtifactPath]]);
    });
  });
});

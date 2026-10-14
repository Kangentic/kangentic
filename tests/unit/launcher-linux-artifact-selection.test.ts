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
  isAppRunning: (platformInfo: { platform: string; arch?: string }) => boolean;
  shouldAdviseReopen: (platformInfo: { platform: string }, wasInstalled: boolean) => boolean;
};

const launcherPackageJsonPath = path.resolve(__dirname, '../../packages/launcher/package.json');
const launcherVersion = JSON.parse(fs.readFileSync(launcherPackageJsonPath, 'utf-8')).version;

let mockAvailableCommands: string[] = [];

// Records every `sudo` invocation so tests can assert the exact argv installLinux() chose,
// without a second competing spy - the same execFileSync mock below both answers `which`
// lookups and records `sudo` calls.
let sudoInvocations: string[][] = [];

// Drives the `pgrep -x kangentic` probe in isAppRunning(). A real pgrep exits
// 1 (which execFileSync raises as a throw) when nothing matches, so "no match"
// has to be modelled as a throw rather than an empty return.
let mockPgrepMatches = false;

// Records the argv every `pgrep` call receives. Asserting the return value
// alone cannot catch a wrong probe: mockPgrepMatches is set by the test, so a
// mistyped process name or a swapped flag still returns true here while never
// matching a real process.
let pgrepInvocations: string[][] = [];

// What `sysctl -n sysctl.proc_translated` prints: '1' for an x64 process under Rosetta on Apple
// silicon, '0' for a native one. null models an Intel Mac, where the key does not exist and
// sysctl exits non-zero.
let mockSysctlTranslated: string | null = null;
let sysctlInvocations: string[][] = [];

beforeAll(() => {
  vi.spyOn(childProcess, 'execFileSync').mockImplementation(((command: string, args: readonly string[]) => {
    if (command === 'which' && !mockAvailableCommands.includes(args[0])) {
      throw new Error(`command not found: ${args[0]}`);
    }
    if (command === '/usr/sbin/sysctl') {
      sysctlInvocations.push([...args]);
      if (mockSysctlTranslated === null) {
        throw new Error('sysctl: unknown oid');
      }
      return `${mockSysctlTranslated}\n`;
    }
    if (command === 'pgrep') {
      pgrepInvocations.push([...args]);
      if (!mockPgrepMatches) {
        throw new Error('no matching processes');
      }
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
  mockPgrepMatches = false;
  pgrepInvocations = [];
  mockSysctlTranslated = null;
  sysctlInvocations = [];
});

/** getPlatformInfo() as it reads on a given platform and arch, restoring the real ones after. */
function platformInfoOn(platform: string, arch: string): { platform: string; arch?: string; extension?: string } | null {
  const originalPlatform = process.platform;
  const originalArch = process.arch;
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
  try {
    return launcherModule.getPlatformInfo();
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  }
}

describe('Launcher Linux artifact selection', () => {
  describe('getPlatformInfo', () => {
    it('linux platform info has no extension field (rpm vs deb is decided later)', () => {
      const platformInfo = platformInfoOn('linux', 'x64');
      expect(platformInfo).toEqual({ platform: 'linux', arch: 'x64' });
      expect(platformInfo).not.toHaveProperty('extension');
    });

    // It used to report x64 on every Linux machine, so an ARM board downloaded an amd64 package it
    // could not run.
    it('passes arm64 through on linux', () => {
      expect(platformInfoOn('linux', 'arm64')).toEqual({ platform: 'linux', arch: 'arm64' });
    });

    it('refuses a linux arch no release ships, rather than building a URL that 404s', () => {
      expect(platformInfoOn('linux', 'arm')).toBeNull();
      expect(platformInfoOn('linux', 'ppc64')).toBeNull();
    });

    // A mac arch no release ships a zip for would otherwise build a download URL that 404s. The
    // sysctl probe is for an x64 Node only, so neither of these may reach it.
    it('refuses a darwin arch no release ships, without asking sysctl', () => {
      mockSysctlTranslated = '1';
      expect(platformInfoOn('darwin', 'ia32')).toBeNull();
      expect(platformInfoOn('darwin', 'ppc64')).toBeNull();
      expect(sysctlInvocations).toEqual([]);
    });

    it('takes an Intel Mac as x64 when sysctl has no proc_translated key', () => {
      mockSysctlTranslated = null;
      expect(platformInfoOn('darwin', 'x64')).toEqual({ platform: 'darwin', arch: 'x64', extension: 'zip' });
      expect(sysctlInvocations).toEqual([['-n', 'sysctl.proc_translated']]);
    });

    it('takes an x64 Node under Rosetta as Apple silicon, so it installs the native build', () => {
      mockSysctlTranslated = '1';
      expect(platformInfoOn('darwin', 'x64')).toEqual({ platform: 'darwin', arch: 'arm64', extension: 'zip' });
    });

    it('keeps x64 when sysctl reports a native process', () => {
      mockSysctlTranslated = '0';
      expect(platformInfoOn('darwin', 'x64')).toEqual({ platform: 'darwin', arch: 'x64', extension: 'zip' });
    });

    it('does not ask sysctl when Node is already arm64', () => {
      mockSysctlTranslated = '1';
      expect(platformInfoOn('darwin', 'arm64')).toEqual({ platform: 'darwin', arch: 'arm64', extension: 'zip' });
      expect(sysctlInvocations).toEqual([]);
    });

    it('keeps Windows on x64 whatever the arch, since Windows on ARM runs it under emulation', () => {
      expect(platformInfoOn('win32', 'arm64')).toEqual({ platform: 'win32', arch: 'x64', extension: 'exe' });
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

    // electron-builder names arm64 packages arm64 for deb and aarch64 for rpm.
    it('selects the aarch64 rpm on arm64', () => {
      mockAvailableCommands = ['rpm'];
      expect(launcherModule.getArtifactFilename({ platform: 'linux', arch: 'arm64' }))
        .toBe(`kangentic-${launcherVersion}-1.aarch64.rpm`);
    });

    it('selects the arm64 deb on arm64', () => {
      mockAvailableCommands = ['apt'];
      expect(launcherModule.getArtifactFilename({ platform: 'linux', arch: 'arm64' }))
        .toBe(`kangentic_${launcherVersion}_arm64.deb`);
    });

    it('names no file for an arch no release ships', () => {
      mockAvailableCommands = ['apt'];
      expect(launcherModule.getArtifactFilename({ platform: 'linux', arch: 'arm' })).toBeNull();
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

    it('returns the Intel mac zip filename on an Intel Mac', () => {
      expect(launcherModule.getArtifactFilename({ platform: 'darwin', arch: 'x64' }))
        .toBe(`Kangentic-${launcherVersion}-x64-mac.zip`);
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

    it('falls back to sudo rpm -Uvh when neither dnf nor zypper is present (.rpm)', () => {
      mockAvailableCommands = [];
      launcherModule.installLinux(rpmArtifactPath);
      // -U rather than -i: `rpm -i` refuses an already-installed package, so
      // this branch could never perform an upgrade. --replacepkgs because the
      // app self-updates on Linux, so it can already be at the version the
      // launcher is installing while the launcher's version marker disagrees.
      expect(sudoInvocations).toEqual([['rpm', '-Uvh', '--replacepkgs', rpmArtifactPath]]);
    });
  });

  describe('isAppRunning (running-instance probe)', () => {
    // Only ever used to skip a redundant launch. The "quit and reopen" advice
    // main() prints is unconditional, so every false answer here degrades to
    // one extra launch, never to silence.
    it('reports true when pgrep matches a running kangentic', () => {
      mockAvailableCommands = ['pgrep'];
      mockPgrepMatches = true;
      expect(launcherModule.isAppRunning({ platform: 'linux', arch: 'x64' })).toBe(true);
    });

    it('probes the exact process name, scoped to the current user', () => {
      // -U <uid> keeps another account's Kangentic on a shared machine from
      // reading as "already running" and silently suppressing this user's
      // launch. A false POSITIVE costs a no-op; a false negative costs one
      // redundant launch, so the probe is deliberately narrow.
      mockAvailableCommands = ['pgrep'];
      mockPgrepMatches = true;
      launcherModule.isAppRunning({ platform: 'linux', arch: 'x64' });
      // getuid is POSIX-only, so the expected argv differs between a Windows dev
      // host and Linux CI. Both must still target `-x kangentic` exactly.
      const expectedUserScope =
        typeof process.getuid === 'function' ? ['-U', String(process.getuid())] : [];
      expect(pgrepInvocations).toEqual([['-x', ...expectedUserScope, 'kangentic']]);
    });

    it('reports false when pgrep exits non-zero because nothing matched', () => {
      mockAvailableCommands = ['pgrep'];
      mockPgrepMatches = false;
      expect(launcherModule.isAppRunning({ platform: 'linux', arch: 'x64' })).toBe(false);
    });

    it('reports false when pgrep is not installed', () => {
      mockAvailableCommands = [];
      mockPgrepMatches = true;
      expect(launcherModule.isAppRunning({ platform: 'linux', arch: 'x64' })).toBe(false);
    });

    it('reports false on non-Linux platforms without probing at all', () => {
      mockAvailableCommands = ['pgrep'];
      mockPgrepMatches = true;
      expect(launcherModule.isAppRunning({ platform: 'darwin', arch: 'arm64' })).toBe(false);
      expect(launcherModule.isAppRunning({ platform: 'win32', arch: 'x64' })).toBe(false);
      // The "without probing at all" half: a return-value-only assertion would
      // pass even if the platform guard were removed, since pgrep is mocked to
      // match here.
      expect(pgrepInvocations).toEqual([]);
    });
  });

  describe('shouldAdviseReopen (post-install "quit and reopen" advice)', () => {
    it('advises on a Linux upgrade', () => {
      expect(launcherModule.shouldAdviseReopen({ platform: 'linux' }, true)).toBe(true);
    });

    it('stays quiet on a first-time Linux install', () => {
      // Nothing to finish: there is no older copy, and the app launches below.
      expect(launcherModule.shouldAdviseReopen({ platform: 'linux' }, false)).toBe(false);
    });

    it('stays quiet on a Windows or macOS upgrade', () => {
      // Those platforms relaunch into the NEW version from the launcher, so
      // telling the user to quit and reopen would be false.
      expect(launcherModule.shouldAdviseReopen({ platform: 'win32' }, true)).toBe(false);
      expect(launcherModule.shouldAdviseReopen({ platform: 'darwin' }, true)).toBe(false);
    });

    it('does not consult the running-instance probe', () => {
      // Within Linux the advice must hold whether or not pgrep confirmed
      // anything, so a false negative costs a redundant launch rather than
      // restoring the silence this exists to fix.
      mockAvailableCommands = [];
      mockPgrepMatches = false;
      expect(launcherModule.shouldAdviseReopen({ platform: 'linux' }, true)).toBe(true);
    });
  });
});

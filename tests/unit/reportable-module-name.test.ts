import { describe, it, expect } from 'vitest';
import {
  moduleBasename,
  reportableModuleName,
  UNKNOWN_MODULE,
  USER_BINARY_MODULE,
} from '../../src/main/analytics/reportable-module-name';

/**
 * A foreign crash's `module` tag names the program only when an installer or a
 * package manager put it where it crashed. Every path here is invented; the
 * real binaries behind the pre-release baseline stay off the repository.
 */
describe('reportableModuleName: installed by the OS or a package manager', () => {
  it.each([
    ['a macOS system tool', '/usr/bin/ssh-agent', 'ssh-agent'],
    ['a macOS system framework process', '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder', 'Finder'],
    ['Apple Silicon Homebrew', '/opt/homebrew/bin/ffprobe', 'ffprobe'],
    ['Intel Homebrew under /usr/local', '/usr/local/bin/ffprobe', 'ffprobe'],
    ['a runtime under /usr/local/share', '/usr/local/share/dotnet/dotnet', 'dotnet'],
    ['MacPorts', '/opt/local/bin/python3.12', 'python3.12'],
    ['the python.org framework', '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12', 'python3.12'],
    ['an installed app', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', 'Electron'],
    ['Nix', '/nix/store/abc123-ripgrep-14.1.0/bin/rg', 'rg'],
    ['a Linux distro binary', '/usr/lib/x86_64-linux-gnu/some-helper', 'some-helper'],
    ['a snap', '/snap/node/current/bin/node', 'node'],
    ['Windows system32', 'C:\\Windows\\System32\\conhost.exe', 'conhost.exe'],
    ['Windows Program Files', 'D:\\Program Files\\Git\\bin\\git.exe', 'git.exe'],
  ])('keeps %s', (_label, modulePath, expected) => {
    expect(reportableModuleName(modulePath)).toBe(expected);
  });

  it.each([
    ['cargo install', '/Users/dev/.cargo/bin/ripgrep', 'ripgrep'],
    ['a rustup toolchain', '/Users/dev/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc', 'rustc'],
    ['go install', '/Users/dev/go/bin/gopls', 'gopls'],
    ['pipx or uv tool', '/Users/dev/.local/bin/ruff', 'ruff'],
    ['a toolchain store under XDG data', '/home/dev/.local/share/mise/installs/node/22.0.0/bin/node', 'node'],
    ['bun', '/Users/dev/.bun/bin/bun', 'bun'],
    ['nvm', '/Users/dev/.nvm/versions/node/v22.0.0/bin/node', 'node'],
    ['pyenv', '/Users/dev/.pyenv/versions/3.13.0/bin/python3.13', 'python3.13'],
    ['a Puppeteer browser download', '/Users/dev/.cache/puppeteer/chrome-headless-shell/mac_arm-151/chrome-headless-shell', 'chrome-headless-shell'],
    ['a Playwright browser download on macOS', '/Users/dev/Library/Caches/ms-playwright/chromium-1100/chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
    ['a per-user macOS app', '/Users/dev/Applications/Some Tool.app/Contents/MacOS/Some Tool', 'Some Tool'],
    ['a per-user Windows install', 'C:\\Users\\dev\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'Code.exe'],
    ['a Linux home', '/home/dev/.cargo/bin/ripgrep', 'ripgrep'],
    ['root\'s home', '/root/.local/bin/ruff', 'ruff'],
    ['root\'s home at /var/root (macOS)', '/var/root/.cargo/bin/ripgrep', 'ripgrep'],
  ])('keeps %s under a home directory', (_label, modulePath, expected) => {
    expect(reportableModuleName(modulePath)).toBe(expected);
  });

  it('keeps a published package binary inside any project\'s node_modules (DESKTOP-1D)', () => {
    expect(
      reportableModuleName(
        '/Users/dev/other-project/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper'
      )
    ).toBe('Electron Helper');
  });

  it('reads through a Windows long-path prefix', () => {
    expect(
      reportableModuleName('\\\\?\\C:\\Program Files\\Git\\usr\\bin\\ssh.exe')
    ).toBe('ssh.exe');
  });

  it('matches directory names case-insensitively but returns the basename as the dump spells it', () => {
    expect(reportableModuleName('/Users/dev/.CARGO/bin/RipGrep')).toBe('RipGrep');
  });
});

describe('reportableModuleName: anything else is a user binary', () => {
  it.each([
    ['a Rust test binary in a project', '/Users/dev/work/acme/target/debug/deps/acme_search-0123456789abcdef'],
    ['a Swift package build', '/Users/dev/work/acme/.build/debug/AcmePackageTests.xctest/Contents/MacOS/AcmePackageTests'],
    ['an Xcode DerivedData product', '/Users/dev/Library/Developer/Xcode/DerivedData/Acme-abc/Build/Products/Debug/Acme.app/Contents/MacOS/Acme'],
    ['a Go test binary in a temp directory', '/private/var/folders/xy/abc/T/go-build123/b001/acme.test'],
    ['a binary in /tmp', '/tmp/acme-scratch'],
    ['a binary on an external volume', '/Volumes/Work/acme/bin/acme'],
    ['a binary straight in the home directory', '/Users/dev/acme'],
    ['a Linux project build', '/home/dev/src/acme/build/acme-tests'],
    ['a Windows project build', 'C:\\Users\\dev\\source\\repos\\Acme\\bin\\Debug\\Acme.Tests.exe'],
    ['a project virtualenv', '/Users/dev/work/acme/.venv/bin/python3'],
    ['a build product under root\'s home at /var/root, outside an install directory', '/var/root/project/target/debug/app'],
  ])('replaces %s with user-binary', (_label, modulePath) => {
    expect(reportableModuleName(modulePath)).toBe(USER_BINARY_MODULE);
  });

  it.each([
    ['a directory that only starts like /usr', '/usrlocal/bin/acme'],
    ['a directory that only starts like /opt', '/optional/acme'],
    ['a home directory whose name looks like .cargo', '/Users/dev/projects/.cargo-like/bin/acme'],
    ['.cargo/bin below the home root, inside a project', '/Users/dev/work/acme/.cargo/bin/acme'],
    ['an install directory name inside a project', '/Users/dev/work/acme/go/bin/acme'],
    ['a relative path', 'acme/bin/acme'],
  ])('stops at a path-segment boundary: %s', (_label, modulePath) => {
    expect(reportableModuleName(modulePath)).toBe(USER_BINARY_MODULE);
  });

  it('says unknown when the dump names no main module', () => {
    expect(reportableModuleName(undefined)).toBe(UNKNOWN_MODULE);
    expect(reportableModuleName('')).toBe(UNKNOWN_MODULE);
    expect(reportableModuleName('/usr/bin/')).toBe(UNKNOWN_MODULE);
  });
});

describe('moduleBasename', () => {
  it('splits on either separator, whatever the host', () => {
    expect(moduleBasename('C:\\Program Files\\Git\\bin\\git.exe')).toBe('git.exe');
    expect(moduleBasename('/usr/bin/ssh')).toBe('ssh');
    expect(moduleBasename('ssh')).toBe('ssh');
  });
});

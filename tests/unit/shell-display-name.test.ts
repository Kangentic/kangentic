/**
 * A session on a remote host (#913) reports its login shell by program name alone, so a host's
 * bash arrives as `bash`: the same string a Git Bash session on this computer can carry. The
 * label therefore has to be told where the shell runs. Before it was, a Windows desktop named
 * every host's bash "Git Bash".
 *
 * This computer's OS is the bridge's platform (main's process.platform), never the browser's
 * navigator: in the web demo the sample install is a Windows machine on every visitor's OS, and a
 * label read from navigator.platform said "bash" on the Linux-shot posters and "Git Bash" in a
 * Windows visitor's live frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shellDisplayName } from '../../src/renderer/utils/shell-display-name';

/** The desktop the renderer runs on, as the bridge reports it, and the browser's own navigator. */
function onDesktop(platform: string, navigatorPlatform = 'Linux x86_64'): void {
  vi.stubGlobal('window', { electronAPI: { platform } });
  vi.stubGlobal('navigator', { platform: navigatorPlatform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shellDisplayName', () => {
  it('names a bash on this Windows computer Git Bash, and a host\'s bash as the host does', () => {
    onDesktop('win32');
    expect(shellDisplayName('bash')).toBe('Git Bash');
    expect(shellDisplayName('bash', { onHost: true })).toBe('bash');
  });

  it('names a host\'s shell the same on every desktop', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      onDesktop(platform);
      expect(shellDisplayName('bash', { onHost: true }), platform).toBe('bash');
      expect(shellDisplayName('zsh', { onHost: true }), platform).toBe('zsh');
    }
  });

  it('still reads a local shell by this computer\'s platform', () => {
    onDesktop('darwin');
    expect(shellDisplayName('/bin/bash')).toBe('bash');
    onDesktop('win32');
    expect(shellDisplayName('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('Git Bash');
    expect(shellDisplayName('wsl -d Ubuntu')).toBe('WSL: Ubuntu');
  });

  it('reads the bridge, not the browser, so the web demo names its Windows install\'s shell on any visitor\'s OS', () => {
    onDesktop('win32', 'Linux x86_64');
    expect(shellDisplayName('bash')).toBe('Git Bash');
    onDesktop('linux', 'Win32');
    expect(shellDisplayName('bash')).toBe('bash');
  });
});

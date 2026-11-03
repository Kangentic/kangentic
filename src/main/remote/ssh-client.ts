/**
 * Which `ssh` and `ssh-keygen` Kangentic runs (#913).
 *
 * On Windows the one first on PATH is often Git for Windows' own build, an MSYS program. It reports
 * its files as `/c/Users/dev/.ssh/known_hosts`, which a Windows program reads as `C:\c\Users\dev\...`:
 * Kangentic once pinned a host key into a folder it created at the drive root, `ssh` then found no pin
 * and waited on a host-key prompt nobody could answer. Windows' own OpenSSH (`System32\OpenSSH`, in the
 * box since Windows 10) reports native paths, so it is preferred when it exists. It reads the same
 * `~/.ssh` config and keys. Elsewhere the name on PATH is what a terminal would run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface SshClientPaths {
  ssh: string;
  sshKeygen: string;
}

export function defaultSshClientPaths(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = fs.existsSync,
): SshClientPaths {
  if (platform === 'win32') {
    const directory = path.win32.join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH');
    const ssh = path.win32.join(directory, 'ssh.exe');
    const sshKeygen = path.win32.join(directory, 'ssh-keygen.exe');
    if (exists(ssh) && exists(sshKeygen)) return { ssh, sshKeygen };
  }
  return { ssh: 'ssh', sshKeygen: 'ssh-keygen' };
}

/**
 * A file path as `ssh` printed it, as this platform's own programs read it. Only an MSYS or Cygwin build
 * on Windows prints `/c/Users/dev/...` or `/cygdrive/c/Users/dev/...`; every other path is returned as it came.
 */
export function nativePathFromSsh(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath;
  const match = filePath.match(/^(?:\/cygdrive)?\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) return filePath;
  return `${match[1].toUpperCase()}:\\${(match[2] ?? '').replaceAll('/', '\\')}`;
}

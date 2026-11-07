/**
 * Which `ssh` Kangentic runs, and how a path it prints is read (#913). On Windows the `ssh` first on PATH
 * is often Git for Windows' MSYS build, which names files `/c/Users/dev/...`. Kangentic once trusted that
 * path as written, created `C:\c\Users\dev\.ssh` at the drive root, pinned a host key there, and `ssh` then
 * waited on a host-key prompt that nobody could answer. This was found by running the real app against a
 * real sshd, which the rig (always System32's ssh) never did.
 *
 * What a user loses if it breaks: Add host hangs for a minute on Windows with Git installed, then fails
 * with no explanation, and a stray folder sits at the drive root.
 */
import { describe, expect, it } from 'vitest';
import { defaultSshClientPaths, nativePathFromSsh } from '../../src/main/remote/ssh-client';

describe('which ssh Kangentic runs', () => {
  const system = 'C:\\Windows\\System32\\OpenSSH';

  it('prefers Windows\' own OpenSSH over whatever is first on PATH, when both programs are there', () => {
    const paths = defaultSshClientPaths('win32', { SystemRoot: 'C:\\Windows' }, () => true);

    expect(paths).toEqual({ ssh: `${system}\\ssh.exe`, sshKeygen: `${system}\\ssh-keygen.exe` });
  });

  it('follows SystemRoot rather than assuming the C: drive', () => {
    const paths = defaultSshClientPaths('win32', { SystemRoot: 'D:\\WINNT' }, () => true);

    expect(paths.ssh).toBe('D:\\WINNT\\System32\\OpenSSH\\ssh.exe');
  });

  it('falls back to the name on PATH when Windows\' OpenSSH is missing or half there', () => {
    expect(defaultSshClientPaths('win32', {}, () => false)).toEqual({ ssh: 'ssh', sshKeygen: 'ssh-keygen' });
    expect(defaultSshClientPaths('win32', {}, (filePath) => filePath.endsWith('ssh.exe') && !filePath.endsWith('keygen.exe')))
      .toEqual({ ssh: 'ssh', sshKeygen: 'ssh-keygen' });
  });

  it('falls back to the name on PATH, instead of throwing, when the file system cannot answer', () => {
    const broken = () => { throw new Error('No "existsSync" export is defined on the "node:fs" mock'); };

    expect(defaultSshClientPaths('win32', { SystemRoot: 'C:\\Windows' }, broken)).toEqual({ ssh: 'ssh', sshKeygen: 'ssh-keygen' });
  });

  it('runs the name on PATH on macOS and Linux, never looking for a Windows folder', () => {
    let looked = false;
    const exists = () => { looked = true; return true; };

    expect(defaultSshClientPaths('linux', {}, exists)).toEqual({ ssh: 'ssh', sshKeygen: 'ssh-keygen' });
    expect(defaultSshClientPaths('darwin', {}, exists)).toEqual({ ssh: 'ssh', sshKeygen: 'ssh-keygen' });
    expect(looked).toBe(false);
  });
});

describe('a path as ssh printed it', () => {
  it.each([
    ['/c/Users/dev/.ssh/known_hosts', 'C:\\Users\\dev\\.ssh\\known_hosts'],
    ['/cygdrive/d/work/known_hosts', 'D:\\work\\known_hosts'],
    ['/c', 'C:\\'],
  ])('reads %s on Windows as %s', (printed, native) => {
    expect(nativePathFromSsh(printed, 'win32')).toBe(native);
  });

  it.each([
    'C:\\Users\\dev\\.ssh\\known_hosts',
    'C:/Users/dev/.ssh/known_hosts',
    '\\\\server\\share\\known_hosts',
    '/etc/ssh/ssh_known_hosts',
  ])('leaves %s alone on Windows: it is already a path Windows reads', (printed) => {
    expect(nativePathFromSsh(printed, 'win32')).toBe(printed);
  });

  it('never rewrites a path on macOS or Linux', () => {
    expect(nativePathFromSsh('/c/Users/dev/.ssh/known_hosts', 'linux')).toBe('/c/Users/dev/.ssh/known_hosts');
    expect(nativePathFromSsh('/c/Users/dev/.ssh/known_hosts', 'darwin')).toBe('/c/Users/dev/.ssh/known_hosts');
  });
});

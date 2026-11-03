/**
 * The host program's archive is rebuilt on every release run, and its SHA-256 is pinned in the manifest
 * that ships inside the installer (#913). If two builds of one commit differ by a byte, a user's app
 * rejects the archive that the release now holds, and Add host fails with "does not match the checksum".
 * `tar -czf` differs run to run (file mtimes, directory order), so the archive is written by our own
 * writer. These tests pin that it is byte-stable and that a real `tar` still reads what it writes.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packDirectory } from '../../scripts/lib/deterministic-tar.mjs';

const temporaryFolders: string[] = [];

function makeFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tar-test-'));
  temporaryFolders.push(folder);
  return folder;
}

function populate(root: string, order: string[]): void {
  for (const relative of order) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `contents of ${relative}`);
  }
}

afterEach(() => {
  for (const folder of temporaryFolders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

describe('the host archive is byte-stable', () => {
  it('gives the same bytes for the same files, whatever order they were created in and whenever they were touched', () => {
    const first = makeFolder();
    const second = makeFolder();
    const files = ['node/bin/node', 'app/host.js', 'app/node_modules/node-pty/package.json', 'node/LICENSE'];
    populate(first, files);
    populate(second, [...files].reverse());
    const longAgo = new Date('2001-02-03T04:05:06Z');
    fs.utimesSync(path.join(second, 'app', 'host.js'), longAgo, longAgo);

    expect(packDirectory(first).equals(packDirectory(second))).toBe(true);
  });

  it('changes when a file changes, so the checksum still means something', () => {
    const first = makeFolder();
    const second = makeFolder();
    populate(first, ['app/host.js']);
    populate(second, ['app/host.js']);
    fs.writeFileSync(path.join(second, 'app', 'host.js'), 'different');

    expect(packDirectory(first).equals(packDirectory(second))).toBe(false);
  });

  it('writes no machine, user or time into the gzip header', () => {
    const folder = makeFolder();
    populate(folder, ['app/host.js']);
    const header = packDirectory(folder).subarray(0, 10);

    // magic, deflate, no flags (no file name), mtime 0, then the extra flags byte and the OS byte (Unix).
    expect([...header.subarray(0, 4)]).toEqual([0x1f, 0x8b, 0x08, 0x00]);
    expect([...header.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(header[9]).toBe(3);
  });

  it('refuses a symbolic link instead of following or dropping it', () => {
    const folder = makeFolder();
    populate(folder, ['app/host.js']);
    try {
      fs.symlinkSync(path.join(folder, 'app', 'host.js'), path.join(folder, 'link'));
    } catch {
      return; // Windows without symlink rights cannot make one, and then the archive cannot contain one either.
    }

    expect(() => packDirectory(folder)).toThrow(/symbolic link/);
  });

  it('refuses a path no tar header can hold', () => {
    const folder = makeFolder();
    const deep = path.join(folder, 'a'.repeat(120), 'b'.repeat(120));
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'c'.repeat(120)), 'x');

    expect(() => packDirectory(folder)).toThrow(/too long/);
  });

  it('is read back whole by the system tar that the host installer runs', () => {
    const folder = makeFolder();
    // 130 characters: past the 100-byte name field, so it rides the prefix field.
    const longName = `${'d'.repeat(60)}/${'e'.repeat(60)}/file.txt`;
    populate(folder, ['node/bin/node', 'app/host.js', longName]);
    const archive = path.join(makeFolder(), 'host.tar.gz');
    fs.writeFileSync(archive, packDirectory(folder));
    const extracted = makeFolder();

    // By full path on Windows, as the build does: a bare `tar` can find Git's GNU tar, which reads "C:" as a host.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    execFileSync(tar, ['-xzf', archive, '-C', extracted]);

    expect(fs.readFileSync(path.join(extracted, 'app', 'host.js'), 'utf8')).toBe('contents of app/host.js');
    expect(fs.readFileSync(path.join(extracted, 'node', 'bin', 'node'), 'utf8')).toBe('contents of node/bin/node');
    expect(fs.readFileSync(path.join(extracted, ...longName.split('/')), 'utf8')).toBe(`contents of ${longName}`);
  });
});

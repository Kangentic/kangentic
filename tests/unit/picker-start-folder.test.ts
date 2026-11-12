/**
 * Where an OS file picker opens (#913): `~/.ssh` for a key file, with a fallback to home.
 *
 * What a user loses if it breaks: the key picker opening in Downloads (Electron 43's default) or failing
 * on a machine with no `.ssh` folder yet.
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { resolvePickerStartFolder } from '../../src/main/ipc/helpers/picker-start-folder';

const HOME = path.join(path.sep, 'home', 'dev');

describe('the folder a file picker opens in', () => {
  it('is home when no folder is asked for', () => {
    expect(resolvePickerStartFolder(undefined, HOME, () => true)).toBe(HOME);
  });

  it('expands a leading ~ to home, with either separator, and checks the folder is there', () => {
    const sshFolder = path.join(HOME, '.ssh');
    expect(resolvePickerStartFolder('~/.ssh', HOME, (candidate) => candidate === sshFolder)).toBe(sshFolder);
    expect(resolvePickerStartFolder('~\\.ssh', HOME, (candidate) => candidate === sshFolder)).toBe(sshFolder);
    expect(resolvePickerStartFolder('~', HOME, () => true)).toBe(HOME);
  });

  it('falls back to home when the folder is not there', () => {
    expect(resolvePickerStartFolder('~/.ssh', HOME, () => false)).toBe(HOME);
    expect(resolvePickerStartFolder(path.join(path.sep, 'srv', 'keys'), HOME, () => false)).toBe(HOME);
  });

  it('keeps an absolute folder that exists, and does not treat ~name as home', () => {
    const keys = path.join(path.sep, 'srv', 'keys');
    expect(resolvePickerStartFolder(keys, HOME, () => true)).toBe(keys);
    expect(resolvePickerStartFolder('~other/.ssh', HOME, (candidate) => candidate === '~other/.ssh')).toBe('~other/.ssh');
  });
});

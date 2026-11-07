/**
 * How the Directory field reads typed text (#913). What a user loses if it breaks: suggestions for the wrong
 * folder, a half-typed name that matches nothing, or a Browse breadcrumb that leads outside home.
 */
import { describe, expect, it } from 'vitest';
import { breadcrumbOf, chooseFolder, matchingFolders, splitTypedDirectory } from '../../src/renderer/components/dialogs/remote-directory';

describe('splitTypedDirectory', () => {
  it('lists home for nothing typed, and for a lone ~', () => {
    expect(splitTypedDirectory('')).toEqual({ parent: '~/', tail: '' });
    expect(splitTypedDirectory('  ')).toEqual({ parent: '~/', tail: '' });
    expect(splitTypedDirectory('~')).toEqual({ parent: '~/', tail: '' });
  });

  it('splits at the last slash, keeping the slash with the directory', () => {
    expect(splitTypedDirectory('~/co')).toEqual({ parent: '~/', tail: 'co' });
    expect(splitTypedDirectory('~/code/')).toEqual({ parent: '~/code/', tail: '' });
    expect(splitTypedDirectory('/home/dev/code/ap')).toEqual({ parent: '/home/dev/code/', tail: 'ap' });
  });

  it('reads a name with no slash as a folder in home', () => {
    expect(splitTypedDirectory('code')).toEqual({ parent: '~/', tail: 'code' });
  });
});

describe('matchingFolders', () => {
  const entries = [{ name: 'API', isGitRepo: true }, { name: 'apps', isGitRepo: false }, { name: 'web', isGitRepo: true }];

  it('keeps the folders that start with the typed part, ignoring case, in order', () => {
    expect(matchingFolders(entries, 'ap').map((entry) => entry.name)).toEqual(['API', 'apps']);
    expect(matchingFolders(entries, '').map((entry) => entry.name)).toEqual(['API', 'apps', 'web']);
    expect(matchingFolders(entries, 'zzz')).toEqual([]);
  });
});

describe('chooseFolder', () => {
  it('ends in a slash, so the next level lists at once', () => {
    expect(chooseFolder('~/code/', { name: 'api', isGitRepo: true })).toBe('~/code/api/');
  });
});

describe('breadcrumbOf', () => {
  it('starts at home and adds one crumb per folder below it, each leading to its own path', () => {
    expect(breadcrumbOf('/home/dev/code/api', '/home/dev')).toEqual([
      { label: '~', path: '/home/dev' },
      { label: 'code', path: '/home/dev/code' },
      { label: 'api', path: '/home/dev/code/api' },
    ]);
  });

  it('is only home for home itself, and for a path outside it', () => {
    expect(breadcrumbOf('/home/dev', '/home/dev/')).toEqual([{ label: '~', path: '/home/dev' }]);
    expect(breadcrumbOf('/etc', '/home/dev')).toEqual([{ label: '~', path: '/home/dev' }]);
  });
});

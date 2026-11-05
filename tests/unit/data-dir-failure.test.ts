/**
 * Unit tests for src/main/config/data-dir-failure.ts and the `config_dirs` report it feeds.
 * Regression cover for Sentry DESKTOP-2B / DESKTOP-2C: a config directory that could not be
 * created reached Sentry as a bare `ENOENT: mkdir failed`, and the path that would have said
 * why is removed on purpose. The tags here answer that question without the path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({ reportHandledErrorSpy: vi.fn() }));

vi.mock('../../src/main/analytics/error-reporting', () => ({
  reportHandledError: mocks.reportHandledErrorSpy,
}));

import {
  classifyDataDirState,
  dataDirFailureOf,
  dataDirFailureTags,
  markDataDirFailure,
  type DataDirProbes,
  type DataDirState,
} from '../../src/main/config/data-dir-failure';

/** Assigning undefined to `process.env` stores the string "undefined", which reads as a path. */
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) delete process.env[name];
  else process.env[name] = original;
}

/** Probes over a described filesystem: `existing` paths resolve, `links` are links, case-sensitively. */
function fakeFilesystem(existing: string[], links: string[] = []): DataDirProbes {
  return {
    exists: (target) => existing.includes(target),
    isLink: (target) => links.includes(target),
  };
}

describe('classifyDataDirState over the measured Windows shapes', () => {
  const cases: Array<[string, string, DataDirProbes, DataDirState]> = [
    [
      'a drive that does not exist (ENOENT)',
      'Z:\\Users\\dev\\AppData\\Roaming\\kangentic',
      fakeFilesystem(['C:\\']),
      'drive_missing',
    ],
    [
      'an unreachable UNC share (UNKNOWN)',
      '\\\\server\\share\\kangentic',
      fakeFilesystem(['C:\\']),
      'drive_missing',
    ],
    [
      'a dangling junction at the target (ENOENT)',
      'C:\\Users\\dev\\kangentic',
      fakeFilesystem(['C:\\', 'C:\\Users', 'C:\\Users\\dev'], ['C:\\Users\\dev\\kangentic']),
      'dangling_link',
    ],
    [
      'a dangling junction at a parent (ENOENT)',
      'C:\\Users\\dev\\Roaming\\kangentic',
      fakeFilesystem(['C:\\', 'C:\\Users', 'C:\\Users\\dev'], ['C:\\Users\\dev\\Roaming']),
      'dangling_link',
    ],
    [
      'an invalid character in a segment (ENOENT)',
      'C:\\Users\\dev\\kan?gentic',
      fakeFilesystem(['C:\\', 'C:\\Users', 'C:\\Users\\dev']),
      'invalid_path',
    ],
    [
      'a colon below the drive letter',
      'C:\\Users\\dev:data\\kangentic',
      fakeFilesystem(['C:\\', 'C:\\Users']),
      'invalid_path',
    ],
    [
      'a file at the target (EEXIST)',
      'C:\\Users\\dev\\kangentic',
      fakeFilesystem(['C:\\', 'C:\\Users', 'C:\\Users\\dev', 'C:\\Users\\dev\\kangentic']),
      'other',
    ],
    [
      'a file as the parent (ENOTDIR)',
      'C:\\Users\\dev\\file.txt\\kangentic',
      fakeFilesystem(['C:\\', 'C:\\Users', 'C:\\Users\\dev', 'C:\\Users\\dev\\file.txt']),
      'other',
    ],
  ];

  it.each(cases)('%s', (_shape, directory, probes, expected) => {
    expect(classifyDataDirState(directory, probes, 'win32')).toBe(expected);
  });
});

describe('classifyDataDirState edge cases', () => {
  it('finds a dangling link on POSIX, where the root always exists', () => {
    const probes = fakeFilesystem(['/', '/home', '/home/dev'], ['/home/dev/.config']);
    expect(classifyDataDirState('/home/dev/.config/kangentic', probes, 'linux')).toBe('dangling_link');
  });

  it('does not read a Windows-illegal character as invalid on POSIX', () => {
    const probes = fakeFilesystem(['/', '/data']);
    expect(classifyDataDirState('/data/what?/kangentic', probes, 'linux')).toBe('other');
  });

  it('answers other when a probe throws, because it runs inside a catch', () => {
    const throwingProbes: DataDirProbes = {
      exists: () => { throw new Error('probe failed'); },
      isLink: () => false,
    };
    expect(classifyDataDirState('C:\\Users\\dev\\kangentic', throwingProbes, 'win32')).toBe('other');
  });
});

describe('data dir failure marks on errors that were never marked', () => {
  // ConfigManager.load()'s catch calls dataDirFailureTags, so a throw here would escape it.
  it('answers no failure and no tags for an error that was never marked', () => {
    const error = new Error('EIO: i/o error');
    expect(dataDirFailureOf(error)).toBeUndefined();
    expect(dataDirFailureTags(error)).toEqual({});
  });

  it.each([
    ['a thrown string', 'ENOENT: no such file'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('does not throw for %s, and records nothing', (_label, thrown) => {
    expect(() => markDataDirFailure(thrown, { path: 'C:\\Users\\dev\\kangentic', kind: 'config', origin: 'env' })).not.toThrow();
    expect(dataDirFailureOf(thrown)).toBeUndefined();
    expect(dataDirFailureTags(thrown)).toEqual({});
  });

  it('tags a marked error with fixed words and never the path', () => {
    const error = new Error('ENOENT: mkdir failed');
    markDataDirFailure(error, { path: '/mock/gone/kangentic', kind: 'models', origin: 'flag' });

    const tags = dataDirFailureTags(error);
    expect(tags).toMatchObject({ config_dir: 'models', config_dir_origin: 'flag' });
    expect(JSON.stringify(tags)).not.toContain('gone');
  });
});

describe('classifyDataDirState against the real filesystem', () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'data-dir-failure-'));
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('reads a link whose target is gone as dangling, on Windows a junction', () => {
    // The classifier rests on lstat reporting a junction as a symbolic link. 'junction' is
    // ignored off Windows, and needs no elevation on it.
    const target = path.join(sandbox, 'target');
    const link = path.join(sandbox, 'link');
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'junction');
    fs.rmSync(target, { recursive: true, force: true });

    expect(classifyDataDirState(path.join(link, 'kangentic'))).toBe('dangling_link');
  });
});

describe('the config_dirs report', () => {
  let sandbox: string;
  let blockingFile: string;
  const originalDataDir = process.env.KANGENTIC_DATA_DIR;
  const originalAppData = process.env.APPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    mocks.reportHandledErrorSpy.mockClear();
    vi.resetModules();
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'config-dirs-report-'));
    // A real mkdir failure: a directory cannot be created below a file.
    blockingFile = path.join(sandbox, 'blocking-file');
    fs.writeFileSync(blockingFile, '');
  });

  afterEach(() => {
    restoreEnv('KANGENTIC_DATA_DIR', originalDataDir);
    restoreEnv('APPDATA', originalAppData);
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  async function loadConfig(): Promise<void> {
    const { ConfigManager } = await import('../../src/main/config/config-manager');
    new ConfigManager().load();
  }

  function configDirsReport(): { reported: Error; tags: Record<string, string> } {
    const call = mocks.reportHandledErrorSpy.mock.calls.find(
      ([, tags]) => (tags as Record<string, string>).source === 'config_dirs',
    );
    if (!call) throw new Error('no config_dirs report was made');
    return { reported: call[0] as Error, tags: call[1] as Record<string, string> };
  }

  function expectNoPath(reported: Error, tags: Record<string, string>): void {
    for (const text of [reported.message, reported.stack ?? '', JSON.stringify(tags)]) {
      expect(text).not.toContain(sandbox);
      expect(text).not.toContain('blocking-file');
    }
  }

  it('says where the directory came from and what is wrong with it, without the path', async () => {
    process.env.KANGENTIC_DATA_DIR = path.join(blockingFile, 'kangentic');

    await loadConfig();

    const { reported, tags } = configDirsReport();
    expect(tags).toMatchObject({
      config_dir: 'config',
      config_dir_origin: 'env',
      config_dir_state: 'other',
    });
    expectNoPath(reported, tags);
  });

  it('names the projects directory, with the same origin as the config directory, when only it fails', async () => {
    const dataDir = path.join(sandbox, 'data');
    fs.mkdirSync(dataDir);
    // A file where the projects directory belongs: config succeeds, projects cannot be made.
    fs.writeFileSync(path.join(dataDir, 'projects'), '');
    process.env.KANGENTIC_DATA_DIR = dataDir;

    await loadConfig();

    const { reported, tags } = configDirsReport();
    expect(tags).toMatchObject({ config_dir: 'projects', config_dir_origin: 'env' });
    expectNoPath(reported, tags);
  });

  it.skipIf(process.platform === 'darwin')(
    'names the platform as the origin when only the models directory fails',
    async () => {
      // The models directory ignores KANGENTIC_DATA_DIR, so reading the origin off the
      // config directory would tag `env` here and send the wrong answer. macOS reads
      // neither variable.
      process.env.KANGENTIC_DATA_DIR = path.join(sandbox, 'healthy-data');
      process.env.APPDATA = blockingFile;
      process.env.XDG_CONFIG_HOME = blockingFile;

      await loadConfig();

      const { reported, tags } = configDirsReport();
      expect(tags).toMatchObject({ config_dir: 'models', config_dir_origin: 'appdata' });
      expectNoPath(reported, tags);
    },
  );
});

describe('where paths.ts says the data directory came from', () => {
  const originalArgv = process.argv;
  const originalDataDir = process.env.KANGENTIC_DATA_DIR;
  const originalAppData = process.env.APPDATA;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

  beforeEach(() => {
    vi.resetModules();
    delete process.env.KANGENTIC_DATA_DIR;
  });

  afterEach(() => {
    process.argv = originalArgv;
    restoreEnv('KANGENTIC_DATA_DIR', originalDataDir);
    restoreEnv('APPDATA', originalAppData);
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
  });

  async function loadPaths() {
    return (await import('../../src/main/config/paths')).PATHS;
  }

  it('reads the --data-dir=<path> flag as the flag origin', async () => {
    process.argv = ['node', 'main.js', '--data-dir=/mock/flag-dir'];

    const paths = await loadPaths();

    expect(paths.configDir).toBe('/mock/flag-dir');
    expect(paths.configDirOrigin).toBe('flag');
  });

  it('reads the --data-dir <path> flag as the flag origin', async () => {
    process.argv = ['node', 'main.js', '--data-dir', '/mock/flag-dir'];

    const paths = await loadPaths();

    expect(paths.configDir).toBe('/mock/flag-dir');
    expect(paths.configDirOrigin).toBe('flag');
  });

  it('does not take a following option as the value of a bare --data-dir', async () => {
    process.argv = ['node', 'main.js', '--data-dir', '--other'];
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;

    const paths = await loadPaths();

    expect(paths.configDirOrigin).toBe('home');
  });

  it('lets the environment variable win over the flag', async () => {
    process.env.KANGENTIC_DATA_DIR = '/mock/env-dir';
    process.argv = ['node', 'main.js', '--data-dir=/mock/flag-dir'];

    const paths = await loadPaths();

    expect(paths.configDir).toBe('/mock/env-dir');
    expect(paths.configDirOrigin).toBe('env');
  });

  it('names home when neither override nor the OS config variable is set', async () => {
    // Off macOS the platform default is the OS variable (APPDATA or XDG_CONFIG_HOME) and
    // falls back to the home directory only when it is unset. macOS never reads either.
    process.argv = ['node', 'main.js'];
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;

    const paths = await loadPaths();

    expect(paths.configDirOrigin).toBe('home');
    expect(paths.modelCacheDirOrigin).toBe('home');
  });

  it.skipIf(process.platform === 'darwin')(
    'names appdata for both when the OS config variable decides the platform default',
    async () => {
      process.argv = ['node', 'main.js'];
      process.env.APPDATA = '/mock/appdata';
      process.env.XDG_CONFIG_HOME = '/mock/appdata';

      const paths = await loadPaths();

      expect(paths.configDirOrigin).toBe('appdata');
      expect(paths.modelCacheDirOrigin).toBe('appdata');
    },
  );

  it('keeps the model cache on the platform origin when the config directory is overridden', async () => {
    process.argv = ['node', 'main.js', '--data-dir=/mock/flag-dir'];
    delete process.env.APPDATA;
    delete process.env.XDG_CONFIG_HOME;

    const paths = await loadPaths();

    expect(paths.configDirOrigin).toBe('flag');
    expect(paths.modelCacheDirOrigin).toBe('home');
  });
});

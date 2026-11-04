/**
 * Kimi Code's session files, read from a real temp data root
 * (`KIMI_CODE_HOME`): the index that names each session's folder, the id
 * capture that reads it, and the home and path-compare helpers. A wrong path
 * here leaves a session with no activity and no resume.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kimiCodeHome, kimiMainWirePath, kimiWorkDirCompareKey } from '../../src/main/agent/adapters/kimi/kimi-home';
import { findKimiSessionDir, kimiSessionDeleted, kimiSessionsForWorkDir, parseKimiSessionIndex } from '../../src/main/agent/adapters/kimi/session-index';
import { KimiSessionHistoryParser, locateKimiWireFile } from '../../src/main/agent/adapters/kimi/session-history-parser';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const SESSION_A = 'session_11111111-1111-4111-8111-111111111111';
const SESSION_B = 'session_22222222-2222-4222-8222-222222222222';
const WORK_DIR = '/projects/my-app';

let home: string;
let savedHome: string | undefined;

function addSession(sessionId: string, workDir: string, options: { wire?: boolean } = {}): string {
  const sessionDir = path.join(home, 'sessions', 'wd_test_000000000000', sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  if (options.wire !== false) {
    fs.mkdirSync(path.dirname(kimiMainWirePath(sessionDir)), { recursive: true });
    fs.writeFileSync(kimiMainWirePath(sessionDir), '{"type":"metadata","protocol_version":"1.5","created_at":1}\n');
  }
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId, sessionDir, workDir }) + '\n');
  return sessionDir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-home-'));
  savedHome = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.KIMI_CODE_HOME;
  else process.env.KIMI_CODE_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('kimiCodeHome', () => {
  it('reads KIMI_CODE_HOME, else ~/.kimi-code', () => {
    expect(kimiCodeHome()).toBe(home);
    delete process.env.KIMI_CODE_HOME;
    expect(kimiCodeHome()).toBe(path.join(os.homedir(), '.kimi-code'));
  });

  it('keeps the default for a relative value it has nothing to resolve against', () => {
    process.env.KIMI_CODE_HOME = 'relative/path';
    expect(kimiCodeHome()).toBe(path.join(os.homedir(), '.kimi-code'));
  });

  it('reads a WSL install in its distro\'s home, under the distro\'s own KIMI_CODE_HOME', () => {
    const facts = { homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', env: {} as Record<string, string>, networkingMode: 'nat' };
    const place = { kind: 'wsl', distro: 'Ubuntu', facts } as unknown as CliPlace;
    expect(kimiCodeHome(place)).toBe(path.join(facts.homeUnc, '.kimi-code'));
    facts.env.KIMI_CODE_HOME = '~/custom';
    expect(kimiCodeHome(place).replaceAll('\\', '/')).toContain('/home/dev/custom');
  });
});

describe('kimiWorkDirCompareKey', () => {
  it('compares Windows-shaped paths without case, and POSIX ones with it', () => {
    expect(kimiWorkDirCompareKey('C:\\Users\\Dev\\App\\')).toBe(kimiWorkDirCompareKey('c:/users/dev/app'));
    expect(kimiWorkDirCompareKey('/Users/dev/App')).not.toBe(kimiWorkDirCompareKey('/users/dev/app'));
  });
});

describe('session_index.jsonl', () => {
  it('skips what is not a record with a session id', () => {
    const entries = parseKimiSessionIndex(`not json\n[]\n{"sessionDir":"/x"}\n{"sessionId":"${SESSION_A}","sessionDir":"/s","workDir":"/w"}\n`);
    expect(entries).toEqual([{ sessionId: SESSION_A, sessionDir: '/s', workDir: '/w', deleted: false }]);
  });

  it('finds a session\'s folder by id, and forgets a deleted one', () => {
    const sessionDir = addSession(SESSION_A, WORK_DIR);
    expect(findKimiSessionDir(SESSION_A)).toBe(path.normalize(sessionDir));
    expect(kimiSessionDeleted(SESSION_A)).toBe(false);
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION_A, deleted: true }) + '\n');
    expect(findKimiSessionDir(SESSION_A)).toBeNull();
    expect(kimiSessionDeleted(SESSION_A)).toBe(true);
  });

  it('reads a relative folder against the data root', () => {
    fs.writeFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION_A, sessionDir: 'sessions/wd_x/abc', workDir: WORK_DIR }) + '\n');
    expect(findKimiSessionDir(SESSION_A)).toBe(path.join(home, 'sessions', 'wd_x', 'abc'));
  });

  it('answers nothing, and no proof of deletion, with no index', () => {
    expect(findKimiSessionDir(SESSION_A)).toBeNull();
    expect(kimiSessionDeleted(SESSION_A)).toBe(false);
  });

  it('lists only the working directory\'s live sessions', () => {
    addSession(SESSION_A, WORK_DIR);
    addSession(SESSION_B, '/projects/other');
    expect(kimiSessionsForWorkDir([WORK_DIR]).map((session) => session.sessionId)).toEqual([SESSION_A]);
  });
});

describe('locating the wire file', () => {
  it('returns it once it exists, and nothing for a folder with none yet', () => {
    const sessionDir = addSession(SESSION_A, WORK_DIR);
    addSession(SESSION_B, WORK_DIR, { wire: false });
    expect(locateKimiWireFile(SESSION_A)).toBe(path.normalize(kimiMainWirePath(sessionDir)));
    expect(locateKimiWireFile(SESSION_B)).toBeNull();
  });
});

describe('captureSessionIdFromFilesystem', () => {
  it('finds the newest session of this folder made since the spawn', async () => {
    addSession(SESSION_B, '/projects/other');
    addSession(SESSION_A, WORK_DIR);
    await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: WORK_DIR, maxAttempts: 1 })).resolves.toBe(SESSION_A);
  });

  it('does not take an older session of the folder for this spawn', async () => {
    addSession(SESSION_A, WORK_DIR);
    const later = new Date(Date.now() + 60_000);
    const found = await KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: later, cwd: WORK_DIR, maxAttempts: 1 });
    expect(found).toBeNull();
  });

  it('does not take another folder\'s session', async () => {
    addSession(SESSION_B, '/projects/other');
    await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: WORK_DIR, maxAttempts: 1 })).resolves.toBeNull();
  });

  it('returns the later of two sessions of one folder made since the spawn', async () => {
    const spawnedAt = new Date();
    addSession(SESSION_A, WORK_DIR);
    addSession(SESSION_B, WORK_DIR);
    await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt, cwd: WORK_DIR, maxAttempts: 1 })).resolves.toBe(SESSION_B);
  });

  it('does not capture a session the index records as deleted', async () => {
    addSession(SESSION_A, WORK_DIR);
    fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: SESSION_A, deleted: true }) + '\n');
    await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: WORK_DIR, maxAttempts: 1 })).resolves.toBeNull();
  });

  // The CLI records process.cwd(), which has symlinks resolved, while Kangentic
  // knows the spelling it spawned with. A symlink needs a privilege on Windows.
  it.skipIf(process.platform === 'win32')('matches a cwd reached through a symlink to the resolved path the index holds', async () => {
    const realDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-real-'));
    const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-link-'));
    const linkPath = path.join(linkParent, 'project-link');
    try {
      fs.symlinkSync(realDirectory, linkPath, 'dir');
      addSession(SESSION_A, fs.realpathSync.native(linkPath));
      await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: new Date(), cwd: linkPath, maxAttempts: 1 })).resolves.toBe(SESSION_A);
    } finally {
      fs.rmSync(linkParent, { recursive: true, force: true });
      fs.rmSync(realDirectory, { recursive: true, force: true });
    }
  });

  it('stops at the first older session, so a folder with many costs one stat per poll', async () => {
    const olderIds = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `session_older-${suffix}`);
    for (const sessionId of olderIds) addSession(sessionId, WORK_DIR);
    const sessionsRoot = path.join(home, 'sessions');
    const realStat = fs.statSync;
    const sessionFolderStats: string[] = [];
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).startsWith(sessionsRoot)) sessionFolderStats.push(String(target));
      return (realStat as (...args: unknown[]) => fs.Stats)(target, ...rest);
    }) as typeof fs.statSync);
    try {
      const later = new Date(Date.now() + 60_000);
      await expect(KimiSessionHistoryParser.captureSessionIdFromFilesystem({ spawnedAt: later, cwd: WORK_DIR, maxAttempts: 1 })).resolves.toBeNull();
    } finally {
      statSpy.mockRestore();
    }
    expect(sessionFolderStats).toHaveLength(1);
  });

  it('keeps locating wire files after the index grows between two calls', () => {
    const firstDir = addSession(SESSION_A, WORK_DIR);
    expect(locateKimiWireFile(SESSION_A)).toBe(path.normalize(kimiMainWirePath(firstDir)));
    const secondDir = addSession(SESSION_B, WORK_DIR);
    expect(locateKimiWireFile(SESSION_B)).toBe(path.normalize(kimiMainWirePath(secondDir)));
  });
});

function writeIndex(lines: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(home, 'session_index.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

describe('kimiSessionsForWorkDir', () => {
  const dirOf = (name: string) => path.join(home, 'sessions', name);

  it('leaves out a session a later line deletes, which carries no workDir', () => {
    writeIndex([
      { sessionId: SESSION_A, sessionDir: dirOf('a'), workDir: WORK_DIR },
      { sessionId: SESSION_B, sessionDir: dirOf('b'), workDir: WORK_DIR },
      { sessionId: SESSION_A, deleted: true },
    ]);
    expect(kimiSessionsForWorkDir([WORK_DIR]).map((session) => session.sessionId)).toEqual([SESSION_B]);
  });

  it('lists a session with two lines once, at the place of its first line', () => {
    writeIndex([
      { sessionId: SESSION_A, sessionDir: dirOf('a'), workDir: WORK_DIR },
      { sessionId: SESSION_B, sessionDir: dirOf('b'), workDir: WORK_DIR },
      { sessionId: SESSION_A, sessionDir: dirOf('a-moved'), workDir: WORK_DIR },
    ]);
    const sessions = kimiSessionsForWorkDir([WORK_DIR]);
    expect(sessions.map((session) => session.sessionId)).toEqual([SESSION_A, SESSION_B]);
    expect(sessions[0].sessionDir).toBe(path.normalize(dirOf('a-moved')));
  });

  it('matches both spellings of one directory', () => {
    writeIndex([
      { sessionId: SESSION_A, sessionDir: dirOf('a'), workDir: '/projects/app' },
      { sessionId: SESSION_B, sessionDir: dirOf('b'), workDir: '/private/projects/app' },
    ]);
    const found = kimiSessionsForWorkDir(['/projects/app', '/private/projects/app']).map((session) => session.sessionId);
    expect(found).toEqual([SESSION_A, SESSION_B]);
    expect(kimiSessionsForWorkDir(['/projects/app']).map((session) => session.sessionId)).toEqual([SESSION_A]);
  });
});

describe('a Kimi Code in a WSL distro', () => {
  let homeUnc: string;

  function wslPlace(uncRoot: string): CliPlace {
    const facts = { homeLinux: '/home/dev', homeUnc, uncRoot, env: {} as Record<string, string>, networkingMode: 'nat' };
    return { kind: 'wsl', distro: 'Ubuntu', facts } as unknown as CliPlace;
  }

  function writeDistroIndex(lines: Array<Record<string, unknown>>): void {
    fs.mkdirSync(path.join(homeUnc, '.kimi-code'), { recursive: true });
    fs.writeFileSync(path.join(homeUnc, '.kimi-code', 'session_index.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }

  beforeEach(() => {
    homeUnc = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-distro-'));
  });

  afterEach(() => {
    fs.rmSync(homeUnc, { recursive: true, force: true });
  });

  it('maps a session folder the distro wrote to the share that reaches it', () => {
    const place = wslPlace('\\\\wsl.localhost\\Ubuntu');
    writeDistroIndex([{ sessionId: SESSION_A, sessionDir: '/home/dev/.kimi-code/sessions/wd_x/abc', workDir: '/home/dev/app' }]);
    expect(findKimiSessionDir(SESSION_A, place)).toBe('\\\\wsl.localhost\\Ubuntu\\home\\dev\\.kimi-code\\sessions\\wd_x\\abc');
  });

  it('captures by the path the distro sees for the cwd, not the Windows spelling', async () => {
    const place = wslPlace('\\\\wsl.localhost\\Ubuntu');
    const sessionDir = path.join(homeUnc, '.kimi-code', 'sessions', 'wd_x', SESSION_A);
    fs.mkdirSync(sessionDir, { recursive: true });
    writeDistroIndex([
      { sessionId: SESSION_A, sessionDir: path.join('sessions', 'wd_x', SESSION_A), workDir: '/mnt/c/Users/dev/app' },
      { sessionId: SESSION_B, sessionDir: path.join('sessions', 'wd_x', SESSION_B), workDir: 'C:\\Users\\dev\\app' },
    ]);
    const cliTarget = { kind: 'wsl' as const, distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc, uncRoot: place.facts.uncRoot };
    fs.mkdirSync(path.join(homeUnc, '.kimi-code', 'sessions', 'wd_x', SESSION_B), { recursive: true });
    const found = await KimiSessionHistoryParser.captureSessionIdFromFilesystem({
      spawnedAt: new Date(),
      cwd: 'C:\\Users\\dev\\app',
      cliTarget,
      maxAttempts: 1,
    });
    expect(found).toBe(SESSION_A);
  });
});

describe('kimiWorkDirCompareKey for a share', () => {
  it('compares a UNC path and its // spelling without case or a trailing slash', () => {
    expect(kimiWorkDirCompareKey('\\\\Server\\Share\\Dir\\')).toBe('//server/share/dir');
    expect(kimiWorkDirCompareKey('//Server/Share/Dir')).toBe('//server/share/dir');
  });
});

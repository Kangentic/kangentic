/**
 * Why sqlite-vec failed to load, as the fixed word the retrieval worker's report
 * carries (Sentry DESKTOP-4Q, which said only `SqliteError` / `SQLITE_ERROR`).
 *
 * The table maps each loader's own words to a cause. The Windows texts are the
 * system's messages for each code (`[ComponentModel.Win32Exception]::new(N).Message`),
 * the POSIX and macOS ones are glibc's and dyld's. The real loads below run
 * `loadVecExtensionFrom` against files that cannot load, through the bundled
 * SQLite, so they prove the message SQLite really hands back.
 *
 * Tier: Unit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { getLoadablePath } from 'sqlite-vec';
import { isVecLoadCause, vecLoadCause, type VecLoadCause } from '../../src/main/retrieval/vec-load-cause';
import { hasVecSupport, loadVecExtensionFrom, withoutLibrarySuffix } from '../../src/main/retrieval/vec-support';

const suffix = process.platform === 'win32' ? '.dll' : process.platform === 'darwin' ? '.dylib' : '.so';

const LOADER_MESSAGES: ReadonlyArray<readonly [string, string, VecLoadCause]> = [
  ['Windows 126', 'The specified module could not be found.', 'not_found'],
  ['Windows 2', 'The system cannot find the file specified.', 'not_found'],
  ['Windows 3', 'The system cannot find the path specified.', 'not_found'],
  ['Windows 193', '%1 is not a valid Win32 application.', 'bad_image'],
  ['Windows 216', 'This version of %1 is not compatible with the version of Windows you\'re running. Check your computer\'s system information and then contact the software publisher.', 'bad_image'],
  ['Windows 14001', 'The application has failed to start because its side-by-side configuration is incorrect. Please see the application event log or use the command-line sxstrace.exe tool for more detail.', 'bad_image'],
  ['Windows 1260', 'This program is blocked by group policy. For more information, contact your system administrator.', 'blocked_by_policy'],
  ['Windows 4551', 'An Application Control policy has blocked this file.', 'blocked_by_policy'],
  ['Windows 4556', 'An Application Control policy has blocked this file.  Malicious binary reputation.', 'blocked_by_policy'],
  ['Windows 577', 'Windows cannot verify the digital signature for this file. A recent hardware or software change might have installed a file that is signed incorrectly or damaged, or that might be malicious software from an unknown source.', 'blocked_by_policy'],
  ['Windows 225', 'Operation did not complete successfully because the file contains a virus or potentially unwanted software.', 'blocked_by_policy'],
  ['Windows 5', 'Access is denied.', 'access_denied'],
  ['Windows 127', 'The specified procedure could not be found.', 'entry_point'],
  ['Windows 1114', 'A dynamic link library (DLL) initialization routine failed.', 'other'],
  ['SQLite OS error fallback', 'OsError 0x45a (1114)', 'other'],
  ['Linux missing file', '/opt/kangentic/vec0.so: cannot open shared object file: No such file or directory', 'not_found'],
  ['Linux missing dependency', 'libm.so.7: cannot open shared object file: No such file or directory', 'not_found'],
  ['Linux bad header', '/opt/kangentic/vec0.so: invalid ELF header', 'bad_image'],
  ['Linux short file', '/opt/kangentic/vec0.so: file too short', 'bad_image'],
  ['Linux wrong class', '/opt/kangentic/vec0.so: wrong ELF class: ELFCLASS32', 'bad_image'],
  ['Linux permission', '/opt/kangentic/vec0.so: cannot open shared object file: Permission denied', 'access_denied'],
  ['Linux undefined symbol', '/opt/kangentic/vec0.so: undefined symbol: sqlite3_vec_init', 'entry_point'],
  ['macOS missing file', "dlopen(/Applications/Kangentic.app/vec0.dylib, 0x000A): tried: '/Applications/Kangentic.app/vec0.dylib' (no such file), '/System/Volumes/Preboot/Cryptexes/OS/Applications/Kangentic.app/vec0.dylib' (no such file)", 'not_found'],
  ['macOS bad image', "dlopen(/Applications/Kangentic.app/vec0.dylib, 0x000A): tried: '/Applications/Kangentic.app/vec0.dylib' (not a mach-o file), '/System/Volumes/Preboot/Cryptexes/OS/Applications/Kangentic.app/vec0.dylib' (no such file)", 'bad_image'],
  ['macOS wrong architecture', "dlopen(/Applications/Kangentic.app/vec0.dylib, 0x000A): tried: '/Applications/Kangentic.app/vec0.dylib' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))", 'bad_image'],
  ['macOS signature', "dlopen(/Applications/Kangentic.app/vec0.dylib, 0x000A): tried: '/Applications/Kangentic.app/vec0.dylib' (code signature in <1A2B> '/Applications/Kangentic.app/vec0.dylib' not valid for use in process: library load disallowed by system policy)", 'blocked_by_policy'],
  ['macOS symbol', 'dlsym(0x1234, sqlite3_vec_init): symbol not found', 'entry_point'],
  ['SQLite own entry point text', 'no entry point [sqlite3_vec_init] in shared library [/opt/kangentic/vec0]', 'entry_point'],
  ['SQLite init failure', 'error during initialization: out of memory', 'other'],
  ['SQLite load off', 'not authorized', 'other'],
];

describe('vecLoadCause', () => {
  it.each(LOADER_MESSAGES)('%s reads as its cause', (_name, message, cause) => {
    expect(vecLoadCause(message)).toBe(cause);
  });
});

describe('withoutLibrarySuffix', () => {
  it('takes this platform\'s library suffix off, and only that', () => {
    expect(withoutLibrarySuffix(path.join('app.asar.unpacked', 'node_modules', `vec0${suffix}`)))
      .toBe(path.join('app.asar.unpacked', 'node_modules', 'vec0'));
    expect(withoutLibrarySuffix(path.join('app.asar.unpacked', 'vec0'))).toBe(path.join('app.asar.unpacked', 'vec0'));
    expect(withoutLibrarySuffix(path.join('app.asar.unpacked', 'vec0.txt'))).toBe(path.join('app.asar.unpacked', 'vec0.txt'));
  });

  // SQLite's retry appends the suffix in lower case. A case-sensitive filesystem would miss
  // `Vec0.so` after that retry, so only Windows may read an upper-case suffix as the suffix.
  it('reads an upper-case suffix as the suffix on Windows only, and leaves the rest of the path as given', () => {
    const upperCasePath = path.join('X', `Vec0${suffix.toUpperCase()}`);
    const expected = process.platform === 'win32' ? path.join('X', 'Vec0') : upperCasePath;
    expect(withoutLibrarySuffix(upperCasePath)).toBe(expected);
  });
});

describe('isVecLoadCause', () => {
  it.each(['not_found', 'bad_image', 'blocked_by_policy', 'access_denied', 'entry_point', 'other'])(
    'accepts %s',
    (cause) => {
      expect(isVecLoadCause(cause)).toBe(true);
    },
  );

  it.each([
    ['another string', 'unknown_cause'],
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
  ])('rejects %s', (_name, value) => {
    expect(isVecLoadCause(value)).toBe(false);
  });

  it('accepts every cause the classifier can return, so the allow-list cannot drift', () => {
    for (const [, message] of LOADER_MESSAGES) {
      expect(isVecLoadCause(vecLoadCause(message))).toBe(true);
    }
  });
});

// A real load through the bundled SQLite. SQLite retries a failed load with the suffix
// appended and keeps the loader's LAST error, so given `vec0.dll` the message described
// `vec0.dll.dll`, which never exists: every failure read `not_found`.
//
// Red-green: load `loadablePath` as given in `loadVecExtensionFrom` (no suffix strip) and the
// garbage-file case reads `not_found` instead of `bad_image`.
describe('a real failing load reports the real file\'s cause', () => {
  let directory: string;

  beforeAll(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-vec-load-cause-'));
  });

  afterAll(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function causeOfLoading(loadablePath: string): VecLoadCause {
    const db = new Database(':memory:');
    try {
      loadVecExtensionFrom(db, loadablePath);
      throw new Error('the load was expected to fail');
    } catch (error) {
      if (error instanceof Error && error.message === 'the load was expected to fail') throw error;
      return vecLoadCause(error instanceof Error ? error.message : String(error));
    } finally {
      db.close();
    }
  }

  it('a missing file reads not_found', () => {
    expect(causeOfLoading(path.join(directory, `missing${suffix}`))).toBe('not_found');
  });

  it('a file that is not a library reads bad_image', () => {
    const garbagePath = path.join(directory, `vec0${suffix}`);
    fs.writeFileSync(garbagePath, Buffer.alloc(4096, 0x5a));
    expect(causeOfLoading(garbagePath)).toBe('bad_image');
  });

  it('still loads the real extension through the path with its suffix taken off', () => {
    const db = new Database(':memory:');
    try {
      loadVecExtensionFrom(db, getLoadablePath());
      expect(hasVecSupport(db)).toBe(true);
      expect(db.prepare('SELECT vec_version() AS version').get()).toMatchObject({ version: expect.any(String) });
    } finally {
      db.close();
    }
  });
});

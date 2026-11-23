/**
 * Why sqlite-vec failed to load, as a fixed word a report can carry (Sentry
 * DESKTOP-4Q, where the report said only `SqliteError` / `SQLITE_ERROR` and the
 * reason stayed in the local log).
 *
 * The reason is read from SQLite's message, which on a failed load is the
 * operating system's own words: SQLite replaces its "unable to open shared
 * library" text with the loader's error (`winDlError` reads `GetLastError`,
 * `unixDlError` reads `dlerror()`). That error is the real file's only because
 * `loadVecExtensionFrom` loads the path without its suffix (see `vec-support.ts`).
 * The message itself never leaves the worker: it holds the install path.
 *
 * The Windows texts are the system's own messages for each code, read with
 * `[ComponentModel.Win32Exception]::new(<code>).Message`:
 * 126 not found, 2 and 3 file or path not found, 193 not a valid Win32
 * application, 216 not compatible with this Windows, 14001 side-by-side, 1260
 * group policy, 4551 and 4556 Application Control, 577 signature not verified,
 * 225 virus, 5 access denied, 127 procedure not found.
 *
 * On Windows `not_found` with the file present usually means a DLL the
 * extension links against is missing, since the loader names neither.
 */

export type VecLoadCause = 'not_found' | 'bad_image' | 'blocked_by_policy' | 'access_denied' | 'entry_point' | 'other';

/** Each cause's phrases, tried in order; the first that matches decides. */
const VEC_LOAD_CAUSES: ReadonlyArray<readonly [VecLoadCause, RegExp]> = [
  // Policy before the rest: a blocked file's message can also mention the file.
  ['blocked_by_policy', /blocked by group policy|Application Control policy has blocked|cannot verify the digital signature|contains a virus or potentially unwanted software|code signature|not valid for use in process|library load disallowed by system policy/i],
  ['access_denied', /Access is denied|Permission denied|operation not permitted/i],
  ['bad_image', /is not a valid Win32 application|is not compatible with the version of Windows|side-by-side configuration is incorrect|invalid ELF header|file too short|wrong ELF class|ELF file|not a mach-o file|incompatible architecture|mach-o file, but is an incompatible/i],
  ['entry_point', /The specified procedure could not be found|undefined symbol|symbol not found|no entry point \[/i],
  ['not_found', /The specified module could not be found|The system cannot find the (?:file|path) specified|cannot open shared object file: No such file or directory|image not found|no such file/i],
];

const VEC_LOAD_CAUSE_NAMES: ReadonlySet<string> = new Set<VecLoadCause>([...VEC_LOAD_CAUSES.map(([cause]) => cause), 'other']);

/** Whether a value that crossed the process line is one of the fixed causes.
 *  Main checks it before it becomes a report tag, since the type stops at the wire. */
export function isVecLoadCause(value: unknown): value is VecLoadCause {
  return typeof value === 'string' && VEC_LOAD_CAUSE_NAMES.has(value);
}

/** The cause a loader message names, or `other`. Never returns the message. */
export function vecLoadCause(message: string): VecLoadCause {
  for (const [cause, phrase] of VEC_LOAD_CAUSES) {
    if (phrase.test(message)) return cause;
  }
  return 'other';
}

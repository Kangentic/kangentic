import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Canonical Kimi work-dir -> sessions-directory hash.
 *
 * Kimi keys sessions to the absolute work-dir path:
 *   ~/.kimi/sessions/<md5(work_dir)>/<uuid>/...
 * where the directory name is the md5 hex of the literal absolute work-dir
 * string (verified empirically and against kimi-cli's `metadata.py`). Kangentic
 * spawns Kimi with a forward-slashed `-w`, but Kimi normalizes it to the native
 * separator before hashing, and `path.resolve` yields that native form, so
 * callers should hash `path.resolve(cwd)` to land on the same on-disk digest.
 *
 * Single source of truth shared by `project-relocation.ts` (which renames these
 * directories on a project move) and `session-history-parser.ts` (which scopes
 * the filesystem session-id capture to this directory). Keeping one definition
 * prevents the two from drifting, which would silently break capture or
 * relocation.
 */
export function kimiWorkDirHash(literalPath: string): string {
  return crypto.createHash('md5').update(literalPath, 'utf8').digest('hex');
}

/** Absolute path to `~/.kimi/sessions`. */
export function kimiSessionsRoot(): string {
  return path.join(os.homedir(), '.kimi', 'sessions');
}

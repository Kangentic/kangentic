import path from 'node:path';
import { hostPathForTarget, type CliPlace } from '../../shared/cli-target';
import { parseJsonlRecords } from '../../shared/history-scan';
import { cachedFileReader } from './cached-file';
import { kimiCodeHome, kimiSessionIndexPath, kimiWorkDirCompareKey } from './kimi-home';

/**
 * Kimi Code CLI's session index, `<home>/session_index.jsonl`.
 *
 * Source: `en/configuration/data-locations.md` (Kimi Code CLI 2.4.1, read
 * 2026-11-03): "a top-level `session_index.jsonl` index is maintained (one
 * record per line, each containing `sessionId`, `sessionDir`, and
 * `workDir`)". A deleted session appends `{sessionId, deleted: true}`
 * (`packages/agent-core-v2` session index). Built from the docs and source,
 * not yet checked against a real install.
 */
export interface KimiSessionIndexEntry {
  sessionId: string;
  /** The session's folder, as the CLI wrote it (a distro path for a WSL install). */
  sessionDir: string | null;
  workDir: string | null;
  deleted: boolean;
}

/** Parse the index's lines, skipping any that are not a record with a session id. */
export function parseKimiSessionIndex(text: string): KimiSessionIndexEntry[] {
  const entries: KimiSessionIndexEntry[] = [];
  for (const record of parseJsonlRecords(text, false)) {
    if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) continue;
    entries.push({
      sessionId: record.sessionId,
      sessionDir: typeof record.sessionDir === 'string' && record.sessionDir.length > 0 ? record.sessionDir : null,
      workDir: typeof record.workDir === 'string' && record.workDir.length > 0 ? record.workDir : null,
      deleted: record.deleted === true,
    });
  }
  return entries;
}

const readParsedIndex = cachedFileReader<KimiSessionIndexEntry[]>(parseKimiSessionIndex, []);

/** Every line of the index, in file order. Empty when it cannot be read. */
export function readKimiSessionIndex(place: CliPlace | null = null): KimiSessionIndexEntry[] {
  return readParsedIndex(kimiSessionIndexPath(place));
}

/**
 * The session's folder on this machine, by its id: the last line naming it with
 * a folder, mapped from the distro's path for a WSL install. Null when the
 * index has no such line, or a later line deleted the session.
 */
export function findKimiSessionDir(sessionId: string, place: CliPlace | null = null): string | null {
  let sessionDir: string | null = null;
  for (const entry of readKimiSessionIndex(place)) {
    if (entry.sessionId !== sessionId) continue;
    if (entry.deleted) {
      sessionDir = null;
      continue;
    }
    if (entry.sessionDir) sessionDir = entry.sessionDir;
  }
  return sessionDir ? hostSessionDir(sessionDir, place) : null;
}

/** True only when the index records the session as deleted. */
export function kimiSessionDeleted(sessionId: string, place: CliPlace | null = null): boolean {
  return readKimiSessionIndex(place).some((entry) => entry.sessionId === sessionId && entry.deleted);
}

/**
 * The live sessions the index lists for a working directory, each once, oldest
 * first (a session keeps the place of its first line), with their folders on
 * this machine. `cliWorkDirs` names one directory: more than one is its spellings
 * (as the CLI saw it, and with symlinks resolved). A later line can delete a
 * session, and that line carries no `workDir`, so it is matched by id.
 */
export function kimiSessionsForWorkDir(
  cliWorkDirs: readonly string[],
  place: CliPlace | null = null,
): Array<{ sessionId: string; sessionDir: string }> {
  const keys = new Set(cliWorkDirs.map(kimiWorkDirCompareKey));
  const sessions = new Map<string, { sessionId: string; sessionDir: string }>();
  for (const entry of readKimiSessionIndex(place)) {
    if (entry.deleted) {
      sessions.delete(entry.sessionId);
      continue;
    }
    if (!entry.sessionDir || !entry.workDir || !keys.has(kimiWorkDirCompareKey(entry.workDir))) continue;
    sessions.set(entry.sessionId, { sessionId: entry.sessionId, sessionDir: hostSessionDir(entry.sessionDir, place) });
  }
  return [...sessions.values()];
}

/**
 * A folder from the index as a path on this machine. The docs do not say
 * whether `sessionDir` is absolute, so a relative one is read against the data
 * root it sits in.
 */
function hostSessionDir(sessionDir: string, place: CliPlace | null): string {
  const absolute = sessionDir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(sessionDir) || sessionDir.startsWith('\\\\');
  if (!absolute) return path.join(kimiCodeHome(place), sessionDir);
  return place ? hostPathForTarget(sessionDir, place) : path.normalize(sessionDir);
}

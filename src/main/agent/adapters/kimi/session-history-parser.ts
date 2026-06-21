import fs from 'node:fs';
import path from 'node:path';
import { parseWireJsonl } from './wire-parser';
import { kimiWorkDirHash, kimiSessionsRoot } from './work-dir-hash';
import type { SessionHistoryParseResult } from '../../../../shared/types';

/**
 * Locator + parser for Kimi CLI's wire.jsonl session telemetry.
 *
 * On-disk layout (verified empirically with kimi v1.37.0):
 *
 *   ~/.kimi/
 *     config.toml             user config
 *     credentials/            OAuth state
 *     device_id               opaque
 *     kimi.json               { work_dirs: [{ path, kaos, last_session_id }] }
 *     logs/                   diagnostic logs
 *     sessions/
 *       <work_dir_hash>/      32-char hex hash of the absolute work_dir path
 *         <session_uuid>/     RFC4122 UUIDv4
 *           context.jsonl     full conversation history
 *           wire.jsonl        wire-protocol event stream (when --print
 *                             or interactive runs - NOT only with --wire)
 *
 * The work_dir → hash is the md5 hex of the literal absolute work-dir
 * path (verified empirically and against kimi-cli's `metadata.py`; see
 * `project-relocation.ts`, which computes it to rename session dirs on
 * relocation). The locator below deliberately does NOT rely on it: it
 * globs across all hash directories under `~/.kimi/sessions/` and matches
 * on the session UUID, which is unique and robust against the user opening
 * the same directory under different paths (symlinks, drive letters).
 */
export class KimiSessionHistoryParser {
  /**
   * Locate `wire.jsonl` for a known session UUID. Polls for up to 5s
   * to handle the brief disk-write latency between PTY first output
   * and the file actually existing.
   *
   * Returns null when the session does not exist on disk yet (still
   * spinning up), the session has not generated wire events (no LLM
   * calls completed), or the file system is otherwise inaccessible.
   */
  static async locate(options: {
    agentSessionId: string;
    cwd: string;
  }): Promise<string | null> {
    const { agentSessionId } = options;
    const sessionsRoot = kimiSessionsRoot();
    const maxAttempts = 10;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const found = findSessionWireFile(sessionsRoot, agentSessionId);
      if (found) return found;
      await sleep(500);
    }
    return null;
  }

  /**
   * Capture a session UUID from disk by mtime + UUID directory match
   * when the PTY output capture missed the welcome banner. Mirrors
   * Codex's filesystem fallback path.
   *
   * Strategy: scan ONLY this work_dir's session directory
   * (`~/.kimi/sessions/<md5(cwd)>/`, plus its `<kaos>_<md5(cwd)>` variant)
   * for session UUID directories created within ±30s of the spawn, and
   * return the most recently created match, or null if none.
   *
   * Scoping to the spawn's own work_dir hash is load-bearing, not an
   * optimization: a global newest-across-all-hashes scan attributes the wrong
   * session whenever another Kimi session exists in the window under a
   * different work_dir - a concurrent spawn in another project, or a `-w`-less
   * probe's stray session - which would poison `--resume` with a foreign id.
   *
   * This is best-effort. The primary capture path is the PTY regex
   * scrape on the welcome banner ("Session: <uuid>"); this fallback
   * exists for the rare case where the banner is suppressed (--quiet
   * variants) or the regex fails on a future banner format change.
   */
  static async captureSessionIdFromFilesystem(options: {
    spawnedAt: Date;
    cwd: string;
    maxAttempts?: number;
  }): Promise<string | null> {
    const spawnedAtMs = options.spawnedAt.getTime();
    const floorMs = spawnedAtMs - 30_000;
    const ceilMs = spawnedAtMs + 30_000;
    const sessionsRoot = kimiSessionsRoot();
    // Hash of the spawn's own work_dir; only sessions under this hash (and its
    // non-local-kaos `<kaos>_<hash>` variant) belong to this spawn.
    const workDirHash = kimiWorkDirHash(path.resolve(options.cwd));
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const maxAttempts = options.maxAttempts ?? 20;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const candidates = collectFreshSessionDirs(sessionsRoot, workDirHash, uuidPattern, floorMs, ceilMs);
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.createdAtMs - a.createdAtMs);
        return candidates[0].uuid;
      }
      await sleep(500);
    }
    return null;
  }

  /**
   * Parse newly-appended wire.jsonl bytes (or the whole file) into a
   * SessionHistoryParseResult. Pure delegation to wire-parser.ts so the
   * locator file stays focused on filesystem concerns and the parser
   * stays focused on event semantics.
   */
  static parse(content: string, mode: 'full' | 'append'): SessionHistoryParseResult {
    return parseWireJsonl(content, mode);
  }
}

// ---------- internal helpers ----------

/**
 * Walk one level under `~/.kimi/sessions/` looking for a directory
 * named exactly `<sessionUUID>` containing `wire.jsonl`. Returns the
 * absolute file path, or null if no match.
 *
 * We do NOT compute the work_dir hash because the algorithm is
 * upstream-internal. Globbing across all hash dirs is O(N) where N is
 * the number of work_dirs the user has opened with Kimi - small and
 * cheap on every plausible setup.
 */
export function findSessionWireFile(sessionsRoot: string, sessionUuid: string): string | null {
  let hashEntries: string[];
  try {
    hashEntries = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }

  for (const hash of hashEntries) {
    const candidate = path.join(sessionsRoot, hash, sessionUuid, 'wire.jsonl');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // permission denied, race with another process - skip and continue.
    }
  }
  return null;
}

/**
 * Collect every session UUID directory under this work_dir's hash directory
 * (`~/.kimi/sessions/<workDirHash>/<uuid>/`, plus any `<kaos>_<workDirHash>`
 * variant) whose directory mtime falls between `floorMs` and `ceilMs`. Used as
 * the filesystem fallback for session ID capture when PTY scraping fails.
 *
 * Restricting to `workDirHash` is what keeps a concurrent session under a
 * different work_dir (or a `-w`-less probe stray) from winning the recency
 * sort. Two-level scan: the matching hash directories, then the UUID
 * directories beneath each. Filters by uuidPattern so any future non-UUID
 * files Kimi might add are ignored.
 */
function collectFreshSessionDirs(
  sessionsRoot: string,
  workDirHash: string,
  uuidPattern: RegExp,
  floorMs: number,
  ceilMs: number,
): Array<{ uuid: string; createdAtMs: number }> {
  let hashEntries: string[];
  try {
    hashEntries = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }

  const results: Array<{ uuid: string; createdAtMs: number }> = [];
  for (const hash of hashEntries) {
    // Only this work_dir's hash dir (and its non-local-kaos `<kaos>_<hash>`
    // variant); every other hash belongs to a different work_dir.
    if (hash !== workDirHash && !hash.endsWith(`_${workDirHash}`)) continue;
    let sessionEntries: string[];
    try {
      sessionEntries = fs.readdirSync(path.join(sessionsRoot, hash));
    } catch {
      continue;
    }
    for (const uuid of sessionEntries) {
      if (!uuidPattern.test(uuid)) continue;
      try {
        const stat = fs.statSync(path.join(sessionsRoot, hash, uuid));
        const mtimeMs = stat.mtimeMs;
        if (mtimeMs < floorMs || mtimeMs > ceilMs) continue;
        results.push({ uuid, createdAtMs: mtimeMs });
      } catch {
        // vanished between readdir and stat - skip.
      }
    }
  }
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

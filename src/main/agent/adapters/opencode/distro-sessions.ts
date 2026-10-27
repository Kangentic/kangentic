import { cliPathForTarget, execCliForTarget, type CliTarget } from '../../shared/cli-target';
import type { OpenCodeRemoteMessageEntry } from './remote-client';

/**
 * An OpenCode installed in a WSL distro keeps its sessions in the distro's
 * SQLite database (`~/.local/share/opencode/opencode.db`, WAL mode). WAL needs
 * shared memory the `\\wsl.localhost` share does not give a Windows reader, so
 * that database is never opened from here. The distro's own CLI is asked
 * instead, through `wsl.exe`, as for every other run in a distro:
 *
 * - `opencode session list --format json -n <N>`: one record per session,
 *   `{ id, title, updated, created, projectId, directory }`, newest first, and
 *   no output at all when there is none (1.14.25 in a distro, 1.18.31 here).
 * - `opencode export <id>`: `{ info, messages: [{ info, parts }] }`, the same
 *   `{ info, parts }` entries the server's message API returns
 *   (`mapOpenCodeRemoteEntries`).
 *
 * `--pure` keeps the project's plugins out of these runs; both commands take it.
 * Each run starts with the session's cwd, which the distro sees as its `/mnt`
 * path, so OpenCode reads the same project the session did.
 */

const LIST_TIMEOUT_MS = 15_000;
const EXPORT_TIMEOUT_MS = 30_000;
const LIST_MAX_BUFFER = 4 * 1024 * 1024;
const EXPORT_MAX_BUFFER = 64 * 1024 * 1024;
/** Sessions read per poll; the spawn's own is among the newest. */
const LIST_COUNT = 25;

export interface DistroOpenCodeSession {
  id: string;
  directory: string;
  created: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A session id in the shape OpenCode gives one, the only text that goes on a command line. */
function isSessionId(value: string): boolean {
  return /^[\w-]+$/.test(value);
}

/** `session list --format json`'s records, or none for no output, other output, or a bad record. */
export function parseOpenCodeSessionList(stdout: string): DistroOpenCodeSession[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((record): DistroOpenCodeSession[] => (
      isRecord(record) && typeof record.id === 'string' && typeof record.directory === 'string' && typeof record.created === 'number'
        ? [{ id: record.id, directory: record.directory, created: record.created }]
        : []
    ));
  } catch {
    return [];
  }
}

/** `export`'s messages, or none for output that is not an export. Anything before its JSON (a log line) is skipped. */
export function parseOpenCodeExport(stdout: string): OpenCodeRemoteMessageEntry[] {
  const start = stdout.indexOf('{');
  if (start === -1) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
    return parsed.messages.filter((entry): entry is OpenCodeRemoteMessageEntry => (
      isRecord(entry) && isRecord(entry.info) && typeof entry.info.id === 'string' && Array.isArray(entry.parts)
    ));
  } catch {
    return [];
  }
}

/** The distro sees a drive's files case-insensitively (drvfs), so a `/mnt` path compares that way. */
function sameDistroDirectory(left: string, right: string): boolean {
  const trimmedLeft = left.replace(/\/+$/, '');
  const trimmedRight = right.replace(/\/+$/, '');
  return trimmedLeft.startsWith('/mnt/') && trimmedRight.startsWith('/mnt/')
    ? trimmedLeft.toLowerCase() === trimmedRight.toLowerCase()
    : trimmedLeft === trimmedRight;
}

/** The distro's newest sessions. Rejects as the run does. */
export async function listDistroOpenCodeSessions(target: CliTarget, cwd: string): Promise<DistroOpenCodeSession[]> {
  const { stdout } = await execCliForTarget(
    target,
    ['session', 'list', '--format', 'json', '-n', String(LIST_COUNT), '--pure'],
    { cwd, timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER },
  );
  return parseOpenCodeSessionList(stdout);
}

/**
 * The session a spawn in `cwd` created: the newest whose directory is the
 * distro's path of `cwd`, created in the spawn's window (the window the local
 * database read uses). Each poll is one `wsl.exe` run, so it polls less often
 * than that read and stops at the first match. Null when none appears.
 */
export async function captureDistroOpenCodeSessionId(options: {
  spawnedAt: Date;
  cwd: string;
  target: CliTarget;
  maxAttempts?: number;
  intervalMs?: number;
  list?: (target: CliTarget, cwd: string) => Promise<DistroOpenCodeSession[]>;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<string | null> {
  const spawnedAtMs = options.spawnedAt.getTime();
  const createdFloorMs = spawnedAtMs - 5_000;
  const createdCeilMs = spawnedAtMs + 30_000;
  const directory = cliPathForTarget(options.cwd, options.target);
  const list = options.list ?? listDistroOpenCodeSessions;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxAttempts = options.maxAttempts ?? 10;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const sessions = await list(options.target, options.cwd).catch(() => []);
    const match = sessions
      .filter((session) => session.created >= createdFloorMs && session.created <= createdCeilMs)
      .filter((session) => sameDistroDirectory(session.directory, directory))
      .sort((left, right) => right.created - left.created)[0];
    if (match && isSessionId(match.id)) return match.id;
    if (attempt < maxAttempts - 1) await sleep(options.intervalMs ?? 1_000);
  }
  return null;
}

/** A session's messages as the distro's CLI exports them. Rejects as the run does; none for an id not in an id's shape. */
export async function exportDistroOpenCodeSession(target: CliTarget, sessionId: string, cwd: string): Promise<OpenCodeRemoteMessageEntry[]> {
  if (!isSessionId(sessionId)) return [];
  const { stdout } = await execCliForTarget(
    target,
    ['export', sessionId, '--pure'],
    { cwd, timeout: EXPORT_TIMEOUT_MS, maxBuffer: EXPORT_MAX_BUFFER },
  );
  return parseOpenCodeExport(stdout);
}

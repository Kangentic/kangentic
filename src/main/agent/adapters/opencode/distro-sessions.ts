import { cliPathForTarget, execCliForTarget, type CliTarget } from '../../shared/cli-target';
import type { OpenCodeRemoteMessageEntry } from './remote-client';
import { openCodeV2CreatedMs, openCodeV2MessageEntry } from './v2-messages';
import { isOpenCodeV2 } from './version';

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
 *
 * OpenCode 2 (2.2.5): `session list` prints the same records, with
 * `--standalone` in place of `--pure`; the export is `session export <id>
 * --standalone` and prints a record per message (`parseOpenCodeExport`).
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

/**
 * `export`'s messages, or none for output that is not an export. Anything before its JSON (a log line) is skipped.
 * OpenCode 1 exports `{ info, parts }` entries. OpenCode 2's `session export`
 * prints one record per message (`{ id, type, time, text | content }`), which
 * `openCodeV2MessageEntry` turns into the same entry; its other records (a
 * system reminder, an agent switch, a turn's end) are not conversation.
 */
export function parseOpenCodeExport(stdout: string): OpenCodeRemoteMessageEntry[] {
  const start = stdout.indexOf('{');
  if (start === -1) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start));
    if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return [];
    return parsed.messages.flatMap((entry): OpenCodeRemoteMessageEntry[] => {
      if (!isRecord(entry)) return [];
      if (isRecord(entry.info) && typeof entry.info.id === 'string' && Array.isArray(entry.parts)) {
        return [entry as unknown as OpenCodeRemoteMessageEntry];
      }
      if (typeof entry.id !== 'string' || typeof entry.type !== 'string') return [];
      const converted = openCodeV2MessageEntry(entry.id, entry.type, openCodeV2CreatedMs(entry, 0), entry);
      return converted ? [converted] : [];
    });
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

const VERSION_TIMEOUT_MS = 15_000;

/**
 * Whether the distro's CLI is OpenCode 2, asked once per binary (`--version`)
 * and kept until the adapter's detection is reset (`forgetDistroOpenCodeVersions`),
 * so an upgrade in the distro is seen when the CLI is detected again. Its runs
 * take other flags: OpenCode 2 has no `--pure`, its `export` is `session
 * export`, and without `--standalone` each run joins or starts the distro
 * user's shared background service. A failed answer is not kept, so the next
 * run asks again, and the run that asked rejects with it: guessing a major
 * would only run the other major's flags.
 */
const distroIsV2Cache = new Map<string, Promise<boolean>>();

export function isDistroOpenCodeV2(
  target: CliTarget,
  exec: typeof execCliForTarget = execCliForTarget,
): Promise<boolean> {
  // A WSL distro by name, or a host by id (an ssh place has no distro): one binary per place.
  const place = target.kind === 'ssh' ? `ssh:${target.hostId}` : target.distro;
  const key = `${place}\u0000${target.linuxCliPath}`;
  const cached = distroIsV2Cache.get(key);
  if (cached) return cached;
  const answer = exec(target, ['--version'], { timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 })
    .then(({ stdout }) => isOpenCodeV2(stdout.trim()));
  distroIsV2Cache.set(key, answer);
  answer.catch(() => {
    if (distroIsV2Cache.get(key) === answer) distroIsV2Cache.delete(key);
  });
  return answer;
}

/** Forget every distro CLI's major, so the next run asks again. */
export function forgetDistroOpenCodeVersions(): void {
  distroIsV2Cache.clear();
}

/** `session list`'s arguments for a CLI of the given major. */
export function distroSessionListArgs(openCode2: boolean): string[] {
  return ['session', 'list', '--format', 'json', '-n', String(LIST_COUNT), openCode2 ? '--standalone' : '--pure'];
}

/** The session export's arguments: top-level `export` on OpenCode 1, `session export` on OpenCode 2. */
export function distroSessionExportArgs(sessionId: string, openCode2: boolean): string[] {
  return openCode2 ? ['session', 'export', sessionId, '--standalone'] : ['export', sessionId, '--pure'];
}

/** The distro's newest sessions. Rejects as the run does. */
export async function listDistroOpenCodeSessions(target: CliTarget, cwd: string): Promise<DistroOpenCodeSession[]> {
  const openCode2 = await isDistroOpenCodeV2(target);
  const { stdout } = await execCliForTarget(
    target,
    distroSessionListArgs(openCode2),
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
  const openCode2 = await isDistroOpenCodeV2(target);
  const { stdout } = await execCliForTarget(
    target,
    distroSessionExportArgs(sessionId, openCode2),
    { cwd, timeout: EXPORT_TIMEOUT_MS, maxBuffer: EXPORT_MAX_BUFFER },
  );
  return parseOpenCodeExport(stdout);
}

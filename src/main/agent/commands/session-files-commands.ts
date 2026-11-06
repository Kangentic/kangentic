import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { TaskRepository } from '../../db/repositories/task-repository';
import { sessionOutputPaths } from '../../transition-engine/session-paths';
import { agentRegistry } from '../../agent/agent-registry';
import { placeOfRecord } from '../shared/cli-target';
import { agentPathsOf, type AgentPaths } from '../../remote/host-paths';
import type { HostAccess } from '../../remote/host-transfer';
import type { ValueLocation } from '../../../shared/types';
import { readBoundedTail } from './bounded-tail-read';
import { resolveTask } from './task-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

interface SessionRow {
  id: string;
  task_id: string;
  session_type: string;
  agent_session_id: string | null;
  cwd: string;
  status: string;
  started_at: string;
  exited_at: string | null;
  suspended_at: string | null;
  /** Where the session's CLI ran when it was not this machine (`placeOfRecord`). */
  cli_target: string | null;
  /** The transcript path the agent reported writing. */
  transcript_path: string | null;
}

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;
/** Byte window for the events.jsonl tail-read. MAX_TAIL (2000) hook events at
 *  ~200-600B/line can legitimately span ~1.2MB, so this is sized above the
 *  200KB session-history cap rather than sharing it. */
const MAX_EVENTS_READ_BYTES = 1024 * 1024;

function resolveSession(
  database: Database.Database,
  params: Record<string, unknown>,
): { session?: SessionRow; error?: string } {
  const sessionId = params.sessionId as string | undefined;
  const taskId = params.taskId as string | undefined;
  const sessionIndex = typeof params.sessionIndex === 'number' ? (params.sessionIndex as number) : 0;

  if (!sessionId && !taskId) {
    return { error: 'Provide either taskId or sessionId' };
  }

  if (sessionId) {
    const row = database.prepare(
      `SELECT id, task_id, session_type, agent_session_id, cwd, status, started_at, exited_at, suspended_at, cli_target,
              transcript_path
       FROM sessions WHERE id = ?`,
    ).get(sessionId) as SessionRow | undefined;
    if (!row) return { error: `Session "${sessionId}" not found` };
    return { session: row };
  }

  const taskIdValue = taskId;
  if (!taskIdValue) return { error: 'Provide either taskId or sessionId' };
  const taskRepository = new TaskRepository(database);
  const task = resolveTask(taskRepository, taskIdValue);
  if (!task) return { error: `Task "${taskId}" not found` };

  const rows = database.prepare(
    `SELECT id, task_id, session_type, agent_session_id, cwd, status, started_at, exited_at, suspended_at, cli_target,
            transcript_path
     FROM sessions WHERE task_id = ? ORDER BY started_at DESC`,
  ).all(task.id) as SessionRow[];

  if (rows.length === 0) {
    return { error: `No sessions found for task "${task.title}"` };
  }
  const picked = rows[sessionIndex];
  if (!picked) {
    return { error: `sessionIndex ${sessionIndex} out of range (have ${rows.length} sessions)` };
  }
  return { session: picked };
}

/**
 * One file of a session as an agent is told it. On a remote project `path` and `exists` are the host's, and only the
 * host answers `exists`: null when it could not be asked, which never means absent. A session's folder is on both
 * machines and they do not hold the same files: the host has the settings and hook folders while the session runs,
 * and `events.jsonl` is built here from what it relays, so it reads absent there with `localExists` true.
 */
interface SessionFileEntry {
  path: string;
  exists: boolean | null;
  location: ValueLocation;
  localPath?: string;
  localExists?: boolean;
}

/** Each file's entry, with one ask of the host for all of them. A host that cannot answer leaves `exists` null and says why. */
async function describeSessionFiles(
  localPaths: readonly string[],
  session: SessionRow,
  paths: AgentPaths,
  hostAccess: HostAccess | null,
): Promise<{ entries: SessionFileEntry[]; hostError: string | null }> {
  if (paths.location === 'local') {
    return {
      entries: localPaths.map((filePath) => ({ path: filePath, exists: fs.existsSync(filePath), location: 'local' })),
      hostError: null,
    };
  }
  const hostPaths = localPaths.map((localPath) => paths.sessionFileToAgent(localPath, session));
  let presence: Array<'present' | 'absent'> | null = null;
  let hostError: string | null = hostAccess ? null : 'This project\'s host is not available.';
  if (hostAccess) {
    try {
      presence = await hostAccess.pathPresence(hostPaths);
    } catch (error) {
      hostError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    entries: localPaths.map((localPath, index) => ({
      path: hostPaths[index],
      exists: presence ? presence[index] === 'present' : null,
      location: 'host',
      localPath,
      localExists: fs.existsSync(localPath),
    })),
    hostError,
  };
}

function sessionFilePaths(projectRoot: string, sessionId: string) {
  const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', sessionId);
  const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);
  const files = {
    eventsJsonl: eventsOutputPath,
    statusJson: statusOutputPath,
    settingsJson: path.join(sessionDir, 'settings.json'),
    commandsJsonl: path.join(sessionDir, 'commands.jsonl'),
    mcpJson: path.join(sessionDir, 'mcp.json'),
    responsesDir: path.join(sessionDir, 'responses'),
  };
  return { sessionDir, files };
}

/**
 * Locate the agent's native session history file for a session record.
 * Returns the absolute path if found, null otherwise.
 */
async function locateNativeSessionFile(session: SessionRow): Promise<string | null> {
  if (!session.agent_session_id) return null;
  const adapter = agentRegistry.getBySessionType(session.session_type);
  if (!adapter) return null;
  // host-value-ok: the adapter reads this computer's copy by the folder the row records
  return adapter.locateSessionHistoryFile(session.agent_session_id, session.cwd, placeOfRecord(session), session.transcript_path);
}

export async function handleGetSessionFiles(
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> {
  const database = context.getProjectDb();
  const resolved = resolveSession(database, params);
  if (resolved.error || !resolved.session) {
    return { success: false, error: resolved.error ?? 'Unknown error resolving session' };
  }
  const session = resolved.session;
  // host-value-ok: each file below is mapped to the host or labeled local
  const projectRoot = context.getProjectPath();
  const paths = agentPathsOf(context);
  const { sessionDir, files } = sessionFilePaths(projectRoot, session.id);

  // Locate the agent's native session file (Claude JSONL, Codex JSONL, Gemini JSON).
  // On a host this path is this computer's copy, and `sessionFileToAgent` names the original.
  const nativeSessionFilePath = await locateNativeSessionFile(session);
  const fileKeys = Object.keys(files) as Array<keyof typeof files>;
  const localPaths = [...fileKeys.map((key) => files[key]), ...(nativeSessionFilePath ? [nativeSessionFilePath] : [])];
  const { entries, hostError } = await describeSessionFiles(localPaths, session, paths, context.hostAccess?.() ?? null);
  const hostSessionDir = paths.toAgent(sessionDir);

  return {
    success: true,
    data: {
      sessionId: session.id,
      agentSessionId: session.agent_session_id,
      taskId: session.task_id,
      sessionType: session.session_type,
      status: session.status,
      cwd: paths.toAgent(session.cwd),
      startedAt: session.started_at,
      exitedAt: session.exited_at,
      suspendedAt: session.suspended_at,
      sessionDir: hostSessionDir,
      location: paths.location,
      // host-value-ok: the stand-in, in the field named for it
      ...(paths.location === 'host' ? { localCwd: session.cwd, localSessionDir: sessionDir } : {}),
      ...(hostError ? { hostError } : {}),
      files: Object.fromEntries(fileKeys.map((key, index) => [key, entries[index]])),
      nativeSessionFile: nativeSessionFilePath ? entries[fileKeys.length] : null,
    },
    message: `Session ${session.id} (${session.status}) at ${hostSessionDir}`,
  };
}

interface ParsedEvent {
  raw: string;
  parsed: Record<string, unknown> | null;
  timestampMs: number | null;
  type: string | null;
}

function parseLine(line: string): ParsedEvent {
  if (!line.trim()) return { raw: line, parsed: null, timestampMs: null, type: null };
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    let timestampMs: number | null = null;
    const timestampValue = parsed.timestamp ?? parsed.ts ?? parsed.time;
    if (typeof timestampValue === 'number') {
      timestampMs = timestampValue;
    } else if (typeof timestampValue === 'string') {
      const numericTimestamp = Number(timestampValue);
      timestampMs = Number.isFinite(numericTimestamp)
        ? numericTimestamp
        : Date.parse(timestampValue) || null;
    }
    const type =
      (parsed.hook_event_name as string | undefined) ??
      (parsed.type as string | undefined) ??
      (parsed.event as string | undefined) ??
      null;
    return { raw: line, parsed, timestampMs, type };
  } catch {
    return { raw: line, parsed: null, timestampMs: null, type: null };
  }
}

export const handleGetSessionEvents: CommandHandler = async (
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> => {
  const database = context.getProjectDb();
  const resolved = resolveSession(database, params);
  if (resolved.error || !resolved.session) {
    return { success: false, error: resolved.error ?? 'Unknown error resolving session' };
  }
  const session = resolved.session;
  // host-value-ok: each file below is mapped to the host or labeled local
  const projectRoot = context.getProjectPath();
  const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', session.id);
  const eventsJsonlPath = path.join(sessionDir, 'events.jsonl');
  // This file is built on this computer from what a host relays, so it has no original an agent there could open.
  const onHost = agentPathsOf(context).location === 'host';
  const source = onHost ? 'this computer\'s record of the session (you cannot open this file from the host)' : eventsJsonlPath;
  const locationFields = { location: 'local' as const, ...(onHost ? { copy: true } : {}) };

  const eventsJsonlExists = await fs.promises.access(eventsJsonlPath).then(() => true, () => false);
  if (!eventsJsonlExists) {
    return {
      success: true,
      message: `No events.jsonl for session ${session.id}`,
      data: { sessionId: session.id, eventsJsonlPath, ...locationFields, totalLines: 0, returned: 0, events: [] },
    };
  }

  const tailRequested = typeof params.tail === 'number' ? (params.tail as number) : DEFAULT_TAIL;
  const tail = Math.max(1, Math.min(MAX_TAIL, tailRequested));
  const since = typeof params.since === 'number' ? (params.since as number) : null;
  const eventTypesArray = Array.isArray(params.eventTypes)
    ? (params.eventTypes as unknown[]).filter((value): value is string => typeof value === 'string')
    : null;
  const eventTypeFilter = eventTypesArray && eventTypesArray.length > 0 ? new Set(eventTypesArray) : null;

  // Bounded tail-read: events.jsonl grows without bound over a long session,
  // and this handler only ever returns the last `tail` events. With
  // truncation, `totalLines` counts only lines inside the scanned window and
  // the since/eventTypes filters apply within that window, so a huge file may
  // return fewer than `tail` matches - acceptable, signaled by `truncated`.
  const { content, truncated, totalBytes } = await readBoundedTail(eventsJsonlPath, MAX_EVENTS_READ_BYTES);
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;

  const matched: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed.parsed) continue;
    if (since !== null) {
      if (parsed.timestampMs === null) continue;
      if (parsed.timestampMs < since) continue;
    }
    if (eventTypeFilter && (!parsed.type || !eventTypeFilter.has(parsed.type))) continue;
    matched.push(parsed.parsed);
  }
  const tailed = matched.length > tail ? matched.slice(-tail) : matched;

  const truncationNote = truncated
    ? ` (file ${Math.round(totalBytes / 1024)}KB; scanned last ${Math.round(MAX_EVENTS_READ_BYTES / 1024)}KB)`
    : '';
  return {
    success: true,
    message: `Returned ${tailed.length} events from ${source}${truncationNote}`,
    data: {
      sessionId: session.id,
      eventsJsonlPath,
      ...locationFields,
      totalLines,
      returned: tailed.length,
      truncated,
      totalBytes,
      events: tailed,
    },
  };
};

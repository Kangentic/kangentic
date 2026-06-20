import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { TaskRepository } from '../../db/repositories/task-repository';
import { sessionOutputPaths } from '../../transition-engine/session-paths';
import { agentRegistry } from '../../agent/agent-registry';
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
}

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2000;

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
      `SELECT id, task_id, session_type, agent_session_id, cwd, status, started_at, exited_at, suspended_at
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
    `SELECT id, task_id, session_type, agent_session_id, cwd, status, started_at, exited_at, suspended_at
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

function buildSessionFiles(projectRoot: string, sessionId: string) {
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
  const filesWithExists: Record<string, { path: string; exists: boolean }> = {};
  for (const [key, filePath] of Object.entries(files)) {
    filesWithExists[key] = { path: filePath, exists: fs.existsSync(filePath) };
  }
  return { sessionDir, files: filesWithExists };
}

/**
 * Locate the agent's native session history file for a session record.
 * Returns the absolute path if found, null otherwise.
 */
async function locateNativeSessionFile(session: SessionRow): Promise<string | null> {
  if (!session.agent_session_id) return null;
  const adapter = agentRegistry.getBySessionType(session.session_type);
  if (!adapter) return null;
  return adapter.locateSessionHistoryFile(session.agent_session_id, session.cwd);
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
  const projectRoot = context.getProjectPath();
  const { sessionDir, files } = buildSessionFiles(projectRoot, session.id);

  // Locate the agent's native session file (Claude JSONL, Codex JSONL, Gemini JSON)
  const nativeSessionFilePath = await locateNativeSessionFile(session);
  const nativeSessionFile = nativeSessionFilePath
    ? { path: nativeSessionFilePath, exists: fs.existsSync(nativeSessionFilePath) }
    : null;

  return {
    success: true,
    data: {
      sessionId: session.id,
      agentSessionId: session.agent_session_id,
      taskId: session.task_id,
      sessionType: session.session_type,
      status: session.status,
      cwd: session.cwd,
      startedAt: session.started_at,
      exitedAt: session.exited_at,
      suspendedAt: session.suspended_at,
      sessionDir,
      files,
      nativeSessionFile,
    },
    message: `Session ${session.id} (${session.status}) at ${sessionDir}`,
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

export const handleGetSessionEvents: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const database = context.getProjectDb();
  const resolved = resolveSession(database, params);
  if (resolved.error || !resolved.session) {
    return { success: false, error: resolved.error ?? 'Unknown error resolving session' };
  }
  const session = resolved.session;
  const projectRoot = context.getProjectPath();
  const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', session.id);
  const eventsJsonlPath = path.join(sessionDir, 'events.jsonl');

  if (!fs.existsSync(eventsJsonlPath)) {
    return {
      success: true,
      message: `No events.jsonl for session ${session.id}`,
      data: { sessionId: session.id, eventsJsonlPath, totalLines: 0, returned: 0, events: [] },
    };
  }

  const tailRequested = typeof params.tail === 'number' ? (params.tail as number) : DEFAULT_TAIL;
  const tail = Math.max(1, Math.min(MAX_TAIL, tailRequested));
  const since = typeof params.since === 'number' ? (params.since as number) : null;
  const eventTypesArray = Array.isArray(params.eventTypes)
    ? (params.eventTypes as unknown[]).filter((value): value is string => typeof value === 'string')
    : null;
  const eventTypeFilter = eventTypesArray && eventTypesArray.length > 0 ? new Set(eventTypesArray) : null;

  const fileContents = fs.readFileSync(eventsJsonlPath, 'utf-8');
  const lines = fileContents.split(/\r?\n/);
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

  return {
    success: true,
    message: `Returned ${tailed.length} events from ${eventsJsonlPath}`,
    data: {
      sessionId: session.id,
      eventsJsonlPath,
      totalLines,
      returned: tailed.length,
      events: tailed,
    },
  };
};

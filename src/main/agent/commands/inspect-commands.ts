import { TranscriptRepository } from '../../db/repositories/transcript-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { resolveTask } from './task-resolver';
import { parseClaudeTranscript, locateClaudeTranscriptFile } from '../adapters/claude/transcript-parser';
import { parseDroidTranscript, droidTranscriptFilePath } from '../adapters/droid/transcript-parser';
import { transcriptToMarkdown } from '../../../shared/transcript-format';
import type { CommandContext, CommandResponse } from './types';
import type { SessionRecord, TranscriptEntry } from '../../../shared/types';

type TranscriptFormat = 'structured' | 'raw';

/**
 * MCP command handler: get_transcript
 *
 * Returns a session's transcript for a task's most recent (or specified)
 * session. Two formats:
 *
 * - `structured` (default): the parsed conversation - user prompts,
 *   assistant text, tool calls and results - rendered as markdown.
 *   Sourced from each agent's native session JSONL. Best for
 *   cross-agent context handoff and human review. Currently supported
 *   for Claude (`claude_agent`) and Droid (`droid_agent`); other agent
 *   types fall back to a polite "not yet supported" message.
 *
 * - `raw`: the ANSI-stripped PTY scrollback - exactly what hit the
 *   terminal, including TUI redraws. Useful for debugging the terminal
 *   layer or for inspecting agents where the structured parser isn't
 *   yet supported.
 */
export async function handleGetTranscript(
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> {
  const rawTaskId = typeof params.taskId === 'string' ? params.taskId : undefined;
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;

  // Validate format BEFORE narrowing - never cast user-supplied input
  // before checking it's in the allowed set.
  const formatParam = params.format;
  if (formatParam !== undefined && formatParam !== 'structured' && formatParam !== 'raw') {
    return { success: false, error: `Invalid format "${String(formatParam)}". Use "structured" or "raw".` };
  }
  const format: TranscriptFormat = formatParam ?? 'structured';

  if (!rawTaskId && !sessionId) {
    return { success: false, error: 'Provide either taskId or sessionId.' };
  }

  try {
    const db = context.getProjectDb();
    const sessionRepo = new SessionRepository(db);

    // Single resolution path: produce one SessionRecord that both branches
    // agree on. This avoids the prior split where structured and raw could
    // disagree about whether a session exists.
    let record: SessionRecord | undefined;
    if (rawTaskId) {
      const taskRepo = new TaskRepository(db);
      const task = resolveTask(taskRepo, rawTaskId);
      if (!task) {
        return { success: false, error: `Task not found: ${rawTaskId}` };
      }
      record = sessionRepo.getLatestForTask(task.id);
    } else if (sessionId) {
      record = sessionRepo.findByAnyId(sessionId);
    }

    if (!record) {
      return { success: true, message: 'No session found for this task.' };
    }

    const targetSessionId = record.id;

    if (format === 'structured') {
      if (!record.agent_session_id) {
        return { success: true, message: `Session ${targetSessionId.slice(0, 8)} has no agent_session_id - JSONL not yet written.` };
      }

      let filePath: string;
      let entries: TranscriptEntry[];
      if (record.session_type === 'claude_agent') {
        filePath = locateClaudeTranscriptFile(record.agent_session_id, record.cwd);
        entries = await parseClaudeTranscript(filePath);
      } else if (record.session_type === 'droid_agent') {
        filePath = droidTranscriptFilePath(record.agent_session_id, record.cwd);
        entries = await parseDroidTranscript(filePath);
      } else {
        return {
          success: true,
          message: `Structured transcripts are not yet supported for ${record.session_type}. Re-run with format="raw" to get the terminal scrollback instead.`,
        };
      }

      if (entries.length === 0) {
        return { success: true, message: `No transcript entries found at ${filePath}.` };
      }

      const markdown = transcriptToMarkdown(entries);
      const header = `Session: ${targetSessionId.slice(0, 8)}... | Format: structured | Entries: ${entries.length}`;
      return {
        success: true,
        message: `${header}\n\n${markdown}`,
        data: {
          sessionId: targetSessionId,
          format,
          entryCount: entries.length,
          filePath,
        },
      };
    }

    // format === 'raw'
    const transcriptRepo = new TranscriptRepository(db);
    const rawRecord = transcriptRepo.getBySessionId(targetSessionId);
    if (!rawRecord || !rawRecord.transcript) {
      return { success: true, message: `No raw transcript captured for session ${targetSessionId.slice(0, 8)}.` };
    }

    const sizeKb = (rawRecord.size_bytes / 1024).toFixed(1);
    const header = `Session: ${targetSessionId.slice(0, 8)}... | Format: raw | Size: ${sizeKb} KB | Updated: ${rawRecord.updated_at}`;
    return {
      success: true,
      message: `${header}\n\n${rawRecord.transcript}`,
      data: {
        sessionId: targetSessionId,
        format,
        sizeBytes: rawRecord.size_bytes,
        createdAt: rawRecord.created_at,
        updatedAt: rawRecord.updated_at,
      },
    };
  } catch (error) {
    return { success: false, error: `Failed to get transcript: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Maximum rows returned by query_db to prevent accidental large result sets. */
const MAX_QUERY_ROWS = 100;

/**
 * MCP command handler: query_db
 *
 * Runs a read-only SQL query against the current project's SQLite database.
 * Uses SQLite's PRAGMA query_only for bulletproof write protection - no regex
 * bypass is possible because the database engine itself rejects mutations.
 * Returns up to 100 rows in a formatted table.
 */
export function handleQueryDb(
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse {
  const sql = (params.sql as string | undefined)?.trim();

  if (!sql) {
    return { success: false, error: 'sql parameter is required.' };
  }

  try {
    const db = context.getProjectDb();

    // Enable query_only mode - SQLite will reject any write operations
    // at the engine level (INSERT, UPDATE, DELETE, DROP, ALTER, etc.).
    // This is safer than regex pattern matching which can be bypassed.
    // Safe to toggle on a shared connection because better-sqlite3 is
    // synchronous - no other operations can interleave.
    db.pragma('query_only = ON');
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(sql).all() as Record<string, unknown>[];
    } finally {
      // Always restore write capability for other operations
      db.pragma('query_only = OFF');
    }

    if (rows.length === 0) {
      return { success: true, message: 'Query returned 0 rows.' };
    }

    const truncated = rows.length > MAX_QUERY_ROWS;
    const displayRows = truncated ? rows.slice(0, MAX_QUERY_ROWS) : rows;
    const columns = Object.keys(displayRows[0]);

    // Format as markdown table
    const lines: string[] = [];
    lines.push(`| ${columns.join(' | ')} |`);
    lines.push(`| ${columns.map(() => '---').join(' | ')} |`);
    for (const row of displayRows) {
      const values = columns.map((column) => {
        const value = row[column];
        if (value === null) return 'NULL';
        const stringValue = String(value);
        // Truncate long values (e.g. transcript text)
        if (stringValue.length > 120) return stringValue.slice(0, 117) + '...';
        return stringValue.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      });
      lines.push(`| ${values.join(' | ')} |`);
    }

    const summary = truncated
      ? `Showing ${MAX_QUERY_ROWS} of ${rows.length} rows (truncated).`
      : `${rows.length} row(s).`;
    lines.push('');
    lines.push(summary);

    return {
      success: true,
      message: lines.join('\n'),
      data: displayRows,
    };
  } catch (error) {
    return { success: false, error: `Query failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

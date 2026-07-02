import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { getProcessMetrics } from '../../diagnostics/process-metrics';
import { enumerateWorktrees } from '../../git/worktree-list';
import type { CrashRecord, IpcLogEntry, LogEntry } from '../../../shared/types';
import { PROJECT_SELECTOR_DESCRIPTION } from './handler-helpers';
import { READ_ONLY_ANNOTATIONS } from './annotations';
import type { RequestResolver } from './project-resolver';

/**
 * Product diagnostics MCP tools. These ship in every build and let any
 * agent connected to the kangentic MCP read crashes, persistent logs,
 * process metrics, IPC traffic recordings, and worktree state.
 *
 * The dev-only `kangentic_devtools_*` tools (separate file) wrap a richer
 * inspection bridge over these same on-disk artifacts plus screenshot,
 * DOM, and UI-driving capabilities; they are excluded from production
 * builds at compile time. See `src/devtools/mcp/preview-tools.ts`.
 *
 * Every tool here is a pure read of on-disk artifacts or a synchronous
 * snapshot, so all carry `READ_ONLY_ANNOTATIONS` (see ./annotations).
 */

export function registerDiagnosticsTools(server: McpServer, resolver: RequestResolver): void {
  // --- kangentic_tail_logs ---
  server.registerTool(
    'kangentic_tail_logs',
    {
      description:
        'Read recent lines from the kangentic console log at `<projectRoot>/.kangentic/logs/<YYYY-MM-DD>.log`. Errors and warnings are always captured; info/debug are captured only when Settings → Developer → Persist Console Logs is on. Useful for diagnosing "the action didn\'t work" or following up on a console.error trace. Pass `project` to read another project\'s logs.',
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe('Log date in `YYYY-MM-DD` format. Defaults to today (UTC).'),
        since: z
          .string()
          .optional()
          .describe('Return only entries with `ts >= since` (ISO 8601). Default: no lower bound.'),
        level: z
          .enum(['error', 'warn', 'info', 'debug', 'log'])
          .optional()
          .describe('Filter by log level.'),
        source: z
          .enum(['main', 'renderer', 'preload'])
          .optional()
          .describe('Filter by log source.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe('Maximum number of entries to return. Default: 200, max: 2000.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ date, since, level, source, limit, project }) => {
      const resolved = resolver.resolveProject(project);
      if ('error' in resolved) {
        return errorResult(resolved.error);
      }
      const projectPath = resolved.context.getProjectPath();
      const targetDate = date ?? today();
      const filePath = path.join(projectPath, '.kangentic', 'logs', `${targetDate}.log`);
      const entries = readJsonLines<LogEntry>(filePath);
      const filtered = entries.filter((entry) => {
        if (since && entry.ts < since) return false;
        if (level && entry.level !== level) return false;
        if (source && entry.source !== source) return false;
        return true;
      });
      const tail = filtered.slice(-(limit ?? 200));
      if (tail.length === 0) {
        return textResult(
          `No log entries${date ? ` for ${date}` : ''}${since ? ` since ${since}` : ''} in ${filePath}.`,
          { items: [] },
        );
      }
      return textResult(tail.map(formatLogLine).join('\n'), { items: tail });
    },
  );

  // --- kangentic_get_recent_crashes ---
  server.registerTool(
    'kangentic_get_recent_crashes',
    {
      description:
        'List recent crash records from `<projectRoot>/.kangentic/logs/crashes/`. Each record contains the timestamp, kind (main-uncaught-exception, render-process-gone, preload-error, renderer-window-error, etc.), source-mapped stack, and version info captured at crash time. Always-on capture; no toggle required. Pass `project` to inspect another project\'s crashes.',
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe('Maximum number of crash records to return. Default: 10, max: 50.'),
        sinceTs: z
          .string()
          .optional()
          .describe('Return only crashes with `ts >= sinceTs` (ISO 8601). Default: no lower bound.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, sinceTs, project }) => {
      const resolved = resolver.resolveProject(project);
      if ('error' in resolved) {
        return errorResult(resolved.error);
      }
      const projectPath = resolved.context.getProjectPath();
      const directory = path.join(projectPath, '.kangentic', 'logs', 'crashes');
      let files: string[];
      try {
        files = fs.readdirSync(directory).filter((name) => name.endsWith('.json'));
      } catch {
        return textResult(`No crashes recorded${project ? ` for project ${project}` : ''}.`);
      }
      // Filenames are derived from ISO timestamps with `:` and `.` swapped to
      // `-`. Lexicographic descending sort matches reverse-chronological.
      files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      const records: CrashRecord[] = [];
      for (const name of files) {
        if (records.length >= (limit ?? 10)) break;
        try {
          const raw = fs.readFileSync(path.join(directory, name), 'utf-8');
          const record = JSON.parse(raw) as CrashRecord;
          if (sinceTs && record.ts < sinceTs) continue;
          records.push(record);
        } catch {
          // Corrupt file - skip.
        }
      }
      if (records.length === 0) {
        return textResult('No matching crashes.', { items: [] });
      }
      return textResult(JSON.stringify(records, null, 2), { items: records });
    },
  );

  // --- kangentic_get_process_metrics ---
  server.registerTool(
    'kangentic_get_process_metrics',
    {
      description:
        'Snapshot of memory + CPU usage per Electron process (main, renderer, GPU, utility, etc.) plus version + uptime info. Useful when investigating "why is kangentic slow / heavy" or filing a bug report. Reads live state from the running app; not project-scoped.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      const metrics = getProcessMetrics();
      return textResult(JSON.stringify(metrics, null, 2), metrics as unknown as Record<string, unknown>);
    },
  );

  // --- kangentic_get_ipc_log ---
  server.registerTool(
    'kangentic_get_ipc_log',
    {
      description:
        'Read recent IPC traffic from `<projectRoot>/.kangentic/logs/ipc-<YYYY-MM-DD>.jsonl`. Each entry has channel, args, result, durationMs, and (on failure) error. Inbound `ipcMain.handle` invocations (renderer -> main) leave `direction` absent; outbound `webContents.send` pushes (main -> renderer, e.g. `task:createdByAgent` board-invalidation events) set `direction: "out"` and, when the push was dropped because the window was destroyed, an `error` with name `PushDropped`. Only available when Settings → Developer → Record IPC Traffic is on. Channels carrying secrets (settings writes, MCP config, auth) are stored as `{ redacted: true, channel }`. Pass `project` to inspect another project.',
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe('Log date in `YYYY-MM-DD` format. Defaults to today (UTC).'),
        since: z
          .string()
          .optional()
          .describe('Return only entries with `ts >= since` (ISO 8601). Default: no lower bound.'),
        channel: z
          .string()
          .optional()
          .describe('Filter to a single IPC channel (e.g. `task:create`).'),
        limit: z
          .number()
          .int()
          .positive()
          .max(2000)
          .optional()
          .describe('Maximum number of entries to return. Default: 200, max: 2000.'),
        project: z.string().optional().describe(PROJECT_SELECTOR_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ date, since, channel, limit, project }) => {
      const resolved = resolver.resolveProject(project);
      if ('error' in resolved) {
        return errorResult(resolved.error);
      }
      const projectPath = resolved.context.getProjectPath();
      const targetDate = date ?? today();
      const filePath = path.join(projectPath, '.kangentic', 'logs', `ipc-${targetDate}.jsonl`);
      const entries = readJsonLines<IpcLogEntry>(filePath);
      const filtered = entries.filter((entry) => {
        if (since && entry.ts < since) return false;
        if (channel && entry.channel !== channel) return false;
        return true;
      });
      const tail = filtered.slice(-(limit ?? 200));
      if (tail.length === 0) {
        return textResult(
          `No IPC entries${date ? ` for ${date}` : ''}${channel ? ` on channel ${channel}` : ''}. Settings -> Developer -> Record IPC Traffic must be on; the recorder writes only while the toggle is enabled.`,
          { items: [] },
        );
      }
      return textResult(tail.map((entry) => JSON.stringify(entry)).join('\n'), { items: tail });
    },
  );

  // --- kangentic_list_worktrees ---
  server.registerTool(
    'kangentic_list_worktrees',
    {
      description:
        'Enumerate worktrees for one or every registered project. Each record carries path, branch, dirty flag, commits ahead/behind upstream, and last-commit timestamp. Pure read-only - useful for finding a task\'s branch, locating dirty work, or reasoning about merge state. Pass `project` to limit to one project; omit to enumerate every project.',
      inputSchema: z.object({
        project: z
          .string()
          .optional()
          .describe(
            `${PROJECT_SELECTOR_DESCRIPTION} When omitted, enumerates worktrees across every registered project.`,
          ),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ project }) => {
      let projectId: string | undefined;
      if (project) {
        const resolved = resolver.resolveProject(project);
        if ('error' in resolved) {
          return errorResult(resolved.error);
        }
        projectId = resolved.projectId;
      }
      const results = await enumerateWorktrees(projectId ? { projectId } : {});
      return textResult(JSON.stringify(results, null, 2), { items: results });
    },
  );
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function readJsonLines<T>(filePath: string): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Skip corrupt lines silently; the persistence path is best-effort
      // so partial writes can occur if the app was killed mid-flush.
    }
  }
  return out;
}

function formatLogLine(entry: LogEntry): string {
  const argsJoined = entry.args.join(' ');
  return `[${entry.ts}] [${entry.source}] [${entry.level}] ${argsJoined}`;
}

function textResult(
  text: string,
  structuredContent?: Record<string, unknown>,
): {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
} {
  return structuredContent
    ? { content: [{ type: 'text', text }], structuredContent }
    : { content: [{ type: 'text', text }] };
}

function errorResult(message: string): {
  content: { type: 'text'; text: string }[];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

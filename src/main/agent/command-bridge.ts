/**
 * CommandBridge watches a commands.jsonl file written by the MCP server process
 * and processes commands using the existing repositories. Responses are written
 * as individual JSON files that the MCP server polls for.
 *
 * This bridges the gap between the external MCP server process (spawned by
 * Claude Code) and the Electron main process (which has DB access).
 */

import fs from 'node:fs';
import path from 'node:path';
import { FileWatcher } from '../pty/file-watcher';
import { TaskRepository } from '../db/repositories/task-repository';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { SessionRepository } from '../db/repositories/session-repository';
import { BacklogRepository } from '../db/repositories/backlog-repository';
import { BACKLOG_PRIORITY_LABELS } from '../../shared/types';
import type Database from 'better-sqlite3';
import type { Task } from '../../shared/types';

interface CommandBridgeOptions {
  commandsPath: string;
  responsesDir: string;
  projectId: string;
  getProjectDb: () => Database.Database;
  onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  onTaskUpdated: (task: Task) => void;
}

interface Command {
  id: string;
  method: string;
  params: Record<string, unknown>;
  ts: number;
}

interface CommandResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

export class CommandBridge {
  private fileWatcher: FileWatcher | null = null;
  private fileOffset = 0;
  private readonly commandsPath: string;
  private readonly responsesDir: string;
  private readonly projectId: string;
  private readonly getProjectDb: () => Database.Database;
  private readonly onTaskCreated: (task: Task, columnName: string, swimlaneId: string) => void;
  private readonly onTaskUpdated: (task: Task) => void;
  private stopped = false;

  constructor(options: CommandBridgeOptions) {
    this.commandsPath = options.commandsPath;
    this.responsesDir = options.responsesDir;
    this.projectId = options.projectId;
    this.getProjectDb = options.getProjectDb;
    this.onTaskCreated = options.onTaskCreated;
    this.onTaskUpdated = options.onTaskUpdated;
  }

  start(): void {
    // Ensure directories exist
    fs.mkdirSync(path.dirname(this.commandsPath), { recursive: true });
    fs.mkdirSync(this.responsesDir, { recursive: true });

    // Truncate commands file on start (no stale commands from previous sessions)
    try {
      fs.writeFileSync(this.commandsPath, '');
    } catch {
      // File may not exist yet
    }

    this.fileWatcher = new FileWatcher({
      filePath: this.commandsPath,
      onChange: () => this.processNewCommands(),
      label: `MCP-Cmd`,
      debounceMs: 50,
      initialGracePeriodMs: 30_000,
      isStale: () => {
        try {
          const stat = fs.statSync(this.commandsPath);
          return stat.size > this.fileOffset;
        } catch {
          return false;
        }
      },
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }
  }

  private processNewCommands(): void {
    if (this.stopped) return;

    try {
      const stat = fs.statSync(this.commandsPath);
      if (stat.size <= this.fileOffset) return;

      const fd = fs.openSync(this.commandsPath, 'r');
      const buffer = Buffer.alloc(stat.size - this.fileOffset);
      fs.readSync(fd, buffer, 0, buffer.length, this.fileOffset);
      fs.closeSync(fd);
      this.fileOffset = stat.size;

      const chunk = buffer.toString('utf-8');
      const lines = chunk.split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const command: Command = JSON.parse(line);
          this.handleCommand(command);
        } catch (parseError) {
          console.error('[CommandBridge] Failed to parse command line:', parseError);
        }
      }
    } catch {
      // File may not exist yet or be partially written
    }
  }

  private handleCommand(command: Command): void {
    let response: CommandResponse;

    try {
      switch (command.method) {
        case 'create_task':
          response = this.handleCreateTask(command.params);
          break;
        case 'list_columns':
          response = this.handleListColumns();
          break;
        case 'list_tasks':
          response = this.handleListTasks(command.params);
          break;
        case 'search_tasks':
          response = this.handleSearchTasks(command.params);
          break;
        case 'get_task_stats':
          response = this.handleGetTaskStats(command.params);
          break;
        case 'find_task':
          response = this.handleFindTask(command.params);
          break;
        case 'board_summary':
          response = this.handleBoardSummary();
          break;
        case 'get_session_history':
          response = this.handleGetSessionHistory(command.params);
          break;
        case 'get_column_detail':
          response = this.handleGetColumnDetail(command.params);
          break;
        case 'update_task':
          response = this.handleUpdateTask(command.params);
          break;
        case 'list_backlog':
          response = this.handleListBacklog(command.params);
          break;
        case 'create_backlog_item':
          response = this.handleCreateBacklogItem(command.params);
          break;
        case 'search_backlog':
          response = this.handleSearchBacklog(command.params);
          break;
        case 'promote_backlog':
          response = this.handlePromoteBacklog(command.params);
          break;
        default:
          response = { success: false, error: `Unknown command: ${command.method}` };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[CommandBridge] Error handling ${command.method}:`, errorMessage);
      response = { success: false, error: errorMessage };
    }

    this.writeResponse(command.id, response);
  }

  private handleCreateTask(params: Record<string, unknown>): CommandResponse {
    const title = String(params.title ?? '').slice(0, 200);
    const description = String(params.description ?? '').slice(0, 10_000);
    const columnName = params.column as string | null;
    const branchName = params.branchName as string | null;
    const baseBranch = params.baseBranch as string | null;
    const useWorktree = params.useWorktree as boolean | null;

    if (!title.trim()) {
      return { success: false, error: 'Task title is required' };
    }

    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);

    // Resolve target column
    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    let targetSwimlane = allSwimlanes.find((swimlane) => swimlane.role === 'todo');

    if (columnName) {
      // Case-insensitive column name match
      const matched = allSwimlanes.find(
        (swimlane) => swimlane.name.toLowerCase() === columnName.toLowerCase(),
      );
      if (!matched) {
        const available = allSwimlanes.map((swimlane) => swimlane.name).join(', ');
        return {
          success: false,
          error: `Column "${columnName}" not found. Available columns: ${available}`,
        };
      }
      targetSwimlane = matched;
    }

    if (!targetSwimlane) {
      return { success: false, error: 'No To Do column found on this board' };
    }

    // Create the task with optional git configuration
    const task = taskRepo.create({
      title,
      description,
      swimlane_id: targetSwimlane.id,
      ...(baseBranch ? { baseBranch } : {}),
      ...(useWorktree !== null ? { useWorktree } : {}),
      ...(branchName ? { customBranchName: branchName } : {}),
    });

    // Notify the main process (for board refresh + toast + auto_spawn)
    this.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);

    return {
      success: true,
      data: { taskId: task.id, title: task.title, column: targetSwimlane.name },
      message: `Created task "${task.title}" in ${targetSwimlane.name} column (id: ${task.id})`,
    };
  }

  private handleListColumns(): CommandResponse {
    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);

    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    const columns = allSwimlanes.map((swimlane) => ({
      name: swimlane.name,
      role: swimlane.role,
      taskCount: taskRepo.list(swimlane.id).length,
    }));

    return { success: true, data: columns };
  }

  private handleListTasks(params: Record<string, unknown>): CommandResponse {
    const columnName = params.column as string | null;

    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);

    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);

    let targetSwimlanes = allSwimlanes;
    if (columnName) {
      const matched = allSwimlanes.find(
        (swimlane) => swimlane.name.toLowerCase() === columnName.toLowerCase(),
      );
      if (!matched) {
        const available = allSwimlanes.map((swimlane) => swimlane.name).join(', ');
        return {
          success: false,
          error: `Column "${columnName}" not found. Available columns: ${available}`,
        };
      }
      targetSwimlanes = [matched];
    }

    const tasks: Array<{ id: string; title: string; description: string; column: string }> = [];
    for (const swimlane of targetSwimlanes) {
      const swimlaneTasks = taskRepo.list(swimlane.id);
      for (const task of swimlaneTasks) {
        tasks.push({
          id: task.id,
          title: task.title,
          description: task.description,
          column: swimlane.name,
        });
      }
    }

    return { success: true, data: tasks };
  }

  private handleSearchTasks(params: Record<string, unknown>): CommandResponse {
    const query = String(params.query ?? '').toLowerCase();
    const statusFilter = (params.status as string) || 'all';

    if (!query.trim()) {
      return { success: false, error: 'Search query is required' };
    }

    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);

    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

    const matchesQuery = (task: Task) =>
      task.title.toLowerCase().includes(query) ||
      task.description.toLowerCase().includes(query);

    const results: Array<{ id: string; title: string; description: string; column: string; status: string }> = [];
    let totalActive = 0;
    let totalCompleted = 0;

    // Search active tasks
    if (statusFilter === 'active' || statusFilter === 'all') {
      for (const swimlane of allSwimlanes) {
        const swimlaneTasks = taskRepo.list(swimlane.id);
        for (const task of swimlaneTasks) {
          if (matchesQuery(task)) {
            totalActive++;
            results.push({
              id: task.id,
              title: task.title,
              description: task.description,
              column: swimlaneMap.get(task.swimlane_id) ?? 'Unknown',
              status: 'active',
            });
          }
        }
      }
    }

    // Search archived/completed tasks
    if (statusFilter === 'completed' || statusFilter === 'all') {
      const archivedTasks = taskRepo.listArchived();
      for (const task of archivedTasks) {
        if (matchesQuery(task)) {
          totalCompleted++;
          results.push({
            id: task.id,
            title: task.title,
            description: task.description,
            column: 'Done',
            status: 'completed',
          });
        }
      }
    }

    return {
      success: true,
      data: { tasks: results, totalActive, totalCompleted },
    };
  }

  private handleGetTaskStats(params: Record<string, unknown>): CommandResponse {
    const taskId = params.taskId as string | null;
    const query = (params.query as string | null)?.toLowerCase() ?? null;
    const sortBy = (params.sortBy as string) || 'tokens';

    const db = this.getProjectDb();
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);

    // Single task stats
    if (taskId) {
      const task = taskRepo.getById(taskId);
      if (!task) {
        return { success: false, error: `Task "${taskId}" not found` };
      }

      const summary = sessionRepo.getSummaryForTask(taskId);
      if (!summary) {
        return {
          success: true,
          message: `No session metrics available for "${task.title}".`,
          data: null,
        };
      }

      return {
        success: true,
        message: [
          `Stats for "${task.title}":`,
          `  Tokens: ${summary.totalInputTokens.toLocaleString()} input + ${summary.totalOutputTokens.toLocaleString()} output = ${(summary.totalInputTokens + summary.totalOutputTokens).toLocaleString()} total`,
          `  Cost: $${summary.totalCostUsd.toFixed(4)}`,
          `  Duration: ${Math.round(summary.durationMs / 1000)}s`,
          `  Tool calls: ${summary.toolCallCount}`,
          `  Lines: +${summary.linesAdded} / -${summary.linesRemoved} across ${summary.filesChanged} file(s)`,
          `  Model: ${summary.modelDisplayName}`,
        ].join('\n'),
        data: summary,
      };
    }

    // Aggregate stats across completed tasks (optionally filtered by query)
    const archivedTasks = taskRepo.listArchived();
    const allSummaries = sessionRepo.listAllSummaries();

    // Also include active tasks that have summaries
    const swimlaneRepo = new SwimlaneRepository(db);
    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    const activeTasks: Task[] = [];
    for (const swimlane of allSwimlanes) {
      activeTasks.push(...taskRepo.list(swimlane.id));
    }

    const allTasks = [...archivedTasks, ...activeTasks];
    const matchesQuery = (task: Task) =>
      !query ||
      task.title.toLowerCase().includes(query) ||
      task.description.toLowerCase().includes(query);

    const taskStats: Array<{
      title: string;
      status: string;
      totalTokens: number;
      cost: number;
      duration: number;
      toolCalls: number;
      linesChanged: number;
    }> = [];

    let totalTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;
    let totalToolCalls = 0;

    for (const task of allTasks) {
      if (!matchesQuery(task)) continue;
      const summary = allSummaries[task.id];
      if (!summary) continue;

      const tokens = summary.totalInputTokens + summary.totalOutputTokens;
      const isCompleted = task.archived_at !== null;

      taskStats.push({
        title: task.title,
        status: isCompleted ? 'completed' : 'active',
        totalTokens: tokens,
        cost: summary.totalCostUsd,
        duration: summary.durationMs,
        toolCalls: summary.toolCallCount,
        linesChanged: summary.linesAdded + summary.linesRemoved,
      });

      totalTokens += tokens;
      totalCost += summary.totalCostUsd;
      totalDuration += summary.durationMs;
      totalToolCalls += summary.toolCallCount;
    }

    // Sort by requested metric (descending)
    const sortKeys: Record<string, (item: typeof taskStats[0]) => number> = {
      tokens: (item) => item.totalTokens,
      cost: (item) => item.cost,
      duration: (item) => item.duration,
      toolCalls: (item) => item.toolCalls,
      linesChanged: (item) => item.linesChanged,
    };
    const sortFn = sortKeys[sortBy] ?? sortKeys.tokens;
    taskStats.sort((a, b) => sortFn(b) - sortFn(a));

    if (taskStats.length === 0) {
      const filterNote = query ? ` matching "${query}"` : '';
      return {
        success: true,
        message: `No tasks with session metrics found${filterNote}.`,
        data: { tasks: [], totals: null },
      };
    }

    const filterNote = query ? ` matching "${query}"` : '';
    const lines = [
      `${taskStats.length} task(s)${filterNote} with metrics (sorted by ${sortBy}):`,
      '',
    ];
    for (const stat of taskStats.slice(0, 20)) {
      const statusTag = stat.status === 'completed' ? '[done]' : '[active]';
      lines.push(
        `- ${stat.title} ${statusTag}: ${stat.totalTokens.toLocaleString()} tokens, $${stat.cost.toFixed(4)}, ${Math.round(stat.duration / 1000)}s, ${stat.toolCalls} tool calls, ${stat.linesChanged} lines changed`,
      );
    }
    if (taskStats.length > 20) {
      lines.push(`  ... and ${taskStats.length - 20} more`);
    }
    lines.push('');
    lines.push(`Totals: ${totalTokens.toLocaleString()} tokens, $${totalCost.toFixed(4)}, ${Math.round(totalDuration / 1000)}s, ${totalToolCalls} tool calls`);

    return {
      success: true,
      message: lines.join('\n'),
      data: { tasks: taskStats, totals: { totalTokens, totalCost, totalDuration, totalToolCalls } },
    };
  }

  private handleFindTask(params: Record<string, unknown>): CommandResponse {
    const branch = params.branch as string | null;
    const titleQuery = (params.title as string | null)?.toLowerCase() ?? null;
    const prNumber = params.prNumber as number | null;

    const db = this.getProjectDb();
    const taskRepo = new TaskRepository(db);
    const swimlaneRepo = new SwimlaneRepository(db);

    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

    // Collect all tasks (active + archived)
    const activeTasks: Task[] = [];
    for (const swimlane of allSwimlanes) {
      activeTasks.push(...taskRepo.list(swimlane.id));
    }
    const archivedTasks = taskRepo.listArchived();
    const allTasks = [...activeTasks, ...archivedTasks];

    const matches = allTasks.filter((task) => {
      if (branch) {
        const branchLower = branch.toLowerCase();
        if (task.branch_name?.toLowerCase().includes(branchLower)) return true;
      }
      if (titleQuery) {
        if (task.title.toLowerCase().includes(titleQuery)) return true;
      }
      if (prNumber !== null) {
        if (task.pr_number === prNumber) return true;
      }
      return false;
    });

    if (matches.length === 0) {
      const criteria: string[] = [];
      if (branch) criteria.push(`branch "${branch}"`);
      if (titleQuery) criteria.push(`title "${titleQuery}"`);
      if (prNumber !== null) criteria.push(`PR #${prNumber}`);
      return {
        success: true,
        message: `No tasks found matching ${criteria.join(' or ')}.`,
        data: [],
      };
    }

    const lines = matches.map((task) => {
      const isArchived = task.archived_at !== null;
      const column = isArchived ? 'Done' : (swimlaneMap.get(task.swimlane_id) ?? 'Unknown');
      const parts = [`"${task.title}" [${column}]`];
      if (task.branch_name) parts.push(`branch: ${task.branch_name}`);
      if (task.base_branch) parts.push(`base: ${task.base_branch}`);
      if (task.worktree_path) parts.push(`worktree: ${task.worktree_path}`);
      if (task.pr_url) parts.push(`PR: ${task.pr_url}`);
      else if (task.pr_number) parts.push(`PR #${task.pr_number}`);
      parts.push(`id: ${task.id}`);
      return `- ${parts.join(' | ')}`;
    });

    return {
      success: true,
      message: `Found ${matches.length} task(s):\n${lines.join('\n')}`,
      data: matches.map((task) => ({
        id: task.id,
        title: task.title,
        description: task.description,
        column: task.archived_at ? 'Done' : (swimlaneMap.get(task.swimlane_id) ?? 'Unknown'),
        branchName: task.branch_name,
        baseBranch: task.base_branch,
        worktreePath: task.worktree_path,
        prNumber: task.pr_number,
        prUrl: task.pr_url,
        useWorktree: task.use_worktree,
        status: task.archived_at ? 'completed' : 'active',
      })),
    };
  }

  private handleBoardSummary(): CommandResponse {
    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);
    const sessionRepo = new SessionRepository(db);
    const backlogRepo = new BacklogRepository(db);

    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    const archivedTasks = taskRepo.listArchived();
    const allSummaries = sessionRepo.listAllSummaries();
    const backlogItems = backlogRepo.list();

    let totalActiveTasks = 0;
    let activeSessions = 0;
    const columnLines: string[] = [];
    const columnData: Array<{ name: string; role: string | null; taskCount: number }> = [];

    for (const swimlane of allSwimlanes) {
      const tasks = taskRepo.list(swimlane.id);
      totalActiveTasks += tasks.length;
      const sessionsInColumn = tasks.filter((task) => task.session_id !== null).length;
      activeSessions += sessionsInColumn;
      const sessionNote = sessionsInColumn > 0 ? ` (${sessionsInColumn} active session${sessionsInColumn > 1 ? 's' : ''})` : '';
      columnLines.push(`  ${swimlane.name}: ${tasks.length} task(s)${sessionNote}`);
      columnData.push({ name: swimlane.name, role: swimlane.role, taskCount: tasks.length });
    }

    // Aggregate metrics across all sessions
    let totalCost = 0;
    let totalTokens = 0;
    let totalDuration = 0;
    let tasksWithMetrics = 0;

    for (const summary of Object.values(allSummaries)) {
      totalCost += summary.totalCostUsd;
      totalTokens += summary.totalInputTokens + summary.totalOutputTokens;
      totalDuration += summary.durationMs;
      tasksWithMetrics++;
    }

    const lines = [
      `Board Summary:`,
      ``,
      `Columns:`,
      ...columnLines,
      ``,
      `Active tasks: ${totalActiveTasks}`,
      `Backlog items: ${backlogItems.length}`,
      `Completed tasks: ${archivedTasks.length}`,
      `Active sessions: ${activeSessions}`,
      ``,
      `Cumulative metrics (${tasksWithMetrics} task${tasksWithMetrics !== 1 ? 's' : ''} with data):`,
      `  Total cost: $${totalCost.toFixed(4)}`,
      `  Total tokens: ${totalTokens.toLocaleString()}`,
      `  Total duration: ${Math.round(totalDuration / 1000)}s`,
    ];

    return {
      success: true,
      message: lines.join('\n'),
      data: {
        columns: columnData,
        totalActiveTasks,
        backlogItems: backlogItems.length,
        completedTasks: archivedTasks.length,
        activeSessions,
        totalCost,
        totalTokens,
        totalDuration,
      },
    };
  }

  private handleGetSessionHistory(params: Record<string, unknown>): CommandResponse {
    const taskId = params.taskId as string;
    if (!taskId) {
      return { success: false, error: 'taskId is required' };
    }

    const db = this.getProjectDb();
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.getById(taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found` };
    }

    const records = db.prepare(
      `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC`
    ).all(taskId) as Array<{
      id: string;
      session_type: string;
      claude_session_id: string | null;
      status: string;
      exit_code: number | null;
      started_at: string;
      suspended_at: string | null;
      exited_at: string | null;
      suspended_by: string | null;
      permission_mode: string | null;
      total_cost_usd: number | null;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      total_duration_ms: number | null;
      tool_call_count: number | null;
    }>;

    if (records.length === 0) {
      return {
        success: true,
        message: `No session history for "${task.title}".`,
        data: [],
      };
    }

    const lines = [`Session history for "${task.title}" (${records.length} session${records.length !== 1 ? 's' : ''}):\n`];

    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const endTime = record.exited_at ?? record.suspended_at ?? 'still running';
      const parts = [
        `#${index + 1}: ${record.status}`,
        `started: ${record.started_at}`,
        `ended: ${endTime}`,
      ];
      if (record.exit_code !== null) parts.push(`exit code: ${record.exit_code}`);
      if (record.suspended_by) parts.push(`suspended by: ${record.suspended_by}`);
      if (record.permission_mode) parts.push(`permissions: ${record.permission_mode}`);
      if (record.total_cost_usd !== null) parts.push(`cost: $${record.total_cost_usd.toFixed(4)}`);
      if (record.total_input_tokens !== null && record.total_output_tokens !== null) {
        parts.push(`tokens: ${(record.total_input_tokens + record.total_output_tokens).toLocaleString()}`);
      }
      if (record.tool_call_count !== null) parts.push(`tool calls: ${record.tool_call_count}`);
      if (record.total_duration_ms !== null) parts.push(`duration: ${Math.round(record.total_duration_ms / 1000)}s`);
      lines.push(`  ${parts.join(' | ')}`);
    }

    return {
      success: true,
      message: lines.join('\n'),
      data: records.map((record) => ({
        id: record.id,
        sessionType: record.session_type,
        status: record.status,
        exitCode: record.exit_code,
        startedAt: record.started_at,
        endedAt: record.exited_at ?? record.suspended_at,
        suspendedBy: record.suspended_by,
        permissionMode: record.permission_mode,
        cost: record.total_cost_usd,
        tokens: record.total_input_tokens !== null && record.total_output_tokens !== null
          ? record.total_input_tokens + record.total_output_tokens
          : null,
        toolCalls: record.tool_call_count,
        durationMs: record.total_duration_ms,
      })),
    };
  }

  private handleGetColumnDetail(params: Record<string, unknown>): CommandResponse {
    const columnName = params.column as string;
    if (!columnName) {
      return { success: false, error: 'column name is required' };
    }

    const db = this.getProjectDb();
    const swimlaneRepo = new SwimlaneRepository(db);
    const taskRepo = new TaskRepository(db);

    const allSwimlanes = swimlaneRepo.list();
    const matched = allSwimlanes.find(
      (swimlane) => swimlane.name.toLowerCase() === columnName.toLowerCase(),
    );

    if (!matched) {
      const available = allSwimlanes.filter((swimlane) => !swimlane.is_archived).map((swimlane) => swimlane.name).join(', ');
      return { success: false, error: `Column "${columnName}" not found. Available: ${available}` };
    }

    const tasks = matched.is_archived ? [] : taskRepo.list(matched.id);

    // Resolve plan exit target name
    let planExitTargetName: string | null = null;
    if (matched.plan_exit_target_id) {
      const target = swimlaneRepo.getById(matched.plan_exit_target_id);
      planExitTargetName = target?.name ?? null;
    }

    const lines = [
      `Column: ${matched.name}`,
      `  Role: ${matched.role ?? 'custom'}`,
      `  Tasks: ${tasks.length}`,
      `  Auto-spawn: ${matched.auto_spawn ? 'yes' : 'no'}`,
      `  Permission mode: ${matched.permission_mode ?? 'default (inherited)'}`,
    ];
    if (matched.auto_command) lines.push(`  Auto-command: ${matched.auto_command}`);
    if (planExitTargetName) lines.push(`  Plan exit target: ${planExitTargetName}`);
    if (matched.is_archived) lines.push(`  Status: archived`);
    if (matched.is_ghost) lines.push(`  Status: ghost (removed from config but has tasks)`);
    lines.push(`  Color: ${matched.color}`);
    if (matched.icon) lines.push(`  Icon: ${matched.icon}`);

    return {
      success: true,
      message: lines.join('\n'),
      data: {
        id: matched.id,
        name: matched.name,
        role: matched.role,
        taskCount: tasks.length,
        autoSpawn: matched.auto_spawn,
        permissionMode: matched.permission_mode,
        autoCommand: matched.auto_command,
        planExitTarget: planExitTargetName,
        color: matched.color,
        icon: matched.icon,
        isArchived: matched.is_archived,
        isGhost: matched.is_ghost,
      },
    };
  }

  private handleUpdateTask(params: Record<string, unknown>): CommandResponse {
    const taskId = params.taskId as string;
    const newTitle = params.title as string | null;
    const newDescription = params.description as string | null;
    const newPrUrl = params.prUrl as string | null;
    const newPrNumber = params.prNumber as number | null;

    if (!taskId) {
      return { success: false, error: 'taskId is required' };
    }

    const db = this.getProjectDb();
    const taskRepo = new TaskRepository(db);
    const task = taskRepo.getById(taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found` };
    }

    const updates: Record<string, unknown> = { id: taskId };
    if (newTitle !== null) updates.title = String(newTitle).slice(0, 200);
    if (newDescription !== null) updates.description = String(newDescription).slice(0, 10_000);
    if (newPrUrl !== null) updates.pr_url = String(newPrUrl);
    if (newPrNumber !== null) updates.pr_number = Number(newPrNumber);

    const updated = taskRepo.update(updates as { id: string; title?: string; description?: string; pr_url?: string; pr_number?: number });

    // Notify the main process so the board refreshes
    this.onTaskUpdated(updated);

    const changedFields: string[] = [];
    if (newTitle !== null) changedFields.push('title');
    if (newDescription !== null) changedFields.push('description');
    if (newPrUrl !== null) changedFields.push('prUrl');
    if (newPrNumber !== null) changedFields.push('prNumber');

    return {
      success: true,
      message: `Updated ${changedFields.join(' and ')} for "${updated.title}".`,
      data: { id: updated.id, title: updated.title, description: updated.description, prUrl: updated.pr_url, prNumber: updated.pr_number },
    };
  }

  private handleListBacklog(params: Record<string, unknown>): CommandResponse {
    const priorityFilter = params.priority as number | null;
    const query = (params.query as string | null)?.toLowerCase() ?? null;

    const db = this.getProjectDb();
    const backlogRepo = new BacklogRepository(db);

    let items = backlogRepo.list();

    if (priorityFilter !== null && priorityFilter !== undefined) {
      items = items.filter((item) => item.priority === priorityFilter);
    }
    if (query) {
      items = items.filter(
        (item) =>
          item.title.toLowerCase().includes(query) ||
          item.description.toLowerCase().includes(query) ||
          item.labels.some((label) => label.toLowerCase().includes(query)),
      );
    }

    if (items.length === 0) {
      const filterNote = query ? ` matching "${query}"` : '';
      return { success: true, message: `No backlog items found${filterNote}.`, data: [] };
    }

    const lines = items.map((item) => {
      const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
      const labelStr = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
      return `- ${item.title} (${priorityLabel})${labelStr} (id: ${item.id})`;
    });

    return {
      success: true,
      message: `${items.length} backlog item(s):\n${lines.join('\n')}`,
      data: items.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        priorityLabel: BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None',
        labels: item.labels,
        createdAt: item.created_at,
      })),
    };
  }

  private handleCreateBacklogItem(params: Record<string, unknown>): CommandResponse {
    const title = String(params.title ?? '').slice(0, 200);
    const description = String(params.description ?? '').slice(0, 10_000);
    const priority = (params.priority as number) ?? 0;
    const labels = (params.labels as string[]) ?? [];

    if (!title.trim()) {
      return { success: false, error: 'Title is required' };
    }

    if (priority < 0 || priority > 4) {
      return { success: false, error: 'Priority must be 0-4 (0=none, 1=low, 2=medium, 3=high, 4=urgent)' };
    }

    const db = this.getProjectDb();
    const backlogRepo = new BacklogRepository(db);

    const item = backlogRepo.create({
      title,
      description,
      priority: priority,
      labels,
    });

    const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
    return {
      success: true,
      data: { id: item.id, title: item.title, priority: priorityLabel, labels: item.labels },
      message: `Created backlog item "${item.title}" (priority: ${priorityLabel}, id: ${item.id})`,
    };
  }

  private handleSearchBacklog(params: Record<string, unknown>): CommandResponse {
    const query = String(params.query ?? '').toLowerCase();

    if (!query.trim()) {
      return { success: false, error: 'Search query is required' };
    }

    const db = this.getProjectDb();
    const backlogRepo = new BacklogRepository(db);
    const allItems = backlogRepo.list();

    const matches = allItems.filter(
      (item) =>
        item.title.toLowerCase().includes(query) ||
        item.description.toLowerCase().includes(query) ||
        item.labels.some((label) => label.toLowerCase().includes(query)),
    );

    if (matches.length === 0) {
      return { success: true, message: `No backlog items matching "${query}" found.`, data: [] };
    }

    const lines = matches.map((item) => {
      const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
      const labelStr = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
      const descriptionPreview = item.description
        ? ` - ${item.description.slice(0, 100)}${item.description.length > 100 ? '...' : ''}`
        : '';
      return `- ${item.title} (${priorityLabel})${labelStr}${descriptionPreview} (id: ${item.id})`;
    });

    return {
      success: true,
      message: `Found ${matches.length} backlog item(s) matching "${query}":\n${lines.join('\n')}`,
      data: matches.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        priorityLabel: BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None',
        labels: item.labels,
      })),
    };
  }

  private handlePromoteBacklog(params: Record<string, unknown>): CommandResponse {
    const itemIds = params.itemIds as string[];
    const columnName = params.column as string | null;

    if (!itemIds || itemIds.length === 0) {
      return { success: false, error: 'At least one backlog item ID is required' };
    }

    const db = this.getProjectDb();
    const backlogRepo = new BacklogRepository(db);
    const taskRepo = new TaskRepository(db);
    const swimlaneRepo = new SwimlaneRepository(db);

    // Resolve target column
    const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
    let targetSwimlane = allSwimlanes.find((swimlane) => swimlane.role === 'todo');

    if (columnName) {
      const matched = allSwimlanes.find(
        (swimlane) => swimlane.name.toLowerCase() === columnName.toLowerCase(),
      );
      if (!matched) {
        const available = allSwimlanes.map((swimlane) => swimlane.name).join(', ');
        return { success: false, error: `Column "${columnName}" not found. Available: ${available}` };
      }
      targetSwimlane = matched;
    }

    if (!targetSwimlane) {
      return { success: false, error: 'No target column found on this board' };
    }

    const promoted: Array<{ taskId: string; title: string }> = [];
    const notFound: string[] = [];

    for (const itemId of itemIds) {
      const item = backlogRepo.getById(itemId);
      if (!item) {
        notFound.push(itemId);
        continue;
      }

      const task = taskRepo.create({
        title: item.title,
        description: item.description,
        swimlane_id: targetSwimlane.id,
      });

      backlogRepo.delete(itemId);
      promoted.push({ taskId: task.id, title: task.title });

      // Notify main process for board refresh
      this.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);
    }

    if (promoted.length === 0) {
      return { success: false, error: `No backlog items found for the provided IDs` };
    }

    const lines = promoted.map((item) => `- "${item.title}" (task id: ${item.taskId})`);
    let message = `Moved ${promoted.length} item(s) to ${targetSwimlane.name}:\n${lines.join('\n')}`;
    if (notFound.length > 0) {
      message += `\n\nNot found: ${notFound.join(', ')}`;
    }

    return {
      success: true,
      message,
      data: { promoted, targetColumn: targetSwimlane.name, notFound },
    };
  }

  private writeResponse(requestId: string, response: CommandResponse): void {
    try {
      const responsePath = path.join(this.responsesDir, `${requestId}.json`);
      fs.writeFileSync(responsePath, JSON.stringify(response));
    } catch (error) {
      console.error(`[CommandBridge] Failed to write response for ${requestId}:`, error);
    }
  }
}

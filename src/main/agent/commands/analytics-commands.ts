import { TaskRepository } from '../../db/repositories/task-repository';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { listActiveSwimlanes } from './column-resolver';
import { resolveTask } from './task-resolver';
import type { Task } from '../../../shared/types';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleGetTaskStats: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string | null;
  const query = (params.query as string | null)?.toLowerCase() ?? null;
  const sortBy = (params.sortBy as string) || 'tokens';

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);

  // Single task stats
  if (taskId) {
    const task = resolveTask(taskRepo, taskId);
    if (!task) {
      return { success: false, error: `Task "${taskId}" not found` };
    }

    const summary = sessionRepo.getSummaryForTask(task.id);
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

  const allSwimlanes = listActiveSwimlanes(db);
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
  const sortKeys: Record<string, (item: (typeof taskStats)[0]) => number> = {
    tokens: (item) => item.totalTokens,
    cost: (item) => item.cost,
    duration: (item) => item.duration,
    toolCalls: (item) => item.toolCalls,
    linesChanged: (item) => item.linesChanged,
  };
  const sortFunction = sortKeys[sortBy] ?? sortKeys.tokens;
  taskStats.sort((a, b) => sortFunction(b) - sortFunction(a));

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
};

export const handleBoardSummary: CommandHandler = (
  _params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const db = context.getProjectDb();
  const swimlaneRepo = new SwimlaneRepository(db);
  const taskRepo = new TaskRepository(db);
  const sessionRepo = new SessionRepository(db);
  const backlogRepo = new BacklogRepository(db);

  const allSwimlanes = swimlaneRepo.list().filter((swimlane) => !swimlane.is_archived);
  const archivedTasks = taskRepo.listArchived();
  const allSummaries = sessionRepo.listAllSummaries();
  const backlogTasks = backlogRepo.list();

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
    `Backlog tasks: ${backlogTasks.length}`,
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
      backlogTasks: backlogTasks.length,
      completedTasks: archivedTasks.length,
      activeSessions,
      totalCost,
      totalTokens,
      totalDuration,
    },
  };
};

export const handleGetSessionHistory: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const taskId = params.taskId as string;
  if (!taskId) {
    return { success: false, error: 'taskId is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const task = resolveTask(taskRepo, taskId);
  if (!task) {
    return { success: false, error: `Task "${taskId}" not found` };
  }

  const records = db.prepare(
    `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC`
  ).all(task.id) as Array<{
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
};

export const handleGetColumnDetail: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string;
  if (!columnName) {
    return { success: false, error: 'column name is required' };
  }

  const db = context.getProjectDb();
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
};

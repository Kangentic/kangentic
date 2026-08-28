import path from 'node:path';
import { TaskRepository } from '../../db/repositories/task-repository';
import { sessionOutputPaths } from '../../transition-engine/session-paths';
import { SessionRepository } from '../../db/repositories/session-repository';
import { SwimlaneRepository } from '../../db/repositories/swimlane-repository';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { agentRegistry } from '../../agent/agent-registry';
import { listActiveSwimlanes } from './column-resolver';
import { readBoundedTail } from './bounded-tail-read';
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
        `  Sessions compacted: ${summary.compactionCount}`,
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

/**
 * How many labels the board summary spells out before collapsing the tail
 * into a "... and N more" line. A mature board accumulates a long tail of
 * one-off labels; the head is what a caller needs to stay consistent with the
 * vocabulary, and printing all of it would swamp the rest of the summary.
 */
const BOARD_SUMMARY_LABEL_LIMIT = 30;

/** Soft wrap width for the label list, so a wide vocabulary stays readable. */
const BOARD_SUMMARY_LABEL_WRAP_COLUMNS = 96;

/**
 * Tally label usage across every item that can carry one: active board tasks,
 * archived (Done) tasks, and backlog items. Archived tasks are deliberately
 * included - on a mature board most of the vocabulary lives in Done, so an
 * active-only tally would report a vocabulary that barely exists.
 *
 * `occurrences` counts label USES (a task with three labels contributes to
 * three of them), while `labelledItems` counts items carrying at least one
 * label, so the two figures the summary prints reconcile for a caller that
 * adds them up.
 */
export function tallyLabelUsage(
  itemLabelLists: Array<readonly string[] | null | undefined>,
): { counts: Map<string, number>; labelledItems: number } {
  const counts = new Map<string, number>();
  let labelledItems = 0;
  for (const labels of itemLabelLists) {
    if (!labels || labels.length === 0) continue;
    labelledItems++;
    for (const label of labels) {
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
  }
  return { counts, labelledItems };
}

/**
 * Order label entries most-used first, ties broken alphabetically. The tie
 * break compares codepoints rather than calling `localeCompare`: ICU collation
 * is not guaranteed identical between a developer's machine and CI, and this
 * is machine-facing MCP output whose order the tests pin, so a locale-
 * dependent comparator could sort two equally-used labels differently per
 * platform.
 *
 * Shared by the printed block and the structured `data.labels` array so the
 * two orderings cannot drift.
 */
function sortLabelEntries(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0),
  );
}

/**
 * Render the label vocabulary block for the board summary: most-used first,
 * ties broken alphabetically so the output is stable across calls.
 */
export function formatLabelVocabulary(
  counts: Map<string, number>,
  labelledItems: number,
): string[] {
  if (counts.size === 0) {
    return ['Labels in use: none yet.'];
  }
  const ordered = sortLabelEntries(counts);
  const shown = ordered.slice(0, BOARD_SUMMARY_LABEL_LIMIT);
  const lines = [
    `Labels in use (${counts.size} distinct, ${labelledItems} labelled item${labelledItems === 1 ? '' : 's'}):`,
  ];
  let currentLine = '';
  for (let index = 0; index < shown.length; index++) {
    const [name, count] = shown[index];
    const entry = `${name} (${count})${index < shown.length - 1 ? ',' : ''}`;
    if (currentLine && `${currentLine} ${entry}`.length > BOARD_SUMMARY_LABEL_WRAP_COLUMNS) {
      lines.push(`  ${currentLine}`);
      currentLine = entry;
    } else {
      currentLine = currentLine ? `${currentLine} ${entry}` : entry;
    }
  }
  if (currentLine) lines.push(`  ${currentLine}`);
  if (ordered.length > shown.length) {
    lines.push(`  ... and ${ordered.length - shown.length} more`);
  }
  return lines;
}

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
  // Every label-bearing item on the board, gathered as we already walk each
  // source for its counts. No extra query and no new repository method.
  const labelLists: Array<readonly string[] | null | undefined> = [
    ...archivedTasks.map((task) => task.labels),
    ...backlogTasks.map((item) => item.labels),
  ];

  for (const swimlane of allSwimlanes) {
    const tasks = taskRepo.list(swimlane.id);
    for (const task of tasks) labelLists.push(task.labels);
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

  const { counts: labelCounts, labelledItems } = tallyLabelUsage(labelLists);

  const lines = [
    `Board Summary:`,
    ``,
    `Columns:`,
    ...columnLines,
    ``,
    ...formatLabelVocabulary(labelCounts, labelledItems),
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
      labels: sortLabelEntries(labelCounts).map(([name, count]) => ({ name, count })),
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

/**
 * List all session records for a task with metadata (times, costs, status).
 * Renamed from get_session_history to avoid confusion with the native
 * session file content returned by handleGetSessionHistory.
 */
export const handleListSessions: CommandHandler = (
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

  const projectRoot = context.getProjectPath();
  const records = db.prepare(
    `SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at ASC`
  ).all(task.id) as Array<{
    id: string;
    session_type: string;
    agent_session_id: string | null;
    cwd: string;
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
      message: `No sessions for "${task.title}".`,
      data: [],
    };
  }

  const lines = [`Sessions for "${task.title}" (${records.length} session${records.length !== 1 ? 's' : ''}):\n`];

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
      agentSessionId: record.agent_session_id,
      cwd: record.cwd,
      eventsJsonlPath: sessionOutputPaths(
        path.join(projectRoot, '.kangentic', 'sessions', record.id),
      ).eventsOutputPath,
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

const MAX_SESSION_HISTORY_BYTES = 200_000;

/**
 * Locate and read the agent's native session history file for a task.
 * Returns the raw file content (JSONL for Claude/Codex, JSON for Gemini),
 * truncated to the most recent portion if the file is very large.
 */
export async function handleGetSessionHistory(
  params: Record<string, unknown>,
  context: CommandContext,
): Promise<CommandResponse> {
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

  // Find the latest session with an agent_session_id
  const record = db.prepare(
    `SELECT id, session_type, agent_session_id, cwd FROM sessions
     WHERE task_id = ? AND agent_session_id IS NOT NULL
     ORDER BY started_at DESC LIMIT 1`
  ).get(task.id) as {
    id: string;
    session_type: string;
    agent_session_id: string;
    cwd: string;
  } | undefined;

  if (!record) {
    return { success: true, message: `No session with a captured agent session ID for "${task.title}".` };
  }

  const adapter = agentRegistry.getBySessionType(record.session_type);
  if (!adapter) {
    return { success: false, error: `No adapter registered for session type "${record.session_type}"` };
  }

  const filePath = await adapter.locateSessionHistoryFile(record.agent_session_id, record.cwd);
  if (!filePath) {
    return {
      success: true,
      message: `Could not locate the native session file for ${adapter.displayName} session ${record.agent_session_id.slice(0, 8)}.`,
      data: { agentSessionId: record.agent_session_id, agent: adapter.name, filePath: null },
    };
  }

  // Read the file, truncating from the beginning if too large
  let content: string;
  try {
    const tailResult = readBoundedTail(filePath, MAX_SESSION_HISTORY_BYTES);
    content = tailResult.truncated
      ? `[Truncated - showing last ${Math.round(MAX_SESSION_HISTORY_BYTES / 1024)}KB of ${Math.round(tailResult.totalBytes / 1024)}KB]\n${tailResult.content}`
      : tailResult.content;
  } catch (readError) {
    return { success: false, error: `Failed to read session file at ${filePath}: ${readError instanceof Error ? readError.message : String(readError)}` };
  }

  return {
    success: true,
    message: content,
    data: {
      agentSessionId: record.agent_session_id,
      agent: adapter.name,
      filePath,
    },
  };
}

/**
 * Cap on how many tasks the column's running order echoes into the message.
 * The full ordering still ships in `data.taskOrder`; this only bounds the
 * rendered text so a 200-card column does not swamp the tool response.
 */
const COLUMN_DETAIL_TASK_LIMIT = 50;

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
  if (matched.description) lines.push(`  Description: ${matched.description}`);
  if (matched.auto_command) lines.push(`  Auto-command: ${matched.auto_command}`);
  if (matched.agent_override) lines.push(`  Agent override: ${matched.agent_override}`);
  if (matched.model_override) lines.push(`  Model override: ${matched.model_override}`);
  if (matched.effort_override) lines.push(`  Effort override: ${matched.effort_override}`);
  if (planExitTargetName) lines.push(`  Plan exit target: ${planExitTargetName}`);
  if (matched.is_archived) lines.push(`  Status: archived`);
  if (matched.is_ghost) lines.push(`  Status: ghost (removed from config but has tasks)`);
  lines.push(`  Color: ${matched.color}`);
  if (matched.icon) lines.push(`  Icon: ${matched.icon}`);

  // The column's running order, so this is a complete read-before-reorder call
  // for kangentic_reorder_tasks and kangentic_move_task's `position`. `list()`
  // is ORDER BY position ASC, so the index IS each task's zero-based slot;
  // report that ordinal, not the raw stored position, which diverges from it
  // once archiving has gapped the column.
  const taskOrder = tasks.map((task, slot) => ({
    id: task.id,
    displayId: task.display_id,
    title: task.title,
    position: slot,
  }));
  if (taskOrder.length > 0) {
    lines.push('  Task order (top to bottom):');
    for (const entry of taskOrder.slice(0, COLUMN_DETAIL_TASK_LIMIT)) {
      lines.push(`    ${entry.position}. #${entry.displayId} ${entry.title}`);
    }
    if (taskOrder.length > COLUMN_DETAIL_TASK_LIMIT) {
      lines.push(`    ... and ${taskOrder.length - COLUMN_DETAIL_TASK_LIMIT} more (use kangentic_list_tasks for the full column)`);
    }
  }

  return {
    success: true,
    message: lines.join('\n'),
    data: {
      id: matched.id,
      name: matched.name,
      description: matched.description,
      role: matched.role,
      taskCount: tasks.length,
      taskOrder,
      autoSpawn: matched.auto_spawn,
      permissionMode: matched.permission_mode,
      autoCommand: matched.auto_command,
      agentOverride: matched.agent_override,
      modelOverride: matched.model_override,
      effortOverride: matched.effort_override,
      planExitTarget: planExitTargetName,
      color: matched.color,
      icon: matched.icon,
      isArchived: matched.is_archived,
      isGhost: matched.is_ghost,
    },
  };
};

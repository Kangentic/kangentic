import { TaskRepository } from '../../db/repositories/task-repository';
import { listActiveSwimlanes } from './column-resolver';
import type { Task } from '../../../shared/types';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleSearchTasks: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const query = String(params.query ?? '').toLowerCase();
  const statusFilter = (params.status as string) || 'all';

  if (!query.trim()) {
    return { success: false, error: 'Search query is required' };
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listActiveSwimlanes(db);
  const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

  const matchesQuery = (task: Task) =>
    task.title.toLowerCase().includes(query) ||
    task.description.toLowerCase().includes(query);

  const results: Array<{ id: string; title: string; description: string; column: string; status: string }> = [];
  let totalActive = 0;
  let totalCompleted = 0;

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
};

export const handleFindTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const branch = params.branch as string | null;
  const titleQuery = (params.title as string | null)?.toLowerCase() ?? null;
  const prNumber = params.prNumber as number | null;

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listActiveSwimlanes(db);
  const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

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
};

import type Database from 'better-sqlite3';
import { TaskRepository } from '../../db/repositories/task-repository';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { listActiveSwimlanes } from './column-resolver';
import { BACKLOG_PRIORITY_LABELS } from '../../../shared/types';
import type { Task, BacklogTask } from '../../../shared/types';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export type SearchScope = 'board' | 'backlog' | 'both';

export interface BoardHit {
  id: string;
  displayId: number;
  title: string;
  description: string;
  column: string;
  status: 'active' | 'completed';
}

export interface BacklogHit {
  id: string;
  title: string;
  description: string;
  priority: number;
  priorityLabel: string;
  labels: string[];
}

/**
 * Find backlog matches for handleFindTask. Backlog items only carry id
 * (UUID) and title that the find_task contract can match against -
 * displayId/branch/prNumber are board-only.
 *
 * Fast path: when only a UUID was given, use getById (O(1) indexed
 * lookup) instead of listing the whole backlog and filtering in JS.
 */
function findBacklogMatchesForFindTask(
  db: Database.Database,
  taskId: string | null,
  titleQuery: string | null,
): BacklogTask[] {
  if (!taskId && !titleQuery) return [];
  const backlogRepo = new BacklogRepository(db);

  if (taskId && !titleQuery) {
    const item = backlogRepo.getById(taskId);
    return item ? [item] : [];
  }

  const allItems = backlogRepo.list();
  return allItems.filter((item) => {
    if (taskId && item.id === taskId) return true;
    if (titleQuery && item.title.toLowerCase().includes(titleQuery)) return true;
    return false;
  });
}

export const handleSearchTasks: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const query = String(params.query ?? '').toLowerCase();
  const statusFilter = (params.status as string) || 'all';
  const scopeRaw = typeof params.scope === 'string' ? params.scope : 'both';
  const scope: SearchScope =
    scopeRaw === 'board' || scopeRaw === 'backlog' || scopeRaw === 'both' ? scopeRaw : 'both';

  if (!query.trim()) {
    return { success: false, error: 'Search query is required' };
  }

  const db = context.getProjectDb();
  const includeBoard = scope === 'board' || scope === 'both';
  const includeBacklog = scope === 'backlog' || scope === 'both';

  const tasks: BoardHit[] = [];
  let totalActive = 0;
  let totalCompleted = 0;

  if (includeBoard) {
    const taskRepo = new TaskRepository(db);
    const allSwimlanes = listActiveSwimlanes(db);
    const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

    const matchesQuery = (task: Task) =>
      task.title.toLowerCase().includes(query) ||
      task.description.toLowerCase().includes(query);

    if (statusFilter === 'active' || statusFilter === 'all') {
      for (const swimlane of allSwimlanes) {
        const swimlaneTasks = taskRepo.list(swimlane.id);
        for (const task of swimlaneTasks) {
          if (matchesQuery(task)) {
            totalActive++;
            tasks.push({
              id: task.id,
              displayId: task.display_id,
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
          tasks.push({
            id: task.id,
            displayId: task.display_id,
            title: task.title,
            description: task.description,
            column: 'Done',
            status: 'completed',
          });
        }
      }
    }
  }

  const backlog: BacklogHit[] = [];
  if (includeBacklog) {
    const backlogRepo = new BacklogRepository(db);
    const allItems = backlogRepo.list();
    for (const item of allItems) {
      const titleHit = item.title.toLowerCase().includes(query);
      const descriptionHit = item.description.toLowerCase().includes(query);
      const labelHit = item.labels.some((label) => label.toLowerCase().includes(query));
      if (titleHit || descriptionHit || labelHit) {
        backlog.push({
          id: item.id,
          title: item.title,
          description: item.description,
          priority: item.priority,
          priorityLabel: BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None',
          labels: item.labels,
        });
      }
    }
  }

  return {
    success: true,
    data: {
      tasks,
      backlog,
      totalActive,
      totalCompleted,
      totalBacklog: backlog.length,
      scope,
    },
  };
};

export const handleFindTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const displayId = typeof params.displayId === 'number' ? params.displayId : null;
  const taskId = typeof params.id === 'string' && params.id ? params.id : null;
  const branch = typeof params.branch === 'string' && params.branch ? params.branch : null;
  const titleQuery = typeof params.title === 'string' && params.title ? params.title.toLowerCase() : null;
  const prNumber = typeof params.prNumber === 'number' ? params.prNumber : null;

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

  const taskMatches = allTasks.filter((task) => {
    if (taskId) {
      if (task.id === taskId) return true;
    }
    if (displayId !== null) {
      if (task.display_id === displayId) return true;
    }
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

  const backlogMatches = findBacklogMatchesForFindTask(db, taskId, titleQuery);

  if (taskMatches.length === 0 && backlogMatches.length === 0) {
    const criteria: string[] = [];
    if (taskId) criteria.push(`id "${taskId}"`);
    if (displayId !== null) criteria.push(`#${displayId}`);
    if (branch) criteria.push(`branch "${branch}"`);
    if (titleQuery) criteria.push(`title "${titleQuery}"`);
    if (prNumber !== null) criteria.push(`PR #${prNumber}`);
    return {
      success: true,
      message: `No tasks or backlog items found matching ${criteria.join(' or ')}.`,
      data: { tasks: [], backlog: [] },
    };
  }

  const sections: string[] = [];
  const totalHits = taskMatches.length + backlogMatches.length;
  sections.push(`Found ${totalHits} match(es):`);

  if (taskMatches.length > 0) {
    if (backlogMatches.length > 0) sections.push(`\nBoard (${taskMatches.length}):`);
    const lines = taskMatches.map((task) => {
      const isArchived = task.archived_at !== null;
      const column = isArchived ? 'Done' : (swimlaneMap.get(task.swimlane_id) ?? 'Unknown');
      const parts = [`"${task.title}" [${column}]`];
      if (task.branch_name) parts.push(`branch: ${task.branch_name}`);
      if (task.base_branch) parts.push(`base: ${task.base_branch}`);
      if (task.worktree_path) parts.push(`worktree: ${task.worktree_path}`);
      if (task.pr_url) parts.push(`PR: ${task.pr_url}`);
      else if (task.pr_number) parts.push(`PR #${task.pr_number}`);
      parts.push(`#${task.display_id}, id: ${task.id}`);
      return `- ${parts.join(' | ')}`;
    });
    sections.push(lines.join('\n'));
  }

  if (backlogMatches.length > 0) {
    if (taskMatches.length > 0) sections.push(`\nBacklog (${backlogMatches.length}):`);
    const lines = backlogMatches.map((item) => {
      const priorityLabel = BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None';
      const labelString = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
      return `- "${item.title}" (${priorityLabel})${labelString} (id: ${item.id})`;
    });
    sections.push(lines.join('\n'));
  }

  return {
    success: true,
    message: sections.join('\n'),
    data: {
      tasks: taskMatches.map((task) => ({
        id: task.id,
        displayId: task.display_id,
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
      backlog: backlogMatches.map((item) => ({
        id: item.id,
        title: item.title,
        description: item.description,
        priority: item.priority,
        priorityLabel: BACKLOG_PRIORITY_LABELS[item.priority] ?? 'None',
        labels: item.labels,
      })),
    },
  };
};

const normalizePath = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

export const handleGetCurrentTask: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const cwdRaw = typeof params.cwd === 'string' && params.cwd ? params.cwd : null;
  const branchRaw = typeof params.branch === 'string' && params.branch ? params.branch : null;

  if (!cwdRaw && !branchRaw) {
    return { success: false, error: 'Provide at least one of: cwd, branch.' };
  }

  const cwdNormalized = cwdRaw ? normalizePath(cwdRaw) : null;
  const branchLower = branchRaw ? branchRaw.toLowerCase() : null;

  // The worktree folder name, used only as a lenient fallback below (the primary
  // match is full-path equality against task.worktree_path). Folder names are the
  // task's display_id now and `<slug>-<shortId>` for worktrees created before
  // that; both work here, because the fallback compares the whole final segment.
  let slug: string | null = null;
  if (cwdNormalized) {
    const slugMatch = cwdNormalized.match(/(?:^|\/)\.kangentic\/worktrees\/([^/]+)/);
    if (slugMatch) slug = slugMatch[1];
  }

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listActiveSwimlanes(db);
  const swimlaneMap = new Map(allSwimlanes.map((swimlane) => [swimlane.id, swimlane.name]));

  const allTasks: Task[] = [];
  for (const swimlane of allSwimlanes) {
    allTasks.push(...taskRepo.list(swimlane.id));
  }
  allTasks.push(...taskRepo.listArchived());

  const matches = allTasks.filter((task) => {
    if (cwdNormalized && task.worktree_path) {
      const taskPath = normalizePath(task.worktree_path);
      if (taskPath === cwdNormalized) return true;
      if (slug && taskPath.endsWith(`/${slug}`)) return true;
    }
    if (branchLower && task.branch_name && task.branch_name.toLowerCase() === branchLower) {
      return true;
    }
    return false;
  });

  const toData = (task: Task) => ({
    id: task.id,
    displayId: task.display_id,
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
    // Ports this task has already RESERVED, so an agent recovers them after a
    // resume instead of reserving again. Usually empty: nothing is reserved
    // until something asks (kangentic_reserve_dev_ports), because a project
    // configures its own ports and a number Kangentic invents means nothing to
    // it.
  });

  if (matches.length === 0) {
    return {
      success: true,
      message: 'No task found for current context.',
      data: null,
    };
  }

  if (matches.length === 1) {
    const task = matches[0];
    return {
      success: true,
      message: `Current task: #${task.display_id} "${task.title}" [${task.archived_at ? 'Done' : (swimlaneMap.get(task.swimlane_id) ?? 'Unknown')}]`,
      data: toData(task),
    };
  }

  return {
    success: true,
    message: `Ambiguous: ${matches.length} tasks match the current context. Disambiguate with displayId.`,
    data: matches.map(toData),
  };
};

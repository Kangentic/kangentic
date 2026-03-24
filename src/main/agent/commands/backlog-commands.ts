import { TaskRepository } from '../../db/repositories/task-repository';
import { BacklogRepository } from '../../db/repositories/backlog-repository';
import { BACKLOG_PRIORITY_LABELS } from '../../../shared/types';
import { resolveColumn } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleListBacklog: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const priorityFilter = params.priority as number | null;
  const query = (params.query as string | null)?.toLowerCase() ?? null;

  const db = context.getProjectDb();
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
    const labelString = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
    return `- ${item.title} (${priorityLabel})${labelString} (id: ${item.id})`;
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
};

export const handleCreateBacklogItem: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
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

  const db = context.getProjectDb();
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
};

export const handleSearchBacklog: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const query = String(params.query ?? '').toLowerCase();

  if (!query.trim()) {
    return { success: false, error: 'Search query is required' };
  }

  const db = context.getProjectDb();
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
    const labelString = item.labels.length > 0 ? ` [${item.labels.join(', ')}]` : '';
    const descriptionPreview = item.description
      ? ` - ${item.description.slice(0, 100)}${item.description.length > 100 ? '...' : ''}`
      : '';
    return `- ${item.title} (${priorityLabel})${labelString}${descriptionPreview} (id: ${item.id})`;
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
};

export const handlePromoteBacklog: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const itemIds = params.itemIds as string[];
  const columnName = params.column as string | null;

  if (!itemIds || itemIds.length === 0) {
    return { success: false, error: 'At least one backlog item ID is required' };
  }

  const db = context.getProjectDb();
  const backlogRepo = new BacklogRepository(db);
  const taskRepo = new TaskRepository(db);

  const resolution = resolveColumn(db, columnName);
  if ('error' in resolution) {
    return { success: false, error: resolution.error };
  }
  const { swimlane: targetSwimlane } = resolution;

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

    context.onTaskCreated(task, targetSwimlane.name, targetSwimlane.id);
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
};

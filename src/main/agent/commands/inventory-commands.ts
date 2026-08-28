import { TaskRepository } from '../../db/repositories/task-repository';
import { listActiveSwimlanes } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleListColumns: CommandHandler = (
  _params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listActiveSwimlanes(db);

  const columns = allSwimlanes.map((swimlane) => ({
    name: swimlane.name,
    role: swimlane.role,
    taskCount: taskRepo.list(swimlane.id).length,
  }));

  return { success: true, data: columns };
};

export const handleListTasks: CommandHandler = (
  params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const columnName = params.column as string | null;

  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listActiveSwimlanes(db);

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

  const tasks: Array<{ id: string; displayId: number; title: string; description: string; column: string; position: number; labels: string[] }> = [];
  for (const swimlane of targetSwimlanes) {
    // `list()` is ORDER BY position ASC, so the loop index IS the task's
    // zero-based slot in its column. Report that ordinal rather than the raw
    // `tasks.position` value: the two diverge once archiving has gapped the
    // column, and the ordinal is what the placement tools
    // (kangentic_move_task's `position`, kangentic_reorder_tasks) consume.
    const swimlaneTasks = taskRepo.list(swimlane.id);
    swimlaneTasks.forEach((task, slot) => {
      tasks.push({
        id: task.id,
        displayId: task.display_id,
        title: task.title,
        description: task.description,
        column: swimlane.name,
        position: slot,
        labels: task.labels,
      });
    });
  }

  return { success: true, data: tasks };
};

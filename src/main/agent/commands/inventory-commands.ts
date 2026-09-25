import { TaskRepository } from '../../db/repositories/task-repository';
import { listBoardColumns } from './column-resolver';
import type { CommandContext, CommandHandler, CommandResponse } from './types';

export const handleListColumns: CommandHandler = (
  _params: Record<string, unknown>,
  context: CommandContext,
): CommandResponse => {
  const db = context.getProjectDb();
  const taskRepo = new TaskRepository(db);
  const allSwimlanes = listBoardColumns(db);

  // The done lane's live count is structurally always zero - moving a task
  // there archives it off the board - so reporting only `taskCount` would make
  // the column read as dead. Count the archive instead, once, rather than per
  // lane. See `TaskRepository.countArchived()` for why a project-wide count is
  // a safe stand-in for the done lane's own.
  const hasDoneLane = allSwimlanes.some((swimlane) => swimlane.role === 'done');
  const completedCount = hasDoneLane ? taskRepo.countArchived() : 0;

  const columns = allSwimlanes.map((swimlane) => ({
    name: swimlane.name,
    role: swimlane.role,
    // Live cards on the board, for every lane including Done.
    taskCount: taskRepo.list(swimlane.id).length,
    ...(swimlane.role === 'done' ? { completedCount } : {}),
    // Sparse on purpose, like completedCount: only the columns that run their
    // own conversation carry it, so the common board prints unchanged. This is
    // what lets an agent see which columns are isolated from the board survey
    // it already makes, instead of a get_column_detail call per column.
    ...(swimlane.session_target === 'isolated' ? { sessionTarget: 'isolated' as const } : {}),
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
  // Done is resolvable here because kangentic_list_columns advertises it. A
  // narrower list would answer `Column "Done" not found` for a name this tool's
  // own sibling just printed. It has no live tasks to return (moving a task
  // there archives it); completed tasks are kangentic_search_tasks' job.
  const allSwimlanes = listBoardColumns(db);

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
